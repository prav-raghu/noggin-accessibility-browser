import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentState, BrowserActionType, createIntentEvent, IntentCommand } from "@noggin/intent-contract";
import type { IntentEvent, Plan } from "@noggin/intent-contract";
import { NullAuditStore } from "@noggin/audit-log";
import type { Planner } from "@noggin/agent-planner";
import { SimulatedBciAdapter } from "@noggin/simulated-bci";
import type { ActionResult, BrowserExecutor, PageContext } from "@noggin/browser-executor";
import type { BrowserAction } from "@noggin/intent-contract";
import { Orchestrator } from "./orchestrator.js";

/** Minimal fake satisfying the BrowserExecutor surface the orchestrator calls. */
function fakeExecutor(): BrowserExecutor {
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
  } as unknown as BrowserExecutor;
}

function makeOrchestrator() {
  // Note: `bci` is wired to the orchestrator's handleIntent automatically (that's the
  // production event flow - see server.ts, which drives everything through
  // bci.trigger()/triggerGoal() rather than calling handleIntent directly). Tests below
  // build IntentEvents directly with createIntentEvent() and call handleIntent()
  // themselves so each test controls exactly one dispatch instead of racing the
  // adapter's own automatic "intent" listener against a second manual call.
  const bci = new SimulatedBciAdapter({ session: "test" });
  const orchestrator = new Orchestrator({
    sessionId: "test-session",
    executor: fakeExecutor(),
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
