/**
 * Agent planner: spec architecture layer 5 ("Infer goal, plan steps, ask clarification
 * where needed"). Only ever invoked for EXECUTE_GOAL / QUERY_INTENT intents - STOP,
 * CONFIRM, REJECT and UNDO are handled deterministically by the orchestrator and the
 * safety gateway and must never route through a planner (spec section 11: "the system
 * must maintain a deterministic STOP pathway that bypasses the LLM").
 *
 * `Planner` is the seam for milestone M1 ("LLM can navigate a controlled task set").
 * `StubPlanner` is a rule-based placeholder so the rest of the pipeline (safety
 * gateway, executor, audit log, feedback UI) can be built and tested with zero
 * external API calls or cost. A real implementation (local or cloud LLM with tool
 * calling, per the spec's suggested stack) only needs to satisfy this interface.
 */
import {
  BrowserActionType,
  DEFAULT_ACTION_RISK,
  type BrowserAction,
  type IntentEvent,
  type Plan,
} from "@noggin/intent-contract";

/** Spec architecture layer 4 output: whatever the context composer hands the planner. */
export interface PlanningContext {
  currentUrl?: string;
  pageTitle?: string;
}

export interface Planner {
  /**
   * Returns a Plan, or null if the planner cannot form one confidently enough and the
   * orchestrator should ask the user for clarification instead of guessing.
   */
  plan(intent: IntentEvent, context: PlanningContext): Promise<Plan | null>;
}

let planCounter = 0;
let actionCounter = 0;
function nextPlanId(): string {
  planCounter += 1;
  return `plan-${planCounter}`;
}
function nextActionId(): string {
  actionCounter += 1;
  return `action-${actionCounter}`;
}

function action(
  type: BrowserActionType,
  params: Record<string, unknown>,
  description: string,
): BrowserAction {
  return {
    id: nextActionId(),
    type,
    params,
    riskTier: DEFAULT_ACTION_RISK[type],
    description,
  };
}

/** One entry in the StubPlanner's small rule table. */
export interface GoalRule {
  /** Human name, used in the interpreted goal string. */
  name: string;
  /** All of these concept tokens must be present (case-insensitive) to match. */
  requiredConcepts: string[];
  build: (concepts: string[]) => BrowserAction[];
}

const GOAL_RULES: GoalRule[] = [
  {
    // Mirrors the spec section 7 worked example exactly.
    name: "Open YouTube and play the requested video/playlist",
    requiredConcepts: ["youtube"],
    build: (concepts) => {
      const query = concepts.filter((c) => c.toLowerCase() !== "youtube").join(" ");
      return [
        action(BrowserActionType.NAVIGATE, { url: "https://www.youtube.com" }, "Navigate to youtube.com"),
        action(BrowserActionType.SEARCH, { query }, `Search YouTube for "${query}"`),
        action(
          BrowserActionType.CLICK_BY_ROLE,
          { role: "link", nameContains: query },
          "Resolve the most likely playlist/official result and present it",
        ),
        action(BrowserActionType.PLAY_PAUSE_MEDIA, { action: "play" }, "Start playback on confirmation"),
      ];
    },
  },
  {
    name: "Check the weather",
    requiredConcepts: ["weather"],
    build: (concepts) => {
      const query = concepts.join(" ");
      return [
        action(
          BrowserActionType.NAVIGATE,
          { url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}` },
          `Search the web for "${query}"`,
        ),
        action(BrowserActionType.SUMMARIZE_PAGE, {}, "Summarize the weather result for the user"),
      ];
    },
  },
];

/**
 * Deterministic, keyword-matching planner. Not a general-purpose agent - it exists so
 * the pipeline is runnable end-to-end today. Swap in an LLM-backed Planner (tool
 * calling over BrowserActionType) once M1 needs open-ended tasks.
 */
export class StubPlanner implements Planner {
  /**
   * Rules checked before the built-in table, in order. Lets callers that need their own
   * closed task set (e.g. the benchmark harness's fixture tasks) extend the planner
   * without forking it or reaching into its private rule table.
   */
  private readonly rules: GoalRule[];

  constructor(extraRules: GoalRule[] = []) {
    this.rules = [...extraRules, ...GOAL_RULES];
  }

  async plan(intent: IntentEvent, _context: PlanningContext): Promise<Plan | null> {
    const lowerConcepts = intent.concepts.map((c) => c.toLowerCase());

    const rule = this.rules.find((r) =>
      r.requiredConcepts.every((required) => lowerConcepts.includes(required)),
    );

    if (rule) {
      const steps = rule.build(intent.concepts);
      return {
        id: nextPlanId(),
        sourceIntentId: intent.id,
        goal: rule.name,
        steps,
      };
    }

    if (intent.concepts.length === 0) {
      // Nothing to plan from - ask for clarification rather than guessing (spec
      // principle: "Confidence-aware execution ... low-confidence intent should
      // trigger clarification rather than action").
      return null;
    }

    // Generic fallback: treat the concepts as a web search query.
    const query = intent.concepts.join(" ");
    return {
      id: nextPlanId(),
      sourceIntentId: intent.id,
      goal: `Search the web for "${query}"`,
      steps: [
        action(
          BrowserActionType.NAVIGATE,
          { url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}` },
          `Search the web for "${query}"`,
        ),
        action(BrowserActionType.READ_PAGE, {}, "Read back the top result to the user"),
      ],
    };
  }
}
