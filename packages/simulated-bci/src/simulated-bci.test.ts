import assert from "node:assert/strict";
import { test } from "node:test";
import { IntentCommand, SimulatedBciAdapter } from "./index.js";

test("triggerGoal emits a validated EXECUTE_GOAL intent with the preset concepts", () => {
  const bci = new SimulatedBciAdapter({ session: "test" });
  const event = bci.triggerGoal("1");
  assert.equal(event.intent, IntentCommand.EXECUTE_GOAL);
  assert.deepEqual(event.concepts, ["youtube", "avgn", "season 9"]);
  assert.ok(event.confidence >= 0 && event.confidence <= 1);
});

test("STOP is never corrupted even at 100% command error rate", () => {
  const bci = new SimulatedBciAdapter({ commandErrorRate: 1, session: "test" });
  for (let i = 0; i < 25; i++) {
    const event = bci.triggerStop();
    assert.equal(event.intent, IntentCommand.STOP);
    assert.equal(event.confidence, 1);
  }
});

test("confidence stays within [0, 1] under jitter", () => {
  const bci = new SimulatedBciAdapter({ baseConfidence: 0.05, confidenceJitter: 0.5 });
  for (let i = 0; i < 50; i++) {
    const event = bci.trigger(IntentCommand.CONFIRM);
    assert.ok(event.confidence >= 0 && event.confidence <= 1);
  }
});

test("emits an 'intent' event to listeners", () => {
  const bci = new SimulatedBciAdapter();
  let received: unknown;
  bci.on("intent", (event) => {
    received = event;
  });
  const triggered = bci.trigger(IntentCommand.QUERY_INTENT);
  assert.equal(received, triggered);
});
