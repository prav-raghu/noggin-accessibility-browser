import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BrowserActionType,
  createIntentEvent,
  DEFAULT_ACTION_RISK,
  IntentCommand,
  type Plan,
} from "@noggin/intent-contract";
import { evaluatePlan, SafetyGateway } from "./index.js";

function makeIntent(confidence: number) {
  return createIntentEvent({
    source: "test",
    intent: IntentCommand.EXECUTE_GOAL,
    concepts: ["youtube"],
    confidence,
    requires_confirmation: false,
    signal_provenance: { decoder: "test", session: "test" },
  });
}

function planWithAction(type: keyof typeof BrowserActionType): Plan {
  const actionType = BrowserActionType[type];
  return {
    id: "plan-1",
    sourceIntentId: "intent-1",
    goal: "test goal",
    steps: [
      {
        id: "step-1",
        type: actionType,
        params: {},
        riskTier: DEFAULT_ACTION_RISK[actionType],
        description: `do a ${actionType}`,
      },
    ],
  };
}

test("Tier 0 (observe) is always approved regardless of confidence", () => {
  const decision = evaluatePlan(planWithAction("READ_PAGE"), makeIntent(0.01));
  assert.equal(decision.kind, "approved");
});

test("Tier 1 auto-approves above the confidence threshold", () => {
  const decision = evaluatePlan(planWithAction("NAVIGATE"), makeIntent(0.9));
  assert.equal(decision.kind, "approved");
});

test("Tier 1 asks for confirmation (not refusal) below the confidence threshold", () => {
  const decision = evaluatePlan(planWithAction("NAVIGATE"), makeIntent(0.2));
  assert.equal(decision.kind, "needs_confirmation");
});

test("Tier 2 always needs confirmation even at high confidence", () => {
  const decision = evaluatePlan(planWithAction("SEND_MESSAGE"), makeIntent(0.99));
  assert.equal(decision.kind, "needs_confirmation");
  assert.equal(decision.requiresIndependentChannel, false);
});

test("Tier 3 needs confirmation and prefers an independent channel", () => {
  const decision = evaluatePlan(planWithAction("PURCHASE"), makeIntent(0.99));
  assert.equal(decision.kind, "needs_confirmation");
  assert.equal(decision.requiresIndependentChannel, true);
});

test("Tier 4 is refused outright regardless of confidence", () => {
  const plan: Plan = {
    id: "plan-4",
    sourceIntentId: "intent-1",
    goal: "unbounded transfer",
    steps: [
      { id: "s1", type: BrowserActionType.PURCHASE, params: {}, riskTier: 4, description: "prohibited" },
    ],
  };
  const decision = evaluatePlan(plan, makeIntent(1));
  assert.equal(decision.kind, "refused");
});

test("stop() clears pending confirmation and refuses subsequent plans until resume()", () => {
  const gateway = new SafetyGateway();
  const decision = gateway.submitPlan(planWithAction("SEND_MESSAGE"), makeIntent(0.9));
  assert.equal(decision.kind, "needs_confirmation");
  assert.ok(gateway.getPending());

  gateway.stop();
  assert.equal(gateway.getPending(), null);

  const afterStop = gateway.submitPlan(planWithAction("READ_PAGE"), makeIntent(1));
  assert.equal(afterStop.kind, "refused");

  gateway.resume();
  const afterResume = gateway.submitPlan(planWithAction("READ_PAGE"), makeIntent(1));
  assert.equal(afterResume.kind, "approved");
});

test("expirePendingConfirmation rejects rather than silently approving", () => {
  const gateway = new SafetyGateway();
  gateway.submitPlan(planWithAction("PURCHASE"), makeIntent(0.99));
  assert.ok(gateway.getPending());

  const events: string[] = [];
  gateway.on((e) => events.push(e.type));

  const result = gateway.expirePendingConfirmation();
  assert.ok(result);
  assert.equal(gateway.getPending(), null);
  assert.ok(events.includes("rejected"));
  assert.ok(!events.includes("confirmed"));
});

test("confirm() returns null when nothing is pending", () => {
  const gateway = new SafetyGateway();
  assert.equal(gateway.confirm(), null);
});
