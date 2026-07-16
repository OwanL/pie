import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { emitScore, runIsolatedCases } from "./isolated-cases.mjs";

const [workspace, taskDir, mode, encodedCase] = process.argv.slice(2);
if (mode === "--case") {
  try {
    const seed = JSON.parse(encodedCase);
    const { planBatches } = await import(`${pathToFileURL(join(workspace, "src/scheduler.mjs"))}?case=${seed}`);
    const { evaluatePlan } = await import(pathToFileURL(join(taskDir, "fixture/src/replay-runtime.mjs")));
    const { makeWorkload } = await import(pathToFileURL(join(taskDir, "fixture/scripts/workload.mjs")));
    const limits = JSON.parse(await readFile(join(taskDir, "fixture/config/replay.json")));
    const requests = makeWorkload(seed, 42);
    const started = performance.now();
    const run = evaluatePlan(requests, limits, planBatches(structuredClone(requests), structuredClone(limits)));
    emitScore({ valid: run.valid, quality: run.quality, runtimeMs: performance.now() - started, metrics: run.metrics });
  } catch (error) {
    emitScore({ valid: false, metrics: { error: String(error) } });
  }
} else {
  const isolated = runIsolatedCases(import.meta.url, workspace, taskDir, [103, 211, 389, 557, 701]);
  const runtimeMs = isolated.runs.reduce((sum, run) => sum + run.runtimeMs, 0);
  const valid = isolated.valid && runtimeMs < 1000;
  const average = key => isolated.runs.reduce((sum, run) => sum + (run.metrics?.[key] || 0), 0) / isolated.runs.length;
  emitScore({ valid, score: valid ? isolated.runs.reduce((sum, run) => sum + run.quality, 0) / isolated.runs.length : 0, metrics: valid ? { runtimeMs, deadlineUtility: average("deadlineUtility"), computeEfficiency: average("computeEfficiency") } : { runtimeMs, ...isolated.failure } });
}
