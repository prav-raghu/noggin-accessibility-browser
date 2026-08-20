/**
 * M4 baseline experiment CLI: `npm run benchmark` (from repo root) or
 * `npm run benchmark --workspace @noggin/benchmark-cli`.
 *
 * Runs the full `@noggin/task-suite` under both experimental conditions defined in
 * `@noggin/benchmark`, prints the spec-section-15 summary table, and writes reproducible
 * JSON (raw per-run metrics) + markdown (the same table) to `run-data/` so results can be
 * diffed/replayed across code changes.
 *
 * Env vars:
 *   NOGGIN_HEADLESS=false        run Chromium headed (needs a display)
 *   NOGGIN_BENCHMARK_REPS=5      repetitions per task per condition
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, BenchmarkHarness, headline, toMarkdownTable } from "@noggin/benchmark";
import { BrowserExecutor } from "@noggin/browser-executor";
import { TASKS } from "@noggin/task-suite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RUN_DATA_DIR = join(__dirname, "..", "..", "..", "run-data");

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() !== "false" && raw !== "0";
}

async function main(): Promise<void> {
  const headless = envBool("NOGGIN_HEADLESS", true);
  const repetitions = Number(process.env.NOGGIN_BENCHMARK_REPS ?? 5);

  console.log(
    `[benchmark] running ${TASKS.length} tasks x 2 conditions x ${repetitions} repetition(s) (headless=${headless})`,
  );

  const executor = new BrowserExecutor({ headless });
  await executor.launch();

  let results;
  try {
    const harness = new BenchmarkHarness({ executor });
    results = await harness.runSuite(TASKS, repetitions);
  } finally {
    await executor.close();
  }

  const groups = aggregate(results);
  const table = toMarkdownTable(groups);
  const summary = headline(groups);

  console.log("");
  console.log(table);
  console.log("");
  console.log(summary);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(RUN_DATA_DIR, { recursive: true });

  const jsonPath = join(RUN_DATA_DIR, `benchmark-${timestamp}.json`);
  const mdPath = join(RUN_DATA_DIR, `benchmark-${timestamp}.md`);

  await writeFile(jsonPath, JSON.stringify({ timestamp, repetitions, results, groups }, null, 2), "utf8");
  await writeFile(mdPath, `# Benchmark run ${timestamp}\n\n${table}\n\n${summary}\n`, "utf8");

  console.log(`\n[benchmark] wrote ${jsonPath}`);
  console.log(`[benchmark] wrote ${mdPath}`);

  const anyFailure = results.some((r) => !r.success);
  process.exit(anyFailure ? 1 : 0);
}

main().catch((err) => {
  console.error("[benchmark] fatal error", err);
  process.exit(1);
});
