import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loggerUrl = pathToFileURL(path.resolve(__dirname, '../src/logger.ts')).href;

async function load() {
  const m = await import(loggerUrl);
  return m as {
    logAutoPruneRewrite: (sessionId: string, before: string, after: string) => void;
    logSessionSummary: (sessionId: string, summary: Record<string, unknown>) => void;
    flushLog: () => Promise<void>;
    setLogPathForTesting: (p: string | null) => void;
    setMaxLogBytesForTesting: (b: number | null) => void;
  };
}

function readLines(file: string): unknown[] {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.trim().split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

describe('warm-bash logger (side-channel analytics jsonl)', () => {
  let tmpDir: string;
  let logFile: string;

  test.before(async () => {
    const L = await load();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-bash-log-'));
    logFile = path.join(tmpDir, 'warm-bash.jsonl');
    L.setLogPathForTesting(logFile);
  });
  test.after(async () => {
    const L = await load();
    L.setLogPathForTesting(null);
    L.setMaxLogBytesForTesting(null);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  test('logAutoPruneRewrite appends one point-in-time event line per rewrite', async () => {
    const L = await load();
    L.logAutoPruneRewrite('sess-1', 'grep -rn foo .', 'grep --exclude-dir=node_modules -rn foo .');
    L.logAutoPruneRewrite('sess-1', 'find . -name x', 'find . \\( -name node_modules \\) -prune');
    await L.flushLog();
    const lines = readLines(logFile) as Array<{ event: string; sessionId: string; timestamp: string; before: string; after: string }>;
    assert.equal(lines.length, 2);
    for (const l of lines) {
      assert.equal(l.event, 'auto_prune_rewrite');
      assert.equal(l.sessionId, 'sess-1');
      assert.match(l.timestamp, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(typeof l.before, 'string');
      assert.equal(typeof l.after, 'string');
    }
    assert.equal(lines[0]!.before, 'grep -rn foo .');
    assert.ok(lines[0]!.after.includes('--exclude-dir=node_modules'));
  });

  test('logSessionSummary appends one cumulative-summary line with routing counters', async () => {
    const L = await load();
    L.logSessionSummary('sess-2', {
      fastPath: 42, warm: 7, fallback: 3, poolSize: 2, warmupFailures: 1,
      autoPruneEnabled: true, fastPathEnabled: true, gnuGrep: true,
    });
    await L.flushLog();
    const lines = readLines(logFile) as Array<Record<string, unknown>>;
    const summary = lines.find((l) => l.event === 'session_summary');
    assert.ok(summary, 'session_summary line present');
    assert.equal(summary!.sessionId, 'sess-2');
    assert.equal(summary!.fastPath, 42);
    assert.equal(summary!.warm, 7);
    assert.equal(summary!.fallback, 3);
    assert.equal(summary!.poolSize, 2);
    assert.equal(summary!.warmupFailures, 1);
    assert.equal(summary!.autoPruneEnabled, true);
    assert.equal(summary!.fastPathEnabled, true);
    assert.equal(summary!.gnuGrep, true);
    assert.match(summary!.timestamp as string, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('writes are serialized — concurrent appends preserve order', async () => {
    const L = await load();
    const ordered: string[] = [];
    for (let i = 0; i < 50; i++) {
      ordered.push(`grep -rn p${i} .`);
      L.logAutoPruneRewrite('sess-3', `grep -rn p${i} .`, `grep --exclude-dir=node_modules -rn p${i} .`);
    }
    await L.flushLog();
    const lines = readLines(logFile).filter((l) => (l as { sessionId: string }).sessionId === 'sess-3') as Array<{ before: string }>;
    assert.equal(lines.length, 50);
    assert.deepEqual(lines.map((l) => l.before), ordered);
  });

  test('rotation: a low byte limit rotates the log into .1 and caps growth', async () => {
    const L = await load();
    const rotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-bash-rot-'));
    const rotFile = path.join(rotDir, 'warm-bash.jsonl');
    L.setLogPathForTesting(rotFile);
    L.setMaxLogBytesForTesting(120); // tiny: ~1-2 lines exceed this
    for (let i = 0; i < 10; i++) {
      L.logAutoPruneRewrite('sess-rot', `grep -rn pattern-${i}-padding-padding .`, `grep --exclude-dir=node_modules -rn pattern-${i} .`);
    }
    await L.flushLog();
    assert.ok(fs.existsSync(rotFile), 'current log recreated after rotation');
    assert.ok(fs.existsSync(`${rotFile}.1`), 'rotated backup .1 exists');
    // No more than the configured number of backups.
    assert.ok(!fs.existsSync(`${rotFile}.3`), 'no backup beyond MAX_ROTATIONS');
    L.setLogPathForTesting(null);
    L.setMaxLogBytesForTesting(null);
    try { fs.rmSync(rotDir, { recursive: true, force: true }); } catch { /* */ }
  });
});
