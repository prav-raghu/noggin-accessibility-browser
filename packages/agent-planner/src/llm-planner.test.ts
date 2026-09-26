import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createIntentEvent, IntentCommand, planRiskTier, RiskTier } from "@noggin/intent-contract";
import { LlmPlanner, OllamaLlmClient, type LlmClient } from "./llm-planner.js";
import { redactSecrets, SecretVault } from "./secret-vault.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Stubs global fetch with a canned JSON response for the OllamaLlmClient tests below. */
function stubFetch(body: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status })) as typeof fetch;
}

function goalIntent(text: string, confidence = 1) {
  return createIntentEvent({
    source: "test",
    intent: IntentCommand.EXECUTE_GOAL,
    concepts: text.trim().length > 0 ? text.trim().split(/\s+/) : [],
    confidence,
    requires_confirmation: false,
    signal_provenance: { decoder: "test", session: "test" },
  });
}

/** Records the last prompt it was given and returns a fixed, canned response. */
function fakeClient(response: unknown): LlmClient & { lastUser?: string } {
  const client: LlmClient & { lastUser?: string } = {
    async proposePlan(input) {
      client.lastUser = input.user;
      return response;
    },
  };
  return client;
}

test("plans the YouTube sumo goal into navigate/search/click/play steps", async () => {
  const client = fakeClient({
    goal: "Open YouTube and watch sumo",
    steps: [
      { type: "navigate", params: { url: "https://www.youtube.com" }, description: "Navigate to YouTube" },
      { type: "search", params: { query: "sumo" }, description: "Search YouTube for sumo" },
      {
        type: "click_by_role",
        params: { role: "link", nameContains: "sumo" },
        description: "Open the most likely sumo result",
      },
      { type: "play_pause_media", params: {}, description: "Start playback" },
    ],
  });

  const planner = new LlmPlanner({ client });
  const plan = await planner.plan(goalIntent("open youtube to watch the sumo"), {});

  assert.ok(plan);
  assert.deepEqual(
    plan.steps.map((s) => s.type),
    ["navigate", "search", "click_by_role", "play_pause_media"],
  );
  // Risk tier is always derived locally, never trusted from the model's output.
  assert.equal(planRiskTier(plan), RiskTier.REVERSIBLE_NAVIGATION);
});

test("plans a Google search goal", async () => {
  const client = fakeClient({
    goal: "Search Google for the best vegan recipes",
    steps: [
      { type: "navigate", params: { url: "https://www.google.com" }, description: "Navigate to Google" },
      { type: "search", params: { query: "best vegan recipes" }, description: "Search for best vegan recipes" },
      { type: "read_page", params: {}, description: "Read back the top result" },
    ],
  });

  const planner = new LlmPlanner({ client });
  const plan = await planner.plan(goalIntent("google search best vegan recipes"), {});

  assert.ok(plan);
  assert.ok(plan.steps.some((s) => s.type === "search" && s.params.query === "best vegan recipes"));
});

test("a Facebook login goal redacts the password before it reaches the LLM and requires confirmation", async () => {
  const client = fakeClient({
    goal: "Log into Facebook",
    steps: [
      { type: "navigate", params: { url: "https://www.facebook.com" }, description: "Navigate to Facebook" },
      {
        type: "fill_field",
        params: { value: "pravir.raghu@tesmail.com", nameContains: "email" },
        description: "Fill in the email field",
      },
      {
        type: "fill_field",
        params: { value: "{{SECRET_1}}", nameContains: "password", fieldType: "password" },
        description: "Fill in the password field",
      },
      { type: "submit_form", params: {}, description: "Submit the login form" },
    ],
  });

  const vault = new SecretVault();
  const planner = new LlmPlanner({ client, vault });
  const intent = goalIntent(
    "visit facebook and login with my username of pravir.raghu@tesmail.com and password password123",
  );
  const plan = await planner.plan(intent, {});

  assert.ok(plan);
  // The real password must never appear in what was sent to the model.
  assert.ok(client.lastUser);
  assert.ok(!client.lastUser?.includes("password123"));
  assert.ok(client.lastUser?.includes("{{SECRET_1}}"));

  // The plan itself only carries the placeholder - never the real secret.
  const passwordStep = plan.steps.find((s) => s.params.fieldType === "password");
  assert.ok(passwordStep);
  assert.equal(passwordStep.params.value, "{{SECRET_1}}");

  // submit_form (Tier 2) dominates the plan's risk tier, so the gateway will pause for
  // confirmation before the credentials are ever actually transmitted.
  assert.equal(planRiskTier(plan), RiskTier.COMMUNICATION);

  // Only resolveParams() - called by the orchestrator right before the live executor
  // call - ever reveals the real value.
  assert.equal(vault.resolve(passwordStep.params).value, "password123");
  assert.equal(passwordStep.params.value, "{{SECRET_1}}", "resolve() must not mutate the original params");
});

test("returns null (asks for clarification) when the model sets clarification_needed", async () => {
  const client = fakeClient({ clarification_needed: "Which site did you mean?" });
  const planner = new LlmPlanner({ client });
  const plan = await planner.plan(goalIntent("do the thing"), {});
  assert.equal(plan, null);
});

test("returns null and does not throw when the model returns malformed output", async () => {
  const client = fakeClient({ not: "a valid plan" });
  const planner = new LlmPlanner({ client });
  const plan = await planner.plan(goalIntent("open youtube"), {});
  assert.equal(plan, null);
});

test("returns null and does not throw when the LLM call itself fails", async () => {
  const client: LlmClient = {
    async proposePlan() {
      throw new Error("network unreachable");
    },
  };
  const planner = new LlmPlanner({ client });
  const plan = await planner.plan(goalIntent("open youtube"), {});
  assert.equal(plan, null);
});

test("returns null for an empty goal without calling the LLM", async () => {
  let called = false;
  const client: LlmClient = {
    async proposePlan() {
      called = true;
      return { goal: "x", steps: [] };
    },
  };
  const planner = new LlmPlanner({ client });
  const plan = await planner.plan(goalIntent(""), {});
  assert.equal(plan, null);
  assert.equal(called, false);
});

test("OllamaLlmClient parses Ollama-native tool calls (already-parsed object arguments)", async () => {
  stubFetch({
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name: "propose_plan",
                arguments: { goal: "x", steps: [{ type: "navigate", params: {}, description: "d" }] },
              },
            },
          ],
        },
      },
    ],
  });

  const client = new OllamaLlmClient({ model: "llama3.1" });
  const result = await client.proposePlan({ system: "s", user: "u" });
  assert.deepEqual(result, { goal: "x", steps: [{ type: "navigate", params: {}, description: "d" }] });
});

test("OllamaLlmClient parses OpenAI-style tool calls (JSON-stringified arguments)", async () => {
  stubFetch({
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name: "propose_plan",
                arguments: JSON.stringify({ goal: "x", steps: [] }),
              },
            },
          ],
        },
      },
    ],
  });

  const client = new OllamaLlmClient({ model: "llama3.1" });
  const result = await client.proposePlan({ system: "s", user: "u" });
  assert.deepEqual(result, { goal: "x", steps: [] });
});

test("OllamaLlmClient throws a clear error when the model didn't call the tool", async () => {
  stubFetch({ choices: [{ message: {} }] });
  const client = new OllamaLlmClient({ model: "some-model-without-tool-support" });
  await assert.rejects(() => client.proposePlan({ system: "s", user: "u" }), /did not return/);
});

test("OllamaLlmClient throws on a non-ok HTTP response", async () => {
  stubFetch({ error: "model not found" }, 404);
  const client = new OllamaLlmClient({ model: "not-pulled" });
  await assert.rejects(() => client.proposePlan({ system: "s", user: "u" }), /404/);
});

test("redactSecrets extracts a password and leaves the rest of the sentence intact", () => {
  const { sanitized, secrets } = redactSecrets(
    "visit facebook and login with my username of pravir.raghu@tesmail.com and password password123",
  );
  assert.match(sanitized, /\{\{SECRET_1\}\}/);
  assert.ok(!sanitized.includes("password123"));
  assert.ok(sanitized.includes("pravir.raghu@tesmail.com"));
  assert.equal(secrets.get("{{SECRET_1}}"), "password123");
});
