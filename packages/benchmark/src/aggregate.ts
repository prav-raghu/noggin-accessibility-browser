/**
 * Turns raw per-run `RunMetrics` into the summary numbers spec section 15 asks for:
 * "task success rate; time to completion; number of user-issued control events ...
 * confirmation burden" - grouped per task/condition, plus an overall roll-up per
 * condition so the headline A-vs-B comparison (H1) doesn't require reading every row.
 */
import type { Condition, RunMetrics } from "./harness.js";

export interface AggregatedGroup {
  taskId: string | "__overall__";
  condition: Condition;
  runs: number;
  successRate: number;
  meanTimeMs: number;
  meanControlEvents: number;
  meanAgentSteps: number;
  meanConfirmations: number;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function summarize(taskId: string | "__overall__", condition: Condition, runs: RunMetrics[]): AggregatedGroup {
  return {
    taskId,
    condition,
    runs: runs.length,
    successRate: mean(runs.map((r) => (r.success ? 1 : 0))),
    meanTimeMs: mean(runs.map((r) => r.timeMs)),
    meanControlEvents: mean(runs.map((r) => r.controlEvents)),
    meanAgentSteps: mean(runs.map((r) => r.agentSteps)),
    meanConfirmations: mean(runs.map((r) => r.confirmations)),
  };
}

/** Per-task, per-condition groups, followed by one `__overall__` group per condition. */
export function aggregate(metrics: RunMetrics[]): AggregatedGroup[] {
  const taskIds = [...new Set(metrics.map((m) => m.taskId))];
  const conditions = [...new Set(metrics.map((m) => m.condition))] as Condition[];

  const groups: AggregatedGroup[] = [];
  for (const taskId of taskIds) {
    for (const condition of conditions) {
      const runs = metrics.filter((m) => m.taskId === taskId && m.condition === condition);
      if (runs.length > 0) groups.push(summarize(taskId, condition, runs));
    }
  }
  for (const condition of conditions) {
    const runs = metrics.filter((m) => m.condition === condition);
    if (runs.length > 0) groups.push(summarize("__overall__", condition, runs));
  }
  return groups;
}
