#!/usr/bin/env node

// Run one or more repo-relative test files directly through the appropriate
// LOCAL tsx with node:test, in fast mode (parallel files, no coverage). This is
// the tightest dev loop: `node scripts/verification/run-test-files.mjs application/hosts/vscode/test/foo.test.ts
// `harness/tools/subagent/test/schema.test.ts`.
//
// Classification mirrors scripts/verification/run-tests.mjs PACKAGE_CONFIGS and registry
// testCwd metadata, routing over every registered source/test root (including
// declared distributed future roots, which classify like any package dir):
//  - application/hosts/vscode/ -> cwd application/hosts/vscode/, tsx = registry-selected local/root CLI
//  - analytics/analysis/       -> cwd analytics/analysis/,        tsx = analytics/analysis/node_modules/tsx
//  - scripts/**/test/ -> cwd repoRoot,            tsx = node_modules/tsx (root)
//  - extensions/* and tools/* -> cwd repoRoot, tsx = node_modules/tsx (root)
//
// Packages with a registry `tsxConfig` pass `--tsconfig` (their tests resolve
// pi SDK path aliases); see scripts/lib/test-packages.mjs. `testTsx: 'root'`
// selects the root CLI for cross-owner ESM sources that need its loader behavior.
//
// The local tsx CLI is invoked directly (`node <local tsx cli.mjs>`, not
// `npx tsx`) to skip npx resolution overhead.
//
// This script is always fast/no-coverage; exit code is non-zero if any tsx
// invocation fails.

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTsconfigOverlay, resolveOwnerTsx } from '../lib/package-resolution.mjs';
import { PACKAGE_DIRECTIVES, resolvePackageEntry } from '../lib/test-packages.mjs';
import { withoutGitRepositoryEnv } from '../lib/git-environment.mjs';
import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import {
  abortOnProcessSignals,
  resolveChildProcessTimeoutMs,
  watchChildProcess,
  withProcessTreeIsolation,
} from '../lib/process-watchdog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  // Repo-root packages declare no testCwd; application/hosts/vscode and
  // analytics/analysis run with their package-local cwd. This also lets
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
 * @typedef {{ files: string[], help: boolean }} ParsedArgs
 */

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  const files = [];
  let help = false;
  let onlyFiles = false;
  for (const arg of argv) {
    if (!onlyFiles && (arg === '--help' || arg === '-h')) {
      help = true;
      continue;
    }
    if (!onlyFiles && arg === '--') {
      onlyFiles = true;
      continue;
    }
    files.push(arg);
  }
  return { files, help };
}

function printHelp() {
  console.log(
    `Usage: node scripts/verification/run-test-files.mjs <test-file>... [options]\n\n` +
      `Run specific test files through the appropriate local tsx with node:test\n` +
      `(fast mode: parallel files, no coverage). Classifies each path into\n` +
      `application/hosts/vscode/, analytics/analysis/, scripts/, extensions/<id>/, or tools/<id>/ and uses that package's local\n` +
      `tsx; packages with SDK path aliases additionally pass --tsconfig.\n\n` +
      `Options:\n` +
      `  --help, -h   Show this help.\n` +
      `  --           Treat the rest of the args as file paths.\n\n` +
      `Examples:\n` +
      `  node scripts/verification/run-test-files.mjs application/frontend/test/components/app-smoke.test.ts\n` +
      `  node scripts/verification/run-test-files.mjs harness/tools/subagent/test/schema.test.ts analytics/analysis/test/pricing.test.ts\n`,
  );
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
export function runGroup(group, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [group.tsxBin, ...args], withProcessTreeIsolation({
      cwd: group.cwd,
      env: withoutPiHarnessEnv(withoutGitRepositoryEnv(process.env)),
      stdio: 'inherit',
      windowsHide: true,
    }));
    const timeoutMs = resolveChildProcessTimeoutMs();
    const watchdog = watchChildProcess(child, {
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
      resolve(watchdog.timedOut || watchdog.aborted || !cleanup.gone ? 1 : (code ?? 0));
    });
  });
}

async function main() {
  const repoRoot = inferRepoRoot();
  const { files, help } = parseArgs(process.argv.slice(2));

  if (help) {
    printHelp();
    return;
  }

  if (files.length === 0) {
    console.error('Error: no test files given.\n');
    printHelp();
    process.exitCode = 1;
    return;
  }

  let groups;
  try {
    groups = groupFilesByPackage(repoRoot, files);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  // Packages with registry tsxConfig entries run through generated overlay
  // configs (owner-relative aliases over the checked-in base config) instead
  // of the raw repo-relative config path. Overlays are private OS-temp files
  // and are always disposed after the run.
  const overlays = new Map();
  const processAbort = abortOnProcessSignals();
  const failures = [];
  let completedGroups = 0;
  try {
    for (const group of groups) {
      if (!group.tsxConfig) continue;
      overlays.set(group.id, createTsconfigOverlay(path.join(repoRoot, group.tsxConfig), {
        includeOwnerDependencies: group.includeOwnerDependencies === true,
      }));
    }
    await Promise.all(groups.map(async (group) => {
      const overlay = overlays.get(group.id);
      const args = buildTsxArgs(overlay ? { ...group, tsxConfig: overlay.configPath } : group);
      const fileWord = group.files.length === 1 ? 'file' : 'files';
      console.log(`\n▶ ${group.id} (${group.files.length} ${fileWord})`);
      const code = await runGroup(group, args, processAbort.signal);
      completedGroups += 1;
      if (code === 0) {
        console.log(`✓ ${group.id}`);
      } else {
        console.log(`✖ ${group.id} (exit ${code})`);
        failures.push(group.id);
      }
    }));
  } finally {
    processAbort.dispose();
    for (const overlay of overlays.values()) overlay.dispose();
  }

  console.log('');
  if (failures.length === 0 && !processAbort.signal.aborted) {
    console.log(`Summary: ${groups.length}/${groups.length} packages passed.`);
    return;
  }
  console.log(`Summary: ${completedGroups - failures.length}/${groups.length} packages passed. Failed: ${failures.join(', ') || 'aborted'}`);
  process.exitCode = 1;
}

// Only run main() when invoked directly, so the pure helpers can be unit-tested
// via `import` without side effects.
const invokedDirectly = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  await main();
}
