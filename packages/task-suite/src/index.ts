/**
 * Benchmark task suite (spec section 13 step 5, milestone M4): "a benchmark suite of
 * accessibility-oriented browser tasks such as media navigation, search, form
 * completion and information retrieval."
 *
 * Every task is fully self-contained - a `data:` URL fixture page plus a DOM-level
 * success check - so the benchmark harness (`@noggin/benchmark`) never depends on
 * network access or a third party's markup. That keeps runs reproducible (spec section
 * 6: "replay anonymized intent events and agent traces"; section 21: "quantitative
 * analysis ... reproducible research traces"), matching how `browser-executor`'s own
 * tests avoid the network (see `browser-executor.test.ts`'s FIXTURE_URL).
 *
 * Each task supplies:
 *   - `steps`: the canonical low-level BrowserAction sequence. Both experimental
 *     conditions execute exactly this sequence - the only thing that differs between
 *     "direct control" and "agentic intent control" is *how many discrete user control
 *     events it takes to authorize it* (spec section 15's primary measure), not what
 *     the browser ends up doing. That's what keeps the A/B comparison fair.
 *   - `concepts`/`confidence`: the sparse intent a simulated BCI would emit for the
 *     agentic condition.
 *   - `goalRule`: lets the benchmark's StubPlanner turn that sparse intent back into
 *     `steps` (see `@noggin/agent-planner`'s injectable rule table).
 *   - `verify`: task success is checked against real page state after execution, not
 *     assumed from "no errors were thrown".
 */
import type { GoalRule } from "@noggin/agent-planner";
import type { ActionResult, BrowserExecutor } from "@noggin/browser-executor";
import {
  BrowserActionType,
  DEFAULT_ACTION_RISK,
  type BrowserAction,
} from "@noggin/intent-contract";

export type TaskCategory =
  | "media_navigation"
  | "search"
  | "form_completion"
  | "information_retrieval";

export interface BenchmarkTask {
  id: string;
  name: string;
  category: TaskCategory;
  /** Canonical action sequence - see module docs for why both conditions share this. */
  steps: BrowserAction[];
  /** Sparse concept tokens a simulated BCI would emit for this task's goal. */
  concepts: string[];
  /** Decoder confidence to attach to the agentic condition's EXECUTE_GOAL intent. */
  confidence: number;
  /** Matching agent-planner rule so a StubPlanner can turn `concepts` back into `steps`. */
  goalRule: GoalRule;
  /**
   * Inspect real page state (and, where useful, the last step's ActionResult) to decide
   * whether the task actually succeeded - never inferred from "the executor didn't
   * throw".
   */
  verify(executor: BrowserExecutor, lastResult: ActionResult | undefined): Promise<boolean>;
}

let stepCounter = 0;
function step(
  type: BrowserActionType,
  params: Record<string, unknown>,
  description: string,
): BrowserAction {
  stepCounter += 1;
  return {
    id: `task-step-${stepCounter}`,
    type,
    params,
    riskTier: DEFAULT_ACTION_RISK[type],
    description,
  };
}

function dataUrl(html: string): string {
  return "data:text/html," + encodeURIComponent(html);
}

/* ------------------------------------------------------------------------------------
 * Task 1: Media navigation
 * ---------------------------------------------------------------------------------- */

const MEDIA_URL = dataUrl(`
  <html><body>
    <h1>Fixture Media Player</h1>
    <p id="status" data-playing="false">Paused</p>
    <script>
      document.addEventListener('keydown', (e) => {
        if (e.key === 'k') {
          const el = document.getElementById('status');
          const playing = el.getAttribute('data-playing') !== 'true';
          el.setAttribute('data-playing', String(playing));
          el.textContent = playing ? 'Playing' : 'Paused';
        }
      });
    </script>
  </body></html>
`);

const mediaNavigationTask: BenchmarkTask = {
  id: "media_navigation",
  name: "Start media playback",
  category: "media_navigation",
  concepts: ["fixture-media", "play"],
  confidence: 0.9,
  steps: [
    step(BrowserActionType.NAVIGATE, { url: MEDIA_URL }, "Navigate to the media fixture"),
    // No <video> element on this fixture, so browser-executor falls back to the
    // YouTube-style 'k' keyboard shortcut - see browser-executor's PLAY_PAUSE_MEDIA case.
    step(BrowserActionType.PLAY_PAUSE_MEDIA, {}, "Toggle playback"),
  ],
  goalRule: {
    name: "Start media playback",
    requiredConcepts: ["fixture-media"],
    build: () => mediaNavigationTask.steps,
  },
  async verify(executor) {
    return executor.evaluate(
      () => document.getElementById("status")?.getAttribute("data-playing") === "true",
    );
  },
};

/* ------------------------------------------------------------------------------------
 * Task 2: Search
 * ---------------------------------------------------------------------------------- */

const SEARCH_URL = dataUrl(`
  <html><body>
    <h1>Fixture Search</h1>
    <input type="text" role="searchbox" aria-label="Search" id="q" />
    <div id="results"></div>
    <script>
      document.getElementById('q').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          document.getElementById('results').textContent =
            'Results for "' + e.target.value + '": 3 matches found';
        }
      });
    </script>
  </body></html>
`);

const searchTask: BenchmarkTask = {
  id: "search",
  name: "Search the fixture site",
  category: "search",
  concepts: ["fixture-search", "cats"],
  confidence: 0.9,
  steps: [
    step(BrowserActionType.NAVIGATE, { url: SEARCH_URL }, "Navigate to the search fixture"),
    step(BrowserActionType.SEARCH, { query: "cats" }, 'Search for "cats"'),
  ],
  goalRule: {
    name: "Search the fixture site",
    requiredConcepts: ["fixture-search"],
    build: () => searchTask.steps,
  },
  async verify(executor) {
    return executor.evaluate(() =>
      (document.getElementById("results")?.textContent ?? "").includes("3 matches found"),
    );
  },
};

/* ------------------------------------------------------------------------------------
 * Task 3: Form completion
 * ---------------------------------------------------------------------------------- */

const FORM_URL = dataUrl(`
  <html><body>
    <h1>Fixture Form</h1>
    <form>
      <input type="text" role="textbox" aria-label="Full name" id="name" />
      <button type="submit">Submit</button>
    </form>
    <p id="status">not submitted</p>
    <script>
      document.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        document.getElementById('status').textContent =
          'submitted: ' + document.getElementById('name').value;
      });
    </script>
  </body></html>
`);

const formCompletionTask: BenchmarkTask = {
  id: "form_completion",
  name: "Fill in and submit a form",
  category: "form_completion",
  concepts: ["fixture-form", "ada lovelace"],
  confidence: 0.9,
  steps: [
    step(BrowserActionType.NAVIGATE, { url: FORM_URL }, "Navigate to the form fixture"),
    step(
      BrowserActionType.FILL_FIELD,
      { role: "textbox", nameContains: "Full name", value: "Ada Lovelace" },
      'Fill "Full name" with "Ada Lovelace"',
    ),
    step(BrowserActionType.SUBMIT_FORM, {}, "Submit the form"),
  ],
  goalRule: {
    name: "Fill in and submit a form",
    requiredConcepts: ["fixture-form"],
    build: () => formCompletionTask.steps,
  },
  async verify(executor) {
    return executor.evaluate(
      () => document.getElementById("status")?.textContent === "submitted: Ada Lovelace",
    );
  },
};

/* ------------------------------------------------------------------------------------
 * Task 4: Information retrieval
 * ---------------------------------------------------------------------------------- */

const INFO_URL = dataUrl(`
  <html><body>
    <article>
      <h1>Local Facts</h1>
      <p>The capital of Freedonia is Fredonia City, founded in 1932.</p>
    </article>
  </body></html>
`);

const EXPECTED_FACT = "Fredonia City";

const informationRetrievalTask: BenchmarkTask = {
  id: "information_retrieval",
  name: "Read back a fact from the page",
  category: "information_retrieval",
  concepts: ["fixture-facts", "freedonia"],
  confidence: 0.9,
  steps: [
    step(BrowserActionType.NAVIGATE, { url: INFO_URL }, "Navigate to the facts fixture"),
    step(BrowserActionType.READ_PAGE, {}, "Read the page back to the user"),
  ],
  goalRule: {
    name: "Read back a fact from the page",
    requiredConcepts: ["fixture-facts"],
    build: () => informationRetrievalTask.steps,
  },
  async verify(_executor, lastResult) {
    return Boolean(lastResult?.ok && lastResult.detail.includes(EXPECTED_FACT));
  },
};

/* ------------------------------------------------------------------------------------
 * Public surface
 * ---------------------------------------------------------------------------------- */

export const TASKS: BenchmarkTask[] = [
  mediaNavigationTask,
  searchTask,
  formCompletionTask,
  informationRetrievalTask,
];

/** GoalRules for all tasks, ready to hand to `new StubPlanner(taskGoalRules())`. */
export function taskGoalRules(): GoalRule[] {
  return TASKS.map((t) => t.goalRule);
}
