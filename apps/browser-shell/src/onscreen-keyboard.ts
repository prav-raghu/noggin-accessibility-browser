/**
 * Row-column scanning keyboard: the standard assistive-tech text-entry pattern for
 * someone limited to a binary select/cancel channel - switch access, AAC devices, and,
 * per spec section 5's "BCI-only" usage mode ("EEG/implant provides select, cancel,
 * yes/no, directional or semantic intent"), exactly what a real BCI's select/cancel
 * signal can drive without ever needing a physical keyboard.
 *
 * The scan clock lives here, server-side, and is authoritative - not a client-side
 * animation the UI free-runs on its own. `select()`/`cancel()` are the same two
 * operations `IntentCommand.CONFIRM`/`REJECT` already provide (see
 * `Orchestrator.handleIntent`), so a real BCI's existing binary channel drives this with
 * no new vocabulary; the control panel is a pure view of `getState()`.
 */

/** 5x6: covers A-Z plus space/backspace/done/cancel. Kept deliberately small - more
 * cells per row means a longer average scan to reach any one of them. */
export const KEYBOARD_ROWS: readonly (readonly string[])[] = [
  ["A", "B", "C", "D", "E", "F"],
  ["G", "H", "I", "J", "K", "L"],
  ["M", "N", "O", "P", "Q", "R"],
  ["S", "T", "U", "V", "W", "X"],
  ["Y", "Z", "SPACE", "BACKSPACE", "DONE", "CANCEL"],
];

export type ScanMode = "row" | "column";

export interface OnscreenKeyboardState {
  active: boolean;
  mode: ScanMode;
  /** Which row is currently highlighted while scanning rows. */
  activeRowIndex: number;
  /** Which row was locked in once the user selected it; null while still scanning rows. */
  lockedRowIndex: number | null;
  /** Which column is currently highlighted while scanning within the locked row. */
  activeColIndex: number | null;
  buffer: string;
}

export type OnscreenKeyboardEvent =
  | { type: "state"; state: OnscreenKeyboardState }
  | { type: "done"; text: string }
  | { type: "cancelled" };

type Listener = (event: OnscreenKeyboardEvent) => void;

export interface OnscreenKeyboardConfig {
  /** How long each row/key stays highlighted before the scan advances. Real assistive
   * scanning speeds are typically 0.5-2s; defaults to a middle-of-the-road 1000ms. */
  dwellMs?: number;
}

const DEFAULT_DWELL_MS = 1000;

function initialState(): OnscreenKeyboardState {
  return { active: false, mode: "row", activeRowIndex: 0, lockedRowIndex: null, activeColIndex: null, buffer: "" };
}

export class OnscreenKeyboard {
  private readonly dwellMs: number;
  private readonly listeners = new Set<Listener>();
  private timer: NodeJS.Timeout | null = null;
  private state: OnscreenKeyboardState = initialState();

  constructor(config: OnscreenKeyboardConfig = {}) {
    this.dwellMs = config.dwellMs ?? DEFAULT_DWELL_MS;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: OnscreenKeyboardEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private emitState(): void {
    this.emit({ type: "state", state: this.getState() });
  }

  getState(): OnscreenKeyboardState {
    return { ...this.state };
  }

  activate(): void {
    if (this.state.active) return;
    this.state = { ...initialState(), active: true };
    this.restartScanTimer();
    this.emitState();
  }

  deactivate(): void {
    this.stopScanTimer();
    this.state = { ...this.state, active: false };
    this.emitState();
  }

  private restartScanTimer(): void {
    this.stopScanTimer();
    this.timer = setInterval(() => this.advance(), this.dwellMs);
  }

  private stopScanTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Advance the scan by one row (row mode) or one column within the locked row (column
   * mode), wrapping around. Public - and the only thing the internal timer calls - so
   * tests can drive the state machine deterministically without waiting on real timers.
   */
  advance(): void {
    if (!this.state.active) return;
    if (this.state.mode === "row") {
      this.state = { ...this.state, activeRowIndex: (this.state.activeRowIndex + 1) % KEYBOARD_ROWS.length };
    } else {
      const row = KEYBOARD_ROWS[this.state.lockedRowIndex ?? 0]!;
      this.state = { ...this.state, activeColIndex: ((this.state.activeColIndex ?? -1) + 1) % row.length };
    }
    this.emitState();
  }

  /** Routed from IntentCommand.CONFIRM while active: lock in the highlighted row, or -
   * if a row is already locked - commit the highlighted key. */
  select(): void {
    if (!this.state.active) return;
    if (this.state.mode === "row") {
      this.state = { ...this.state, mode: "column", lockedRowIndex: this.state.activeRowIndex, activeColIndex: 0 };
      this.restartScanTimer();
      this.emitState();
      return;
    }
    const row = KEYBOARD_ROWS[this.state.lockedRowIndex ?? 0]!;
    this.applyKey(row[this.state.activeColIndex ?? 0]!);
  }

  /** Routed from IntentCommand.REJECT while active: back out one level - out of a
   * locked row, or (with nothing locked) close the keyboard without committing anything. */
  cancel(): void {
    if (!this.state.active) return;
    if (this.state.mode === "column") {
      this.backToRowScan();
      return;
    }
    this.stopScanTimer();
    this.state = { ...initialState(), active: false };
    this.emit({ type: "cancelled" });
    this.emitState();
  }

  private backToRowScan(): void {
    this.state = { ...this.state, mode: "row", lockedRowIndex: null, activeColIndex: null, activeRowIndex: 0 };
    this.restartScanTimer();
    this.emitState();
  }

  private applyKey(key: string): void {
    if (key === "CANCEL") {
      this.stopScanTimer();
      this.state = { ...initialState(), active: false };
      this.emit({ type: "cancelled" });
      this.emitState();
      return;
    }
    if (key === "DONE") {
      const text = this.state.buffer;
      this.stopScanTimer();
      this.state = { ...initialState(), active: false };
      this.emit({ type: "done", text });
      this.emitState();
      return;
    }
    const appended = key === "SPACE" ? " " : key === "BACKSPACE" ? "" : key;
    const buffer = key === "BACKSPACE" ? this.state.buffer.slice(0, -1) : this.state.buffer + appended;
    this.state = { ...this.state, buffer };
    this.backToRowScan();
  }
}
