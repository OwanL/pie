#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { abortOnProcessSignals, resolveChildProcessTimeoutMs, watchChildProcess, withProcessTreeIsolation } from '../lib/process-watchdog.mjs';

const REPORT_PREFIX = '__PI_TEST_SUMMARY__';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const reporter = pathToFileURL(path.join(repoRoot, 'scripts', 'test-reporter.mjs')).href;

export function validateExperimentTestReport(report) {
  const summary = report?.summary;
  const counts = summary?.counts;
  if (!summary || !counts) return { valid: false, reason: 'test summary missing' };
  const completed = counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo;
  if (counts.tests <= 0) return { valid: false, reason: 'no tests completed' };
  if (counts.failed > 0) return { valid: false, reason: `${counts.failed} test(s) failed` };
  if (counts.cancelled > 0) return { valid: false, reason: `${counts.cancelled} test(s) cancelled` };
  if (completed !== counts.tests) return { valid: false, reason: `${counts.tests - completed} test(s) incomplete` };
  if (!summary.success) return { valid: false, reason: 'test runner reported unsuccessful validation' };
  return { valid: true, reason: null };
}

function parseReport(output) {
  const line = output.split(/\r?\n/u).findLast((entry) => entry.startsWith(REPORT_PREFIX));
  if (!line) return null;
  try { return JSON.parse(line.slice(REPORT_PREFIX.length)); } catch { return null; }
}

export async function runExperimentTests(files = ['scripts/experiments/test/*.test.mjs']) {
  const processAbort = abortOnProcessSignals();
  const child = spawn(process.execPath, [
    '--test', '--test-concurrency=1', `--test-reporter=${reporter}`, ...files,
  ], withProcessTreeIsolation({ cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  let output = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const timeoutMs = resolveChildProcessTimeoutMs();
  const watchdog = watchChildProcess(child, {
    timeoutMs, signal: processAbort.signal, label: 'experiment tests',
    onTerminate: ({ reason }) => { output += `\nExperiment tests ${reason}; terminating owned process tree.\n`; },
  });
  try {
    const { code, closeSignal, spawnError } = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ code: 1, closeSignal: null, spawnError: error }));
      child.once('close', (code, closeSignal) => resolve({ code: code ?? 1, closeSignal, spawnError: null }));
    });
    const cleanup = await watchdog.settle().catch((error) => ({ gone: false, survivors: [], diagnostics: [String(error)] }));
    const report = parseReport(output);
    const validation = validateExperimentTestReport(report);
    const failed = spawnError || code !== 0 || closeSignal || watchdog.timedOut || watchdog.aborted || !cleanup.gone || !validation.valid;
    if (report?.summary?.counts) {
      const c = report.summary.counts;
      console.log(`Experiment tests: ${c.passed} passed, ${c.failed} failed, ${c.cancelled} cancelled, ${c.skipped} skipped, ${c.todo} todo (${Math.round(report.summary.durationMs)}ms).`);
    }
    for (const failure of report?.failures ?? []) console.error(`- ${failure.name}${failure.message ? `: ${failure.message}` : ''}`);
    if (!validation.valid) console.error(`Experiment validation failed: ${validation.reason}.`);
    if (!cleanup.gone) console.error(`Experiment cleanup failed; surviving owned PIDs: ${cleanup.survivors.join(', ')}.`);
    if (spawnError) console.error(spawnError);
    return failed ? 1 : 0;
  } finally {
    watchdog.cleanup();
    processAbort.dispose();
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) process.exitCode = await runExperimentTests(process.argv.slice(2).length ? process.argv.slice(2) : undefined);
