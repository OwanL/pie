#!/usr/bin/env node
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, readJson } from "./lib/core.mjs";
import { watchChildProcess, withProcessTreeIsolation } from "../lib/process-watchdog.mjs";

function score(scorer, workspace, taskDir) {
  return new Promise((resolveScore) => {
    const child=spawn(process.execPath,[scorer,workspace,taskDir],withProcessTreeIsolation({stdio:["ignore","pipe","pipe"],windowsHide:true}));let stdout="",stderr="",settled=false;
    const watchdog=watchChildProcess(child,{timeoutMs:10000,label:`calibration scorer ${scorer}`});
    child.stdout.on("data",chunk=>{stdout=(stdout+chunk).slice(-1_000_000);});child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-2000);});
    const finish=async(status)=>{if(settled)return;settled=true;const cleanup=await watchdog.settle().catch(()=>({gone:false}));let result;for(const line of stdout.trim().split(/\r?\n/).reverse())try{result=JSON.parse(line);break;}catch{}resolveScore({status:watchdog.timedOut||!cleanup.gone?null:status,timedOut:watchdog.timedOut,result,stderr});};
    child.on("error",error=>{stderr+=error.stack||String(error);void finish(null);});child.on("close",code=>void finish(code));
  });
}

export async function calibrateSuite(suiteId = "bespoke-optimization-v1", benchmarkRoot = join(REPO, "benchmarks")) {
  const suite = await readJson(join(benchmarkRoot, "suites", `${suiteId}.json`)), rows = [];
  for (const task of suite.tasks) {
    const taskDir = join(benchmarkRoot, "tasks", task), manifest = await readJson(join(taskDir, "task.json")), fixture = join(taskDir, manifest.fixture.path), scorer = resolve(taskDir, manifest.checks.privateScorer);
    const first = await score(scorer, fixture, taskDir), second = await score(scorer, fixture, taskDir);
    if (first.status !== 0 || !first.result?.valid) throw new Error(`${task} baseline invalid: ${JSON.stringify(first)}`);
    if (second.status !== 0 || second.result?.score !== first.result.score) throw new Error(`${task} scorer is nondeterministic`);
    if (!(first.result.score > 0 && first.result.score < 0.95)) throw new Error(`${task} baseline score lacks measurable headroom: ${first.result.score}`);
    const root = await mkdtemp(join(tmpdir(), `pie-calibrate-${task}-`)), workspace = join(root, "fixture");
    try {
      await cp(fixture, workspace, { recursive: true });
      const target = manifest.policy.allowedChangedPaths[0], source = await readFile(join(workspace, target), "utf8"), names = [...source.matchAll(/export function\s+(\w+)/g)].map(match => match[1]);
      if (!names.length) throw new Error(`${task} has no exported function in ${target}`);
      await writeFile(join(workspace, target), names.map(name => `export function ${name}(){throw new Error("calibration-invalid");}`).join("\n") + "\n");
      const invalid = await score(scorer, workspace, taskDir);
      if (invalid.status === 0 || invalid.result?.valid !== false || invalid.result?.score !== 0) throw new Error(`${task} scorer accepted an intentionally invalid implementation`);
      rows.push({ task, baselineScore: first.result.score, runtimeMs: first.result.metrics?.runtimeMs, deterministic: true, invalidRejected: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  return { suite: suiteId, valid: true, tasks: rows };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await calibrateSuite(process.argv[2]), null, 2));
}
