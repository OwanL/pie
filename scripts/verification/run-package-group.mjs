#!/usr/bin/env node

// Expand a named package group (scripts/lib/test-packages.mjs PACKAGE_GROUPS)
// into `--package` / `--project` flags and forward to the requested runner.
// This is the single registry-backed source for the root package.json
// `extensions:test` / `extensions:typecheck` scripts; do not maintain package
// id lists there.
//
// Usage: node scripts/verification/run-package-group.mjs <tests|typechecks> <group> [forwarded args...]
// Example: npm run extensions:test -- --fast  ->  tests extensions --fast

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withoutGitRepositoryEnv } from '../lib/git-environment.mjs';
import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import { PACKAGE_GROUPS } from '../lib/test-packages.mjs';
import {
  abortOnProcessSignals,
  resolveChildProcessTimeoutMs,
  watchChildProcess,
  withProcessTreeIsolation,
} from '../lib/process-watchdog.mjs';

import { extractRuntimeArgs, runtimeArgs, verificationChildEnv, withVerificationRuntime } from './verification-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Pure arg construction so the drift test can verify group expansion without
 * spawning a runner.
 * @param {string} runner 'tests' (run-tests.mjs) or 'typechecks' (run-typechecks.mjs)
 * @param {string[]} groups package group names, expanded in registry order
 * @param {string[]} [forwarded] extra args passed through to the runner verbatim
 * @returns {{ script: string, args: string[] }}
 */
export function buildRunnerInvocation(runner, groups, forwarded = []) {
  if (runner !== 'tests' && runner !== 'typechecks') {
    throw new Error(`Unknown runner: ${runner}. Use "tests" or "typechecks".`);
  }
  const ids = [];
  for (const group of groups) {
    const members = PACKAGE_GROUPS[group];
    if (!members) {
      throw new Error(`Unknown package group: ${group}. Available: ${Object.keys(PACKAGE_GROUPS).join(', ')}`);
    }
    ids.push(...members);
  }
  if (ids.length === 0) {
    throw new Error(`Package group(s) ${groups.join(', ')} expanded to no packages.`);
  }
  const flag = runner === 'tests' ? '--package' : '--project';
  const script = runner === 'tests' ? 'run-tests.mjs' : 'run-typechecks.mjs';
  return { script, args: [...ids.flatMap((id) => [flag, id]), ...forwarded] };
}

function printHelp() {
  console.log('Usage: node scripts/verification/run-package-group.mjs <tests|typechecks> <group> [forwarded args...]');
  console.log(`Available groups: ${Object.keys(PACKAGE_GROUPS).join(', ')}`);
}

export function runRunner(script, args, signal, dependencies = {}) {
  return new Promise((resolve, reject) => {
    const child = (dependencies.spawn ?? spawn)(process.execPath, [path.join(repoRoot, 'scripts', 'verification', script), ...args], withProcessTreeIsolation({
      cwd: repoRoot,
      env: verificationChildEnv(withoutPiHarnessEnv(withoutGitRepositoryEnv(process.env))),
      stdio: 'inherit',
      windowsHide: true,
    }));
    const watchdog = (dependencies.watchChildProcess ?? watchChildProcess)(child, {
      timeoutMs: resolveChildProcessTimeoutMs(),
      signal,
      label: `${script} (${args.join(' ')})`,
    });
    child.on('error', async (error) => {
      const cleanup = await watchdog.settle().catch(() => ({ gone: false }));
      reject(cleanup.gone ? error : Object.assign(new Error('Package-group tree teardown is unconfirmed', { cause: error }), { teardownUnconfirmed: true }));
    });
    child.on('close', async (code, signal) => {
      const cleanup = await watchdog.settle().catch(() => ({ gone: false }));
      if (!cleanup.gone || code === 125) { reject(Object.assign(new Error('Package-group tree teardown is unconfirmed'), { teardownUnconfirmed: true })); return; }
      resolve(watchdog.timedOut || watchdog.aborted || signal || code === null ? 1 : code);
    });
  });
}

export async function runPackageGroup(selection, invocation, signal, dependencies = {}) {
  const run = dependencies.runRunner ?? ((script, args, signal) => runRunner(script, args, signal, dependencies));
  return withVerificationRuntime(selection, signal, (runtime) =>
    run(invocation.script, [...runtimeArgs(runtime), ...invocation.args], signal), dependencies);
}

async function main(argv, dependencies) {
  const selection = extractRuntimeArgs(argv);
  const [runner, group, ...forwarded] = selection.args;
  if (!runner || !group || runner === '--help' || runner === '-h') {
    printHelp();
    if (!runner || runner === '--help' || runner === '-h') return;
    process.exitCode = 1;
    return;
  }

  let invocation;
  try {
    invocation = buildRunnerInvocation(runner, [group], forwarded);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printHelp();
    process.exitCode = 1;
    return;
  }

  const abort = abortOnProcessSignals();
  try {
    const informational = forwarded.some((arg) => ['--help', '-h', '--list'].includes(arg));
    const exitCode = informational
      ? await runRunner(invocation.script, invocation.args, abort.signal, dependencies)
      : await runPackageGroup(selection, invocation, abort.signal, dependencies);
    if (exitCode !== 0) process.exitCode = exitCode;
  } finally {
    abort.dispose();
  }
}

export async function runPackageGroupCli(argv = process.argv.slice(2), dependencies = {}) {
  await main(argv, dependencies).catch((error) => { console.error(error.message); process.exitCode = error.teardownUnconfirmed === true ? 125 : 1; });
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await runPackageGroupCli();