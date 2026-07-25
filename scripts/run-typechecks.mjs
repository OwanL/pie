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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TYPECHECK_PROJECTS = [
  { id: 'shared', config: 'shared/tsconfig.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
  { id: 'extension', config: 'extension/tsconfig.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
  { id: 'analysis', config: 'analysis/tsconfig.json', compiler: 'analysis/node_modules/typescript/bin/tsc' },
  { id: 'ask-user', config: 'extensions/ask-user/tsconfig.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
  { id: 'cwd-skills', config: 'extensions/cwd-skills/tsconfig.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
  { id: 'safeguard', config: 'extensions/safeguard/tsconfig.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
  { id: 'skill-pruner', config: 'extensions/skill-pruner/tsconfig.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
  { id: 'web-access-compat', config: 'extensions/web-access-compat/tsconfig.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
  { id: 'warm-bash', config: 'extensions/warm-bash/tsconfig.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
  { id: 'copilot-model-discovery', config: 'extensions/copilot-model-discovery/tsconfig.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
  { id: 'tool-result-pruner', config: 'extensions/tool-result-pruner/tsconfig.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
  { id: 'session-reviewer', config: 'extensions/session-reviewer/tsconfig.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
  { id: 'session-changes', config: 'extensions/session-changes/tsconfig.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
  { id: 'deferred-triggers', config: 'extensions/deferred-triggers/tsconfig.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
  { id: 'computer-use', config: 'extensions/computer-use/tsconfig.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
  { id: 'subagent', config: 'extensions/subagent/tsconfig.release.json', compiler: 'extension/node_modules/typescript/bin/tsc' },
];

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

function runProject(project, signal) {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(repoRoot, project.compiler),
      '--noEmit',
      '--project', path.join(repoRoot, project.config),
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
