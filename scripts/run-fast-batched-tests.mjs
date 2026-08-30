#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withoutPiHarnessEnv } from './lib/pi-harness-env.mjs';

const REPORT_PREFIX = '__PI_TEST_SUMMARY__';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reporter = pathToFileURL(path.join(repoRoot, 'scripts', 'test-reporter.mjs')).href;
const rootBatchDirs = [
  'scripts/test',
  'extensions/cwd-skills/test',
  'extensions/safeguard/test',
  'extensions/skill-pruner/test',
  'extensions/ask-user/test',
  'extensions/warm-bash/test',
  'extensions/copilot-model-discovery/test',
  'extensions/web-access-guard/test',
  'extensions/tool-result-pruner/test',
  'extensions/session-reviewer/test',
  'extensions/deferred-triggers/test',
  'extensions/session-changes/test',
];

async function walk(directory, extensions, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolutePath, extensions, output);
    else if (extensions.some((suffix) => entry.name.endsWith(suffix))) output.push(absolutePath);
  }
}

async function writeBatch(tempDir, index, files) {
  const suites = files.map((file) =>
    `describe(${JSON.stringify(file)}, { concurrency: false }, async () => { await import(${JSON.stringify(pathToFileURL(file).href)}); });`);
  const batchPath = path.join(tempDir, `batch-${index}.mts`);
  await writeFile(batchPath, `import { describe } from 'node:test';\n${suites.join('\n')}`, 'utf8');
  return batchPath;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: withoutPiHarnessEnv({ ...process.env, FORCE_COLOR: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}

function parseReport(result) {
  const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/u)
    .map((value) => value.trim()).filter((value) => value.startsWith(REPORT_PREFIX)).at(-1);
  return line ? JSON.parse(line.slice(REPORT_PREFIX.length)) : null;
}

function merge(results, durationMs) {
  const counts = { tests: 0, failed: 0, passed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 0, suites: 0 };
  const failures = [];
  let success = true;
  for (const result of results) {
    const report = parseReport(result);
    if (!report || result.code !== 0 || result.signal !== null) success = false;
    for (const key of Object.keys(counts)) counts[key] += report?.summary?.counts?.[key] ?? 0;
    failures.push(...(report?.failures ?? []));
    if (!report) failures.push({ name: 'batched test subprocess failed', message: (result.stderr || result.stdout).trim() });
  }
  if (counts.failed > 0 || counts.cancelled > 0 || failures.length > 0) success = false;
  return { summary: { success, counts, durationMs }, coverage: null, failures };
}

async function buildPlan(mode, tempDir) {
  if (mode === 'root') {
    const batches = [];
    for (const [index, relativeDir] of rootBatchDirs.entries()) {
      const files = [];
      await walk(path.join(repoRoot, relativeDir), ['.test.ts', '.test.mjs'], files);
      files.sort();
      batches.push(await writeBatch(tempDir, index, files));
    }
    return { cwd: repoRoot, batches, tsxConfig: null, forceExitFiles: [] };
  }

  const definitions = {
    analysis: { cwd: path.join(repoRoot, 'analysis'), dir: 'analysis/test', batches: 4, tsxConfig: null },
    'computer-use': { cwd: repoRoot, dir: 'extensions/computer-use/test', batches: 3, tsxConfig: 'extensions/computer-use/tsconfig.json' },
    subagent: { cwd: repoRoot, dir: 'extensions/subagent/test', batches: 4, tsxConfig: 'extensions/subagent/tsconfig.json' },
  };
  const definition = definitions[mode];
  if (!definition) throw new Error(`Unknown fast batch mode: ${mode}`);
  const files = [];
  await walk(path.join(repoRoot, definition.dir), ['.test.ts'], files);
  files.sort();

  let ordinary = files;
  let individual = [];
  let forceExitFiles = [];
  if (mode === 'subagent') {
    forceExitFiles = files.filter((file) => file.endsWith(`${path.sep}preflight-abort.test.ts`));
    individual = [];
    ordinary = [];
    for (const file of files) {
      if (forceExitFiles.includes(file)) continue;
      const source = await readFile(file, 'utf8');
      (/\bModule\.register|\bmodule\.register/u.test(source) ? individual : ordinary).push(file);
    }
  }

  const buckets = Array.from({ length: definition.batches }, () => []);
  ordinary.forEach((file, index) => buckets[index % buckets.length].push(file));
  const batches = await Promise.all(buckets.map((bucket, index) => writeBatch(tempDir, index, bucket)));
  return { cwd: definition.cwd, batches: [...batches, ...individual], tsxConfig: definition.tsxConfig, forceExitFiles };
}

async function main() {
  const mode = process.argv[2];
  if (!mode) throw new Error('Usage: run-fast-batched-tests.mjs <root|analysis|subagent|computer-use>');
  const startedAt = performance.now();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `pie-${mode}-tests-`));
  try {
    const plan = await buildPlan(mode, tempDir);
    const tsxCli = path.join(plan.cwd, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const configArgs = plan.tsxConfig ? [`--tsconfig=${plan.tsxConfig}`] : [];
    const common = [tsxCli, '--test', ...configArgs, `--test-reporter=${reporter}`];
    const runs = [run(process.execPath, [...common, `--test-concurrency=${plan.batches.length}`, ...plan.batches], plan.cwd)];
    if (plan.forceExitFiles.length > 0) {
      runs.push(run(process.execPath, [...common, '--test-force-exit', ...plan.forceExitFiles], plan.cwd));
    }
    const results = await Promise.all(runs);
    const report = merge(results, performance.now() - startedAt);
    process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(report)}\n`);
    if (!report.summary.success) process.exitCode = 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
