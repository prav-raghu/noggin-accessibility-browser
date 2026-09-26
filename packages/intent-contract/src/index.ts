/**
 * Intent Event Contract (spec section 9) and Agent Execution Model (spec section 10).
 *
 * This is the one schema every layer of the pipeline agrees on:
 *   simulated-bci -> agent-planner -> safety-gateway -> browser-executor -> audit-log
 *
 * Keep this package free of dependencies on any other @noggin/* package - everything
 * downstream depends on it, not the other way around.
 */
import { z } from "zod";

/* ------------------------------------------------------------------------------------
 * Intent Event Contract
 * ---------------------------------------------------------------------------------- */

/**
 * Small, closed command vocabulary. The decoder does not need to produce natural
 * language - see spec section 7's "key design choice". New commands should stay this
 * deliberately narrow.
 */
export const IntentCommand = {
  /** Sparse goal expression, e.g. concepts: ["youtube", "avgn", "season 9"]. */
  EXECUTE_GOAL: "EXECUTE_GOAL",
  /** Highly reliable cancel signal (spec section 6, section 11 "deterministic STOP"). */
  STOP: "STOP",
  /** Binary approve of a proposed action (spec section 6). */
  CONFIRM: "CONFIRM",
  /** Binary reject of a proposed action. */
  REJECT: "REJECT",
  /** "What do you believe I intend?" (spec section 6). */
  QUERY_INTENT: "QUERY_INTENT",
  /** Undo the last reversible action (spec section 12). */
  UNDO: "UNDO",
} as const;
export type IntentCommand = (typeof IntentCommand)[keyof typeof IntentCommand];

export const IntentCommandSchema = z.enum([
  IntentCommand.EXECUTE_GOAL,
  IntentCommand.STOP,
  IntentCommand.CONFIRM,
  IntentCommand.REJECT,
  IntentCommand.QUERY_INTENT,
  IntentCommand.UNDO,
]);

export const SignalProvenanceSchema = z.object({
  /** Which decoder model/version produced this event, e.g. "motor-imagery-v1". */
  decoder: z.string().min(1),
  /** Local session identifier - never a cross-session or cross-user identifier. */
  session: z.string().min(1),
});
export type SignalProvenance = z.infer<typeof SignalProvenanceSchema>;

/**
 * The exact wire shape from spec section 9, plus a required `id` so downstream layers
 * (safety gateway, audit log) can reference "the event that authorized this action"
 * without relying on timestamp uniqueness.
 */
export const IntentEventSchema = z.object({
  id: z.string().min(1),
  /** e.g. "eeg.openbci", "sim.keyboard", "switch.single". Identifies the input adapter. */
  source: z.string().min(1),
  intent: IntentCommandSchema,
  /** Structured concept tokens - not free-form natural language. */
  concepts: z.array(z.string().min(1)).default([]),
  /** Decoder confidence in [0, 1]. Low confidence must trigger clarification, not action. */
  confidence: z.number().min(0).max(1),
  /** ISO 8601 timestamp. */
  timestamp: z.string().datetime({ offset: true }),
  /** Decoder-suggested confirmation requirement; the safety gateway may still upgrade this. */
  requires_confirmation: z.boolean(),
  signal_provenance: SignalProvenanceSchema,
});
export type IntentEvent = z.infer<typeof IntentEventSchema>;

/** Convenience constructor: fills `id`/`timestamp`, still validates the result. */
export function createIntentEvent(
  input: Omit<IntentEvent, "id" | "timestamp"> & { id?: string; timestamp?: string },
): IntentEvent {
  const event: IntentEvent = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  return IntentEventSchema.parse(event);
}

/* ------------------------------------------------------------------------------------
 * Agent Execution Model / Risk tiers (spec section 10)
 * ---------------------------------------------------------------------------------- */

export const RiskTier = {
  /** Tier 0 - Observe: read page, summarize, inspect accessibility tree. */
  OBSERVE: 0,
  /** Tier 1 - Reversible navigation: open tab, search, play/pause media, scroll. */
  REVERSIBLE_NAVIGATION: 1,
  /** Tier 2 - Communication: send message, submit form, post content. */
  COMMUNICATION: 2,
  /** Tier 3 - Consequential: purchase, account deletion, change permissions. */
  CONSEQUENTIAL: 3,
  /** Tier 4 - Prohibited/unsupported: unbounded financial transfer or unsafe action. */
  PROHIBITED: 4,
} as const;
export type RiskTier = (typeof RiskTier)[keyof typeof RiskTier];

export interface RiskTierInfo {
  tier: RiskTier;
  label: string;
  examples: string;
  defaultBehavior: string;
}

/** Verbatim from the spec's Agent Execution Model table (section 10). */
export const RISK_TIER_INFO: Record<RiskTier, RiskTierInfo> = {
  [RiskTier.OBSERVE]: {
    tier: RiskTier.OBSERVE,
    label: "Observe",
    examples: "Read page, summarize, inspect accessibility tree",
    defaultBehavior: "No confirmation",
  },
  [RiskTier.REVERSIBLE_NAVIGATION]: {
    tier: RiskTier.REVERSIBLE_NAVIGATION,
    label: "Reversible navigation",
    examples: "Open tab, search, play/pause media, scroll",
    defaultBehavior: "Automatic above confidence threshold",
  },
  [RiskTier.COMMUNICATION]: {
    tier: RiskTier.COMMUNICATION,
    label: "Communication",
    examples: "Send message, submit form, post content",
    defaultBehavior: "Preview + explicit confirmation",
  },
  [RiskTier.CONSEQUENTIAL]: {
    tier: RiskTier.CONSEQUENTIAL,
    label: "Consequential",
    examples: "Purchase, account deletion, change permissions",
    defaultBehavior: "Strong confirmation; preferably independent channel",
  },
  [RiskTier.PROHIBITED]: {
    tier: RiskTier.PROHIBITED,
    label: "Prohibited/unsupported",
    examples: "Unbounded financial transfer or unsafe action",
    defaultBehavior: "Refuse or require external trusted workflow",
  },
};

/* ------------------------------------------------------------------------------------
 * Browser actions and plans
 * ---------------------------------------------------------------------------------- */

export const BrowserActionType = {
  NAVIGATE: "navigate",
  SEARCH: "search",
  CLICK_BY_ROLE: "click_by_role",
  FILL_FIELD: "fill_field",
  PLAY_PAUSE_MEDIA: "play_pause_media",
  SCROLL: "scroll",
  READ_PAGE: "read_page",
  SUMMARIZE_PAGE: "summarize_page",
  SUBMIT_FORM: "submit_form",
  SEND_MESSAGE: "send_message",
  PURCHASE: "purchase",
  DELETE_ACCOUNT: "delete_account",
  CHANGE_PERMISSIONS: "change_permissions",
} as const;
export type BrowserActionType = (typeof BrowserActionType)[keyof typeof BrowserActionType];

/** Default risk tier per action type. Planners may not downgrade these - see
 * `planRiskTier`, which clamps every step to this floor regardless of what a planner
 * (especially a non-deterministic LLM one) claims. */
export const DEFAULT_ACTION_RISK: Record<BrowserActionType, RiskTier> = {
  [BrowserActionType.READ_PAGE]: RiskTier.OBSERVE,
  [BrowserActionType.SUMMARIZE_PAGE]: RiskTier.OBSERVE,
  [BrowserActionType.NAVIGATE]: RiskTier.REVERSIBLE_NAVIGATION,
  [BrowserActionType.SEARCH]: RiskTier.REVERSIBLE_NAVIGATION,
  [BrowserActionType.PLAY_PAUSE_MEDIA]: RiskTier.REVERSIBLE_NAVIGATION,
  [BrowserActionType.SCROLL]: RiskTier.REVERSIBLE_NAVIGATION,
  [BrowserActionType.CLICK_BY_ROLE]: RiskTier.REVERSIBLE_NAVIGATION,
  // Typing into a field is reversible and sends nothing to the page's server by
  // itself - the eventual submit_form/send_message step is what's gated. This is what
  // lets a login-style plan auto-fill credentials but still pause for confirmation
  // before they're actually transmitted.
  [BrowserActionType.FILL_FIELD]: RiskTier.REVERSIBLE_NAVIGATION,
  [BrowserActionType.SEND_MESSAGE]: RiskTier.COMMUNICATION,
  [BrowserActionType.SUBMIT_FORM]: RiskTier.COMMUNICATION,
  [BrowserActionType.PURCHASE]: RiskTier.CONSEQUENTIAL,
  [BrowserActionType.DELETE_ACCOUNT]: RiskTier.CONSEQUENTIAL,
  [BrowserActionType.CHANGE_PERMISSIONS]: RiskTier.CONSEQUENTIAL,
};

export const BrowserActionSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    BrowserActionType.NAVIGATE,
    BrowserActionType.SEARCH,
    BrowserActionType.CLICK_BY_ROLE,
    BrowserActionType.FILL_FIELD,
    BrowserActionType.PLAY_PAUSE_MEDIA,
    BrowserActionType.SCROLL,
    BrowserActionType.READ_PAGE,
    BrowserActionType.SUMMARIZE_PAGE,
    BrowserActionType.SUBMIT_FORM,
    BrowserActionType.SEND_MESSAGE,
    BrowserActionType.PURCHASE,
    BrowserActionType.DELETE_ACCOUNT,
    BrowserActionType.CHANGE_PERMISSIONS,
  ]),
  /** Free-form parameters for the executor, e.g. { url }, { query }, { role, name }. */
  params: z.record(z.string(), z.unknown()).default({}),
  riskTier: z.number().int().min(0).max(4),
  /** Human-readable sentence for "Explain what you are about to do" (spec section 12). */
  description: z.string().min(1),
});
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

export const PlanSchema = z.object({
  id: z.string().min(1),
  /** The IntentEvent.id this plan was derived from - required for audit provenance. */
  sourceIntentId: z.string().min(1),
  /** Human-readable interpreted goal, e.g. "Open YouTube and play the AVGN Season 9 playlist". */
  goal: z.string().min(1),
  steps: z.array(BrowserActionSchema).min(1),
});
export type Plan = z.infer<typeof PlanSchema>;

/**
 * Highest risk tier across a plan's steps - what the safety gateway gates on.
 *
 * Each step is clamped to at least `DEFAULT_ACTION_RISK[step.type]` first: a planner
 * (especially a tool-calling LLM) proposes a plan, it does not authorize one, so it must
 * never be able to talk its way into a lower risk tier for an action type than the
 * table says that type actually is.
 */
export function planRiskTier(plan: Plan): RiskTier {
  return plan.steps.reduce<RiskTier>((max, step) => {
    const effective = Math.max(step.riskTier, DEFAULT_ACTION_RISK[step.type]) as RiskTier;
    return effective > max ? effective : max;
  }, RiskTier.OBSERVE);
}

/* ------------------------------------------------------------------------------------
 * Agent state (spec section 12: "listening, paused, planning or acting")
 * ---------------------------------------------------------------------------------- */

export const AgentState = {
  LISTENING: "listening",
  PLANNING: "planning",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  ACTING: "acting",
  /** A mid-plan bot-check/CAPTCHA challenge was detected that only a person can
   * complete (see BrowserExecutor.detectChallenge) - execution is paused, not failed,
   * and resumes once the person clears it and chooses "Continue". */
  AWAITING_MANUAL_ACTION: "awaiting_manual_action",
  PAUSED: "paused",
  STOPPED: "stopped",
} as const;
export type AgentState = (typeof AgentState)[keyof typeof AgentState];
