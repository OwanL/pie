#!/usr/bin/env node

import { OWNERSHIP_STARTUP_TOKEN } from './ownership-startup.mjs';

// Shared legacy classification and execution helpers. Focused CLI: test-node.mjs (test:file).

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createTsconfigOverlay, resolveOwnerTsx } from '../lib/package-resolution.mjs';
import { isSdkIndependentTestFile, PACKAGE_DIRECTIVES, resolvePackageEntry } from '../lib/test-packages.mjs';
import { verificationChildEnv } from './verification-runtime.mjs';
import { withoutGitRepositoryEnv } from '../lib/git-environment.mjs';
import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import {
  resolveChildProcessTimeoutMs,
  watchChildProcess,
  withProcessTreeIsolation,
} from '../lib/process-watchdog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Focused affected runs can span many registered packages. Keep a small fixed
// process budget so one npm test invocation cannot start every package runner
// at once (each runner may itself parallelize test files).
export const DEFAULT_GROUP_CONCURRENCY = 3;
const DEFAULT_SDK_TSCONFIG = 'application/hosts/vscode/tsconfig.json';

/**
 * Run package groups with a bounded number of active package test processes.
 * Results retain the input order; entries for groups not started after abort
 * remain undefined. Runner errors are re-thrown after active workers settle.
 *
 * @template T, R
 * @param {T[]} groups
 * @param {(group: T, index: number) => Promise<R>} run
 * @param {{ concurrency?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<Array<R | undefined>>}
 */
export async function runGroupQueue(groups, run, {
  concurrency = DEFAULT_GROUP_CONCURRENCY,
  signal,
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Test group concurrency must be a positive integer; received ${concurrency}.`);
  }

  const results = new Array(groups.length);
  let nextIndex = 0;
  let hasError = false;
  let firstError;
  const worker = async () => {
    while (!signal?.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= groups.length) return;
      try {
        results[index] = await run(groups[index], index);
      } catch (error) {
        if (!hasError) firstError = error;
        hasError = true;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, worker));
  if (hasError) throw firstError;
  return results;
}

/** Repo root inferred from this file's location: scripts/ -> .. */
export function inferRepoRoot() {
  return path.resolve(__dirname, '../..');
}

/**
 * Per-package `--tsconfig` needs (host-SDK path-alias resolution) live in the
 * shared registry (scripts/lib/test-packages.mjs `tsxConfig`); focused runs
 * use the same compiler configuration as run-tests.mjs by construction.
 */

/**
 * Walk up from `startDir` to find `node_modules/tsx/dist/cli.mjs`.
 * Returns the absolute path to the tsx CLI entry so we can invoke
 * `node <cli.mjs> ...` without a shell / npx.
 * @param {string} startDir
 * @returns {string}
 */
export function resolveLocalTsx(startDir) {
  const target = path.join('node_modules', 'tsx', 'dist', 'cli.mjs');
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i += 1) {
    const candidate = path.join(dir, target);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`Could not find a local tsx (node_modules/tsx/dist/cli.mjs) at or above ${startDir}`);
}

/**
 * Normalize an arbitrary input path (absolute or repo-relative, any slashes) to
 * a repo-relative, forward-slash string.
 * @param {string} repoRoot
 * @param {string} input
 * @returns {{ repoRel: string, abs: string }}
 * @throws if the path resolves outside the repo
 */
export function normalizeRepoRelative(repoRoot, input) {
  const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(repoRoot, input);
  const repoRel = path.relative(repoRoot, abs).replace(/\\/g, '/');
  if (repoRel.startsWith('..') || path.isAbsolute(repoRel)) {
    throw new Error(`Test file is outside the repo: ${input}`);
  }
  return { repoRel, abs };
}

/**
 * Whether this exact focused-file selection can run without acquiring/verifying
 * a Pi runtime. Any explicit selection, empty input, unlisted file, or mixed
 * invocation remains on the ordinary verified-runtime path.
 *
 * @param {string} repoRoot
 * @param {string[]} inputs
 * @param {{ artifactDir?: string, sdkPath?: string }} [selection]
 * @returns {boolean}
 */
export function requiresVerifiedRuntime(repoRoot, inputs, selection = {}) {
  if (selection.artifactDir !== undefined || selection.sdkPath !== undefined || inputs.length === 0) return true;
  return !inputs.every((input) => {
    try {
      return isSdkIndependentTestFile(normalizeRepoRelative(repoRoot, input).repoRel);
    } catch {
      // Preserve the normal path's validation/error handling for invalid inputs.
      return false;
    }
  });
}

/**
 * Classify a single test file into its package invocation descriptor.
 * Pure (no fs) — existence is checked separately in groupFilesByPackage.
 *
 * @param {string} repoRoot
 * @param {string} input - absolute or repo-relative test file path
 * @returns {{ id: string, cwd: string, tsxConfig?: string, includeOwnerDependencies?: boolean, tsxBin: string, repoRel: string, abs: string, relativeFilePath: string }}
 * @throws if the file is not under a registered test-package directory
 */
export function classifyTestFile(repoRoot, input) {
  const { repoRel, abs } = normalizeRepoRelative(repoRoot, input);
  const directive = PACKAGE_DIRECTIVES.find(({ dir }) => repoRel === dir || repoRel.startsWith(`${dir}/`));
  if (!directive) {
    throw new Error(
      `Cannot classify test file "${repoRel}": not under a registered test-package source/test root.`,
    );
  }
  const { id } = directive;
  // Repo-root packages declare no testCwd; application/hosts/vscode runs
  // with its package-local cwd. This also lets
  // harness/tools/ask-user remain in the extensions test group without
  // pretending its tests live in extensions/.
  const packageEntry = resolvePackageEntry(id);
  const cwd = packageEntry?.testCwd ? path.join(repoRoot, packageEntry.testCwd) : repoRoot;
  const tsxConfig = packageEntry?.tsxConfig;
  const includeOwnerDependencies = packageEntry?.includeOwnerDependencies;
  const tsxBin = packageEntry?.testTsx === 'root'
    ? resolveLocalTsx(repoRoot)
    : id === 'extension' ? resolveOwnerTsx({ repositoryRoot: repoRoot }) : resolveLocalTsx(cwd);
  const relativeFilePath = path.relative(cwd, abs).replace(/\\/g, '/');
  return {
    id,
    cwd,
    tsxConfig,
    ...(includeOwnerDependencies ? { includeOwnerDependencies: true } : {}),
    tsxBin,
    repoRel,
    abs,
    relativeFilePath,
  };
}

/**
 * Group classified test files by package so each package gets a single tsx
 * invocation. Validates that every file exists.
 *
 * @param {string} repoRoot
 * @param {string[]} inputs
 * @returns {Array<{ id: string, cwd: string, tsxConfig?: string, includeOwnerDependencies?: boolean, tsxBin: string, files: string[] }>}
 * @throws on a missing or unclassifiable file (message lists the offending path)
 */
export function groupFilesByPackage(repoRoot, inputs) {
  const groups = new Map();
  const errors = [];
  for (const input of inputs) {
    let descriptor;
    try {
      descriptor = classifyTestFile(repoRoot, input);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (!existsSync(descriptor.abs)) {
      errors.push(`Test file not found: ${descriptor.repoRel}`);
      continue;
    }
    let group = groups.get(descriptor.id);
    if (!group) {
      group = {
        id: descriptor.id,
        cwd: descriptor.cwd,
        tsxConfig: descriptor.tsxConfig,
        ...(descriptor.includeOwnerDependencies ? { includeOwnerDependencies: true } : {}),
        tsxBin: descriptor.tsxBin,
        files: [],
      };
      groups.set(descriptor.id, group);
    }
    if (!group.files.includes(descriptor.relativeFilePath)) {
      group.files.push(descriptor.relativeFilePath);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Build the tsx CLI args for one package group (fast / no coverage).
 * @param {{ tsxConfig?: string, files: string[] }} group
 * @returns {string[]}
 */
export function buildTsxArgs(group) {
  const args = ['--test', '--test-force-exit'];
  if (group.tsxConfig) {
    // Must precede the positional test files.
    args.push(`--tsconfig=${group.tsxConfig}`);
  }
  args.push(...group.files);
  return args;
}

/**
 * Create the config overlay used by a focused package group. Explicit SDK
 * candidates need aliases even for groups without a registry tsconfig, so
 * those groups inherit the application owner's root SDK config.
 * @param {string} repoRoot
 * @param {{ tsxConfig?: string, includeOwnerDependencies?: boolean }} group
 * @param {{ sdkPath?: string }} [options]
 */
export function createGroupTsconfigOverlay(repoRoot, group, { sdkPath } = {}) {
  if (!group.tsxConfig && sdkPath === undefined) return undefined;
  const baseConfig = path.join(repoRoot, group.tsxConfig ?? DEFAULT_SDK_TSCONFIG);
  return createTsconfigOverlay(baseConfig, {
    includeOwnerDependencies: group.includeOwnerDependencies === true,
    ...(sdkPath === undefined ? {} : { sdkPath }),
  });
}

/**
 * @typedef {{ files: string[], help: boolean, filesFromStdin: boolean, sdkPath?: string }} ParsedArgs
 */

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  const files = [];
  let help = false;
  let filesFromStdin = false;
  let sdkPath;
  let onlyFiles = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!onlyFiles && (arg === '--help' || arg === '-h')) {
      help = true;
      continue;
    }
    if (!onlyFiles && arg === '--') {
      onlyFiles = true;
      continue;
    }
    if (!onlyFiles && arg === '--files-from-stdin') {
      filesFromStdin = true;
      continue;
    }
    if (!onlyFiles && (arg === '--sdk-path' || arg.startsWith('--sdk-path='))) {
      if (sdkPath !== undefined) throw new Error('--sdk-path may be specified only once.');
      const value = arg === '--sdk-path' ? argv[++index] : arg.slice('--sdk-path='.length);
      if (!value || value === '--' || (arg === '--sdk-path' && value.startsWith('--'))) {
        throw new Error('--sdk-path requires a candidate coding-agent package directory.');
      }
      sdkPath = value;
      continue;
    }
    files.push(arg);
  }
  return { files, help, filesFromStdin, ...(sdkPath === undefined ? {} : { sdkPath }) };
}

/**
 * Spawn `node <tsxBin> <args>` with inherited stdio so output streams live.
 * Exported for the integrated future-root proof tests: registry classification
 * stays repo-bound, but group execution is the shared runner surface that
 * generated overlay configs flow through.
 * @param {{ tsxBin: string, cwd: string }} group
 * @param {string[]} args
 * @param {AbortSignal} [signal]
 * @returns {Promise<number>} exit code
 */
export function runGroup(group, args, signal, watchdogOptions = {}) {
  return new Promise((resolve, reject) => {
    const waitForOwnership = process.platform === 'win32';
    const entryArgs = waitForOwnership
      ? [fileURLToPath(new URL('./focused-test-startup.mjs', import.meta.url)), group.tsxBin, ...args]
      : [group.tsxBin, ...args];
    const child = spawn(process.execPath, entryArgs, withProcessTreeIsolation({
      cwd: group.cwd,
      env: verificationChildEnv(withoutPiHarnessEnv(withoutGitRepositoryEnv(process.env))),
      stdio: waitForOwnership ? ['pipe', 'inherit', 'inherit'] : 'inherit',
      windowsHide: true,
    }));
    const timeoutMs = resolveChildProcessTimeoutMs();
    const watchdog = watchChildProcess(child, {
      ...watchdogOptions,
      timeoutMs,
      signal,
      label: `${group.id} focused tests`,
      onTerminate: ({ reason }) => {
        const detail = reason === 'timeout' ? ` after ${timeoutMs}ms` : '';
        console.error(`\n✖ ${group.id} test process ${reason === 'timeout' ? 'timed out' : `was aborted (${signal?.reason?.message ?? 'signal'})`}${detail}; killed process tree.`);
      },
    });
    child.on('error', async (error) => {
      await watchdog.settle().catch(() => {});
      reject(error);
    });
    child.on('close', async (code) => {
      const cleanup = await watchdog.settle().catch(() => ({ gone: false }));
      if (!cleanup.gone) {
        const error = new Error('Focused test tree teardown is unconfirmed');
        error.cleanup = cleanup;
        reject(error);
        return;
      }
      resolve(watchdog.timedOut || watchdog.aborted ? 1 : (code ?? 0));
    });
    if (waitForOwnership) {
      child.stdin.on('error', () => {});
      if (watchdog.ownershipReady && !watchdog.terminationStarted) child.stdin.end(OWNERSHIP_STARTUP_TOKEN);
      else void watchdog.settle().catch(() => {});
    }
  });
}

export async function readFilesFromStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new Error('Expected a JSON array of test file paths on stdin.', { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every((file) => typeof file === 'string')) {
    throw new Error('Expected a JSON array of test file paths on stdin.');
  }
  return parsed;
}
