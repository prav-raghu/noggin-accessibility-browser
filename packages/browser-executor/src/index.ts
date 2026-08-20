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

  /**
   * Run a page-scoped function and return its result. Not part of the BrowserAction
   * vocabulary (a real intent-driven agent never gets arbitrary script execution) - this
   * exists for callers that already know exactly what they're checking, such as the
   * benchmark harness verifying task success against fixture-page DOM state.
   */
  async evaluate<T>(pageFunction: () => T): Promise<T> {
    return this.requirePage().evaluate(pageFunction);
  }

  /** Backs the spec section 12 "Undo last reversible action" command for Tier 1 nav. */
  async goBack(): Promise<PageContext> {
    const page = this.requirePage();
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    return this.getPageContext();
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
        const locator = page
          .getByRole(role as Parameters<Page["getByRole"]>[0], {
            name: nameContains ? new RegExp(escapeRegExp(nameContains), "i") : undefined,
          })
          .first();
        await locator.click({ timeout: 5000 });
        return this.ok(action, `clicked role="${role}"${nameContains ? ` name~="${nameContains}"` : ""}`);
      }

      case BrowserActionType.FILL_FIELD: {
        const role = requireStringParam(action, "role");
        const nameContains = optionalStringParam(action, "nameContains");
        const value = requireStringParam(action, "value");
        const locator = page
          .getByRole(role as Parameters<Page["getByRole"]>[0], {
            name: nameContains ? new RegExp(escapeRegExp(nameContains), "i") : undefined,
          })
          .first();
        await locator.fill(value, { timeout: 5000 });
        return this.ok(action, `filled role="${role}"${nameContains ? ` name~="${nameContains}"` : ""} with "${value}"`);
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
