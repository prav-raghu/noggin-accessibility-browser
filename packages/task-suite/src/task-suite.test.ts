import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BrowserExecutor, type ActionResult } from "@noggin/browser-executor";
import { TASKS, taskGoalRules } from "./index.js";

let executor: BrowserExecutor;

before(async () => {
  executor = new BrowserExecutor({ headless: true });
  await executor.launch();
});

after(async () => {
  await executor.close();
});

test("every task has a unique id and at least one step", () => {
  const ids = new Set(TASKS.map((t) => t.id));
  assert.equal(ids.size, TASKS.length, "task ids must be unique");
  for (const task of TASKS) {
    assert.ok(task.steps.length > 0, `${task.id} has no steps`);
  }
});

test("taskGoalRules() returns one rule per task, matching its own concepts", () => {
  const rules = taskGoalRules();
  assert.equal(rules.length, TASKS.length);
  for (const task of TASKS) {
    const rule = rules.find((r) => r.requiredConcepts.every((c) => task.concepts.includes(c)));
    assert.ok(rule, `no goal rule matches ${task.id}'s own concepts`);
  }
});

test("every fixture task can be executed end-to-end and verifies as successful", async () => {
  for (const task of TASKS) {
    let lastResult: ActionResult | undefined;
    for (const s of task.steps) {
      lastResult = await executor.execute(s);
      assert.ok(lastResult.ok, `${task.id} step "${s.description}" failed: ${lastResult.detail}`);
    }
    const succeeded = await task.verify(executor, lastResult);
    assert.ok(succeeded, `${task.id} did not verify as successful after its steps ran`);
  }
});
