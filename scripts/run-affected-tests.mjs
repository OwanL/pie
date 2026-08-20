#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withoutGitRepositoryEnv } from './lib/git-environment.mjs';
import { withoutPiHarnessEnv } from './lib/pi-harness-env.mjs';
import { planAffectedTests } from './lib/test-impact.mjs';
import { getChangedFiles } from './lib/git-changed-files.mjs';
import {
  abortOnProcessSignals,
  resolveChildProcessTimeoutMs,
  watchChildProcess,
  withProcessTreeIsolation,
} from './lib/process-watchdog.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runNodeScript(script, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], withProcessTreeIsolation({
      cwd: repoRoot,
      env: withoutPiHarnessEnv(withoutGitRepositoryEnv(process.env)),
      stdio: 'inherit',
      windowsHide: true,
    }));
    const watchdog = watchChildProcess(child, {
      timeoutMs: resolveChildProcessTimeoutMs(),
      signal,
      label: 'affected-test runner',
    });
    child.on('error', async (error) => {
      await watchdog.settle().catch(() => {});
      reject(error);
    });
    child.on('close', async (code) => {
      const cleanup = await watchdog.settle().catch(() => ({ gone: false }));
      resolve(watchdog.timedOut || watchdog.aborted || !cleanup.gone ? 1 : (code ?? 0));
    });
  });
}

export async function buildAffectedTestPlan(root = repoRoot) {
  const changedFiles = await getChangedFiles(root);
  return { changedFiles, plan: planAffectedTests(root, changedFiles) };
}

async function main() {
  const forceAll = process.argv.slice(2).includes('--all');
  const { changedFiles, plan } = forceAll
    ? { changedFiles: [], plan: { mode: 'full', testFiles: [], reasons: ['--all requested'] } }
    : await buildAffectedTestPlan();

  if (plan.mode === 'none') {
    console.log(changedFiles.length === 0
      ? 'No working-tree changes detected; no tests need to be rerun.'
      : `No tests are affected by ${changedFiles.length} changed file(s).`);
    return;
  }

  const abort = abortOnProcessSignals();
  let exitCode;
  try {
    if (plan.mode === 'full') {
      console.log(`Running the full fast suite (${plan.reasons.join('; ')}).`);
      exitCode = await runNodeScript(path.join(repoRoot, 'scripts', 'run-tests.mjs'), ['--fast'], abort.signal);
    } else {
      console.log(`Running ${plan.testFiles.length} affected test file(s) in parallel.`);
      for (const reason of plan.reasons) console.log(`- ${reason}`);
      exitCode = await runNodeScript(path.join(repoRoot, 'scripts', 'run-test-files.mjs'), plan.testFiles, abort.signal);
    }
  } finally {
    abort.dispose();
  }
  if (exitCode !== 0) process.exitCode = exitCode;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
