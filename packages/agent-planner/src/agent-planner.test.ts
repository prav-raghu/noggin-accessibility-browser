import assert from "node:assert/strict";
import { test } from "node:test";
import { createIntentEvent, IntentCommand, planRiskTier, RiskTier } from "@noggin/intent-contract";
import { StubPlanner } from "./index.js";

function goalIntent(concepts: string[], confidence = 0.85) {
  return createIntentEvent({
    source: "test",
    intent: IntentCommand.EXECUTE_GOAL,
    concepts,
    confidence,
    requires_confirmation: false,
    signal_provenance: { decoder: "test", session: "test" },
  });
}

test("matches the spec section 7 worked example (YouTube AVGN season 9)", async () => {
  const planner = new StubPlanner();
  const plan = await planner.plan(goalIntent(["youtube", "avgn", "season 9"]), {});
  assert.ok(plan);
  assert.match(plan.goal, /youtube/i);
  assert.equal(planRiskTier(plan), RiskTier.REVERSIBLE_NAVIGATION);
  assert.ok(plan.steps.some((s) => s.type === "navigate"));
  assert.ok(plan.steps.some((s) => s.type === "play_pause_media"));
});

test("falls back to a generic web search for unknown concepts", async () => {
  const planner = new StubPlanner();
  const plan = await planner.plan(goalIntent(["some", "unmapped", "goal"]), {});
  assert.ok(plan);
  assert.ok(plan.steps.some((s) => s.type === "navigate"));
});

test("returns null (asks for clarification) when there are no concepts", async () => {
  const planner = new StubPlanner();
  const plan = await planner.plan(goalIntent([]), {});
  assert.equal(plan, null);
});

test("every plan records its source intent id for audit provenance", async () => {
  const planner = new StubPlanner();
  const intent = goalIntent(["weather", "today"]);
  const plan = await planner.plan(intent, {});
  assert.equal(plan?.sourceIntentId, intent.id);
});
