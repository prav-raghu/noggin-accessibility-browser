import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BrowserExecutor } from "@noggin/browser-executor";
import { TASKS } from "@noggin/task-suite";
import { aggregate } from "./aggregate.js";
import { BenchmarkHarness } from "./harness.js";
import { headline, toMarkdownTable } from "./report.js";

let executor: BrowserExecutor;
let harness: BenchmarkHarness;

before(async () => {
  executor = new BrowserExecutor({ headless: true });
  await executor.launch();
  harness = new BenchmarkHarness({ executor });
});

after(async () => {
  await executor.close();
});

test("direct_control executes every step as its own control event", async () => {
  const task = TASKS.find((t) => t.id === "information_retrieval")!;
  const result = await harness.runDirectControl(task);
  assert.equal(result.success, true);
  assert.equal(result.controlEvents, task.steps.length);
  assert.equal(result.confirmations, 0);
});

test("agentic_intent_control needs only one control event for a Tier <=1 task", async () => {
  const task = TASKS.find((t) => t.id === "information_retrieval")!;
  const result = await harness.runAgenticIntentControl(task);
  assert.equal(result.success, true);
  assert.equal(result.controlEvents, 1);
  assert.equal(result.confirmations, 0);
});

test("agentic_intent_control models one CONFIRM event for a Tier 2 task (form submission)", async () => {
  const task = TASKS.find((t) => t.id === "form_completion")!;
  const result = await harness.runAgenticIntentControl(task);
  assert.equal(result.success, true);
  assert.equal(result.controlEvents, 2);
  assert.equal(result.confirmations, 1);
  // ... and still fewer control events than direct control for the same task.
  assert.ok(result.controlEvents < task.steps.length);
});

test("runSuite covers both conditions for every task across N repetitions", async () => {
  const results = await harness.runSuite(TASKS, 2);
  assert.equal(results.length, TASKS.length * 2 * 2);
  assert.ok(results.every((r) => r.success));
});

test("aggregate + report produce a sane overall comparison", async () => {
  const results = await harness.runSuite(TASKS, 1);
  const groups = aggregate(results);

  const overallDirect = groups.find((g) => g.taskId === "__overall__" && g.condition === "direct_control");
  const overallAgentic = groups.find(
    (g) => g.taskId === "__overall__" && g.condition === "agentic_intent_control",
  );
  assert.ok(overallDirect);
  assert.ok(overallAgentic);
  assert.equal(overallDirect.successRate, 1);
  assert.equal(overallAgentic.successRate, 1);
  assert.ok(
    overallAgentic.meanControlEvents < overallDirect.meanControlEvents,
    "agentic condition should need fewer control events on average across this task set",
  );

  const table = toMarkdownTable(groups);
  assert.match(table, /\| Task \| Condition \|/);
  assert.match(table, /overall/);

  const summary = headline(groups);
  assert.match(summary, /fewer/);
});
