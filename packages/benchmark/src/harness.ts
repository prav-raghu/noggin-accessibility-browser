/**
 * M4 baseline experiment (spec section 15 / milestone table): "Direct-control vs
 * agentic-control benchmark runs reproducibly."
 *
 * Holds the task constant (spec section 15: "hold browser tasks constant while changing
 * the control strategy") and runs each `@noggin/task-suite` task under two conditions:
 *
 *   - `direct_control` (spec's Condition A): the same low-level action sequence the
 *     agentic planner would eventually take, but each step models one explicit
 *     switch/BCI-like control event - no planner, no safety-gateway confirmation
 *     modeling, since a real direct-control UI authorizes each atomic action as it's
 *     issued.
 *   - `agentic_intent_control` (spec's Condition B): one sparse EXECUTE_GOAL intent goes
 *     through the real `StubPlanner` and the real `SafetyGateway` used by the production
 *     pipeline (`apps/browser-shell`) - not a re-implementation of their logic. Every
 *     `needs_confirmation` decision is modeled as one additional CONFIRM control event
 *     from an always-cooperative simulated user, matching the spec's Condition C framing
 *     ("same as B" plus confirmation, minus the extra uncertainty policy this MVP
 *     doesn't add on top yet - see docs/architecture.md).
 *
 * This intentionally does NOT drive intent through `SimulatedBciAdapter`/orchestrator's
 * event plumbing - the harness needs synchronous, per-run control over confidence and
 * confirmation so the metrics below are exact, not sampled from timers and listeners.
 */
import { StubPlanner } from "@noggin/agent-planner";
import type { ActionResult, BrowserExecutor } from "@noggin/browser-executor";
import {
  createIntentEvent,
  IntentCommand,
  type IntentEvent,
} from "@noggin/intent-contract";
import { SafetyGateway } from "@noggin/safety-gateway";
import { taskGoalRules, type BenchmarkTask, type TaskCategory } from "@noggin/task-suite";

export type Condition = "direct_control" | "agentic_intent_control";

export interface RunMetrics {
  taskId: string;
  category: TaskCategory;
  condition: Condition;
  repetition: number;
  success: boolean;
  timeMs: number;
  /** Primary measure (spec section 15): number of user-issued control events. */
  controlEvents: number;
  /** Primary measure: agent steps per user command (always 1 command in both conditions
   * here; what differs is controlEvents). */
  agentSteps: number;
  /** Primary measure: confirmation burden. Always 0 for direct_control by construction. */
  confirmations: number;
  detail?: string;
}

export interface BenchmarkHarnessConfig {
  executor: BrowserExecutor;
  /** Forwarded to the SafetyGateway used by the agentic condition. */
  tier1AutoApproveConfidence?: number;
}

export class BenchmarkHarness {
  private readonly executor: BrowserExecutor;
  private readonly tier1AutoApproveConfidence: number | undefined;

  constructor(config: BenchmarkHarnessConfig) {
    this.executor = config.executor;
    this.tier1AutoApproveConfidence = config.tier1AutoApproveConfidence;
  }

  async runSuite(tasks: BenchmarkTask[], repetitions = 1): Promise<RunMetrics[]> {
    const results: RunMetrics[] = [];
    for (const task of tasks) {
      for (let rep = 1; rep <= repetitions; rep += 1) {
        results.push(await this.runDirectControl(task, rep));
        results.push(await this.runAgenticIntentControl(task, rep));
      }
    }
    return results;
  }

  async runDirectControl(task: BenchmarkTask, repetition = 1): Promise<RunMetrics> {
    const start = Date.now();
    let success = false;
    let detail: string | undefined;
    let lastResult: ActionResult | undefined;

    try {
      for (const step of task.steps) {
        lastResult = await this.executor.execute(step);
        if (!lastResult.ok) {
          detail = `step "${step.description}" failed: ${lastResult.detail}`;
          break;
        }
      }
      success = await task.verify(this.executor, lastResult);
    } catch (err) {
      detail = describeError(err);
    }

    return {
      taskId: task.id,
      category: task.category,
      condition: "direct_control",
      repetition,
      success,
      timeMs: Date.now() - start,
      // Condition A: "each selection or browser action requires an explicit
      // switch/BCI-like event" (spec section 15) - one control event per step.
      controlEvents: task.steps.length,
      agentSteps: task.steps.length,
      confirmations: 0,
      detail,
    };
  }

  async runAgenticIntentControl(task: BenchmarkTask, repetition = 1): Promise<RunMetrics> {
    const start = Date.now();
    let success = false;
    let detail: string | undefined;
    let controlEvents = 1; // the one sparse EXECUTE_GOAL intent
    let confirmations = 0;
    let lastResult: ActionResult | undefined;

    try {
      const planner = new StubPlanner(taskGoalRules());
      const gateway = new SafetyGateway(
        this.tier1AutoApproveConfidence === undefined
          ? {}
          : { tier1AutoApproveConfidence: this.tier1AutoApproveConfidence },
      );
      const intent: IntentEvent = createIntentEvent({
        source: "benchmark.sim",
        intent: IntentCommand.EXECUTE_GOAL,
        concepts: task.concepts,
        confidence: task.confidence,
        requires_confirmation: false,
        signal_provenance: { decoder: "benchmark-v1", session: "benchmark" },
      });

      const plan = await planner.plan(intent, {});
      if (!plan) {
        throw new Error(`planner could not form a plan from task "${task.id}"'s own concepts`);
      }

      const decision = gateway.submitPlan(plan, intent);
      if (decision.kind === "refused") {
        throw new Error(`gateway refused the plan: ${decision.reason}`);
      }

      let stepsToRun = plan.steps;
      if (decision.kind === "needs_confirmation") {
        // Always-cooperative simulated user (spec Condition B: "one sparse goal plus
        // confirmations allows the agent to perform multiple reversible steps").
        controlEvents += 1;
        confirmations += 1;
        const confirmedPlan = gateway.confirm();
        if (!confirmedPlan) {
          throw new Error("gateway.confirm() returned null for a plan it just reported pending");
        }
        stepsToRun = confirmedPlan.steps;
      }

      for (const step of stepsToRun) {
        lastResult = await this.executor.execute(step);
        if (!lastResult.ok) {
          detail = `step "${step.description}" failed: ${lastResult.detail}`;
          break;
        }
      }
      success = await task.verify(this.executor, lastResult);
    } catch (err) {
      detail = describeError(err);
    }

    return {
      taskId: task.id,
      category: task.category,
      condition: "agentic_intent_control",
      repetition,
      success,
      timeMs: Date.now() - start,
      agentSteps: task.steps.length,
      controlEvents,
      confirmations,
      detail,
    };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
