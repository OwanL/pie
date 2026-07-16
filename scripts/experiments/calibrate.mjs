#!/usr/bin/env node
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, readJson } from "./lib/core.mjs";

function score(scorer, workspace, taskDir) {
  const run = spawnSync(process.execPath, [scorer, workspace, taskDir], { encoding: "utf8", timeout: 10000, maxBuffer: 1_000_000 });
  let result;
  for (const line of (run.stdout || "").trim().split(/\r?\n/).reverse()) try { result = JSON.parse(line); break; } catch {}
  return { status: run.status, timedOut: run.error?.code === "ETIMEDOUT", result, stderr: (run.stderr || "").slice(-2000) };
}

export async function calibrateSuite(suiteId = "bespoke-optimization-v1", benchmarkRoot = join(REPO, "benchmarks")) {
  const suite = await readJson(join(benchmarkRoot, "suites", `${suiteId}.json`)), rows = [];
  for (const task of suite.tasks) {
    const taskDir = join(benchmarkRoot, "tasks", task), manifest = await readJson(join(taskDir, "task.json")), fixture = join(taskDir, manifest.fixture.path), scorer = resolve(taskDir, manifest.checks.privateScorer);
    const first = score(scorer, fixture, taskDir), second = score(scorer, fixture, taskDir);
    if (first.status !== 0 || !first.result?.valid) throw new Error(`${task} baseline invalid: ${JSON.stringify(first)}`);
    if (second.status !== 0 || second.result?.score !== first.result.score) throw new Error(`${task} scorer is nondeterministic`);
    if (!(first.result.score > 0 && first.result.score < 0.95)) throw new Error(`${task} baseline score lacks measurable headroom: ${first.result.score}`);
    const root = await mkdtemp(join(tmpdir(), `pie-calibrate-${task}-`)), workspace = join(root, "fixture");
    try {
      await cp(fixture, workspace, { recursive: true });
      const target = manifest.policy.allowedChangedPaths[0], source = await readFile(join(workspace, target), "utf8"), names = [...source.matchAll(/export function\s+(\w+)/g)].map(match => match[1]);
      if (!names.length) throw new Error(`${task} has no exported function in ${target}`);
      await writeFile(join(workspace, target), names.map(name => `export function ${name}(){throw new Error("calibration-invalid");}`).join("\n") + "\n");
      const invalid = score(scorer, workspace, taskDir);
      if (invalid.status === 0 || invalid.result?.valid !== false || invalid.result?.score !== 0) throw new Error(`${task} scorer accepted an intentionally invalid implementation`);
      rows.push({ task, baselineScore: first.result.score, runtimeMs: first.result.metrics?.runtimeMs, deterministic: true, invalidRejected: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  return { suite: suiteId, valid: true, tasks: rows };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await calibrateSuite(process.argv[2]), null, 2));
}
