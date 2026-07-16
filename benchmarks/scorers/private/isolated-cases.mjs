import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { watchChildProcess, withProcessTreeIsolation } from "../../../scripts/lib/process-watchdog.mjs";

async function runCase(scorerPath,workspace,taskDir,testCase,timeoutMs){return new Promise(resolveCase=>{const child=spawn(process.execPath,[scorerPath,workspace,taskDir,"--case",JSON.stringify(testCase)],withProcessTreeIsolation({windowsHide:true,stdio:["ignore","pipe","pipe"]}));let stdout="",stderr="",settled=false;const watchdog=watchChildProcess(child,{timeoutMs,label:"isolated benchmark case"});child.stdout.on("data",chunk=>{stdout=(stdout+chunk).slice(-1_000_000);});child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-1000);});const finish=async status=>{if(settled)return;settled=true;const cleanup=await watchdog.settle().catch(()=>({gone:false}));resolveCase({status:watchdog.timedOut||!cleanup.gone?null:status,timedOut:watchdog.timedOut,stdout,stderr,cleanup});};child.on("error",error=>{stderr+=error.stack||String(error);void finish(null);});child.on("close",code=>void finish(code));});}

export async function runIsolatedCases(scorerUrl, workspace, taskDir, cases, timeoutMs = 1200) {
  const scorerPath = fileURLToPath(scorerUrl);
  const runs = [];
  for (const testCase of cases) {
    const child = await runCase(scorerPath,workspace,taskDir,testCase,timeoutMs);
    if (child.timedOut) return { valid: false, runs, failure: { type: "case_timeout", case: testCase, timeoutMs } };
    if (!child.cleanup.gone) return { valid: false, runs, failure: { type: "case_cleanup_failure", case: testCase, survivors: child.cleanup.survivors } };
    let result;
    for (const line of child.stdout.trim().split(/\r?\n/).reverse()) {
      try { result = JSON.parse(line); break; } catch {}
    }
    if (child.status !== 0 || !result?.valid) {
      return { valid: false, runs, failure: { type: "case_failure", case: testCase, status: child.status, error: result?.metrics?.error || child.stderr.slice(-1000) } };
    }
    runs.push(result);
  }
  return { valid: true, runs };
}

export function emitScore(result) {
  console.log(JSON.stringify(result));
  if (!result.valid) process.exitCode = 1;
}
