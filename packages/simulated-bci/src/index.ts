/**
 * Simulated BCI adapter.
 *
 * Stands in for spec architecture layers 1-2 (input adapter + signal/intent decoder)
 * until a real device is integrated (milestone M5). It emits the same IntentEvent
 * contract a real decoder would (spec section 9), so nothing downstream needs to know
 * the difference.
 *
 * Two ways to drive it, both first-class (spec section 5 lists keyboard/gamepad
 * explicitly, but a research harness also needs to trigger events programmatically to
 * replay error-rate experiments - spec section 15/21):
 *   - `attachKeyboard()` for interactive manual testing from a terminal
 *   - `trigger()` for programmatic use (tests, the browser-shell control panel, batch
 *     evaluation scripts)
 */
import { EventEmitter } from "node:events";
import readline from "node:readline";
import {
  createIntentEvent,
  IntentCommand,
  type IntentEvent,
} from "@noggin/intent-contract";

export interface SimulatedBciConfig {
  /** Reported in IntentEvent.source, e.g. "sim.keyboard". */
  source?: string;
  /** Reported in signal_provenance.decoder. */
  decoder?: string;
  /** Reported in signal_provenance.session. */
  session?: string;
  /** Confidence used when a trigger doesn't specify one. */
  baseConfidence?: number;
  /** Uniform random jitter applied to confidence, e.g. 0.1 => +/-0.1. */
  confidenceJitter?: number;
  /**
   * Probability [0,1] that a triggered command is misclassified into a different
   * command, simulating decoder error. STOP is always exempt - spec section 6/11
   * require a "highly reliable" / "deterministic" cancel signal, so the simulator
   * should never model STOP as unreliable.
   */
  commandErrorRate?: number;
}

const DEFAULT_CONFIG: Required<SimulatedBciConfig> = {
  source: "sim.keyboard",
  decoder: "simulated-v1",
  session: "local-session",
  baseConfidence: 0.85,
  confidenceJitter: 0.1,
  commandErrorRate: 0,
};

/** Canned goals mapped to number keys, including the spec section 7 worked example. */
export const DEFAULT_GOAL_PRESETS: Record<string, string[]> = {
  "1": ["youtube", "avgn", "season 9"],
  "2": ["search", "weather", "today"],
  "3": ["email", "inbox", "unread"],
  "4": ["news", "headlines", "today"],
};

const CORRUPTIBLE_COMMANDS: IntentCommand[] = [
  IntentCommand.EXECUTE_GOAL,
  IntentCommand.CONFIRM,
  IntentCommand.REJECT,
  IntentCommand.QUERY_INTENT,
  IntentCommand.UNDO,
];

export interface SimulatedBciEvents {
  intent: [IntentEvent];
}

export class SimulatedBciAdapter extends EventEmitter {
  private readonly config: Required<SimulatedBciConfig>;

  constructor(config: SimulatedBciConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Emit one IntentEvent. This is the primitive both the keyboard adapter and any
   * programmatic caller (tests, control panel, batch harness) go through, so error
   * injection and confidence jitter apply uniformly regardless of the trigger source.
   */
  trigger(
    command: IntentCommand,
    concepts: string[] = [],
    overrides: Partial<Pick<IntentEvent, "confidence" | "requires_confirmation">> = {},
  ): IntentEvent {
    const effectiveCommand = this.maybeCorrupt(command);
    const jitter = (Math.random() * 2 - 1) * this.config.confidenceJitter;
    const confidence = clamp01(overrides.confidence ?? this.config.baseConfidence + jitter);

    const event = createIntentEvent({
      source: this.config.source,
      intent: effectiveCommand,
      concepts,
      confidence,
      requires_confirmation: overrides.requires_confirmation ?? false,
      signal_provenance: {
        decoder: this.config.decoder,
        session: this.config.session,
      },
    });

    this.emit("intent", event);
    return event;
  }

  /** Convenience: trigger EXECUTE_GOAL for one of the DEFAULT_GOAL_PRESETS keys. */
  triggerGoal(presetKey: keyof typeof DEFAULT_GOAL_PRESETS): IntentEvent {
    const concepts = DEFAULT_GOAL_PRESETS[presetKey];
    if (!concepts) {
      throw new Error(`Unknown goal preset "${presetKey}"`);
    }
    return this.trigger(IntentCommand.EXECUTE_GOAL, concepts);
  }

  /** The deterministic, never-corrupted cancel signal (spec section 6, 11). */
  triggerStop(): IntentEvent {
    const event = createIntentEvent({
      source: this.config.source,
      intent: IntentCommand.STOP,
      concepts: [],
      confidence: 1,
      requires_confirmation: false,
      signal_provenance: { decoder: this.config.decoder, session: this.config.session },
    });
    this.emit("intent", event);
    return event;
  }

  private maybeCorrupt(command: IntentCommand): IntentCommand {
    if (command === IntentCommand.STOP) return command;
    if (this.config.commandErrorRate <= 0) return command;
    if (Math.random() >= this.config.commandErrorRate) return command;

    const alternatives = CORRUPTIBLE_COMMANDS.filter((c) => c !== command);
    const pick = alternatives[Math.floor(Math.random() * alternatives.length)];
    return pick ?? command;
  }

  /**
   * Attach to a readable TTY stream and translate keypresses into intents. Returns a
   * detach function. No-ops (with a console warning) outside a TTY, since headless/CI
   * runs cannot read raw keyboard input - use `trigger()` directly there instead.
   */
  attachKeyboard(input: NodeJS.ReadStream = process.stdin): () => void {
    if (!input.isTTY) {
      console.warn(
        "[simulated-bci] stdin is not a TTY; keyboard control disabled. Use trigger()/triggerGoal() programmatically instead.",
      );
      return () => {};
    }

    readline.emitKeypressEvents(input);
    input.setRawMode(true);

    const onKeypress = (
      _str: string,
      key: { name?: string; ctrl?: boolean; sequence?: string } | undefined,
    ) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        this.triggerStop();
        process.exit(0);
      }
      switch (key.name) {
        case "1":
        case "2":
        case "3":
        case "4":
          this.triggerGoal(key.name);
          break;
        case "s":
        case "escape":
          this.triggerStop();
          break;
        case "y":
          this.trigger(IntentCommand.CONFIRM);
          break;
        case "n":
          this.trigger(IntentCommand.REJECT);
          break;
        case "q":
          this.trigger(IntentCommand.QUERY_INTENT);
          break;
        case "u":
          this.trigger(IntentCommand.UNDO);
          break;
        default:
          break;
      }
    };

    input.on("keypress", onKeypress);

    return () => {
      input.off("keypress", onKeypress);
      if (input.isTTY) input.setRawMode(false);
    };
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export { IntentCommand } from "@noggin/intent-contract";
export type { IntentEvent } from "@noggin/intent-contract";
