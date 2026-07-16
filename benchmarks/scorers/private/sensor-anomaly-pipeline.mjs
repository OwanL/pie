import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { emitScore, runIsolatedCases } from "./isolated-cases.mjs";

const [workspace, taskDir, mode, encodedCase] = process.argv.slice(2);
if (mode === "--case") {
  try {
    const [trainingSeed, testSeed, shift] = JSON.parse(encodedCase);
    const { train, predict } = await import(`${pathToFileURL(join(workspace, "src/model.mjs"))}?case=${trainingSeed}`);
    const { makeSamples } = await import(pathToFileURL(join(taskDir, "fixture/scripts/samples.mjs")));
    const { classificationMetrics } = await import(pathToFileURL(join(taskDir, "fixture/src/metrics.mjs")));
    const training = makeSamples(trainingSeed, 360, shift / 2);
    const test = makeSamples(testSeed, 260, shift);
    const started = performance.now();
    const model = JSON.parse(JSON.stringify(train(training)));
    const predictions = test.map(sample => predict(model, sample.features));
    if (!predictions.every(value => value === 0 || value === 1)) throw new Error("predict must return binary labels");
    const metrics = classificationMetrics(test.map(sample => sample.label), predictions);
    emitScore({ valid: true, quality: metrics.balancedAccuracy, runtimeMs: performance.now() - started, metrics });
  } catch (error) {
    emitScore({ valid: false, metrics: { error: String(error) } });
  }
} else {
  const cases = [[101, 307, -0.2], [211, 419, 0.15], [337, 601, 0.4], [449, 733, -0.35]];
  const isolated = runIsolatedCases(import.meta.url, workspace, taskDir, cases);
  const runtimeMs = isolated.runs.reduce((sum, run) => sum + run.runtimeMs, 0);
  const valid = isolated.valid && runtimeMs < 1000;
  const average = key => isolated.runs.reduce((sum, run) => sum + (run.metrics?.[key] || 0), 0) / isolated.runs.length;
  emitScore({ valid, score: valid ? isolated.runs.reduce((sum, run) => sum + run.quality, 0) / isolated.runs.length : 0, metrics: valid ? { runtimeMs, sensitivity: average("sensitivity"), specificity: average("specificity") } : { runtimeMs, ...isolated.failure } });
}
