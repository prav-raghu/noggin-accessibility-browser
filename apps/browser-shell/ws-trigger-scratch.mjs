// Scratch driver - not part of the app. Drives the running control panel over
// WebSocket exactly like public/app.js does, to test an open-ended goal end-to-end.
// Delete after use.
import WebSocket from "ws";

const goal = process.argv[2] ?? "google search cake video and then play it on youtube";
const ws = new WebSocket("ws://localhost:4173");

ws.on("open", () => {
  console.log(`[driver] connected - sending goal: "${goal}"`);
  ws.send(JSON.stringify({ type: "trigger_free_text_goal", text: goal }));
});

ws.on("message", (data) => {
  const update = JSON.parse(data.toString());
  if (update.type !== "update") return;
  console.log(
    `[update] state=${update.state}${update.message ? ` msg="${update.message}"` : ""}` +
      (update.lastPlan ? ` plan.goal="${update.lastPlan.goal}" steps=${update.lastPlan.steps.length}` : ""),
  );
  if (update.lastPlan) {
    for (const step of update.lastPlan.steps) {
      console.log(`   - ${step.type} ${JSON.stringify(step.params)} :: ${step.description}`);
    }
  }
});

ws.on("close", () => console.log("[driver] socket closed"));
ws.on("error", (err) => console.error("[driver] error", err));

setTimeout(() => {
  console.log("[driver] done observing, exiting");
  ws.close();
  process.exit(0);
}, 60_000);
