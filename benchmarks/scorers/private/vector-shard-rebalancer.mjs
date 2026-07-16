import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { emitScore, runIsolatedCases } from "./isolated-cases.mjs";

const [workspace, taskDir, mode, encodedCase] = process.argv.slice(2);
if (mode === "--case") {
  try {
    const seed = JSON.parse(encodedCase);
    const { rebalance } = await import(`${pathToFileURL(join(workspace, "src/rebalance.mjs"))}?case=${seed}`);
    const { evaluatePlacement } = await import(pathToFileURL(join(taskDir, "fixture/src/topology-runtime.mjs")));
    const { makeTopology } = await import(pathToFileURL(join(taskDir, "fixture/scripts/topology-data.mjs")));
    const limits = JSON.parse(await readFile(join(taskDir, "fixture/config/rebalance.json")));
    const topology = makeTopology(seed, 21);
    const started = performance.now();
    const run = evaluatePlacement(topology, limits, rebalance(structuredClone(topology), structuredClone(limits)));
    emitScore({ valid: run.valid, quality: run.quality, runtimeMs: performance.now() - started, metrics: run.metrics });
  } catch (error) {
    emitScore({ valid: false, metrics: { error: String(error) } });
  }
} else {
  const isolated = runIsolatedCases(import.meta.url, workspace, taskDir, [109, 227, 401, 599, 811]);
  const runtimeMs = isolated.runs.reduce((sum, run) => sum + run.runtimeMs, 0);
  const valid = isolated.valid && runtimeMs < 1000;
  const average = key => isolated.runs.reduce((sum, run) => sum + (run.metrics?.[key] || 0), 0) / isolated.runs.length;
  emitScore({ valid, score: valid ? isolated.runs.reduce((sum, run) => sum + run.quality, 0) / isolated.runs.length : 0, metrics: valid ? { runtimeMs, peakUtilization: average("peakUtilization"), migrationCost: average("migrationCost") } : { runtimeMs, ...isolated.failure } });
}
