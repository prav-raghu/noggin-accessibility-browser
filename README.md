# Noggin Accessibility Browser

<p align="left">
  <img
    src="https://res.cloudinary.com/dbqg2azyd/image/upload/v1786457899/eeac2ef0-2576-4703-a344-33f110ff6db6.png"
    alt="Noggin Accessibility Browser"
    width="250"
  />
</p>

An AI-mediated accessibility browser that turns sparse, low-bandwidth neural intent
into safe, auditable, multi-step web actions.

A brain-computer interface (BCI) does not need to replace the mouse and keyboard one
gesture at a time - it only needs to express *intent*. This project explores the
mediation layer between an uncertain neural decoder and an autonomous browser agent: how
confidence, context, risk tiering, confirmation and provenance should combine so a user
can complete web tasks in fewer interactions, without letting a false neural
classification or malicious page content cause harmful actions.

Full product/research spec: [`docs/spec/BCI-AI-Accessibility-Browser-Spec-v0.1.md`](docs/spec/BCI-AI-Accessibility-Browser-Spec-v0.1.md).
Architecture-to-code mapping and known gaps: [`docs/architecture.md`](docs/architecture.md).

## What's here today (MVP milestones M1-M4)

```
simulated-bci -> agent-planner -> safety-gateway -> browser-executor -> audit-log
```

- **`packages/intent-contract`** — the Intent Event Contract and risk-tier schema every
  other package shares (spec sections 9-10).
- **`packages/simulated-bci`** — keyboard/programmatic input adapter emitting intent
  events with configurable confidence jitter and command error injection, standing in
  for a live EEG decoder.
- **`packages/agent-planner`** — a `Planner` interface plus a deterministic rule-based
  `StubPlanner` (no external LLM calls) that turns a sparse intent into an ordered plan
  of browser actions. Swap in a tool-calling LLM later without touching anything else.
- **`packages/safety-gateway`** — deterministic risk-tier policy engine: auto-approval,
  confirmation, or refusal per action risk tier, plus the hard STOP pathway that bypasses
  the planner entirely and a confirmation timeout that only ever cancels, never
  silently approves.
- **`packages/browser-executor`** — Playwright-controlled Chromium, using the CDP
  Accessibility domain and role/name-grounded lookups rather than screen coordinates.
- **`packages/audit-log`** — append-only JSONL trace distinguishing neural-source
  events, planner interpretation, gateway decisions and executed actions.
- **`apps/browser-shell`** — the orchestrator that wires all of the above together and
  serves a small local control panel (feedback UI) showing live intent/confidence/state
  with Stop / Pause / Confirm / Reject / Explain / Undo controls.
- **`packages/task-suite`** — the M4 benchmark task suite (spec section 13 step 5):
  four offline, `data:`-URL fixture tasks (media navigation, search, form completion,
  information retrieval), each with a real DOM-level success check and a matching
  `agent-planner` goal rule.
- **`packages/benchmark`** — the M4 baseline experiment harness (spec section 15):
  runs every task suite task under a direct-control baseline (Condition A) and under
  agentic intent control through the real `StubPlanner` + `SafetyGateway` (Condition B),
  and reports success rate, time, control-event count and confirmation burden.
- **`apps/benchmark-cli`** — `npm run benchmark` runs the harness end to end and writes
  reproducible JSON + markdown results to `run-data/`.

See `docs/architecture.md` for what's deliberately *not* built yet (live EEG, a real
LLM planner, SQLite-backed audit storage) and why.

## Getting started

Requires Node.js 20+.

```bash
npm install
npm run typecheck   # tsc -b across the whole workspace
npm test            # node:test, includes a headless Playwright smoke test
npm run dev          # launch the pipeline + control panel (headless Chromium by default)
npm run benchmark    # M4 baseline experiment: direct-control vs agentic-intent-control
```

Then open `http://localhost:4173` for the control panel. If your terminal is a TTY,
keyboard shortcuts also work directly: `1`-`4` trigger a preset goal, `s`/`Esc` = STOP,
`y` = CONFIRM, `n` = REJECT, `q` = QUERY_INTENT (explain), `u` = UNDO.

Useful env vars (see `apps/browser-shell/src/main.ts`):

| Var | Default | Purpose |
|---|---|---|
| `NOGGIN_HEADLESS` | `true` | Set `false` to run Chromium headed (needs a display) |
| `NOGGIN_PORT` | `4173` | Feedback UI port |
| `NOGGIN_ERROR_RATE` | `0` | Simulated BCI command misclassification rate, `0`-`1` |

`npm run dev:headed` is a shortcut for `NOGGIN_HEADLESS=false npm run dev`.

The benchmark CLI (`apps/benchmark-cli`) reads its own env vars:

| Var | Default | Purpose |
|---|---|---|
| `NOGGIN_HEADLESS` | `true` | Set `false` to run Chromium headed |
| `NOGGIN_BENCHMARK_REPS` | `5` | Repetitions per task per condition |

`npm run benchmark:headed` is a shortcut for `NOGGIN_HEADLESS=false npm run benchmark`.

## Repo layout

```
docs/
  spec/           the product & research spec (source of truth)
  architecture.md  spec architecture table -> code, and explicit known gaps
packages/
  intent-contract/   shared types + zod schemas
  simulated-bci/      input adapter
  agent-planner/       planner interface + StubPlanner
  safety-gateway/       risk tiers, confirmation, STOP
  browser-executor/      Playwright/CDP executor
  audit-log/              JSONL trace store
  task-suite/              M4 benchmark task suite (fixtures + success checks)
  benchmark/                M4 baseline experiment harness (direct vs agentic control)
apps/
  browser-shell/    orchestrator + feedback UI (public/)
  benchmark-cli/     `npm run benchmark` entry point
```

Each package/app is an npm workspace (`npm install` at the repo root installs
everything). Run a single package's tests with, e.g.,
`node --import tsx --test packages/safety-gateway/src/**/*.test.ts`.
