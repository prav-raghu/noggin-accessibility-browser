/**
 * Browser executor: spec architecture layer 7 ("Read page semantics and perform
 * actions" / "Chrome DevTools Protocol / Playwright / Electron").
 *
 * Uses Playwright to drive Chromium and prefers accessibility-tree-grounded lookups
 * (role + accessible name, via `getByRole`, and raw CDP `Accessibility.getFullAXTree`
 * for observe actions) over coordinate-based interaction - this is what RQ3 in the
 * spec asks the eventual evaluation to test.
 *
 * Tier 2+ actions (send_message, submit_form, purchase, delete_account,
 * change_permissions) intentionally have no generic executor implementation: the spec
 * scopes the MVP benchmark suite to "media navigation, search, form completion and
 * information retrieval" (section 13) and explicitly puts "autonomous high-risk
 * financial transactions" out of scope (section 4). Task-specific execution for those
 * belongs in the benchmark/task layer, not as a generic fallback here.
 */
import { existsSync } from "node:fs";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import { BrowserActionType, type BrowserAction } from "@noggin/intent-contract";

const DEFAULT_EXECUTABLE_PATH = "/opt/pw-browsers/chromium";

export interface BrowserExecutorConfig {
  headless?: boolean;
  /** Defaults to the sandbox-preinstalled Chromium build when present. */
  executablePath?: string;
}

export interface PageContext {
  url: string;
  title: string;
}

export interface ActionResult {
  action: BrowserAction;
  ok: boolean;
  detail: string;
  context: PageContext;
}

export interface ChallengeInfo {
  /** A recognized bot-check widget (checkbox or active challenge) is present anywhere
   * on the page. */
  present: boolean;
  provider?: "recaptcha" | "hcaptcha" | "turnstile";
  /** True only when the widget's own interactive challenge (image grid, audio, puzzle)
   * is actually showing - not just an unclicked checkbox - meaning nothing further can
   * proceed until a person solves it. */
  requiresManualAction: boolean;
}

export class NotImplementedActionError extends Error {
  constructor(actionType: BrowserActionType) {
    super(
      `browser-executor has no generic implementation for "${actionType}" - this is deliberate ` +
        `(spec section 4/13 scopes autonomous MVP execution to observe/navigation/search/form ` +
        `actions). Implement task-specific execution at the benchmark/task layer.`,
    );
    this.name = "NotImplementedActionError";
  }
}

export class BrowserExecutor {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly config: BrowserExecutorConfig;

  constructor(config: BrowserExecutorConfig = {}) {
    this.config = config;
  }

  async launch(): Promise<void> {
    const executablePath =
      this.config.executablePath ??
      (existsSync(DEFAULT_EXECUTABLE_PATH) ? DEFAULT_EXECUTABLE_PATH : undefined);

    this.browser = await chromium.launch({
      headless: this.config.headless ?? true,
      executablePath,
    });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new Error("BrowserExecutor.launch() must be called before use");
    }
    return this.page;
  }

  async getPageContext(): Promise<PageContext> {
    const page = this.requirePage();
    return { url: page.url(), title: await page.title().catch(() => "") };
  }

  /**
   * Raw CDP accessibility tree (Tier 0 "inspect accessibility tree" per spec section
   * 10). Downstream summarization/read_page can walk this rather than scraping text.
   */
  async getAccessibilityTree(): Promise<unknown[]> {
    const page = this.requirePage();
    const cdp: CDPSession = await page.context().newCDPSession(page);
    try {
      await cdp.send("Accessibility.enable");
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      return nodes;
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  async screenshot(): Promise<Buffer> {
    return this.requirePage().screenshot();
  }

  /** Backs the spec section 12 "Undo last reversible action" command for Tier 1 nav. */
  async goBack(): Promise<PageContext> {
    const page = this.requirePage();
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    return this.getPageContext();
  }

  /**
   * Best-effort detection of a bot-check widget on the page, via the `src` attribute of
   * every `<iframe>` - matched against known, publicly documented URL patterns for the
   * major providers, not against network activity, so it works even if the iframe's own
   * cross-origin content hasn't (or can't) finish loading.
   *
   * This deliberately does nothing to solve or bypass a challenge - that's out of scope
   * on principle (it's what these checks exist to prevent, and would violate the
   * target site's terms of service) as well as out of reach technically (there's no
   * BrowserActionType for "read this image grid"). The only thing this enables is
   * `Orchestrator` pausing plan execution and asking a person to complete the challenge
   * in the browser window - which only works when the browser is headed
   * (`NOGGIN_HEADLESS=false`); see README.
   */
  async detectChallenge(): Promise<ChallengeInfo> {
    const page = this.requirePage();
    const iframes = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll("iframe")).map((el) => {
          const rect = el.getBoundingClientRect();
          return { src: el.getAttribute("src") ?? "", visible: rect.width > 4 && rect.height > 4 };
        }),
      )
      .catch(() => [] as Array<{ src: string; visible: boolean }>);

    let present = false;
    let requiresManualAction = false;
    let provider: ChallengeInfo["provider"];

    for (const iframe of iframes) {
      for (const pattern of CHALLENGE_URL_PATTERNS) {
        if (pattern.checkbox.test(iframe.src) || pattern.challenge.test(iframe.src)) {
          present = true;
          provider ??= pattern.provider;
        }
        if (pattern.challenge.test(iframe.src) && iframe.visible) {
          requiresManualAction = true;
          provider = pattern.provider;
        }
      }
    }

    return { present, provider, requiresManualAction };
  }

  /**
   * Execute one BrowserAction and report back a page-context snapshot for the audit
   * log and for the next planning iteration.
   */
  async execute(action: BrowserAction): Promise<ActionResult> {
    const page = this.requirePage();

    switch (action.type) {
      case BrowserActionType.READ_PAGE:
      case BrowserActionType.SUMMARIZE_PAGE: {
        // Extractive stub - no LLM summarization here by design (see package README).
        const text = await page
          .locator("body")
          .innerText()
          .catch(() => "");
        const snippet = text.replace(/\s+/g, " ").trim().slice(0, 400);
        return this.ok(action, `page text (truncated): ${snippet || "(empty)"}`);
      }

      case BrowserActionType.NAVIGATE: {
        const url = requireStringParam(action, "url");
        // Hard guard, not a planner-instruction one: no planner (a hallucinating LLM
        // included) gets to send this executor to a javascript:/file:/chrome: URL just
        // by putting one in a plan's params - spec section 11's "never treat webpage
        // text as authorization" extends to never treating planner output as
        // authorization for an unsafe scheme either. Enforced here, at the one place
        // navigation actually happens, rather than trusted to prompt wording.
        if (!isNavigableUrl(url)) {
          return this.fail(action, `refused to navigate to a non-http(s) URL: ${url}`);
        }
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return this.ok(action, `navigated to ${url}`);
      }

      case BrowserActionType.SEARCH: {
        const query = requireStringParam(action, "query");
        const searchBox = page
          .getByRole("combobox", { name: /search/i })
          .or(page.getByRole("searchbox"))
          .or(page.getByRole("textbox", { name: /search/i }))
          .first();
        await searchBox.fill(query, { timeout: 5000 });
        await searchBox.press("Enter");
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        return this.ok(action, `searched for "${query}"`);
      }

      case BrowserActionType.CLICK_BY_ROLE: {
        const role = requireStringParam(action, "role");
        const nameContains = optionalStringParam(action, "nameContains");
        const name = nameContains ? new RegExp(escapeRegExp(nameContains), "i") : undefined;
        // Checks like reCAPTCHA's "I'm not a robot" checkbox live inside an <iframe>,
        // which page.getByRole() alone never reaches - it only searches the main frame.
        const locator = await firstMatchAcrossFrames(page, (target) =>
          target.getByRole(role as Parameters<Page["getByRole"]>[0], { name }),
        );
        await locator.click({ timeout: 5000 });
        return this.ok(action, `clicked role="${role}"${nameContains ? ` name~="${nameContains}"` : ""}`);
      }

      case BrowserActionType.FILL_FIELD: {
        const value = requireStringParam(action, "value");
        const nameContains = optionalStringParam(action, "nameContains");
        const fieldType = optionalStringParam(action, "fieldType");
        // input[type=password] is deliberately excluded from the ARIA "textbox" role by
        // the HTML-AAM spec, so getByRole("textbox") never matches it - fall back to a
        // CSS locator for that one case instead of pretending role-grounding covers it.
        const locator =
          fieldType === "password"
            ? await firstMatchAcrossFrames(page, (target) => target.locator('input[type="password"]'))
            : await firstMatchAcrossFrames(page, (target) =>
                target.getByRole("textbox", {
                  name: nameContains ? new RegExp(escapeRegExp(nameContains), "i") : undefined,
                }),
              );
        await locator.fill(value, { timeout: 5000 });
        // Never echo a password-field value back into the audit-visible detail string,
        // even though the caller is expected to have already redacted it upstream.
        const shownValue = fieldType === "password" ? "•".repeat(Math.min(value.length, 8)) : value;
        return this.ok(
          action,
          `filled field${nameContains ? ` "${nameContains}"` : ""} with "${shownValue}"`,
        );
      }

      case BrowserActionType.PLAY_PAUSE_MEDIA: {
        const video = page.locator("video").first();
        const hasVideo = (await video.count()) > 0;
        if (hasVideo) {
          await video.evaluate((el: HTMLVideoElement) => (el.paused ? el.play() : el.pause()));
        } else {
          // YouTube-style keyboard shortcut fallback.
          await page.keyboard.press("k");
        }
        return this.ok(action, "toggled media playback");
      }

      case BrowserActionType.SCROLL: {
        const direction = (action.params.direction as string | undefined) ?? "down";
        const amount = (action.params.amount as number | undefined) ?? 600;
        const delta = direction === "up" ? -amount : amount;
        await page.mouse.wheel(0, delta);
        return this.ok(action, `scrolled ${direction} by ${amount}px`);
      }

      case BrowserActionType.SUBMIT_FORM: {
        const form = page.locator("form").first();
        if ((await form.count()) === 0) {
          return this.fail(action, "no form found on page");
        }
        await form.evaluate((el: HTMLFormElement) => el.requestSubmit());
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        return this.ok(action, "submitted form");
      }

      case BrowserActionType.SEND_MESSAGE:
      case BrowserActionType.PURCHASE:
      case BrowserActionType.DELETE_ACCOUNT:
      case BrowserActionType.CHANGE_PERMISSIONS:
        throw new NotImplementedActionError(action.type);

      default: {
        const exhaustiveCheck: never = action.type;
        throw new Error(`Unhandled action type: ${exhaustiveCheck}`);
      }
    }
  }

  private async ok(action: BrowserAction, detail: string): Promise<ActionResult> {
    return { action, ok: true, detail, context: await this.getPageContext() };
  }

  private async fail(action: BrowserAction, detail: string): Promise<ActionResult> {
    return { action, ok: false, detail, context: await this.getPageContext() };
  }
}

function requireStringParam(action: BrowserAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Action "${action.type}" is missing required string param "${key}"`);
  }
  return value;
}

function optionalStringParam(action: BrowserAction, key: string): string | undefined {
  const value = action.params[key];
  return typeof value === "string" ? value : undefined;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Tries a locator against the main frame first, then every sub-frame in document order,
 * returning the first one with at least one match. Falls back to the main-frame locator
 * (which will simply time out with its normal error) if nothing matched anywhere - a
 * widget embedded in an <iframe> (reCAPTCHA's checkbox is the motivating case) is
 * otherwise invisible to a plain `page.getByRole()`/`page.locator()` call, which only
 * searches the main frame.
 */
async function firstMatchAcrossFrames(
  page: Page,
  makeLocator: (target: Page | Frame) => Locator,
): Promise<Locator> {
  const mainLocator = makeLocator(page);
  if ((await mainLocator.count().catch(() => 0)) > 0) return mainLocator.first();

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const locator = makeLocator(frame);
    if ((await locator.count().catch(() => 0)) > 0) return locator.first();
  }

  return mainLocator.first();
}

/**
 * Best-effort, based on each provider's publicly documented iframe URL conventions as
 * of writing - not a guarantee, since providers can and do change these. `checkbox`
 * matches the unclicked/passive widget; `challenge` matches the iframe that shows the
 * actual interactive puzzle once escalated.
 */
const CHALLENGE_URL_PATTERNS: Array<{
  provider: NonNullable<ChallengeInfo["provider"]>;
  checkbox: RegExp;
  challenge: RegExp;
}> = [
  { provider: "recaptcha", checkbox: /recaptcha.*\/anchor/i, challenge: /recaptcha.*\/bframe/i },
  { provider: "hcaptcha", checkbox: /hcaptcha\.com\/.*frame=checkbox/i, challenge: /hcaptcha\.com\/.*frame=challenge/i },
  { provider: "turnstile", checkbox: /challenges\.cloudflare\.com/i, challenge: /challenges\.cloudflare\.com.*challenge/i },
];

/**
 * Allowlist, not a blocklist: an unrecognized scheme fails closed. `data:` is included
 * alongside `http:`/`https:` because Chromium gives every `data:` navigation its own
 * opaque origin (no access to another origin's cookies/storage/filesystem), and this
 * package's own tests rely on `data:` fixture pages to avoid real network calls. What's
 * actually worth blocking - `javascript:` (executes in the current page's context),
 * `file:`/`chrome:`/`chrome-extension:` (privileged local/browser-internal access) -
 * stays blocked regardless of which planner (rule-based or LLM) produced the action.
 */
const NAVIGABLE_URL_SCHEMES = new Set(["http:", "https:", "data:"]);

function isNavigableUrl(url: string): boolean {
  try {
    return NAVIGABLE_URL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
