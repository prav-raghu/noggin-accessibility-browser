/**
 * Safety gateway: spec architecture layer 6, and the sharpest safety requirement in
 * section 11: "the agent must never treat webpage text as authorization", "a
 * deterministic STOP pathway that bypasses the LLM", and "no confirmation timeout that
 * silently accepts an action".
 *
 * Everything in this module is synchronous, has no network/model dependency, and is
 * intentionally boring: risk tiering and confirmation are table lookups, not inference.
 * That's the point - the planner (which may one day call an LLM) proposes; this module,
 * not the planner, disposes.
 */
import {
  type IntentEvent,
  type Plan,
  planRiskTier,
  RiskTier,
} from "@noggin/intent-contract";

export type GatewayMode = "active" | "paused" | "stopped";

export type GatewayDecisionKind = "approved" | "needs_confirmation" | "refused";

export interface GatewayDecision {
  kind: GatewayDecisionKind;
  plan: Plan;
  riskTier: RiskTier;
  reason: string;
  /** Tier 3 actions should prefer a second, independent confirmation channel (spec 11). */
  requiresIndependentChannel: boolean;
}

export interface PendingConfirmation {
  plan: Plan;
  riskTier: RiskTier;
  sourceIntentId: string;
  createdAt: string;
  requiresIndependentChannel: boolean;
}

export interface SafetyGatewayConfig {
  /**
   * Minimum decoder confidence (from the IntentEvent that produced the plan) required
   * for Tier 1 (reversible navigation) actions to auto-execute. Below this, the plan
   * still needs confirmation instead of being refused - spec principle: "low-confidence
   * intent should trigger clarification rather than action", not silent failure.
   */
  tier1AutoApproveConfidence?: number;
}

const DEFAULT_CONFIG: Required<SafetyGatewayConfig> = {
  tier1AutoApproveConfidence: 0.7,
};

export type GatewayEvent =
  | { type: "decision"; decision: GatewayDecision }
  | { type: "confirmed"; plan: Plan }
  | { type: "rejected"; plan: Plan; reason: string }
  | { type: "stopped" }
  | { type: "paused" }
  | { type: "resumed" };

type Listener = (event: GatewayEvent) => void;

/**
 * Stateful wrapper around `evaluatePlan`. Tracks gateway mode (active/paused/stopped)
 * and at most one pending confirmation at a time - the spec's UX principle of "2-4
 * alternatives rather than long menus" implies the system shouldn't be juggling
 * multiple simultaneous pending actions for a low-bandwidth user.
 */
export class SafetyGateway {
  private readonly config: Required<SafetyGatewayConfig>;
  private mode: GatewayMode = "active";
  private pending: PendingConfirmation | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(config: SafetyGatewayConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: GatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  getMode(): GatewayMode {
    return this.mode;
  }

  getPending(): PendingConfirmation | null {
    return this.pending;
  }

  /**
   * The deterministic STOP pathway. Bypasses the planner/LLM entirely, clears any
   * pending confirmation, and puts the gateway into a mode where no further plan can
   * be approved until `resume()` is called explicitly (never implicitly by a timeout).
   */
  stop(): void {
    this.mode = "stopped";
    this.pending = null;
    this.emit({ type: "stopped" });
  }

  pause(): void {
    if (this.mode === "stopped") return;
    this.mode = "paused";
    this.pending = null;
    this.emit({ type: "paused" });
  }

  resume(): void {
    this.mode = "active";
    this.emit({ type: "resumed" });
  }

  /**
   * Submit a candidate plan for authorization. Returns the decision synchronously;
   * if the decision is `needs_confirmation`, the plan is held as `pending` until
   * `confirm()`, `reject()` or `expirePendingConfirmation()` is called.
   */
  submitPlan(plan: Plan, sourceIntent: IntentEvent): GatewayDecision {
    if (this.mode !== "active") {
      const decision: GatewayDecision = {
        kind: "refused",
        plan,
        riskTier: planRiskTier(plan),
        reason: `gateway is ${this.mode}; no plan can be authorized until resume()`,
        requiresIndependentChannel: false,
      };
      this.emit({ type: "decision", decision });
      return decision;
    }

    const decision = evaluatePlan(plan, sourceIntent, this.config);
    if (decision.kind === "needs_confirmation") {
      this.pending = {
        plan,
        riskTier: decision.riskTier,
        sourceIntentId: sourceIntent.id,
        createdAt: new Date().toISOString(),
        requiresIndependentChannel: decision.requiresIndependentChannel,
      };
    }
    this.emit({ type: "decision", decision });
    return decision;
  }

  /** Explicit CONFIRM. No-op-with-null-return if there is nothing pending. */
  confirm(): Plan | null {
    if (!this.pending) return null;
    const { plan } = this.pending;
    this.pending = null;
    this.emit({ type: "confirmed", plan });
    return plan;
  }

  /** Explicit REJECT. */
  reject(reason = "user rejected"): Plan | null {
    if (!this.pending) return null;
    const { plan } = this.pending;
    this.pending = null;
    this.emit({ type: "rejected", plan, reason });
    return plan;
  }

  /**
   * Called by a caller-managed timer when a confirmation window elapses. Per spec
   * section 12 this must CANCEL, never silently approve. There is deliberately no
   * "auto-confirm on timeout" code path anywhere in this class.
   */
  expirePendingConfirmation(): Plan | null {
    return this.reject("confirmation window expired");
  }
}

/**
 * Pure decision function - exported separately so it can be unit tested and reasoned
 * about without constructing a stateful gateway.
 */
export function evaluatePlan(
  plan: Plan,
  sourceIntent: IntentEvent,
  config: Required<SafetyGatewayConfig> = DEFAULT_CONFIG,
): GatewayDecision {
  const riskTier = planRiskTier(plan);

  if (riskTier >= RiskTier.PROHIBITED) {
    return {
      kind: "refused",
      plan,
      riskTier,
      reason: "plan contains a Tier 4 (prohibited/unsupported) action",
      requiresIndependentChannel: false,
    };
  }

  if (riskTier === RiskTier.OBSERVE) {
    return {
      kind: "approved",
      plan,
      riskTier,
      reason: "Tier 0 (observe) actions never require confirmation",
      requiresIndependentChannel: false,
    };
  }

  if (riskTier === RiskTier.REVERSIBLE_NAVIGATION) {
    if (sourceIntent.confidence >= config.tier1AutoApproveConfidence) {
      return {
        kind: "approved",
        plan,
        riskTier,
        reason: `Tier 1 (reversible navigation) auto-approved: confidence ${sourceIntent.confidence.toFixed(2)} >= threshold ${config.tier1AutoApproveConfidence}`,
        requiresIndependentChannel: false,
      };
    }
    return {
      kind: "needs_confirmation",
      plan,
      riskTier,
      reason: `Tier 1 confidence ${sourceIntent.confidence.toFixed(2)} below auto-approve threshold ${config.tier1AutoApproveConfidence}; asking for confirmation instead of refusing`,
      requiresIndependentChannel: false,
    };
  }

  if (riskTier === RiskTier.COMMUNICATION) {
    return {
      kind: "needs_confirmation",
      plan,
      riskTier,
      reason: "Tier 2 (communication) always requires preview + explicit confirmation",
      requiresIndependentChannel: false,
    };
  }

  // RiskTier.CONSEQUENTIAL
  return {
    kind: "needs_confirmation",
    plan,
    riskTier,
    reason: "Tier 3 (consequential) requires strong confirmation",
    requiresIndependentChannel: true,
  };
}

export { RiskTier, RISK_TIER_INFO } from "@noggin/intent-contract";
