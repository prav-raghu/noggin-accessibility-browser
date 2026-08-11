/**
 * The orchestrator is spec architecture layer 4 (context composer) plus the glue that
 * wires every other layer together:
 *
 *   simulated-bci --intent--> orchestrator --context--> agent-planner
 *                                  |                         |
 *                                  |<--------- plan ---------+
 *                                  v
 *                            safety-gateway
 *                                  |
 *                    approved / needs_confirmation / refused
 *                                  v
 *                           browser-executor  ---->  audit-log
 *
 * It has no HTTP/WebSocket knowledge of its own - `server.ts` subscribes via
 * `onUpdate()` and forwards control messages in via the public methods below. That
 * keeps the pipeline testable without spinning up a server.
 */
import {
  AgentState,
  IntentCommand,
  planRiskTier,
  type IntentEvent,
  type Plan,
} from "@noggin/intent-contract";
import { StubPlanner, type Planner } from "@noggin/agent-planner";
import { SafetyGateway, type GatewayDecision } from "@noggin/safety-gateway";
import { BrowserExecutor, type ActionResult } from "@noggin/browser-executor";
import { AuditEventType, type AuditStore } from "@noggin/audit-log";
import { SimulatedBciAdapter } from "@noggin/simulated-bci";

/**
 * How long a needs_confirmation plan waits before the confirmation window elapses.
 * Per spec section 12, elapsing must CANCEL the plan, never silently approve it.
 */
const CONFIRMATION_TIMEOUT_MS = 20_000;

export interface OrchestratorUpdate {
  state: AgentState;
  lastIntent?: IntentEvent;
  lastPlan?: Plan | null;
  lastDecision?: GatewayDecision;
  lastActionResult?: ActionResult;
  message?: string;
}

type UpdateListener = (update: OrchestratorUpdate) => void;

export interface OrchestratorConfig {
  sessionId: string;
  planner?: Planner;
  gateway?: SafetyGateway;
  executor: BrowserExecutor;
  audit: AuditStore;
  bci: SimulatedBciAdapter;
}

export class Orchestrator {
  readonly planner: Planner;
  readonly gateway: SafetyGateway;
  readonly executor: BrowserExecutor;
  readonly audit: AuditStore;
  readonly bci: SimulatedBciAdapter;
  private readonly sessionId: string;

  private state: AgentState = AgentState.LISTENING;
  private lastIntent?: IntentEvent;
  private lastGoalIntent?: IntentEvent;
  private lastPlan: Plan | null = null;
  private lastDecision?: GatewayDecision;
  private lastActionResult?: ActionResult;
  private confirmationTimer?: NodeJS.Timeout;
  private readonly listeners = new Set<UpdateListener>();

  constructor(config: OrchestratorConfig) {
    this.sessionId = config.sessionId;
    this.planner = config.planner ?? new StubPlanner();
    this.gateway = config.gateway ?? new SafetyGateway();
    this.executor = config.executor;
    this.audit = config.audit;
    this.bci = config.bci;

    this.bci.on("intent", (event) => {
      void this.handleIntent(event);
    });
  }

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(message?: string): void {
    const update: OrchestratorUpdate = {
      state: this.state,
      lastIntent: this.lastIntent,
      lastPlan: this.lastPlan,
      lastDecision: this.lastDecision,
      lastActionResult: this.lastActionResult,
      message,
    };
    for (const listener of this.listeners) listener(update);
  }

  private setState(state: AgentState, message?: string): void {
    this.state = state;
    this.publish(message);
  }

  /* -------------------------------------------------------------------------------
   * Intent handling (spec section 6 user stories map directly onto these branches)
   * ----------------------------------------------------------------------------- */

  async handleIntent(intent: IntentEvent): Promise<void> {
    this.lastIntent = intent;
    await this.audit.record({
      type: AuditEventType.NEURAL_INTENT,
      sessionId: this.sessionId,
      payload: intent,
    });

    switch (intent.intent) {
      case IntentCommand.STOP:
        return this.stop();
      case IntentCommand.CONFIRM:
        return this.confirmPending();
      case IntentCommand.REJECT:
        return this.rejectPending("user rejected");
      case IntentCommand.UNDO:
        return this.undo();
      case IntentCommand.QUERY_INTENT:
        return this.explainBelief();
      case IntentCommand.EXECUTE_GOAL:
        return this.executeGoal(intent);
      default: {
        const exhaustive: never = intent.intent;
        throw new Error(`Unhandled intent command: ${exhaustive}`);
      }
    }
  }

  private async executeGoal(intent: IntentEvent): Promise<void> {
    if (this.gateway.getMode() !== "active") {
      this.publish(`ignored EXECUTE_GOAL: gateway is ${this.gateway.getMode()}`);
      return;
    }

    this.lastGoalIntent = intent;
    this.setState(AgentState.PLANNING, "inferring goal from intent");

    const pageContext = await this.executor.getPageContext().catch(() => undefined);
    const plan = await this.planner.plan(intent, {
      currentUrl: pageContext?.url,
      pageTitle: pageContext?.title,
    });

    await this.audit.record({
      type: AuditEventType.PLANNER_INTERPRETATION,
      sessionId: this.sessionId,
      payload: plan,
    });

    this.lastPlan = plan;

    if (!plan) {
      this.setState(
        AgentState.LISTENING,
        "could not form a confident plan from that intent - please restate the goal",
      );
      return;
    }

    const decision = this.gateway.submitPlan(plan, intent);
    this.lastDecision = decision;
    await this.audit.record({
      type: AuditEventType.GATEWAY_DECISION,
      sessionId: this.sessionId,
      payload: decision,
    });

    if (decision.kind === "approved") {
      await this.runPlan(plan);
      return;
    }

    if (decision.kind === "refused") {
      this.setState(AgentState.LISTENING, `refused: ${decision.reason}`);
      return;
    }

    // needs_confirmation
    this.setState(
      AgentState.AWAITING_CONFIRMATION,
      `awaiting confirmation (risk tier ${planRiskTier(plan)}): ${decision.reason}`,
    );
    this.armConfirmationTimeout(plan.id);
  }

  private armConfirmationTimeout(planId: string): void {
    if (this.confirmationTimer) clearTimeout(this.confirmationTimer);
    this.confirmationTimer = setTimeout(() => {
      const pending = this.gateway.getPending();
      // Only expire if it's still the same plan - a fast CONFIRM/REJECT already
      // resolved it, and we must never cancel a *different*, newer pending plan.
      if (pending && pending.plan.id === planId) {
        this.gateway.expirePendingConfirmation();
        void this.audit.record({
          type: AuditEventType.CONFIRMATION,
          sessionId: this.sessionId,
          payload: { outcome: "expired", planId },
        });
        this.setState(AgentState.LISTENING, "confirmation window elapsed - action cancelled");
      }
    }, CONFIRMATION_TIMEOUT_MS);
  }

  private async runPlan(plan: Plan): Promise<void> {
    this.setState(AgentState.ACTING, `executing: ${plan.goal}`);
    for (const step of plan.steps) {
      try {
        const result = await this.executor.execute(step);
        this.lastActionResult = result;
        await this.audit.record({
          type: AuditEventType.EXECUTED_ACTION,
          sessionId: this.sessionId,
          payload: result,
        });
        this.publish(result.detail);
        if (!result.ok) break;
      } catch (err) {
        await this.audit.record({
          type: AuditEventType.EXECUTED_ACTION,
          sessionId: this.sessionId,
          payload: { step, error: err instanceof Error ? err.message : String(err) },
        });
        this.setState(AgentState.LISTENING, `action failed: ${describeError(err)}`);
        return;
      }
    }
    this.setState(AgentState.LISTENING, `done: ${plan.goal}`);
  }

  /* -------------------------------------------------------------------------------
   * Deterministic controls - all reachable directly from the feedback UI too, not
   * only via IntentEvent, since STOP/pause must work even if the BCI channel itself
   * is misbehaving.
   * ----------------------------------------------------------------------------- */

  stop(): void {
    if (this.confirmationTimer) clearTimeout(this.confirmationTimer);
    this.gateway.stop();
    this.lastPlan = null;
    this.setState(AgentState.STOPPED, "stopped");
  }

  pause(): void {
    this.gateway.pause();
    this.setState(AgentState.PAUSED, "paused");
  }

  resume(): void {
    this.gateway.resume();
    this.setState(AgentState.LISTENING, "resumed");
  }

  async confirmPending(): Promise<void> {
    const plan = this.gateway.confirm();
    if (this.confirmationTimer) clearTimeout(this.confirmationTimer);
    await this.audit.record({
      type: AuditEventType.CONFIRMATION,
      sessionId: this.sessionId,
      payload: { outcome: "confirmed", planId: plan?.id },
    });
    if (!plan) {
      this.publish("nothing pending to confirm");
      return;
    }
    await this.runPlan(plan);
  }

  async rejectPending(reason: string): Promise<void> {
    const plan = this.gateway.reject(reason);
    if (this.confirmationTimer) clearTimeout(this.confirmationTimer);
    await this.audit.record({
      type: AuditEventType.CONFIRMATION,
      sessionId: this.sessionId,
      payload: { outcome: "rejected", planId: plan?.id, reason },
    });
    this.setState(AgentState.LISTENING, plan ? `rejected: ${plan.goal}` : "nothing pending to reject");
  }

  /** "Undo last reversible action" (spec section 12). */
  async undo(): Promise<void> {
    const context = await this.executor.goBack();
    this.publish(`undo: navigated back to ${context.url}`);
  }

  /** "Explain what you are about to do" / QUERY_INTENT: preview without executing. */
  private explainBelief(): void {
    const pending = this.gateway.getPending();
    if (pending) {
      this.publish(
        `about to do: ${pending.plan.goal} (${pending.plan.steps.map((s) => s.description).join("; ")})`,
      );
      return;
    }
    if (this.lastGoalIntent) {
      this.publish(
        `last understood goal: concepts=[${this.lastGoalIntent.concepts.join(", ")}] confidence=${this.lastGoalIntent.confidence.toFixed(2)}`,
      );
      return;
    }
    this.publish("no current intent to explain yet");
  }

  getSnapshot(): OrchestratorUpdate {
    return {
      state: this.state,
      lastIntent: this.lastIntent,
      lastPlan: this.lastPlan,
      lastDecision: this.lastDecision,
      lastActionResult: this.lastActionResult,
    };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
