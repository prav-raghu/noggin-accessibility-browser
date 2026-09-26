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

## What's here today (MVP milestones M1-M3)

```
simulated-bci -> agent-planner -> safety-gateway -> browser-executor -> audit-log
```

- **`packages/intent-contract`** — the Intent Event Contract and risk-tier schema every
  other package shares (spec sections 9-10).
- **`packages/simulated-bci`** — keyboard/programmatic input adapter emitting intent
  events with configurable confidence jitter and command error injection, standing in
  for a live EEG decoder.
- **`packages/agent-planner`** — a `Planner` interface, a deterministic rule-based
  `StubPlanner` (no external LLM calls, the fallback) that turns a sparse intent into an
  ordered plan of browser actions, and an `LlmPlanner` (tool calling) that plans
  open-ended free-text goals instead - over a free local model via Ollama
  (`NOGGIN_OLLAMA_MODEL`, recommended) or Claude via the Anthropic API
  (`ANTHROPIC_API_KEY`).
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

See `docs/architecture.md` for what's deliberately *not* built yet (live EEG, a real
LLM planner, SQLite-backed audit storage) and why.

## Getting started

Requires Node.js 20+.

```bash
npm install
npm run typecheck   # tsc -b across the whole workspace
npm test            # node:test, includes a headless Playwright smoke test
npm run dev          # launch the pipeline + control panel (headless Chromium by default)
```

Then open `http://localhost:4173` for the control panel. It has a text box to type an
open-ended goal (e.g. "open youtube and watch some sumo") - with an LLM configured (see
below) this is planned by `LlmPlanner`; without one, only `StubPlanner`'s narrow keyword
rules apply. If your terminal is a TTY, keyboard shortcuts also work directly: `1`-`4`
trigger a preset goal, `s`/`Esc` = STOP, `y` = CONFIRM, `n` = REJECT, `q` = QUERY_INTENT
(explain), `u` = UNDO.

### Planning open-ended goals for free, locally, via Ollama (recommended)

`LlmPlanner` doesn't need a paid API - [Ollama](https://ollama.com) runs open-weight
models (Llama 3.1, Qwen2.5, Mistral-Nemo, etc.) entirely on your own machine for free,
with no rate limit tied to a cloud account. Only a handful of Ollama's models actually
support tool calling; `llama3.1` is a solid default.

```bash
ollama pull llama3.1
ollama serve                    # usually already running as a background service
NOGGIN_OLLAMA_MODEL=llama3.1 npm run dev
```

Useful env vars (see `apps/browser-shell/src/main.ts`):

| Var | Default | Purpose |
|---|---|---|
| `NOGGIN_HEADLESS` | `true` | Set `false` to run Chromium headed (needs a display) |
| `NOGGIN_PORT` | `4173` | Feedback UI port |
| `NOGGIN_ERROR_RATE` | `0` | Simulated BCI command misclassification rate, `0`-`1` |
| `NOGGIN_OLLAMA_MODEL` | unset | If set, use `LlmPlanner` over a free local Ollama model (e.g. `llama3.1`) |
| `NOGGIN_LLM_BASE_URL` | `http://localhost:11434/v1` | Override for `NOGGIN_OLLAMA_MODEL` - also works against any other OpenAI-compatible local server (llama.cpp, LM Studio, vLLM) |
| `ANTHROPIC_API_KEY` | unset | If set (and no `NOGGIN_OLLAMA_MODEL`), use `LlmPlanner` over the paid Anthropic API instead |
| `NOGGIN_LLM_MODEL` | `claude-haiku-4-5-20251001` | Model id, only used with `ANTHROPIC_API_KEY` |
| `NOGGIN_LLM_PROVIDER` | unset | Force `"ollama"`, `"anthropic"` or `"stub"`, overriding the auto-detection above |

`npm run dev:headed` is a shortcut for `NOGGIN_HEADLESS=false npm run dev`.

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
apps/
  browser-shell/    orchestrator + feedback UI (public/)
```

Each package/app is an npm workspace (`npm install` at the repo root installs
everything). Run a single package's tests with, e.g.,
`node --import tsx --test packages/safety-gateway/src/**/*.test.ts`.
