/**
 * Feedback UI transport (spec architecture layer 8): a small local HTTP server for the
 * static control panel plus a WebSocket for live state and controls. Deliberately not
 * React yet - see docs/architecture.md for why.
 *
 * Wire protocol (both directions are plain JSON text frames):
 *   server -> client: { type: "update", state, lastIntent?, lastPlan?, lastDecision?,
 *                        lastActionResult?, message? }               (OrchestratorUpdate)
 *   client -> server: { type: "stop" | "pause" | "resume" | "confirm" | "reject" |
 *                        "undo" | "query_intent" }
 *                     { type: "trigger_goal", preset: "1" | "2" | "3" | "4" }
 *                     { type: "trigger_free_text_goal", text: "open youtube and watch some sumo" }
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { IntentCommand } from "@noggin/intent-contract";
import type { Orchestrator } from "./orchestrator.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestedPath = normalize(decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/"));
  const relative = requestedPath === "/" ? "/index.html" : requestedPath;

  // Refuse to walk outside PUBLIC_DIR.
  if (relative.includes("..")) {
    res.writeHead(400).end("bad request");
    return;
  }

  const filePath = join(PUBLIC_DIR, relative);
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) throw new Error("not a file");
    const contentType = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404).end("not found");
  }
}

interface ClientMessage {
  type: string;
  preset?: string;
  text?: string;
}

export function startServer(orchestrator: Orchestrator, port: number) {
  const httpServer = createServer((req, res) => {
    void serveStatic(req, res);
  });

  const wss = new WebSocketServer({ server: httpServer });
  const clients = new Set<WebSocket>();

  function broadcast(payload: unknown): void {
    const text = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(text);
    }
  }

  orchestrator.onUpdate((update) => broadcast({ type: "update", ...update }));

  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: "update", ...orchestrator.getSnapshot() }));

    socket.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case "stop":
          orchestrator.stop();
          break;
        case "pause":
          orchestrator.pause();
          break;
        case "resume":
          orchestrator.resume();
          break;
        case "confirm":
          void orchestrator.confirmPending();
          break;
        case "reject":
          void orchestrator.rejectPending("user rejected via control panel");
          break;
        case "undo":
          void orchestrator.undo();
          break;
        case "query_intent":
          void orchestrator.handleIntent(
            orchestrator.bci.trigger(IntentCommand.QUERY_INTENT, [], { confidence: 1 }),
          );
          break;
        case "trigger_goal":
          if (msg.preset) orchestrator.bci.triggerGoal(msg.preset);
          break;
        case "trigger_free_text_goal": {
          const text = msg.text?.trim();
          if (!text) break;
          // Split into whitespace tokens rather than one long string: IntentEvent.concepts
          // is a structured token array (spec section 9), and StubPlanner's keyword
          // matching needs exact tokens like "youtube" - LlmPlanner rejoins them with
          // intent.concepts.join(" ") so it sees the original phrase either way.
          // confidence: 1 - this came from an explicit typed command, not a noisy decoder.
          orchestrator.bci.trigger(IntentCommand.EXECUTE_GOAL, text.split(/\s+/), { confidence: 1 });
          break;
        }
        default:
          break;
      }
    });

    socket.on("close", () => clients.delete(socket));
  });

  httpServer.listen(port, () => {
    console.log(`[browser-shell] feedback UI at http://localhost:${port}`);
  });

  return httpServer;
}
