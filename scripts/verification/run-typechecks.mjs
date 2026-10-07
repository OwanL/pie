#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  abortOnProcessSignals,
  resolveChildProcessTimeoutMs,
  watchChildProcess,
  withProcessTreeIsolation,
} from '../lib/process-watchdog.mjs';
import { createTsconfigOverlay, resolveTypeScriptCompiler } from '../lib/package-resolution.mjs';
import { TYPECHECK_PROJECTS } from '../lib/test-packages.mjs';

import { extractRuntimeArgs, withVerificationRuntime } from './verification-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

// Only current-run evidence is available. Never reconstruct or kill old trees.
const boundedText = (value, limit = 2048) => String(value ?? '').slice(-limit);
const boundedProcesses = (entries) => (entries ?? []).slice(0, 64).map((entry) => ({
  pid: entry.pid, ppid: entry.ppid,
  identity: entry.identity == null ? null : boundedText(entry.identity, 128),
  creationDate: entry.creationDate == null ? null : boundedText(entry.creationDate, 128),
}));

export function runProject(project, signal, runtime, dependencies = {}) {
  const started = performance.now();
  const configPath = path.isAbsolute(project.config) ? project.config : path.join(repoRoot, project.config);
  const overlay = (dependencies.createTsconfigOverlay ?? createTsconfigOverlay)(configPath, {
    typescript: true,
    includeOwnerDependencies: project.includeOwnerDependencies === true,
    sdkPath: runtime.sdkPath,
  });
  let launched = false;
  return new Promise((resolve, reject) => {
    const child = (dependencies.spawn ?? spawn)(process.execPath, [
      resolveProjectCompiler(project),
      '--noEmit',
      '--project', overlay?.configPath ?? configPath,
      '--incremental',
      '--tsBuildInfoFile', path.join(overlay.directory, `${project.id}.tsbuildinfo`),
    ], withProcessTreeIsolation({ cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
    launched = true;
    let output = '';
    const timeoutMs = resolveChildProcessTimeoutMs();
    const watchdog = (dependencies.watchChildProcess ?? watchChildProcess)(child, {
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
    let settling = false;
    const finish = async (code, childError) => {
      // Spawn errors can be followed by close. Claim settlement before awaiting
      // so cleanup/disposal and the retained proof happen exactly once.
      if (settling) return;
      settling = true;
      let cleanup;
      let cleanupError;
      try { cleanup = await watchdog.settle(); }
      catch (error) {
        cleanupError = error;
        cleanup = { gone: false, diagnostics: [`watchdog settlement failed: ${boundedText(error?.message ?? error)}`] };
      }
      if (!cleanup?.gone) {
        const diagnostics = (cleanup?.diagnostics ?? []).slice(0, 32).map((value) => boundedText(value));
        if (!diagnostics.length) diagnostics.push('Watchdog did not confirm tree extinction; ownership or survivors may be unknown');
        const diagnosticPath = path.join(overlay.directory, 'teardown.json');
        const error = Object.assign(new Error(`${project.id}: typecheck tree teardown is unconfirmed`, {
          cause: cleanupError ?? childError,
        }), { teardownUnconfirmed: true, diagnosticPath });
        const evidence = {
          owner: { pid: process.pid, directory: boundedText(overlay.directory) },
          project: { id: boundedText(project.id), config: boundedText(configPath), compiler: boundedText(project.compiler) },
          sdkSelection: { sdkPath: boundedText(runtime.sdkPath), artifactDir: boundedText(runtime.artifactDir) },
          childPid: child.pid ?? null,
          gone: false, timedOut: watchdog.timedOut, aborted: watchdog.aborted,
          diagnostics,
          ownedProcesses: boundedProcesses(cleanup?.ownedProcesses),
          survivorProcesses: boundedProcesses(cleanup?.survivorProcesses),
          ownedPids: (cleanup?.ownedPids ?? []).slice(0, 64),
          survivors: (cleanup?.survivors ?? []).slice(0, 64),
          output: boundedText(output, 16384),
          childError: childError ? boundedText(childError.message) : null,
          evidenceScope: 'current run only; missing ownership evidence is unknown, not reconstructed',
        };
        try { writeFileSync(diagnosticPath, `${JSON.stringify(evidence)}\n`, { flag: 'wx', mode: 0o600 }); }
        catch (writeError) { error.diagnosticWriteError = writeError; }
        (dependencies.console ?? console).error(`${error.message}: ${diagnostics.join('; ')}; retained overlay ${overlay.directory}; diagnostics ${diagnosticPath}${error.diagnosticWriteError ? ` (write failed: ${boundedText(error.diagnosticWriteError.message)})` : ''}`);
        reject(error);
        return;
      }
      overlay.dispose();
      if (childError) { reject(childError); return; }
      resolve({
        project,
        code: watchdog.timedOut || watchdog.aborted ? 1 : (code ?? 1),
        output,
        durationMs: performance.now() - started,
      });
    };
    child.on('error', (error) => { void finish(undefined, error); });
    child.on('close', (code) => { void finish(code); });
  }).catch((error) => {
    // Synchronous setup failure launched no process. Unconfirmed trees retain
    // their overlay, even when the error/close events have both fired.
    if (!launched) overlay.dispose();
    throw error;
  });
}

export async function runWithConcurrency(projects, concurrency, run = runProject, signal) {
  const results = new Array(projects.length);
  let next = 0;
  let failed = false;
  let firstError;
  let teardownUnconfirmed = false;
  async function worker() {
    while (next < projects.length && !signal?.aborted && !failed) {
      const index = next++;
      try {
        results[index] = await run(projects[index], signal);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
        teardownUnconfirmed ||= error?.teardownUnconfirmed === true;
      }
    }
  }
  // A failed worker stops new dispatch, but every already-launched sibling
  // must finish teardown before the caller disposes signals/runtime resources.
  await Promise.all(Array.from({ length: Math.min(concurrency, projects.length) }, worker));
  if (failed) {
    if (teardownUnconfirmed) {
      firstError = Object.assign(new Error(String(firstError?.message ?? firstError), { cause: firstError }), { teardownUnconfirmed: true });
    }
    throw firstError;
  }
  return results;
}

function printHelp() {
  console.log('Usage: node scripts/verification/run-typechecks.mjs [--project <id>] [--concurrency <n>] [--list]');
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const target = dependencies.process ?? process;
  const logger = dependencies.console ?? console;
  try {
    const selection = extractRuntimeArgs(argv);
    const args = parseArgs(selection.args);
    if (args.help) return printHelp();
    if (args.list) {
      for (const project of TYPECHECK_PROJECTS) console.log(project.id);
      return;
    }
    const projects = selectProjects(args.ids);
    const started = performance.now();
    const processAbort = (dependencies.abortOnProcessSignals ?? abortOnProcessSignals)();
    let results;
    let teardownUnconfirmed = false;
    try {
      results = await (dependencies.withVerificationRuntime ?? withVerificationRuntime)(selection, processAbort.signal, (runtime) =>
        runWithConcurrency(projects, args.concurrency, (project, signal) => runProject(project, signal, runtime, dependencies), processAbort.signal));
    } catch (error) {
      teardownUnconfirmed = error?.teardownUnconfirmed === true;
      throw error;
    } finally {
      if (!teardownUnconfirmed) processAbort.dispose();
    }
    for (const result of results.filter(Boolean)) {
      const status = result.code === 0 ? '✓' : '✖';
      console.log(`${status} ${result.project.id} — ${(result.durationMs / 1000).toFixed(1)}s`);
      if (result.code !== 0 && result.output.trim()) console.log(result.output.trim());
    }
    console.log(`Typecheck completed in ${((performance.now() - started) / 1000).toFixed(1)}s.`);
    if (processAbort.signal.aborted || results.filter(Boolean).some((result) => result.code !== 0)) target.exitCode = 1;
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    target.exitCode = error?.teardownUnconfirmed === true ? 125 : 1;
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
