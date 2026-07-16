import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { emitScore, runIsolatedCases } from "./isolated-cases.mjs";

const [workspace, taskDir, mode, encodedCase] = process.argv.slice(2);
if (mode === "--case") {
  try {
    const seed = JSON.parse(encodedCase);
    const { buildCachePlan } = await import(`${pathToFileURL(join(workspace, "src/planner.mjs"))}?case=${seed}`);
    const { evaluatePlan } = await import(pathToFileURL(join(taskDir, "fixture/src/cache-runtime.mjs")));
    const { makeCatalog } = await import(pathToFileURL(join(taskDir, "fixture/scripts/catalog.mjs")));
    const config = JSON.parse(await readFile(join(taskDir, "fixture/config/cache.json")));
    const features = makeCatalog(seed, 34);
    const started = performance.now();
    const run = evaluatePlan(features, config, buildCachePlan(structuredClone(features), structuredClone(config)));
    emitScore({ valid: run.valid, quality: run.quality, runtimeMs: performance.now() - started, metrics: run.metrics });
  } catch (error) {
    emitScore({ valid: false, metrics: { error: String(error) } });
  }
} else {
  const isolated = await runIsolatedCases(import.meta.url, workspace, taskDir, [107, 239, 419, 601, 887]);
  const runtimeMs = isolated.runs.reduce((sum, run) => sum + run.runtimeMs, 0);
  const valid = isolated.valid && runtimeMs < 1000;
  const average = key => isolated.runs.reduce((sum, run) => sum + (run.metrics?.[key] || 0), 0) / isolated.runs.length;
  emitScore({ valid, score: valid ? isolated.runs.reduce((sum, run) => sum + run.quality, 0) / isolated.runs.length : 0, metrics: valid ? { runtimeMs, savedCompute: average("savedCompute"), freshnessPenalty: average("freshnessPenalty"), usedBytes: average("usedBytes") } : { runtimeMs, ...isolated.failure } });
}
