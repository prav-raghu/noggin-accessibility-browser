// Plain vanilla JS on purpose - no build step for the feedback UI yet (see
// docs/architecture.md). Talks to apps/browser-shell/src/server.ts over WebSocket.

const connectionStatusEl = document.getElementById("connection-status");
const stateEl = document.getElementById("state");
const messageEl = document.getElementById("message");
const pendingSummaryEl = document.getElementById("pending-summary");
const btnConfirm = document.getElementById("btn-confirm");
const btnReject = document.getElementById("btn-reject");
const logEl = document.getElementById("log");
const manualActionPanelEl = document.getElementById("manual-action-panel");
const manualActionMessageEl = document.getElementById("manual-action-message");

let socket;

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}`);

  socket.addEventListener("open", () => {
    connectionStatusEl.textContent = "Connected";
  });

  socket.addEventListener("close", () => {
    connectionStatusEl.textContent = "Disconnected — retrying…";
    setTimeout(connect, 1500);
  });

  socket.addEventListener("message", (event) => {
    const update = JSON.parse(event.data);
    if (update.type === "update") applyUpdate(update);
  });
}

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function applyUpdate(update) {
  stateEl.textContent = update.state;
  messageEl.textContent = update.message ?? "";

  const keyboardActive = Boolean(update.keyboard && update.keyboard.active);
  const awaitingConfirmation = update.state === "awaiting_confirmation" && update.lastPlan;
  // While the keyboard is active it claims Confirm/Reject for select/back instead of
  // plan confirmation (see Orchestrator.handleIntent) - so both stay enabled either way.
  btnConfirm.disabled = !(awaitingConfirmation || keyboardActive);
  btnReject.disabled = !(awaitingConfirmation || keyboardActive);

  if (awaitingConfirmation) {
    const plan = update.lastPlan;
    pendingSummaryEl.textContent = `Proposed: ${plan.goal} — ${plan.steps
      .map((s) => s.description)
      .join("; ")}`;
  } else {
    pendingSummaryEl.textContent = "Nothing awaiting confirmation.";
  }

  manualActionPanelEl.hidden = update.state !== "awaiting_manual_action";
  if (!manualActionPanelEl.hidden) {
    manualActionMessageEl.textContent = update.message ?? "A challenge needs your help to continue.";
  }

  applyKeyboardState(update.keyboard);

  appendLog(update);
}

function appendLog(update) {
  const li = document.createElement("li");
  const time = new Date().toLocaleTimeString();
  const intentSummary = update.lastIntent
    ? `${update.lastIntent.intent}${update.lastIntent.concepts.length ? " " + update.lastIntent.concepts.join(",") : ""} (conf ${update.lastIntent.confidence.toFixed(2)})`
    : "";
  li.textContent = `[${time}] ${update.state}${intentSummary ? " — " + intentSummary : ""}${update.message ? " — " + update.message : ""}`;
  logEl.prepend(li);
  while (logEl.children.length > 200) logEl.removeChild(logEl.lastChild);
}

document.getElementById("btn-stop").addEventListener("click", () => send({ type: "stop" }));
document.getElementById("btn-pause").addEventListener("click", () => send({ type: "pause" }));
document.getElementById("btn-resume").addEventListener("click", () => send({ type: "resume" }));
btnConfirm.addEventListener("click", () => send({ type: "confirm" }));
btnReject.addEventListener("click", () => send({ type: "reject" }));
document.getElementById("btn-explain").addEventListener("click", () => send({ type: "query_intent" }));
document.getElementById("btn-undo").addEventListener("click", () => send({ type: "undo" }));
document
  .getElementById("btn-continue-manual")
  .addEventListener("click", () => send({ type: "continue_after_manual_action" }));

document.getElementById("goal-buttons").addEventListener("click", (event) => {
  const preset = event.target.closest("[data-preset]")?.dataset.preset;
  if (preset) send({ type: "trigger_goal", preset });
});

const goalForm = document.getElementById("goal-form");
const goalInput = document.getElementById("goal-input");
goalForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = goalInput.value.trim();
  if (!text) return;
  send({ type: "trigger_free_text_goal", text });
  goalInput.value = "";
});

// Theme: the accent color defaults to the Noggin logo's pink (set in styles.css) but is
// user-customizable and persisted per-browser. It's purely decorative (borders/focus
// rings via var(--accent)), never the only way state is conveyed, so any color choice
// stays usable. localStorage can throw (private browsing, blocked site data) or just be
// unavailable - every access below is wrapped so a customized theme degrades to "doesn't
// persist across reloads" rather than breaking the page.
const THEME_STORAGE_KEY = "noggin.theme.accent";
const accentInput = document.getElementById("theme-accent");
const defaultAccent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();

function applyAccent(hex) {
  document.documentElement.style.setProperty("--accent", hex);
  accentInput.value = hex;
}

(function loadTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Ignore - fall through to the CSS default.
  }
  if (saved) applyAccent(saved);
  else accentInput.value = defaultAccent;
})();

accentInput.addEventListener("input", () => {
  applyAccent(accentInput.value);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, accentInput.value);
  } catch {
    // Ignore - the color still applies for this session, it just won't persist.
  }
});

document.getElementById("btn-theme-reset").addEventListener("click", () => {
  document.documentElement.style.removeProperty("--accent");
  try {
    localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Ignore.
  }
  accentInput.value = defaultAccent;
});

// Onscreen scanning keyboard: mirrors packages KEYBOARD_ROWS in
// apps/browser-shell/src/onscreen-keyboard.ts. Purely a view - the scan clock and
// select/cancel logic are server-side and authoritative (see that file's header
// comment for why); this only ever renders whatever `update.keyboard` says.
const KEYBOARD_ROWS = [
  ["A", "B", "C", "D", "E", "F"],
  ["G", "H", "I", "J", "K", "L"],
  ["M", "N", "O", "P", "Q", "R"],
  ["S", "T", "U", "V", "W", "X"],
  ["Y", "Z", "SPACE", "BACKSPACE", "DONE", "CANCEL"],
];

const keyboardPanelEl = document.getElementById("keyboard-panel");
const keyboardGridEl = document.getElementById("keyboard-grid");
const keyboardBufferEl = document.getElementById("keyboard-buffer");
const btnToggleKeyboard = document.getElementById("btn-toggle-keyboard");

KEYBOARD_ROWS.forEach((row, rowIndex) => {
  const rowEl = document.createElement("div");
  rowEl.className = "kb-row";
  rowEl.dataset.rowIndex = String(rowIndex);
  row.forEach((key) => {
    const keyEl = document.createElement("span");
    keyEl.className = "kb-key";
    keyEl.textContent = key;
    rowEl.appendChild(keyEl);
  });
  keyboardGridEl.appendChild(rowEl);
});

function applyKeyboardState(kb) {
  const active = Boolean(kb && kb.active);
  keyboardPanelEl.hidden = !active;
  btnToggleKeyboard.textContent = active ? "Hide onscreen keyboard" : "Show onscreen keyboard";
  keyboardBufferEl.textContent = active && kb.buffer ? kb.buffer : "(empty)";

  const rowEls = keyboardGridEl.children;
  for (let r = 0; r < rowEls.length; r++) {
    const rowEl = rowEls[r];
    const isHighlightedRow = active && ((kb.mode === "row" && kb.activeRowIndex === r) || kb.lockedRowIndex === r);
    rowEl.classList.toggle("active", isHighlightedRow);

    const keyEls = rowEl.children;
    for (let c = 0; c < keyEls.length; c++) {
      const isHighlightedKey = active && kb.mode === "column" && kb.lockedRowIndex === r && kb.activeColIndex === c;
      keyEls[c].classList.toggle("active", isHighlightedKey);
    }
  }
}

btnToggleKeyboard.addEventListener("click", () => send({ type: "toggle_onscreen_keyboard" }));

connect();
