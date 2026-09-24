#!/usr/bin/env node

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  abortOnProcessSignals,
  resolveChildProcessTimeoutMs,
  watchChildProcess,
  withProcessTreeIsolation,
} from './lib/process-watchdog.mjs';
import { resolveTypeScriptCompiler } from './lib/package-resolution.mjs';
import { TYPECHECK_PROJECTS } from './lib/test-packages.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Typecheck projects (ids, tsconfigs, per-project compiler selection) are
// owned by scripts/lib/test-packages.mjs; re-exported for the drift test and
// existing consumers.
export { TYPECHECK_PROJECTS };

export function parseArgs(argv) {
  const ids = [];
  let concurrency = Math.min(4, Math.max(1, os.availableParallelism?.() ?? os.cpus().length));
  let list = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      const id = argv[++index];
      if (!id) throw new Error('--project requires an id');
      ids.push(id);
    } else if (arg.startsWith('--project=')) {
      ids.push(arg.slice('--project='.length));
    } else if (arg === '--concurrency') {
      concurrency = Number.parseInt(argv[++index] ?? '', 10);
    } else if (arg.startsWith('--concurrency=')) {
      concurrency = Number.parseInt(arg.slice('--concurrency='.length), 10);
    } else if (arg === '--list') {
      list = true;
    } else if (arg === '--help' || arg === '-h') {
      return { ids, concurrency, list, help: true };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
  return { ids, concurrency, list, help: false };
}

export function selectProjects(ids) {
  if (ids.length === 0) return TYPECHECK_PROJECTS;
  const lookup = new Map(TYPECHECK_PROJECTS.map((project) => [project.id, project]));
  return [...new Set(ids)].map((id) => {
    const project = lookup.get(id);
    if (!project) throw new Error(`Unknown typecheck project: ${id}`);
    return project;
  });
}

/**
 * Resolve a registry-declared compiler to an absolute binary path.
 *
 * The registry keeps the `<owner>/node_modules/typescript/bin/tsc` selection
 * as the routing authority for which project uses which compiler owner;
 * this derives the owner root from that declaration and resolves the binary
 * owner-relatively through the shared package-resolution helper, so planned
 * layouts re-point by updating registry data only. Absolute declarations
 * (future-root proof projects) pass through unchanged.
 */
export function resolveProjectCompiler(project, projectRoot = repoRoot) {
  if (typeof project.compiler !== 'string' || project.compiler.length === 0) {
    throw new Error('Typecheck compiler must be a non-empty path');
  }
  if (path.isAbsolute(project.compiler)) return project.compiler;
  const compilerSuffix = '/node_modules/typescript/bin/tsc';
  const declaration = project.compiler.replace(/\\/gu, '/');
  const suffixIndex = declaration.lastIndexOf(compilerSuffix);
  if (suffixIndex < 0 || suffixIndex + compilerSuffix.length !== declaration.length) {
    throw new Error(`Typecheck compiler must end with "${compilerSuffix}": ${project.compiler}`);
  }

  const absoluteProjectRoot = path.resolve(projectRoot);
  const ownerPath = declaration.slice(0, suffixIndex);
  const ownerRoot = path.resolve(absoluteProjectRoot, ownerPath);
  const relativeOwner = path.relative(absoluteProjectRoot, ownerRoot);
  if (relativeOwner === '..' || relativeOwner.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOwner)) {
    throw new Error(`Typecheck compiler owner must stay within the project root: ${project.compiler}`);
  }
  return resolveTypeScriptCompiler({ dependencyOwnerRoot: ownerRoot });
}

function runProject(project, signal) {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      resolveProjectCompiler(project),
      '--noEmit',
      '--project', path.isAbsolute(project.config) ? project.config : path.join(repoRoot, project.config),
      '--incremental',
      '--tsBuildInfoFile', path.join(repoRoot, 'node_modules', '.cache', 'typecheck', `${project.id}.tsbuildinfo`),
    ], withProcessTreeIsolation({ cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
    let output = '';
    const timeoutMs = resolveChildProcessTimeoutMs();
    const watchdog = watchChildProcess(child, {
      timeoutMs,
      signal,
      label: `${project.id} typecheck`,
      onTerminate: ({ reason }) => {
        const detail = reason === 'timeout' ? ` after ${timeoutMs}ms` : '';
        output += `\nTypecheck process ${reason === 'timeout' ? 'timed out' : 'was aborted'}${detail}; killed process tree.\n`;
      },
    });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', async (error) => {
      await watchdog.settle().catch(() => {});
      resolve({ project, code: 1, output: String(error), durationMs: performance.now() - started });
    });
    child.on('close', async (code) => {
      const cleanup = await watchdog.settle().catch(() => ({ gone: false }));
      resolve({
        project,
        code: watchdog.timedOut || watchdog.aborted || !cleanup.gone ? 1 : (code ?? 1),
        output,
        durationMs: performance.now() - started,
      });
    });
  });
}

export async function runWithConcurrency(projects, concurrency, run = runProject, signal) {
  const results = new Array(projects.length);
  let next = 0;
  async function worker() {
    while (next < projects.length && !signal?.aborted) {
      const index = next++;
      results[index] = await run(projects[index], signal);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, projects.length) }, worker));
  return results;
}

function printHelp() {
  console.log('Usage: node scripts/run-typechecks.mjs [--project <id>] [--concurrency <n>] [--list]');
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return printHelp();
    if (args.list) {
      for (const project of TYPECHECK_PROJECTS) console.log(project.id);
      return;
    }
    const projects = selectProjects(args.ids);
    const started = performance.now();
    const processAbort = abortOnProcessSignals();
    let results;
    try {
      results = await runWithConcurrency(projects, args.concurrency, runProject, processAbort.signal);
    } finally {
      processAbort.dispose();
    }
    for (const result of results.filter(Boolean)) {
      const status = result.code === 0 ? '✓' : '✖';
      console.log(`${status} ${result.project.id} — ${(result.durationMs / 1000).toFixed(1)}s`);
      if (result.code !== 0 && result.output.trim()) console.log(result.output.trim());
    }
    console.log(`Typecheck completed in ${((performance.now() - started) / 1000).toFixed(1)}s.`);
    if (processAbort.signal.aborted || results.filter(Boolean).some((result) => result.code !== 0)) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
