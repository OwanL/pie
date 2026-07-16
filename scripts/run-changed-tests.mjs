#!/usr/bin/env node

// Inspect git changed (tracked, vs HEAD) + untracked files and run the affected
// test packages via scripts/run-tests.mjs --fast.
//
// Mapping:
//  - A file under extension/, analysis/, or extensions/<id>/ selects that one
//    package id (forwarded to run-tests.mjs as `--package <id>`).
//  - A global test-infrastructure / config file (the runner scripts, scripts/lib,
//    root package.json / lockfile, node version pins, shared/, or Git hooks)
//    selects ALL packages — see lib/test-packages.mjs isGlobalTestInfra.
//  - A file under scripts/test/ selects only the scripts package.
//  - Anything else (docs/, README, settings.json, models.yaml, …) selects no
//    package; the script exits 0 with a short note.
//
// When more than one package is affected they are passed to a single
// run-tests.mjs invocation, which already parallelizes packages. We invoke
// `node scripts/run-tests.mjs` directly (not `npm run`) so the exit code and
// output are passed through unchanged.

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mapFilesToPackages } from './lib/test-packages.mjs';
import { withoutGitRepositoryEnv } from './lib/git-environment.mjs';
import {
  abortOnProcessSignals,
  resolveChildProcessTimeoutMs,
  watchChildProcess,
  withProcessTreeIsolation,
} from './lib/process-watchdog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root inferred from this file's location: scripts/ -> .. */
export function inferRepoRoot() {
  return path.resolve(__dirname, '..');
}

/**
 * Run `git -C repoRoot <args>` and collect stdout as a UTF-8 string.
 * @param {string} repoRoot
 * @param {string[]} args
 * @returns {Promise<{ ok: boolean, stdout: string }>}
 */
function gitOutput(repoRoot, args) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repoRoot, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => resolve({ ok: false, stdout: '' }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout }));
  });
}

/** Split git `-z` (NUL-delimited) output into a list of non-empty paths. */
function splitNull(output) {
  return output.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Collect all repo-relative, forward-slash changed/untracked file paths.
 * Tracked changes are diffed against HEAD; if HEAD does not exist (fresh repo),
 * every tracked file is treated as changed. Untracked, non-ignored files are
 * added via `git ls-files --others --exclude-standard`.
 * @param {string} repoRoot
 * @returns {Promise<string[]>}
 */
export async function getChangedFiles(repoRoot) {
  const trackedResult = await gitOutput(repoRoot, ['diff', '--name-only', '-z', 'HEAD']);
  let tracked = trackedResult.ok ? splitNull(trackedResult.stdout) : [];
  if (!trackedResult.ok) {
    // No HEAD yet (fresh repo with no commits): treat all tracked files as changed.
    const allTracked = await gitOutput(repoRoot, ['ls-files', '-z']);
    tracked = allTracked.ok ? splitNull(allTracked.stdout) : [];
  }
  const untrackedResult = await gitOutput(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  const untracked = untrackedResult.ok ? splitNull(untrackedResult.stdout) : [];

  const seen = new Set();
  const merged = [];
  for (const file of [...tracked, ...untracked]) {
    // git always emits forward-slash, repo-relative paths; normalize defensively.
    const normalized = file.replace(/\\/g, '/');
    if (!seen.has(normalized)) {
      seen.add(normalized);
      merged.push(normalized);
    }
  }
  return merged;
}

/**
 * Build the argv tail to pass to scripts/run-tests.mjs.
 * Select-all => just `--fast` (runs every package). Otherwise `--fast` plus a
 * `--package <id>` pair per affected package.
 * @param {{ selectAll: boolean, packageIds: string[] }} plan
 * @returns {string[]}
 */
export function buildRunTestsArgs(plan) {
  const args = ['--fast'];
  if (plan.selectAll) {
    return args;
  }
  for (const id of plan.packageIds) {
    args.push('--package', id);
  }
  return args;
}

/**
 * Reduce changed files to a run plan (delegates to the shared lib).
 * @param {string[]} files
 * @returns {{ selectAll: boolean, packageIds: string[] }}
 */
export function planRuns(files) {
  return mapFilesToPackages(files);
}

/**
 * Spawn `node <runTestsScript> <args>` with inherited stdio.
 * @param {string} runTestsScript
 * @param {string[]} args
 * @param {string} cwd
 * @param {AbortSignal} [signal]
 * @returns {Promise<number>}
 */
function runRunTests(runTestsScript, args, cwd, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runTestsScript, ...args], withProcessTreeIsolation({
      cwd,
      env: withoutGitRepositoryEnv(process.env),
      stdio: 'inherit',
      windowsHide: true,
    }));
    const timeoutMs = resolveChildProcessTimeoutMs();
    const watchdog = watchChildProcess(child, {
      timeoutMs,
      signal,
      label: 'changed-test runner',
      onTerminate: ({ reason }) => {
        const detail = reason === 'timeout' ? ` after ${timeoutMs}ms` : '';
        console.error(`\nChanged-test runner ${reason === 'timeout' ? 'timed out' : 'was aborted'}${detail}; killed process tree.`);
      },
    });
    child.on('error', (error) => {
      watchdog.cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      watchdog.cleanup();
      resolve(watchdog.timedOut || watchdog.aborted ? 1 : (code ?? 0));
    });
  });
}

async function main() {
  const repoRoot = inferRepoRoot();
  const files = await getChangedFiles(repoRoot);

  if (files.length === 0) {
    console.log('No changes detected; nothing to test.');
    return;
  }

  const plan = planRuns(files);

  if (plan.selectAll) {
    console.log('Global test-infrastructure/config changed; running ALL packages.');
  } else if (plan.packageIds.length === 0) {
    console.log(`No test packages affected by ${files.length} changed file(s).`);
    return;
  } else {
    console.log(`Running ${plan.packageIds.length} package(s): ${plan.packageIds.join(', ')}`);
  }

  const runTestsScript = path.join(repoRoot, 'scripts', 'run-tests.mjs');
  const args = buildRunTestsArgs(plan);
  const processAbort = abortOnProcessSignals();
  try {
    const code = await runRunTests(runTestsScript, args, repoRoot, processAbort.signal);
    if (code !== 0) {
      process.exitCode = code;
    }
  } finally {
    processAbort.dispose();
  }
}

// Only run main() when invoked directly, so the helpers can be unit-tested.
const invokedDirectly = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  await main();
}
