/**
 * Audit/evaluation store: spec architecture layer 9 and section 11's requirement that
 * "audit logs must distinguish neural-source events, LLM interpretation, external
 * webpage content and executed browser actions."
 *
 * Implementation is append-only JSON-Lines today - deliberately not SQLite yet (see
 * docs/architecture.md "Known gaps"). The `AuditStore` interface is the seam: swap the
 * implementation for a SQLite/encrypted store later without touching call sites.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const AuditEventType = {
  /** Raw (already-parsed) neural/simulated intent - "neural-source events". */
  NEURAL_INTENT: "neural_intent",
  /** What the planner (LLM or stub) inferred from an intent - "LLM interpretation". */
  PLANNER_INTERPRETATION: "planner_interpretation",
  /** Untrusted page content consumed as context - "external webpage content". */
  PAGE_CONTEXT: "page_context",
  /** Safety gateway's approve/needs-confirmation/refuse call. */
  GATEWAY_DECISION: "gateway_decision",
  /** User confirm/reject/stop/pause/resume of a pending action. */
  CONFIRMATION: "confirmation",
  /** A browser action actually executed - "executed browser actions". */
  EXECUTED_ACTION: "executed_action",
} as const;
export type AuditEventType = (typeof AuditEventType)[keyof typeof AuditEventType];

export interface AuditEvent<TPayload = unknown> {
  id: string;
  type: AuditEventType;
  timestamp: string;
  sessionId: string;
  payload: TPayload;
}

export type NewAuditEvent<TPayload = unknown> = Omit<AuditEvent<TPayload>, "id" | "timestamp">;

export interface AuditStore {
  record<TPayload>(event: NewAuditEvent<TPayload>): Promise<AuditEvent<TPayload>>;
  all(): Promise<AuditEvent[]>;
  byType(type: AuditEventType): Promise<AuditEvent[]>;
  bySession(sessionId: string): Promise<AuditEvent[]>;
  close(): Promise<void>;
}

/**
 * JSONL-backed store. Writes are serialized through a promise chain so concurrent
 * `record()` calls from different pipeline stages never interleave partial lines.
 */
export class JsonlAuditStore implements AuditStore {
  private writeChain: Promise<void> = Promise.resolve();
  private counter = 0;

  constructor(private readonly filePath: string) {}

  private async ensureDir(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  async record<TPayload>(event: NewAuditEvent<TPayload>): Promise<AuditEvent<TPayload>> {
    this.counter += 1;
    const full: AuditEvent<TPayload> = {
      ...event,
      id: `evt-${Date.now()}-${this.counter}`,
      timestamp: new Date().toISOString(),
    };

    this.writeChain = this.writeChain
      .then(async () => {
        await this.ensureDir();
        await appendFile(this.filePath, JSON.stringify(full) + "\n", "utf8");
      })
      // Never let one failed write take down the chain for subsequent events.
      .catch((err) => {
        console.error("[audit-log] failed to append event", err);
      });

    await this.writeChain;
    return full;
  }

  async all(): Promise<AuditEvent[]> {
    const raw = await readFile(this.filePath, "utf8").catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    });
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditEvent);
  }

  async byType(type: AuditEventType): Promise<AuditEvent[]> {
    return (await this.all()).filter((e) => e.type === type);
  }

  async bySession(sessionId: string): Promise<AuditEvent[]> {
    return (await this.all()).filter((e) => e.sessionId === sessionId);
  }

  async close(): Promise<void> {
    await this.writeChain;
  }
}

/** Never persists anything - useful for tests or `--no-audit` runs. */
export class NullAuditStore implements AuditStore {
  async record<TPayload>(event: NewAuditEvent<TPayload>): Promise<AuditEvent<TPayload>> {
    return { ...event, id: "noop", timestamp: new Date().toISOString() };
  }
  async all(): Promise<AuditEvent[]> {
    return [];
  }
  async byType(): Promise<AuditEvent[]> {
    return [];
  }
  async bySession(): Promise<AuditEvent[]> {
    return [];
  }
  async close(): Promise<void> {}
}
