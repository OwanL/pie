import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function runIsolatedCases(scorerUrl, workspace, taskDir, cases, timeoutMs = 1200) {
  const scorerPath = fileURLToPath(scorerUrl);
  const runs = [];
  for (const testCase of cases) {
    const child = spawnSync(process.execPath, [scorerPath, workspace, taskDir, "--case", JSON.stringify(testCase)], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1_000_000,
      windowsHide: true,
    });
    if (child.error?.code === "ETIMEDOUT") return { valid: false, runs, failure: { type: "case_timeout", case: testCase, timeoutMs } };
    let result;
    for (const line of (child.stdout || "").trim().split(/\r?\n/).reverse()) {
      try { result = JSON.parse(line); break; } catch {}
    }
    if (child.status !== 0 || !result?.valid) {
      return { valid: false, runs, failure: { type: "case_failure", case: testCase, status: child.status, error: result?.metrics?.error || (child.stderr || "").slice(-1000) } };
    }
    runs.push(result);
  }
  return { valid: true, runs };
}

export function emitScore(result) {
  console.log(JSON.stringify(result));
  if (!result.valid) process.exitCode = 1;
}
