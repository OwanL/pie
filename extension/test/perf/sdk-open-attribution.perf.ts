/**
 * SDK session-open attribution bench.
 *
 * Times the pinned pi SDK's SessionManager.open path directly against the
 * same real session files the session-store harness uses, isolating pi's
 * share of the open cost from pie's envelope building:
 *
 *   readFile+parse (floor) → SessionManager.open → getBranch → getEntries
 *   → buildSessionContext → getTree → JSON.stringify(branch)
 *
 * Run:   npx tsx ./test/perf/sdk-open-attribution.perf.ts   (from extension/)
 * Not swept by `npm test` (*.perf.ts). Writes to ./test/perf/reports/.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = resolve(HERE, '..', '..');
const REPO_ROOT = resolve(EXTENSION_ROOT, '..');
const DEFAULT_SESSION_DIR = join(REPO_ROOT, 'data', 'outcomes', 'sessions');
const SESSION_DIR = process.env.PIE_PERF_SESSION_DIR ? resolve(process.env.PIE_PERF_SESSION_DIR) : DEFAULT_SESSION_DIR;
const SDK_PATH = join(EXTENSION_ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent');

async function loadSdk(): Promise<typeof import('@earendil-works/pi-coding-agent')> {
  const sdk = await import(pathToFileURL(join(SDK_PATH, 'dist', 'index.js')).href);
  return sdk as typeof import('@earendil-works/pi-coding-agent');
}

interface Sample { path: string; bytes: number; name: string }

function sampleSessions(): Sample[] {
  const files: Sample[] = [];
  for (const entry of readdirSync(SESSION_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const bytes = statSync(join(SESSION_DIR, entry.name)).size;
        if (bytes > 100_000) files.push({ path: join(SESSION_DIR, entry.name), bytes, name: entry.name });
      } catch { /* raced */ }
    }
  }
  files.sort((a, b) => a.bytes - b.bytes);
  const targets = [files[0], files[Math.floor(files.length / 2)], files[files.length - 1]];
  return targets;
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
}

async function main(): Promise<void> {
  console.log('pi SDK session-open attribution');
  console.log(`session dir: ${SESSION_DIR}`);
  const sdk = await loadSdk();
  console.log(`sdk: @earendil-works/pi-coding-agent (loaded from ${SDK_PATH})`);
  const samples = sampleSessions();

  const rows: Record<string, unknown>[] = [];
  for (const sample of samples) {
    const copyDir = mkdtempSync(join(tmpdir(), 'pie-sdk-attrib-'));
    const copyPath = join(copyDir, sample.name);
    copyFileSync(sample.path, copyPath);

    // 1. floor: read + line parse
    const text = readFileSync(copyPath, 'utf8');
    const lines = text.split('\n');
    const t0 = performance.now();
    for (const line of lines) if (line.trim()) JSON.parse(line);
    const parseMs = performance.now() - t0;

    // 2. open timing (5 samples, median)
    const openTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const a = performance.now();
      sdk.SessionManager.open(copyPath);
      openTimes.push(performance.now() - a);
    }
    const openMs = median(openTimes);

    // 3. per-op timing on a fresh open
    const manager = sdk.SessionManager.open(copyPath);
    const ops: Record<string, number> = {};
    const time = (label: string, fn: () => unknown): void => {
      const a = performance.now();
      const value = fn();
      ops[label] = performance.now() - a;
      if (label === 'getBranch') ops['branchRows'] = (value as unknown[]).length;
    };
    time('getBranch', () => manager.getBranch());
    time('getEntries', () => manager.getEntries());
    time('buildSessionContext', () => manager.buildSessionContext());
    if (typeof (manager as any).getTree === 'function') time('getTree', () => (manager as any).getTree());
    time('stringifyBranch', () => JSON.stringify(manager.getBranch()));

    rmSync(copyDir, { recursive: true, force: true });

    const row = {
      name: sample.name,
      bytes: sample.bytes,
      parseMs,
      openMs,
      ops,
    };
    rows.push(row);
    console.log(
      `${sample.name.slice(0, 40).padEnd(42)} ${(sample.bytes / 1024 / 1024).toFixed(1).padStart(5)}MiB ` +
      `parse ${fmtMs(parseMs).padStart(9)} open ${fmtMs(row.openMs).padStart(9)} ` +
      `getBranch ${fmtMs(ops['getBranch']).padStart(9)} ctx ${fmtMs(ops['buildSessionContext']).padStart(9)} ` +
      `stringify ${fmtMs(ops['stringifyBranch']).padStart(9)}`,
    );
  }

  const reportsDir = join(HERE, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    generatedAt: new Date().toISOString(),
    gitSha: (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: REPO_ROOT }).trim(); } catch { return 'unknown'; } })(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    sdkVersion: sdk.VERSION ?? 'unknown',
    rows,
  };
  const reportPath = join(reportsDir, `sdk-open-attribution-${stamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nreport written: ${reportPath}`);
}

void main();
