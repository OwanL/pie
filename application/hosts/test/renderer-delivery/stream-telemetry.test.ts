import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

import {
  flushStreamDiag,
  getDiagPath,
  isStreamDiagEnabled,
  recordSnapshotPost,
  recordStreamEvent,
  recordWatchdog,
  setStreamDiagEnabled,
} from '../../../lib/stream-telemetry.js';

interface DiagRecord {
  ts: string;
  windowMs: number;
  deltas: number;
  thinking: number;
  snapshotPosts: number;
  wdResnapshot: number;
  wdThrottled: number;
  wdReload: number;
}

const DIAG_PATH = getDiagPath();

function clearDiagFile(): void {
  fs.rmSync(DIAG_PATH, { force: true });
  fs.rmSync(`${DIAG_PATH}.1`, { force: true });
}

function resetWindow(): void {
  setStreamDiagEnabled(false);
  flushStreamDiag();
  clearDiagFile();
}

function readRecords(): DiagRecord[] {
  let text = '';
  try {
    text = fs.readFileSync(DIAG_PATH, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return text ? text.split('\n').map((line) => JSON.parse(line) as DiagRecord) : [];
}

function recordAndFlush(record: () => void): DiagRecord {
  resetWindow();
  setStreamDiagEnabled(true);
  record();
  flushStreamDiag();
  setStreamDiagEnabled(false);
  const records = readRecords();
  assert.equal(records.length, 1, 'one active window produces one record');
  return records[0]!;
}

test.after(() => {
  setStreamDiagEnabled(false);
  clearDiagFile();
});

test('enable/disable toggle round-trips and diagnostic path is stable', () => {
  setStreamDiagEnabled(false);
  assert.equal(isStreamDiagEnabled(), false);
  assert.equal(setStreamDiagEnabled(true), true);
  assert.equal(isStreamDiagEnabled(), true);
  assert.equal(setStreamDiagEnabled(false), false);
  assert.equal(getDiagPath(), DIAG_PATH);
  assert.ok(path.isAbsolute(DIAG_PATH));
  assert.ok(DIAG_PATH.endsWith('pie-diag.jsonl'));
});

test('flush reports exact event and watchdog counts', () => {
  const record = recordAndFlush(() => {
    for (let i = 0; i < 7; i++) recordStreamEvent('delta');
    for (let i = 0; i < 3; i++) recordStreamEvent('thinking');
    for (let i = 0; i < 5; i++) recordSnapshotPost();
    recordWatchdog('resnapshot');
    recordWatchdog('resnapshot');
    recordWatchdog('throttled');
    recordWatchdog('reload');
  });

  assert.deepEqual(Object.keys(record).sort(), [
    'deltas', 'snapshotPosts', 'thinking', 'ts', 'wdReload', 'wdResnapshot', 'wdThrottled', 'windowMs',
  ]);
  assert.equal(record.windowMs, 1000);
  assert.equal(record.deltas, 7);
  assert.equal(record.thinking, 3);
  assert.equal(record.snapshotPosts, 5);
  assert.equal(record.wdResnapshot, 2);
  assert.equal(record.wdThrottled, 1);
  assert.equal(record.wdReload, 1);
});

test('stream diagnostic rotates at a fixed size and keeps one backup', () => {
  resetWindow();
  fs.writeFileSync(DIAG_PATH, 'first'.repeat(1_100_000), 'utf8');
  setStreamDiagEnabled(true);
  recordStreamEvent('delta');
  flushStreamDiag();
  setStreamDiagEnabled(false);
  assert.ok(fs.existsSync(`${DIAG_PATH}.1`), 'rotation should retain one backup');
  assert.match(fs.readFileSync(`${DIAG_PATH}.1`, 'utf8'), /^first/);
  assert.match(fs.readFileSync(DIAG_PATH, 'utf8'), /"deltas":1/);

  fs.writeFileSync(DIAG_PATH, 'second'.repeat(1_100_000), 'utf8');
  setStreamDiagEnabled(true);
  recordSnapshotPost();
  flushStreamDiag();
  setStreamDiagEnabled(false);
  assert.doesNotMatch(fs.readFileSync(`${DIAG_PATH}.1`, 'utf8'), /^first/);
  assert.match(fs.readFileSync(`${DIAG_PATH}.1`, 'utf8'), /^second/);
  assert.equal(fs.existsSync(`${DIAG_PATH}.2`), false, 'rotation is one-deep');
});

test('disabled recording and idle flush produce no output', () => {
  resetWindow();
  recordStreamEvent('delta');
  recordStreamEvent('thinking');
  recordSnapshotPost();
  recordWatchdog('resnapshot');
  flushStreamDiag();
  assert.deepEqual(readRecords(), []);
});

test('recording and flushing never throw when disabled', () => {
  resetWindow();
  assert.doesNotThrow(() => recordStreamEvent('delta'));
  assert.doesNotThrow(() => recordSnapshotPost());
  assert.doesNotThrow(() => recordWatchdog('reload'));
  assert.doesNotThrow(() => flushStreamDiag());
});
