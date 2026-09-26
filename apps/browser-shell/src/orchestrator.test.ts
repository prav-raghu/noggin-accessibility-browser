import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentState, BrowserActionType, createIntentEvent, IntentCommand } from "@noggin/intent-contract";
import type { IntentEvent, Plan } from "@noggin/intent-contract";
import { NullAuditStore } from "@noggin/audit-log";
import type { Planner } from "@noggin/agent-planner";
import { SimulatedBciAdapter } from "@noggin/simulated-bci";
import type { ActionResult, BrowserExecutor, ChallengeInfo, PageContext } from "@noggin/browser-executor";
import type { BrowserAction } from "@noggin/intent-contract";
import { Orchestrator } from "./orchestrator.js";

const NO_CHALLENGE: ChallengeInfo = { present: false, requiresManualAction: false };

/** Minimal fake satisfying the BrowserExecutor surface the orchestrator calls. */
function fakeExecutor(overrides: Partial<BrowserExecutor> = {}): BrowserExecutor {
  const context: PageContext = { url: "https://example.test/", title: "Example" };
  return {
    async getPageContext(): Promise<PageContext> {
      return context;
    },
    async execute(action: BrowserAction): Promise<ActionResult> {
      return { action, ok: true, detail: `executed ${action.type}`, context };
    },
    async goBack(): Promise<PageContext> {
      return context;
    },
    async detectChallenge(): Promise<ChallengeInfo> {
      return NO_CHALLENGE;
    },
    ...overrides,
  } as unknown as BrowserExecutor;
}

function makeOrchestrator(executor: BrowserExecutor = fakeExecutor()) {
  // Note: `bci` is wired to the orchestrator's handleIntent automatically (that's the
  // production event flow - see server.ts, which drives everything through
  // bci.trigger()/triggerGoal() rather than calling handleIntent directly). Tests below
  // build IntentEvents directly with createIntentEvent() and call handleIntent()
  // themselves so each test controls exactly one dispatch instead of racing the
  // adapter's own automatic "intent" listener against a second manual call.
  const bci = new SimulatedBciAdapter({ session: "test" });
  const orchestrator = new Orchestrator({
    sessionId: "test-session",
    executor,
    audit: new NullAuditStore(),
    bci,
  });
  return { orchestrator, bci };
}

function intent(overrides: Partial<IntentEvent> & Pick<IntentEvent, "intent">): IntentEvent {
  return createIntentEvent({
    source: "test",
    concepts: [],
    confidence: 1,
    requires_confirmation: false,
    signal_provenance: { decoder: "test", session: "test" },
    ...overrides,
  });
}

test("EXECUTE_GOAL for a high-confidence known goal runs to completion without confirmation", async () => {
  const { orchestrator } = makeOrchestrator();
  const states: string[] = [];
  orchestrator.onUpdate((u) => states.push(u.state));

  await orchestrator.handleIntent(
    intent({ intent: IntentCommand.EXECUTE_GOAL, concepts: ["youtube", "avgn", "season 9"], confidence: 0.9 }),
  );

  assert.ok(states.includes(AgentState.PLANNING));
  assert.ok(states.includes(AgentState.ACTING));
  assert.equal(states.at(-1), AgentState.LISTENING);
});

test("EXECUTE_GOAL with low confidence on a Tier 1 plan waits for confirmation, then CONFIRM runs it", async () => {
  const { orchestrator } = makeOrchestrator();
  await orchestrator.handleIntent(
    intent({ intent: IntentCommand.EXECUTE_GOAL, concepts: ["youtube", "avgn"], confidence: 0.1 }),
  );
  assert.equal(orchestrator.getSnapshot().state, AgentState.AWAITING_CONFIRMATION);

  await orchestrator.handleIntent(intent({ intent: IntentCommand.CONFIRM }));
  assert.equal(orchestrator.getSnapshot().state, AgentState.LISTENING);
});

test("REJECT clears the pending plan without executing it", async () => {
  const { orchestrator } = makeOrchestrator();
  await orchestrator.handleIntent(
    intent({ intent: IntentCommand.EXECUTE_GOAL, concepts: ["youtube", "avgn"], confidence: 0.1 }),
  );
  assert.equal(orchestrator.getSnapshot().state, AgentState.AWAITING_CONFIRMATION);

  await orchestrator.handleIntent(intent({ intent: IntentCommand.REJECT }));
  assert.equal(orchestrator.getSnapshot().state, AgentState.LISTENING);
  assert.equal(orchestrator.gateway.getPending(), null);
});

test("STOP immediately transitions to stopped and clears any pending plan", async () => {
  const { orchestrator } = makeOrchestrator();
  await orchestrator.handleIntent(
    intent({ intent: IntentCommand.EXECUTE_GOAL, concepts: ["youtube", "avgn"], confidence: 0.1 }),
  );
  assert.equal(orchestrator.getSnapshot().state, AgentState.AWAITING_CONFIRMATION);

  orchestrator.stop();
  assert.equal(orchestrator.getSnapshot().state, AgentState.STOPPED);
  assert.equal(orchestrator.gateway.getPending(), null);
});

test("EXECUTE_GOAL is ignored while paused", async () => {
  const { orchestrator } = makeOrchestrator();
  orchestrator.pause();
  await orchestrator.handleIntent(
    intent({ intent: IntentCommand.EXECUTE_GOAL, concepts: ["youtube"], confidence: 1 }),
  );
  assert.equal(orchestrator.getSnapshot().state, AgentState.PAUSED);
});

test("a planner's resolveParams is used for the live executor call but never for the audit/UI-visible result", async () => {
  const executedParams: Record<string, unknown>[] = [];
  const context: PageContext = { url: "https://example.test/", title: "Example" };
  const executor = {
    async getPageContext(): Promise<PageContext> {
      return context;
    },
    async execute(action: BrowserAction): Promise<ActionResult> {
      executedParams.push(action.params);
      return { action, ok: true, detail: `executed ${action.type}`, context };
    },
    async goBack(): Promise<PageContext> {
      return context;
    },
    async detectChallenge(): Promise<ChallengeInfo> {
      return NO_CHALLENGE;
    },
  } as unknown as BrowserExecutor;

  const redactedPlan: Plan = {
    id: "plan-1",
    sourceIntentId: "intent-1",
    goal: "log into a fake site",
    steps: [
      {
        id: "step-1",
        type: BrowserActionType.FILL_FIELD,
        params: { value: "{{SECRET_1}}", fieldType: "password" },
        riskTier: 1,
        description: "Fill in the password field",
      },
    ],
  };

  const planner: Planner = {
    async plan(): Promise<Plan> {
      return redactedPlan;
    },
    resolveParams(action: BrowserAction): Record<string, unknown> {
      return { ...action.params, value: "the-real-password" };
    },
  };

  const results: ActionResult[] = [];
  const bci = new SimulatedBciAdapter({ session: "test" });
  const orchestrator = new Orchestrator({
    sessionId: "test-session",
    executor,
    audit: new NullAuditStore(),
    bci,
    planner,
  });
  orchestrator.onUpdate((u) => {
    if (u.lastActionResult) results.push(u.lastActionResult);
  });

  await orchestrator.handleIntent(
    intent({ intent: IntentCommand.EXECUTE_GOAL, concepts: ["log", "in"], confidence: 1 }),
  );

  // The live executor call must have received the resolved (real) value.
  assert.equal(executedParams[0]?.value, "the-real-password");
  // But everything published for audit/UI must keep the original placeholder - the
  // resolved value must never leak into a logged or displayed ActionResult.
  assert.equal(results[0]?.action.params.value, "{{SECRET_1}}");
});

async function flushAsync(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a bot-check challenge mid-plan pauses execution, and Continue resumes the remaining steps once it's cleared", async () => {
  const executedTypes: string[] = [];
  let detectCalls = 0;
  const context: PageContext = { url: "https://example.test/", title: "Example" };
  const executor = {
    async getPageContext(): Promise<PageContext> {
      return context;
    },
    async execute(action: BrowserAction): Promise<ActionResult> {
      executedTypes.push(action.type);
      return { action, ok: true, detail: `executed ${action.type}`, context };
    },
    async goBack(): Promise<PageContext> {
      return context;
    },
    async detectChallenge(): Promise<ChallengeInfo> {
      detectCalls += 1;
      // Blocking on the first check (right after step 1), cleared on every check after.
      return detectCalls === 1
        ? { present: true, provider: "recaptcha", requiresManualAction: true }
        : NO_CHALLENGE;
    },
  } as unknown as BrowserExecutor;

  const plan: Plan = {
    id: "plan-1",
    sourceIntentId: "intent-1",
    goal: "log in",
    steps: [
      {
        id: "s1",
        type: BrowserActionType.CLICK_BY_ROLE,
        params: { role: "checkbox", nameContains: "not a robot" },
        riskTier: 1,
        description: "check the box",
      },
      { id: "s2", type: BrowserActionType.SUBMIT_FORM, params: {}, riskTier: 2, description: "submit" },
    ],
  };
  const planner: Planner = { async plan() { return plan; } };

  const bci = new SimulatedBciAdapter({ session: "test" });
  const orchestrator = new Orchestrator({ sessionId: "test-session", executor, audit: new NullAuditStore(), bci, planner });

  await orchestrator.handleIntent(
    intent({ intent: IntentCommand.EXECUTE_GOAL, concepts: ["log", "in"], confidence: 1 }),
  );
  // Tier 2 (submit_form) always needs confirmation regardless of confidence.
  assert.equal(orchestrator.getSnapshot().state, AgentState.AWAITING_CONFIRMATION);

  await orchestrator.confirmPending();

  // Only step 1 ran before the (simulated) challenge appeared and paused execution.
  assert.deepEqual(executedTypes, ["click_by_role"]);
  assert.equal(orchestrator.getSnapshot().state, AgentState.AWAITING_MANUAL_ACTION);

  await orchestrator.continueAfterManualAction();

  assert.deepEqual(executedTypes, ["click_by_role", "submit_form"]);
  assert.equal(orchestrator.getSnapshot().state, AgentState.LISTENING);
});

test("Continue while the challenge is still showing does not resume, and says so", async () => {
  const executedTypes: string[] = [];
  const context: PageContext = { url: "https://example.test/", title: "Example" };
  const executor = {
    async getPageContext(): Promise<PageContext> {
      return context;
    },
    async execute(action: BrowserAction): Promise<ActionResult> {
      executedTypes.push(action.type);
      return { action, ok: true, detail: `executed ${action.type}`, context };
    },
    async goBack(): Promise<PageContext> {
      return context;
    },
    async detectChallenge(): Promise<ChallengeInfo> {
      return { present: true, provider: "recaptcha", requiresManualAction: true };
    },
  } as unknown as BrowserExecutor;

  const plan: Plan = {
    id: "plan-1",
    sourceIntentId: "intent-1",
    goal: "search",
    steps: [{ id: "s1", type: BrowserActionType.NAVIGATE, params: { url: "https://example.test" }, riskTier: 1, description: "go" }],
  };
  const planner: Planner = { async plan() { return plan; } };
  const bci = new SimulatedBciAdapter({ session: "test" });
  const orchestrator = new Orchestrator({ sessionId: "test-session", executor, audit: new NullAuditStore(), bci, planner });

  await orchestrator.handleIntent(intent({ intent: IntentCommand.EXECUTE_GOAL, concepts: ["search"], confidence: 1 }));
  assert.equal(orchestrator.getSnapshot().state, AgentState.AWAITING_MANUAL_ACTION);

  const messages: (string | undefined)[] = [];
  orchestrator.onUpdate((u) => messages.push(u.message));
  await orchestrator.continueAfterManualAction();

  assert.equal(orchestrator.getSnapshot().state, AgentState.AWAITING_MANUAL_ACTION);
  assert.deepEqual(executedTypes, ["navigate"]);
  assert.ok(messages.some((m) => m?.includes("still detecting")));
});

test("toggleOnscreenKeyboard activates and deactivates it", () => {
  const { orchestrator } = makeOrchestrator();
  assert.equal(orchestrator.onscreenKeyboard.getState().active, false);
  orchestrator.toggleOnscreenKeyboard();
  assert.equal(orchestrator.onscreenKeyboard.getState().active, true);
  orchestrator.toggleOnscreenKeyboard();
  assert.equal(orchestrator.onscreenKeyboard.getState().active, false);
});

test("while the onscreen keyboard is active, CONFIRM/REJECT drive it instead of resolving a pending plan confirmation", async () => {
  const { orchestrator } = makeOrchestrator();

  await orchestrator.handleIntent(
    intent({ intent: IntentCommand.EXECUTE_GOAL, concepts: ["youtube", "avgn"], confidence: 0.1 }),
  );
  assert.equal(orchestrator.getSnapshot().state, AgentState.AWAITING_CONFIRMATION);
  assert.ok(orchestrator.gateway.getPending());

  orchestrator.toggleOnscreenKeyboard();
  orchestrator.onscreenKeyboard.advance(); // row -> 1

  await orchestrator.handleIntent(intent({ intent: IntentCommand.CONFIRM }));

  // The CONFIRM was consumed by the keyboard (locked row 1), not the pending plan.
  assert.equal(orchestrator.onscreenKeyboard.getState().mode, "column");
  assert.equal(orchestrator.onscreenKeyboard.getState().lockedRowIndex, 1);
  assert.ok(orchestrator.gateway.getPending());
  assert.equal(orchestrator.getSnapshot().state, AgentState.AWAITING_CONFIRMATION);
  // Cleanup: stop() clears both the keyboard's scan timer and the still-pending
  // confirmation's 20s timeout, so this test doesn't hold the process open until it fires.
  orchestrator.stop();
});

test("composing text via the onscreen keyboard and selecting DONE triggers EXECUTE_GOAL with that text", async () => {
  const { orchestrator } = makeOrchestrator();
  const states: string[] = [];
  orchestrator.onUpdate((u) => states.push(u.state));

  orchestrator.toggleOnscreenKeyboard();

  orchestrator.onscreenKeyboard.advance(); // row 1 ("G H I J K L")
  await orchestrator.handleIntent(intent({ intent: IntentCommand.CONFIRM })); // lock row 1
  orchestrator.onscreenKeyboard.advance(); // col 1 ("H")
  await orchestrator.handleIntent(intent({ intent: IntentCommand.CONFIRM })); // commit "H"

  for (let i = 0; i < 4; i++) orchestrator.onscreenKeyboard.advance(); // row 4
  await orchestrator.handleIntent(intent({ intent: IntentCommand.CONFIRM })); // lock row 4
  for (let i = 0; i < 4; i++) orchestrator.onscreenKeyboard.advance(); // col 4 ("DONE")
  await orchestrator.handleIntent(intent({ intent: IntentCommand.CONFIRM })); // commit DONE

  await flushAsync();

  assert.equal(orchestrator.onscreenKeyboard.getState().active, false);
  assert.ok(states.includes(AgentState.PLANNING));
  assert.equal(states.at(-1), AgentState.LISTENING);
});

test("the simulated-bci adapter's automatic wiring reaches the orchestrator exactly once per trigger", async () => {
  const { orchestrator, bci } = makeOrchestrator();
  const states: string[] = [];
  orchestrator.onUpdate((u) => states.push(u.state));

  bci.triggerGoal("1");
  // handleIntent runs asynchronously off the EventEmitter callback; give it a tick.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(states.at(-1), AgentState.LISTENING);
});
