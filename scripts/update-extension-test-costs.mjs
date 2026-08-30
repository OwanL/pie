#!/usr/bin/env node

// Regenerate scripts/extension-test-costs.json: the per-file serial test cost
// table that run-fast-extension-tests.mjs uses for load-balanced batch
// bucketing. Run this after adding notably heavy test files or when the
// slowest bundle-batch child clearly dominates the wave again:
//
//   node scripts/update-extension-test-costs.mjs
//
// The full extension suite runs once (with the timing reporter) and the
// aggregated serial per-test durations are keyed by extension-relative test
// path (test/..., POSIX separators) to match balancedBuckets' lookups.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerPath = path.join(repoRoot, 'scripts', 'run-fast-extension-tests.mjs');
const reporterPath = path.join(repoRoot, 'scripts', 'test-costs-reporter.mjs');
const outputTablePath = path.join(repoRoot, 'scripts', 'extension-test-costs.json');
const extensionRoot = path.join(repoRoot, 'extension');

const timingDir = await mkdtemp(path.join(os.tmpdir(), 'pie-test-costs-'));
const timingOutput = path.join(timingDir, 'costs.jsonl');

console.error('Running the full extension suite to collect per-test timings...');
const result = spawnSync(process.execPath, [runnerPath], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PIE_TIMING_REPORTER: reporterPath,
    TIMING_OUTPUT: timingOutput,
  },
  stdio: 'inherit',
  windowsHide: true,
});
if (result.status !== 0) {
  console.error('Fast extension suite failed; cost table not updated.');
  await rm(timingDir, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

const parts = (await readdir(timingDir)).filter((name) => name.startsWith('costs.jsonl.'));
const perFile = new Map();
for (const part of parts) {
  const content = await readFile(path.join(timingDir, part), 'utf8');
  for (const line of content.trim().split('\n')) {
    const entry = JSON.parse(line);
    for (const test of entry.tests ?? []) {
      let sourcePath = String(test.file ?? '').replace(/\\/gu, '/');
      const bundledMatch = sourcePath.match(/pie-extension-fast-[^/]+\/(.*)\.js$/u);
      if (bundledMatch) sourcePath = `${bundledMatch[1]}.ts`;
      sourcePath = sourcePath.replace(/^.*GitHub\/pie\/extension\//u, '');
      // Bundled output loses the .tsx extension; resolve it from disk.
      if (!sourcePath.startsWith('test/') || !existsSync(path.join(extensionRoot, sourcePath))) {
        const fallback = sourcePath.replace(/\.ts$/u, '.tsx');
        sourcePath = existsSync(path.join(extensionRoot, fallback)) ? fallback : sourcePath;
      }
      if (!sourcePath.startsWith('test/')) continue;
      perFile.set(sourcePath, (perFile.get(sourcePath) ?? 0) + (Number(test.dur) || 0));
    }
  }
}
await rm(timingDir, { recursive: true, force: true });

const table = {};
for (const [key, cost] of [...perFile.entries()].sort((a, b) => b[1] - a[1])) {
  table[key] = Math.max(1, Math.round(cost));
}
await writeFile(outputTablePath, `${JSON.stringify(table, null, 1)}\n`, 'utf8');
console.error(`Wrote ${Object.keys(table).length} per-file costs to scripts/extension-test-costs.json`);