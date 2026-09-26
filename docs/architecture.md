# Architecture

This document maps the spec's high-level architecture (section 8) onto the code in this
repo. It also records the deliberate deviations from the spec's "candidate technology"
column and why.

## Pipeline

```
 ┌────────────────┐   IntentEvent    ┌──────────────────┐
 │ simulated-bci   │ ───────────────▶│ agent-planner     │
 │ (input adapter, │                  │ (goal inference,  │
 │  intent broker) │                  │  step planning)   │
 └────────────────┘                  └─────────┬─────────┘
                                                 │ Plan (ordered BrowserAction[])
                                                 ▼
                                       ┌──────────────────┐
                                       │ safety-gateway    │
                                       │ (risk tiers,      │
                                       │  confirmation,    │
                                       │  hard STOP)       │
                                       └─────────┬─────────┘
                                                 │ authorized actions only
                                                 ▼
                                       ┌──────────────────┐
                                       │ browser-executor  │
                                       │ (Playwright +     │
                                       │  CDP accessibility│
                                       │  tree)             │
                                       └─────────┬─────────┘
                                                 │ page state / results
                                                 ▼
                                       ┌──────────────────┐
                                       │ audit-log         │
                                       │ (JSONL trace)      │
                                       └──────────────────┘
```

`apps/browser-shell` is the orchestrator: it wires the packages above together and
serves the feedback UI (`apps/browser-shell/public`) that shows the current interpreted
intent, confidence, agent state (listening / paused / planning / acting) and exposes
Stop / Confirm / Reject / Explain controls.

## Spec architecture table → code

| Spec layer | Spec candidate tech | This repo |
|---|---|---|
| 1. Input adapters | Python/C++ SDKs; WebSocket/gRPC bridge | `packages/simulated-bci` (TypeScript, in-process `EventEmitter`; swap for a WebSocket bridge to a Python decoder when live EEG is integrated) |
| 2. Signal/intent decoder | Python, MNE, PyTorch/scikit-learn | Not implemented yet — out of scope until a real EEG device is integrated (M5). The simulated adapter stands in for "decoder + intent broker" combined. |
| 3. Intent broker | TypeScript service | `packages/intent-contract` (schema/types) + validation inside `simulated-bci` |
| 4. Context composer | Node/TypeScript | `apps/browser-shell` orchestrator (combines the latest `IntentEvent` with current page/tab state read from `browser-executor` before calling the planner) |
| 5. LLM planner | Local or cloud LLM with tool calling | `packages/agent-planner`. Ships with a deterministic rule-based `StubPlanner` so the pipeline runs with zero external API calls; implements the `Planner` interface so a real LLM-backed planner (tool-calling) can be dropped in without touching the rest of the pipeline |
| 6. Safety/authorization | Deterministic policy engine | `packages/safety-gateway` |
| 7. Browser executor | CDP / Playwright / Electron | `packages/browser-executor` — Playwright driving the Chromium build already present in this environment, using `Accessibility.getFullAXTree` over CDP for accessibility-tree-grounded interaction (RQ3) |
| 8. Feedback UI | React + accessible Chromium UI | `apps/browser-shell/public` — a small dependency-free HTML/CSS/JS control panel served locally over HTTP + WebSocket. Deliberately not React yet: the MVP goal is an accessible, low-latency status/confirmation surface, not UI framework iteration. Swapping in React later only touches this one directory. |
| 9. Audit/evaluation | Local encrypted event store | `packages/audit-log` — append-only JSONL today (schema-compatible with a later SQLite/encrypted store; see "Known gaps" below) |

## Why Playwright-controlled Chromium instead of Electron

The spec lists both as acceptable starting points ("Electron + Chromium, or
Playwright-controlled Chromium ... Avoid maintaining a Chromium fork during research").
This repo starts with Playwright because:

- The sandboxed dev environment already ships a pinned Chromium build for Playwright
  (`/opt/pw-browsers`), so `browser-executor` has zero extra binary download cost.
- CDP access (`Accessibility` domain, `Input`, `Page`, `DOM`) is available directly
  through `page.context().newCDPSession(page)` without Electron's `webContents.debugger`
  plumbing or a packaged app shell.
- It keeps the "browser shell" and "feedback UI" concerns decoupled: the feedback UI is
  just a local web page, not a renderer process tied to an Electron main process.

Electron remains a reasonable second milestone if the project needs a single packaged
desktop app (installer, OS-level tray/menu integration, always-on background service).
`packages/browser-executor` only depends on Playwright's `Page`/`CDPSession` types, so it
should be reusable from an Electron main process later with minimal changes.

## Risk tiers (section 10)

Implemented in `packages/safety-gateway` as `RiskTier` 0–4, matching the spec table
exactly (Observe / Reversible navigation / Communication / Consequential /
Prohibited). Each `BrowserAction` produced by a planner declares its own risk tier; the
gateway — not the planner — decides whether that tier requires confirmation, and the
STOP pathway short-circuits the gateway entirely rather than routing through it.

## Known gaps / explicit non-goals for this scaffold

These are flagged rather than silently deferred, per the spec's emphasis on auditable,
honestly-scoped claims (section 18, section 25):

- **LLM planner exists but is opt-in, not the default.** `packages/agent-planner`'s
  `LlmPlanner` (`llm-planner.ts`) turns an open-ended free-text goal - "open YouTube and
  watch some sumo", "google best vegan recipes", "log into Facebook with my email and
  password" - into a `BrowserAction[]` plan via a tool-calling call to an LLM, behind the
  same `LlmClient` seam regardless of which one: `OllamaLlmClient` (free, open-weight,
  runs locally via `ollama serve`, no SDK - recommended default, since planning "all the
  time" shouldn't imply a per-call bill) or `AnthropicLlmClient` (Claude via the paid
  Anthropic API, for when a larger model is worth the cost). Both use plain `fetch`, no
  vendor SDK dependency. It only activates when `NOGGIN_OLLAMA_MODEL` or
  `ANTHROPIC_API_KEY` is set (`apps/browser-shell/src/main.ts`); otherwise the pipeline
  still runs on the zero-cost, zero-network `StubPlanner`, matching the "runs with zero
  external API calls" MVP goal. The `LlmPlanner` never gets to weaken safety: it cannot
  set a step's risk tier at all (the schema it's forced to return has no such field),
  and `planRiskTier` in `@noggin/intent-contract` independently clamps every step to its
  `DEFAULT_ACTION_RISK` floor regardless of what any planner claims.
  - **Not every open model supports tool calling.** Ollama documents only a handful
    (llama3.1, llama3.2, qwen2.5, mistral-nemo, firefunction-v2, command-r) as capable of
    it; an arbitrary model asked to plan will just reply with prose instead of the forced
    `propose_plan` call, which surfaces as a validation failure and a "please restate the
    goal" clarification rather than a crash - but it does mean model choice matters here
    in a way it doesn't for the cloud option.
  - **Credential redaction.** A goal that embeds a password (e.g. a "login with
    username X and password Y" command) is redacted (`secret-vault.ts`) before it ever
    reaches the LLM or the audit log - the model only sees a `{{SECRET_n}}` placeholder,
    and the `Planner.resolveParams` hook lets the orchestrator substitute the real value
    back in only for the live `browser-executor` call, immediately before use
    (`Orchestrator.runPlan`). This is regex-based on the "password/pwd/passcode" keyword
    family, not a general secret scanner - a real product would replace it with a local
    password-manager/autofill integration instead of ever routing secrets through a
    goal string at all.
  - **Login as a plan shape, not a special case.** There's no bespoke "login" action.
    `FILL_FIELD` (new, Tier 1 - reversible, nothing is sent to the page's server yet)
    lets a plan type into arbitrary fields, and the existing `SUBMIT_FORM` (Tier 2)
    is what actually transmits the form. Because the safety gateway gates on a plan's
    *highest* step risk tier before any step runs, a login-shaped plan auto-fills
    nothing until the user has explicitly previewed and confirmed the whole plan -
    "fill email, fill password, submit" - matching spec section 10's "Preview +
    explicit confirmation" for Tier 2, without any planner-specific gateway logic.
  - **Bounded resource usage.** A plan is capped at `MAX_PLAN_STEPS` (8) steps -
    schema-enforced (`z.array(...).max(...)`), not just requested in the prompt - and
    both LLM clients cap the model's response length and abort a hung request after
    `timeoutMs` (default 20s) via `AbortSignal.timeout`, so a stalled local model can't
    leave the orchestrator stuck in "planning" indefinitely. Context fields
    (`currentUrl`/`pageTitle`) are truncated before they reach the prompt, since they
    ultimately come from the current page - untrusted, and otherwise unbounded, content.
    For `OllamaLlmClient` specifically, a small (1B-3B) model is the intended choice, not
    just for token/resource budget but because Chromium is running on the same machine.
  - **Guards live at the execution boundary, not just in the prompt.** A prompt
    instruction is not a security control - it's advisory, and open-weight models in
    particular can be steered off it by adversarial page content. So `browser-executor`
    independently enforces an allowlist of navigable URL schemes (`http:`/`https:`/
    `data:`) before any `navigate` action runs, refusing `javascript:`/`file:`/`chrome:`
    regardless of which planner (rule-based or LLM) produced the URL or why.
- **No live EEG / BCI hardware.** Only the simulated adapter (M2) exists. Device SDKs
  (Python/C++) and a WebSocket/gRPC bridge (spec layer 1–2) are not built.
- **Audit log is JSONL, not SQLite, and not encrypted at rest.** The `AuditStore`
  interface in `packages/audit-log` is narrow enough to re-implement on SQLite
  (`better-sqlite3` or similar) without touching call sites; encryption-at-rest is a
  follow-up once the on-disk format is settled.
- **No accessibility-tree diffing / caching yet.** `browser-executor` re-queries
  `Accessibility.getFullAXTree` per lookup; this is fine for the MVP task set but will
  need caching/diffing before latency (section 23 risk) becomes a problem.
- **Feedback UI is a minimal control panel**, not a full accessible Chromium UI (screen
  reader / high-contrast / switch-scanning support per section 12 is only partially
  covered — it's plain semantic HTML with `aria-live` regions, not yet audited).
