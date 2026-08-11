import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AuditEventType, JsonlAuditStore } from "./index.js";

let dir: string;
let store: JsonlAuditStore;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "noggin-audit-"));
  store = new JsonlAuditStore(join(dir, "events.jsonl"));
});

after(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

test("record() assigns id/timestamp and persists as JSONL", async () => {
  const event = await store.record({
    type: AuditEventType.NEURAL_INTENT,
    sessionId: "s1",
    payload: { concepts: ["youtube"] },
  });
  assert.ok(event.id);
  assert.ok(event.timestamp);

  const all = await store.all();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.type, AuditEventType.NEURAL_INTENT);
});

test("concurrent record() calls do not corrupt the file", async () => {
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.record({ type: AuditEventType.EXECUTED_ACTION, sessionId: "s1", payload: { i } }),
    ),
  );
  const all = await store.all();
  // 1 from the previous test + 20 here.
  assert.equal(all.length, 21);
  for (const e of all) {
    assert.ok(e.id);
  }
});

test("byType and bySession filter correctly", async () => {
  await store.record({ type: AuditEventType.GATEWAY_DECISION, sessionId: "s2", payload: {} });
  const decisions = await store.byType(AuditEventType.GATEWAY_DECISION);
  assert.equal(decisions.length, 1);

  const session2 = await store.bySession("s2");
  assert.equal(session2.length, 1);
});
