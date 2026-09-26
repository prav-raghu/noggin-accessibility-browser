import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BrowserActionType, type BrowserAction } from "@noggin/intent-contract";
import { BrowserExecutor, NotImplementedActionError } from "./index.js";

// Self-contained fixture page so this test needs no network access.
const FIXTURE_URL =
  "data:text/html," +
  encodeURIComponent(`
    <html>
      <body>
        <h1>Fixture Page</h1>
        <a href="#" role="link">Open Season 9</a>
        <video></video>
        <input type="text" aria-label="Search box" />
      </body>
    </html>
  `);

let executor: BrowserExecutor;

before(async () => {
  executor = new BrowserExecutor({ headless: true });
  await executor.launch();
});

after(async () => {
  await executor.close();
});

function makeAction(overrides: Partial<BrowserAction>): BrowserAction {
  return {
    id: "test-action",
    type: BrowserActionType.NAVIGATE,
    params: {},
    riskTier: 1,
    description: "test",
    ...overrides,
  };
}

test("navigate action loads the fixture page", async () => {
  const result = await executor.execute(
    makeAction({ type: BrowserActionType.NAVIGATE, params: { url: FIXTURE_URL } }),
  );
  assert.ok(result.ok);
  assert.match(result.context.url, /^data:text\/html/);
});

test("read_page returns extracted text", async () => {
  const result = await executor.execute(makeAction({ type: BrowserActionType.READ_PAGE }));
  assert.ok(result.ok);
  assert.match(result.detail, /Fixture Page/);
});

test("click_by_role finds and clicks an accessibility-tree-grounded element", async () => {
  const result = await executor.execute(
    makeAction({
      type: BrowserActionType.CLICK_BY_ROLE,
      params: { role: "link", nameContains: "Season 9" },
    }),
  );
  assert.ok(result.ok);
});

test("getAccessibilityTree returns CDP AX nodes", async () => {
  const tree = await executor.getAccessibilityTree();
  assert.ok(Array.isArray(tree));
  assert.ok(tree.length > 0);
});

test("Tier 2+ actions without a generic implementation throw NotImplementedActionError", async () => {
  await assert.rejects(
    () => executor.execute(makeAction({ type: BrowserActionType.PURCHASE })),
    NotImplementedActionError,
  );
});

test("fill_field types into a text field", async () => {
  await executor.execute(makeAction({ type: BrowserActionType.NAVIGATE, params: { url: FIXTURE_URL } }));
  const result = await executor.execute(
    makeAction({
      type: BrowserActionType.FILL_FIELD,
      params: { value: "hello", nameContains: "Search" },
    }),
  );
  assert.ok(result.ok);
});

test("navigate refuses a javascript: URL regardless of which planner produced it", async () => {
  const before = await executor.getPageContext();
  const result = await executor.execute(
    makeAction({ type: BrowserActionType.NAVIGATE, params: { url: "javascript:alert(1)" } }),
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /refused to navigate/);
  // The page must not have actually navigated anywhere.
  assert.equal(result.context.url, before.url);
});

test("navigate refuses a file: URL", async () => {
  const result = await executor.execute(
    makeAction({ type: BrowserActionType.NAVIGATE, params: { url: "file:///etc/passwd" } }),
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /refused to navigate/);
});

test("navigate allows http(s) and data: URLs", async () => {
  const result = await executor.execute(
    makeAction({ type: BrowserActionType.NAVIGATE, params: { url: FIXTURE_URL } }),
  );
  assert.ok(result.ok);
});
