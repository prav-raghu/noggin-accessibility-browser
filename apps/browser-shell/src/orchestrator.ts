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
  type BrowserAction,
  type IntentEvent,
  type Plan,
} from "@noggin/intent-contract";
import { StubPlanner, type Planner } from "@noggin/agent-planner";
import { SafetyGateway, type GatewayDecision } from "@noggin/safety-gateway";
import { BrowserExecutor, type ActionResult, type ChallengeInfo } from "@noggin/browser-executor";
import { AuditEventType, type AuditStore } from "@noggin/audit-log";
import { SimulatedBciAdapter } from "@noggin/simulated-bci";
import { OnscreenKeyboard, type OnscreenKeyboardState } from "./onscreen-keyboard.js";

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
  keyboard: OnscreenKeyboardState;
}

type UpdateListener = (update: OrchestratorUpdate) => void;

export interface OrchestratorConfig {
  sessionId: string;
  planner?: Planner;
  gateway?: SafetyGateway;
  executor: BrowserExecutor;
  audit: AuditStore;
  bci: SimulatedBciAdapter;
  onscreenKeyboard?: OnscreenKeyboard;
}

export class Orchestrator {
  readonly planner: Planner;
  readonly gateway: SafetyGateway;
  readonly executor: BrowserExecutor;
  readonly audit: AuditStore;
  readonly bci: SimulatedBciAdapter;
  readonly onscreenKeyboard: OnscreenKeyboard;
  private readonly sessionId: string;

  private state: AgentState = AgentState.LISTENING;
  private lastIntent?: IntentEvent;
  private lastGoalIntent?: IntentEvent;
  private lastPlan: Plan | null = null;
  private lastDecision?: GatewayDecision;
  private lastActionResult?: ActionResult;
  private confirmationTimer?: NodeJS.Timeout;
  /** Set when a plan's execution is halted mid-way by a detected bot-check challenge
   * (see runSteps) - holds exactly what's needed to resume from where it stopped. */
  private pausedForManualAction: { plan: Plan; remainingSteps: BrowserAction[] } | null = null;
  private readonly listeners = new Set<UpdateListener>();

  constructor(config: OrchestratorConfig) {
    this.sessionId = config.sessionId;
    this.planner = config.planner ?? new StubPlanner();
    this.gateway = config.gateway ?? new SafetyGateway();
    this.executor = config.executor;
    this.audit = config.audit;
    this.bci = config.bci;
    this.onscreenKeyboard = config.onscreenKeyboard ?? new OnscreenKeyboard();

    this.bci.on("intent", (event) => {
      void this.handleIntent(event);
    });

    this.onscreenKeyboard.on((event) => {
      if (event.type === "state") {
        this.publish();
        return;
      }
      if (event.type === "cancelled") {
        this.publish("onscreen keyboard: composition cancelled");
        return;
      }
      // "done": feed the composed text through exactly the same EXECUTE_GOAL path the
      // control panel's free-text box uses (server.ts) - a BCI-only user typing a goal
      // via the scanning keyboard is handled identically to one typed on a physical
      // keyboard from here on.
      const text = event.text.trim();
      this.publish(`onscreen keyboard: composed "${text}"`);
      if (text.length > 0) {
        this.bci.trigger(IntentCommand.EXECUTE_GOAL, text.split(/\s+/), { confidence: 1 });
      }
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
      keyboard: this.onscreenKeyboard.getState(),
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
    await this.runSteps(plan, plan.steps);
  }

  /**
   * Runs `steps` (either a whole plan, or - via `continueAfterManualAction` - whatever
   * was left after a pause) in order. After each successfully executed step, checks for
   * a bot-check/CAPTCHA challenge (`BrowserExecutor.detectChallenge`) that only a person
   * can complete; if one is showing, execution halts right there (not failed) and
   * `pausedForManualAction` records exactly what's left to run once it's cleared.
   */
  private async runSteps(plan: Plan, steps: readonly BrowserAction[]): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      try {
        // `resolveParams` lets a planner (e.g. LlmPlanner) substitute a redacted
        // credential placeholder back to its real value for the live call only - the
        // audit log and feedback UI below must keep logging/publishing `step` itself
        // (placeholder intact), never a resolved copy, or a secret would land on disk.
        const resolvedParams = this.planner.resolveParams?.(step) ?? step.params;
        const liveAction = resolvedParams === step.params ? step : { ...step, params: resolvedParams };
        const executed = await this.executor.execute(liveAction);
        const result = executed.action === step ? executed : { ...executed, action: step };
        this.lastActionResult = result;
        await this.audit.record({
          type: AuditEventType.EXECUTED_ACTION,
          sessionId: this.sessionId,
          payload: result,
        });
        this.publish(result.detail);
        if (!result.ok) return;

        const challenge = await this.detectChallenge();
        if (challenge.requiresManualAction) {
          this.pausedForManualAction = { plan, remainingSteps: steps.slice(i + 1) };
          this.setState(
            AgentState.AWAITING_MANUAL_ACTION,
            `a ${challenge.provider ?? "bot-check"} challenge appeared that only a person can complete - ` +
              `solve it in the browser window (requires headed mode - see README), then choose Continue`,
          );
          return;
        }
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

  /** Never lets a failure here take down plan execution - this is a best-effort safety
   * check, not a required step. A plain `.catch()` on the call wouldn't be enough: it
   * only guards a promise rejection, not a synchronous throw (e.g. a test double or
   * other executor that doesn't implement detectChallenge at all). */
  private async detectChallenge(): Promise<ChallengeInfo> {
    try {
      return await this.executor.detectChallenge();
    } catch {
      return { present: false, requiresManualAction: false };
    }
  }

  /**
   * "I've handled it - Continue" after an AWAITING_MANUAL_ACTION pause. Re-checks first:
   * a person clicking Continue before actually finishing the challenge is a real thing
   * that will happen, and re-running the same detection is cheap and precise.
   */
  async continueAfterManualAction(): Promise<void> {
    if (!this.pausedForManualAction) {
      this.publish("nothing paused on a manual challenge");
      return;
    }
    const challenge = await this.detectChallenge();
    if (challenge.requiresManualAction) {
      this.publish(`still detecting a ${challenge.provider ?? "bot-check"} challenge - please finish it first`);
      return;
    }
    const { plan, remainingSteps } = this.pausedForManualAction;
    this.pausedForManualAction = null;
    if (remainingSteps.length === 0) {
      this.setState(AgentState.LISTENING, `done: ${plan.goal}`);
      return;
    }
    this.setState(AgentState.ACTING, `resuming: ${plan.goal}`);
    await this.runSteps(plan, remainingSteps);
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
    this.pausedForManualAction = null;
    this.onscreenKeyboard.deactivate();
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

  /** Show/hide the scanning onscreen keyboard. While active it takes over CONFIRM/
   * REJECT (see handleIntent) - a person composing text and a plan waiting on
   * confirmation can't both claim the same binary signal at once, so the plan just
   * waits until the keyboard is closed. */
  toggleOnscreenKeyboard(): void {
    if (this.onscreenKeyboard.getState().active) {
      this.onscreenKeyboard.deactivate();
    } else {
      this.onscreenKeyboard.activate();
    }
  }

  /**
   * The "CONFIRM" signal - IntentCommand.CONFIRM via handleIntent, the 'y' keyboard
   * shortcut, or the control panel's Confirm button all end up here. While the onscreen
   * keyboard is active it claims this signal for "select the highlighted row/key"
   * instead - a plan still waiting on confirmation just keeps waiting (never silently
   * resolved) until the keyboard is closed. Checked here rather than in handleIntent so
   * every entry point gets the same behavior, not just the ones that route through it.
   */
  async confirmPending(): Promise<void> {
    if (this.onscreenKeyboard.getState().active) {
      this.onscreenKeyboard.select();
      return;
    }
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

  /** The "REJECT" signal - see confirmPending's note on why the keyboard-active check
   * lives here rather than in handleIntent. */
  async rejectPending(reason: string): Promise<void> {
    if (this.onscreenKeyboard.getState().active) {
      this.onscreenKeyboard.cancel();
      return;
    }
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
      keyboard: this.onscreenKeyboard.getState(),
    };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
