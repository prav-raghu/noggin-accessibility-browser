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

  const orchestrator = new Orchestrator({ sessionId, executor, audit, gateway, bci });
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
