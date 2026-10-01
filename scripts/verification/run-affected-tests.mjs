#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withoutGitRepositoryEnv } from '../lib/git-environment.mjs';
import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import { planAffectedTests } from '../lib/test-impact.mjs';
import { getChangedFiles } from '../lib/git-changed-files.mjs';
import {
  abortOnProcessSignals,
  resolveChildProcessTimeoutMs,
  watchChildProcess,
  withProcessTreeIsolation,
} from '../lib/process-watchdog.mjs';

import { extractRuntimeArgs, runtimeArgs, verificationChildEnv, withVerificationRuntime } from './verification-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function runNodeScript(script, args, signal, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], withProcessTreeIsolation({
      cwd: repoRoot,
      env: verificationChildEnv(withoutPiHarnessEnv(withoutGitRepositoryEnv(process.env))),
      stdio: stdin === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
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
      if (!cleanup.gone) { reject(new Error('Affected-test tree teardown is unconfirmed')); return; }
      resolve(watchdog.timedOut || watchdog.aborted ? 1 : (code ?? 0));
    });
    if (stdin !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
  });
}

export function buildTestFilesInvocation(testFiles) {
  return { args: ['--files-from-stdin'], stdin: JSON.stringify(testFiles) };
}

export async function buildAffectedTestPlan(root = repoRoot) {
  const changedFiles = await getChangedFiles(root);
  return { changedFiles, plan: planAffectedTests(root, changedFiles) };
}

export async function runAffectedSelection(plan, selection, signal, run = runNodeScript, dependencies = {}) {
  if (plan.mode === 'none') return 0;
  return withVerificationRuntime(selection, signal, (runtime) => {
    if (plan.mode === 'full') return run(path.join(repoRoot, 'scripts/verification/run-tests.mjs'), ['--fast', ...runtimeArgs(runtime)], signal);
    const invocation = buildTestFilesInvocation(plan.testFiles);
    return run(path.join(repoRoot, 'scripts/verification/run-test-files.mjs'), [...invocation.args, ...runtimeArgs(runtime)], signal, invocation.stdin);
  }, dependencies);
}

async function main() {
  const selection = extractRuntimeArgs(process.argv.slice(2));
  if (selection.args.some((arg) => arg === '--help' || arg === '-h' || arg === '--list')) {
    console.log('Usage: run-affected-tests.mjs [--all] [--pi-runtime <absolute artifact root>]');
    return;
  }
  if (selection.args.some((arg) => arg !== '--all')) throw new Error('Unknown affected-test argument');
  const forceAll = selection.args.includes('--all');
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
    if (plan.mode === 'full') console.log(`Running the full fast suite (${plan.reasons.join('; ')}).`);
    else {
      console.log(`Running ${plan.testFiles.length} affected test file(s) in parallel.`);
      for (const reason of plan.reasons) console.log(`- ${reason}`);
    }
    exitCode = await runAffectedSelection(plan, selection, abort.signal);
  } finally {
    abort.dispose();
  }
  if (exitCode !== 0) process.exitCode = exitCode;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main().catch((error) => { console.error(error.message); process.exitCode = 1; });
