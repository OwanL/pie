import assert from 'node:assert/strict';
import test, { describe, beforeEach, afterEach } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loggerUrl = pathToFileURL(path.resolve(__dirname, '../logger.ts')).href;

type Event = {
  event: 'tool_result_pruned';
  sessionId: string;
  toolName: string;
  rules: string[];
  beforeTokens: number;
  afterTokens: number;
  tokensSaved: number;
  timestamp: string;
};
type LoggerModule = {
  recordPruning: (e: Event) => void;
  flushLog: () => Promise<void>;
  setLogPathOverrideForTesting: (p: string | null, maxBytes?: number) => void;
};

describe('logger', () => {
  let mod: LoggerModule;
  let dir: string;
  let logPath: string;

  test.before(async () => {
    mod = (await import(loggerUrl)) as LoggerModule;
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'trp-log-'));
    logPath = path.join(dir, 'tool-result-pruning.jsonl');
    mod.setLogPathOverrideForTesting(logPath);
  });

  afterEach(() => {
    mod.setLogPathOverrideForTesting(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test('appends one JSONL line per pruned result', async () => {
    mod.recordPruning({
      event: 'tool_result_pruned', sessionId: 's1', toolName: 'bash',
      rules: ['ansi-strip', 'minify-json'], beforeTokens: 100, afterTokens: 40,
      tokensSaved: 60, timestamp: '2026-07-04T08:00:00.000Z',
    });
    mod.recordPruning({
      event: 'tool_result_pruned', sessionId: 's1', toolName: 'ls',
      rules: ['collapse-blank-runs'], beforeTokens: 50, afterTokens: 45,
      tokensSaved: 5, timestamp: '2026-07-04T08:00:01.000Z',
    });
    await mod.flushLog();

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]!);
    assert.equal(first.event, 'tool_result_pruned');
    assert.equal(first.toolName, 'bash');
    assert.deepEqual(first.rules, ['ansi-strip', 'minify-json']);
    assert.equal(first.tokensSaved, 60);
    const second = JSON.parse(lines[1]!);
    assert.equal(second.toolName, 'ls');
  });

  test('creates the parent directory if missing', async () => {
    const nested = path.join(dir, 'nested', 'deep', 'tool-result-pruning.jsonl');
    mod.setLogPathOverrideForTesting(nested);
    mod.recordPruning({
      event: 'tool_result_pruned', sessionId: 's1', toolName: 'bash',
      rules: ['ansi-strip'], beforeTokens: 10, afterTokens: 5,
      tokensSaved: 5, timestamp: '2026-07-04T08:00:00.000Z',
    });
    await mod.flushLog();
    const lines = readFileSync(nested, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);
  });

  test('rotates the log past the byte limit, keeping backups', async () => {
    // Force rotation at a tiny threshold so each ~140-byte line triggers it.
    mod.setLogPathOverrideForTesting(logPath, 200);
    for (let i = 0; i < 20; i++) {
      mod.recordPruning({
        event: 'tool_result_pruned', sessionId: 's1', toolName: 'bash',
        rules: ['ansi-strip'], beforeTokens: 10, afterTokens: 5,
        tokensSaved: 5, timestamp: '2026-07-04T08:00:00.000Z',
      });
    }
    await mod.flushLog();
    // Rotation fires BEFORE append, so the current file can be up to ~limit +
    // one line. The meaningful invariants: a .1 backup exists (rotation
    // happened) and the current file stays bounded under ~2x the limit.
    const cur = statSync(logPath).size;
    assert.ok(cur < 400, 'current log should stay bounded under 2x limit, got ' + cur);
    assert.ok(statSync(logPath + '.1').size > 0, '.1 backup should exist');
  });

  test('flushLog resolves even when no events were recorded', async () => {
    await mod.flushLog(); // no throw
  });

  test('a write-failure path never throws into the caller (best-effort)', async () => {
    // Point the log at a path whose parent is an existing file → write fails.
    const blocking = path.join(dir, 'blockfile');
    writeFileSync(blocking, 'x');
    mod.setLogPathOverrideForTesting(path.join(blocking, 'tool-result-pruning.jsonl'));
    mod.recordPruning({
      event: 'tool_result_pruned', sessionId: 's1', toolName: 'bash',
      rules: ['ansi-strip'], beforeTokens: 1, afterTokens: 0,
      tokensSaved: 1, timestamp: '2026-07-04T08:00:00.000Z',
    });
    await mod.flushLog(); // swallowed — no throw
  });
});