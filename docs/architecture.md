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

- **No live LLM call.** `agent-planner`'s default `StubPlanner` is rule-based
  (concept-token matching), matching the "structured concepts + small command
  vocabulary" framing in section 7, not a general-purpose tool-calling LLM. The
  `Planner` interface is the seam for M1's "LLM can navigate a controlled task set."
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
