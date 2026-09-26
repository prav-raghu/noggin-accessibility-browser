/**
 * Entry point. Wires every package into one runnable pipeline (milestone M1-M3):
 * simulated-bci -> agent-planner -> safety-gateway -> browser-executor -> audit-log,
 * fronted by a local feedback-UI control panel.
 *
 * Run with `npm run dev` (from repo root or this package). Env vars:
 *   NOGGIN_HEADLESS=false   run Chromium headed (needs a display)
 *   NOGGIN_PORT=4173        feedback UI port
 *   NOGGIN_ERROR_RATE=0.1   simulated BCI command misclassification rate (0-1)
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlAuditStore } from "@noggin/audit-log";
import { BrowserExecutor } from "@noggin/browser-executor";
import { BrowserActionType } from "@noggin/intent-contract";
import { AnthropicLlmClient, LlmPlanner, OllamaLlmClient, StubPlanner, type Planner } from "@noggin/agent-planner";
import { SafetyGateway } from "@noggin/safety-gateway";
import { SimulatedBciAdapter } from "@noggin/simulated-bci";
import { Orchestrator } from "./orchestrator.js";
import { startServer } from "./server.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() !== "false" && raw !== "0";
}

/**
 * `StubPlanner` remains the fallback so the pipeline always runs with zero external API
 * calls or cost even when nothing is configured (README/architecture.md). Beyond that,
 * three ways to get the real `LlmPlanner` (open-ended free-text goals instead of only
 * the small hand-coded rule table - see packages/agent-planner/src/llm-planner.ts),
 * chosen by what's set:
 *
 *   NOGGIN_OLLAMA_MODEL=llama3.1   free, open-weight, runs locally via `ollama serve` -
 *                                  the recommended default for planning "all the time"
 *                                  with no per-call cost or external API dependency.
 *   ANTHROPIC_API_KEY=sk-...       Claude via the Anthropic API - a paid alternative if
 *                                  you want a larger model than what's practical to run
 *                                  locally.
 *   NOGGIN_LLM_PROVIDER=stub       explicit override to force StubPlanner even if the
 *                                  above are set (e.g. for a deterministic CI run).
 *
 * If both NOGGIN_OLLAMA_MODEL and ANTHROPIC_API_KEY are set without an explicit
 * NOGGIN_LLM_PROVIDER, Ollama wins - it's free, so there's no reason to default to the
 * paid option.
 */
function buildPlanner(): Planner {
  const provider = process.env.NOGGIN_LLM_PROVIDER?.toLowerCase();
  const ollamaModel = process.env.NOGGIN_OLLAMA_MODEL;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  // Local inference on modest hardware can be slower than a cloud call - raise this via
  // env if you see spurious timeouts rather than disabling the guard outright.
  const timeoutMs = process.env.NOGGIN_LLM_TIMEOUT_MS
    ? Number(process.env.NOGGIN_LLM_TIMEOUT_MS)
    : undefined;

  const useOllama = provider === "ollama" || (!provider && Boolean(ollamaModel));
  const useAnthropic = provider === "anthropic" || (!provider && !ollamaModel && Boolean(anthropicKey));

  if (useOllama) {
    if (!ollamaModel) {
      throw new Error("NOGGIN_LLM_PROVIDER=ollama requires NOGGIN_OLLAMA_MODEL to be set (e.g. \"llama3.2:3b\")");
    }
    console.log(
      `[browser-shell] using LlmPlanner over a free, local Ollama model (model=${ollamaModel}, ` +
        `baseUrl=${process.env.NOGGIN_LLM_BASE_URL ?? "http://localhost:11434/v1"}) - ` +
        "make sure `ollama serve` is running and the model has been pulled",
    );
    return new LlmPlanner({
      client: new OllamaLlmClient({ model: ollamaModel, baseUrl: process.env.NOGGIN_LLM_BASE_URL, timeoutMs }),
    });
  }

  if (useAnthropic) {
    if (!anthropicKey) {
      throw new Error("NOGGIN_LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set");
    }
    console.log(
      `[browser-shell] using LlmPlanner over the Anthropic API (model=${process.env.NOGGIN_LLM_MODEL ?? "default"})`,
    );
    return new LlmPlanner({
      client: new AnthropicLlmClient({ apiKey: anthropicKey, model: process.env.NOGGIN_LLM_MODEL, timeoutMs }),
    });
  }

  console.log(
    "[browser-shell] no LLM configured - using the rule-based StubPlanner " +
      "(set NOGGIN_OLLAMA_MODEL for a free local model, or ANTHROPIC_API_KEY for Claude)",
  );
  return new StubPlanner();
}

async function main(): Promise<void> {
  const sessionId = randomUUID();
  const headless = envBool("NOGGIN_HEADLESS", true);
  const port = Number(process.env.NOGGIN_PORT ?? 4173);
  const errorRate = Number(process.env.NOGGIN_ERROR_RATE ?? 0);

  console.log(`[browser-shell] session ${sessionId} starting (headless=${headless})`);

  const executor = new BrowserExecutor({ headless });
  await executor.launch();
  await executor.execute({
    id: "startup-navigate",
    type: BrowserActionType.NAVIGATE,
    params: { url: "https://www.youtube.com" },
    riskTier: 0,
    description: "Open the default start page",
  }).catch((err) => {
    // Non-fatal: sandboxed/offline environments may have no network. The pipeline
    // still runs; navigation-dependent demo actions will simply fail individually.
    console.warn("[browser-shell] startup navigation failed (continuing):", describeError(err));
  });

  const audit = new JsonlAuditStore(join(__dirname, "..", "..", "..", "run-data", `${sessionId}.jsonl`));
  const gateway = new SafetyGateway();
  const bci = new SimulatedBciAdapter({ session: sessionId, commandErrorRate: errorRate });
  const planner = buildPlanner();

  const orchestrator = new Orchestrator({ sessionId, executor, audit, gateway, bci, planner });
  orchestrator.onUpdate((update) => {
    console.log(`[state] ${update.state}${update.message ? ` — ${update.message}` : ""}`);
  });

  const detachKeyboard = bci.attachKeyboard();
  console.log(
    "[browser-shell] keyboard (if TTY): 1-4 = trigger goal, s/esc = STOP, y = CONFIRM, n = REJECT, q = QUERY_INTENT, u = UNDO",
  );

  const httpServer = startServer(orchestrator, port);

  async function shutdown(): Promise<void> {
    console.log("\n[browser-shell] shutting down");
    detachKeyboard();
    httpServer.close();
    await audit.close();
    await executor.close();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
  console.error("[browser-shell] fatal error", err);
  process.exit(1);
});
