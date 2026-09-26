import assert from "node:assert/strict";
import { test } from "node:test";
import { KEYBOARD_ROWS, OnscreenKeyboard, type OnscreenKeyboardEvent } from "./onscreen-keyboard.js";

function collectEvents(kb: OnscreenKeyboard): OnscreenKeyboardEvent[] {
  const events: OnscreenKeyboardEvent[] = [];
  kb.on((e) => events.push(e));
  return events;
}

test("is inactive until activate() is called, and select()/cancel()/advance() are no-ops until then", () => {
  const kb = new OnscreenKeyboard();
  const events = collectEvents(kb);
  kb.select();
  kb.cancel();
  kb.advance();
  assert.equal(events.length, 0);
  assert.equal(kb.getState().active, false);
});

test("advance() cycles activeRowIndex and wraps around", () => {
  const kb = new OnscreenKeyboard();
  kb.activate();
  assert.equal(kb.getState().activeRowIndex, 0);
  for (let i = 0; i < KEYBOARD_ROWS.length; i++) kb.advance();
  // Wrapped all the way around back to 0.
  assert.equal(kb.getState().activeRowIndex, 0);
  kb.deactivate(); // stop the scan timer - activate() leaves it running otherwise
});

test("select() locks the highlighted row and starts scanning its columns", () => {
  const kb = new OnscreenKeyboard();
  kb.activate();
  kb.advance(); // row 0 -> 1 ("G H I J K L")
  kb.select();
  const state = kb.getState();
  assert.equal(state.mode, "column");
  assert.equal(state.lockedRowIndex, 1);
  assert.equal(state.activeColIndex, 0);
  kb.deactivate();
});

test("select() while column-scanning commits the highlighted key and returns to row scanning", () => {
  const kb = new OnscreenKeyboard();
  kb.activate();
  kb.advance(); // row -> 1 ("G H I J K L")
  kb.select(); // lock row 1, col 0 ("G")
  kb.advance(); // col -> 1 ("H")
  kb.select(); // commit "H"

  const state = kb.getState();
  assert.equal(state.buffer, "H");
  assert.equal(state.mode, "row");
  assert.equal(state.lockedRowIndex, null);
  assert.equal(state.activeRowIndex, 0);
  kb.deactivate();
});

test("composes a full word (\"HI\") via row/column selection", () => {
  const kb = new OnscreenKeyboard();
  kb.activate();

  kb.advance(); // row 1
  kb.select(); // lock row 1 ("G H I J K L")
  kb.advance(); // col 1 ("H")
  kb.select(); // buffer: "H"

  kb.advance(); // row 1
  kb.select(); // lock row 1
  kb.advance(); // col 1
  kb.advance(); // col 2 ("I")
  kb.select(); // buffer: "HI"

  assert.equal(kb.getState().buffer, "HI");
  kb.deactivate();
});

test("SPACE appends a space and BACKSPACE removes the last character", () => {
  const kb = new OnscreenKeyboard();
  kb.activate();

  // Row 4: Y Z SPACE BACKSPACE DONE CANCEL
  for (let i = 0; i < 4; i++) kb.advance();
  kb.select(); // lock row 4, col 0 ("Y")
  kb.select(); // commit "Y"
  assert.equal(kb.getState().buffer, "Y");

  for (let i = 0; i < 4; i++) kb.advance();
  kb.select(); // lock row 4, col 0
  kb.advance(); // col 1
  kb.advance(); // col 2 ("SPACE")
  kb.select();
  assert.equal(kb.getState().buffer, "Y ");

  for (let i = 0; i < 4; i++) kb.advance();
  kb.select();
  kb.advance();
  kb.advance();
  kb.advance(); // col 3 ("BACKSPACE")
  kb.select();
  assert.equal(kb.getState().buffer, "Y");
  kb.deactivate();
});

test("selecting DONE emits the composed text and deactivates", () => {
  const kb = new OnscreenKeyboard();
  const events = collectEvents(kb);
  kb.activate();

  kb.advance(); // row 1 ("G H I J K L")
  kb.select();
  kb.advance(); // col 1 ("H")
  kb.select(); // buffer "H"

  for (let i = 0; i < 4; i++) kb.advance(); // row 4
  kb.select(); // lock row 4, col 0
  for (let i = 0; i < 4; i++) kb.advance(); // col 4 ("DONE")
  kb.select();

  const doneEvent = events.find((e) => e.type === "done");
  assert.ok(doneEvent);
  assert.equal(doneEvent.text, "H");
  assert.equal(kb.getState().active, false);
});

test("selecting CANCEL (via scanning to it) emits cancelled and deactivates without committing", () => {
  const kb = new OnscreenKeyboard();
  const events = collectEvents(kb);
  kb.activate();

  for (let i = 0; i < 4; i++) kb.advance(); // row 4
  kb.select(); // lock row 4, col 0
  for (let i = 0; i < 5; i++) kb.advance(); // col 5 ("CANCEL")
  kb.select();

  assert.ok(events.some((e) => e.type === "cancelled"));
  assert.equal(kb.getState().active, false);
});

test("cancel() while column-scanning backs out to row-scanning without committing", () => {
  const kb = new OnscreenKeyboard();
  const events = collectEvents(kb);
  kb.activate();
  kb.advance();
  kb.select(); // lock a row
  kb.cancel();

  const state = kb.getState();
  assert.equal(state.active, true);
  assert.equal(state.mode, "row");
  assert.equal(state.lockedRowIndex, null);
  assert.equal(events.some((e) => e.type === "cancelled"), false);
  kb.deactivate();
});

test("cancel() while row-scanning (nothing locked) closes the keyboard and discards the buffer", () => {
  const kb = new OnscreenKeyboard();
  const events = collectEvents(kb);
  kb.activate();
  kb.advance();
  kb.select();
  kb.advance();
  kb.select(); // buffer now has one character
  assert.notEqual(kb.getState().buffer, "");

  kb.cancel();

  assert.equal(kb.getState().active, false);
  assert.equal(kb.getState().buffer, "");
  assert.ok(events.some((e) => e.type === "cancelled"));
});

test("the scan timer actually advances the row on its own after activate()", async () => {
  const kb = new OnscreenKeyboard({ dwellMs: 10 });
  const events = collectEvents(kb);
  kb.activate();
  await new Promise((resolve) => setTimeout(resolve, 55));
  kb.deactivate();
  // Exact tick count is timing-sensitive (and could coincidentally wrap back to row 0),
  // so assert on emitted state events rather than the row index itself: activate() plus
  // at least a couple of autonomous ticks should have fired within 55ms at a 10ms dwell.
  const stateEvents = events.filter((e) => e.type === "state");
  assert.ok(stateEvents.length >= 3, `expected several autonomous ticks, got ${stateEvents.length}`);
});
