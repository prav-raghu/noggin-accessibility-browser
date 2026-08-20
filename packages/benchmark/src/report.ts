/** Human-readable rendering of aggregated benchmark results - a markdown table plus a
 * one-line headline comparing mean control events across conditions (spec H1: "Agentic
 * intent control will require significantly fewer deliberate control events per
 * successful task than direct low-level control"). */
import type { AggregatedGroup } from "./aggregate.js";

function fmt(n: number): string {
  return n.toFixed(2);
}

export function toMarkdownTable(groups: AggregatedGroup[]): string {
  const header =
    "| Task | Condition | Runs | Success rate | Mean time (ms) | Mean control events | Mean confirmations |\n" +
    "|---|---|---|---|---|---|---|";
  const rows = groups.map((g) => {
    const task = g.taskId === "__overall__" ? "**overall**" : g.taskId;
    return `| ${task} | ${g.condition} | ${g.runs} | ${fmt(g.successRate * 100)}% | ${fmt(g.meanTimeMs)} | ${fmt(g.meanControlEvents)} | ${fmt(g.meanConfirmations)} |`;
  });
  return [header, ...rows].join("\n");
}

export function headline(groups: AggregatedGroup[]): string {
  const direct = groups.find((g) => g.taskId === "__overall__" && g.condition === "direct_control");
  const agentic = groups.find(
    (g) => g.taskId === "__overall__" && g.condition === "agentic_intent_control",
  );
  if (!direct || !agentic) return "Not enough data for a headline comparison.";

  const reduction =
    direct.meanControlEvents === 0
      ? 0
      : (1 - agentic.meanControlEvents / direct.meanControlEvents) * 100;

  return (
    `Agentic intent control used ${fmt(agentic.meanControlEvents)} control events/task on average ` +
    `vs ${fmt(direct.meanControlEvents)} for direct control (${fmt(reduction)}% fewer), with ` +
    `${fmt(agentic.successRate * 100)}% vs ${fmt(direct.successRate * 100)}% task success.`
  );
}
