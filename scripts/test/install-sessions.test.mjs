// Focused unit tests for scripts/install/lib/sessions.mjs — the session-history
// merge core. Verifies bucket naming, header-cwd parsing, latest-timestamp
// selection, and the copy/identical/conflict-backup merge semantics that both
// shell installers rely on (and that scripts/migrate-local-sessions.mjs
// delegates to).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  defaultSessionBucketName,
  directoryHasJsonlFiles,
  listJsonlFiles,
  mergeLegacySessions,
  sessionInfo,
} from '../install/lib/sessions.mjs';

function withTempDir(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-install-sessions-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function sessionJsonl(cwd, timestamp, extra = []) {
  const lines = [
    JSON.stringify({ type: 'session', cwd, timestamp }),
    ...extra,
  ];
  return `${lines.join('\n')}\n`;
}

test('defaultSessionBucketName slugs cwd with leading-separator strip and colon/slash replace', () => {
  // A colon AND an adjacent backslash each become a dash (matches the original
  // migrate-local-sessions.mjs `replace(/[\\/:]/g, '-')`).
  assert.equal(defaultSessionBucketName('C:\\Users\\me\\repo'), '--C--Users-me-repo--');
  assert.equal(defaultSessionBucketName('/home/me/repo'), '--home-me-repo--');
  assert.equal(defaultSessionBucketName('/leading'), '--leading--');
  assert.equal(defaultSessionBucketName(null), '--unknown--');
  assert.equal(defaultSessionBucketName(''), '--unknown--');
});

test('sessionInfo reads header cwd and the latest timestamp across lines', () => withTempDir((root) => {
  const file = path.join(root, 's.jsonl');
  writeFileSync(file, sessionJsonl('/home/me/repo', '2024-01-01T00:00:00.000Z', [
    JSON.stringify({ type: 'message', timestamp: '2024-03-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'message', timestamp: '2024-02-01T00:00:00.000Z' }),
  ]));
  const info = sessionInfo(file);
  assert.equal(info.bucket, '--home-me-repo--');
  assert.ok(info.latest >= Date.parse('2024-03-01T00:00:00.000Z'));
}));

test('sessionInfo falls back to the --unknown-- bucket when cwd is absent', () => withTempDir((root) => {
  const file = path.join(root, 's.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'message', text: 'hi' })}\n`);
  assert.equal(sessionInfo(file).bucket, '--unknown--');
}));

test('listJsonlFiles lists *.jsonl recursively by default, non-recursive when asked', () => withTempDir((root) => {
  mkdirSync(path.join(root, 'sub'));
  writeFileSync(path.join(root, 'a.jsonl'), '{}\n');
  writeFileSync(path.join(root, 'sub', 'b.jsonl'), '{}\n');
  writeFileSync(path.join(root, 'c.txt'), 'nope\n');
  assert.equal(listJsonlFiles(root).length, 2);
  assert.equal(listJsonlFiles(root, { recursive: false }).length, 1);
  assert.deepEqual(listJsonlFiles(path.join(root, 'missing')), []);
}));

test('directoryHasJsonlFiles is true only when a jsonl file is present', () => withTempDir((root) => {
  assert.equal(directoryHasJsonlFiles(root), false);
  writeFileSync(path.join(root, 'a.jsonl'), '{}\n');
  assert.equal(directoryHasJsonlFiles(root), true);
}));

test('mergeLegacySessions copies new files into bucketed destination dirs', () => withTempDir((root) => {
  const source = path.join(root, 'legacy');
  const dest = path.join(root, 'sessions');
  mkdirSync(source);
  writeFileSync(path.join(source, 's1.jsonl'), sessionJsonl('/home/me/repo', '2024-01-01T00:00:00.000Z'));
  const { totals, perSource } = mergeLegacySessions({ sources: [{ path: source, recursive: true }], destination: dest });
  assert.equal(totals.copied, 1);
  assert.equal(totals.conflicts, 0);
  assert.equal(existsSync(path.join(dest, '--home-me-repo--', 's1.jsonl')), true);
  assert.equal(perSource[0].skipped, false);
}));

test('mergeLegacySessions skips identical files (sha256 equal)', () => withTempDir((root) => {
  const source = path.join(root, 'legacy');
  const dest = path.join(root, 'sessions');
  mkdirSync(source, { recursive: true });
  mkdirSync(path.join(dest, '--home-me-repo--'), { recursive: true });
  const content = sessionJsonl('/home/me/repo', '2024-01-01T00:00:00.000Z');
  writeFileSync(path.join(source, 's.jsonl'), content);
  writeFileSync(path.join(dest, '--home-me-repo--', 's.jsonl'), content);
  const { totals } = mergeLegacySessions({ sources: [{ path: source, recursive: true }], destination: dest });
  assert.equal(totals.identical, 1);
  assert.equal(totals.copied, 0);
  assert.equal(totals.conflicts, 0);
}));

// Pin a file's mtime to the distant past so sessionInfo's `max(mtime, parsed
// timestamp)` falls back to the JSON `timestamp` field — exercising the
// timestamp-floor code path and making the newer/older ordering deterministic.
const PAST = new Date('2020-01-01T00:00:00Z');
function freezeMtime(file) { utimesSync(file, PAST, PAST); }

test('mergeLegacySessions overwrites when the incoming source is newer and backs up the old destination', () => withTempDir((root) => {
  const source = path.join(root, 'legacy');
  const dest = path.join(root, 'sessions');
  mkdirSync(path.join(dest, '--home-me-repo--'), { recursive: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(dest, '--home-me-repo--', 's.jsonl'), sessionJsonl('/home/me/repo', '2024-01-01T00:00:00.000Z'));
  writeFileSync(path.join(source, 's.jsonl'), sessionJsonl('/home/me/repo', '2024-06-01T00:00:00.000Z'));
  freezeMtime(path.join(dest, '--home-me-repo--', 's.jsonl'));
  freezeMtime(path.join(source, 's.jsonl'));
  const { totals } = mergeLegacySessions({ sources: [{ path: source, recursive: true }], destination: dest });
  assert.equal(totals.updated, 1);
  assert.equal(totals.conflicts, 1);
  // Destination now holds the newer content.
  assert.ok(readFileSync(path.join(dest, '--home-me-repo--', 's.jsonl'), 'utf8').includes('2024-06-01'));
  // A .conflict.*.bak backup of the old destination exists.
  const backups = readdirSync(path.join(dest, '--home-me-repo--')).filter((f) => f.startsWith('s.jsonl.conflict.') && f.endsWith('.bak') && !f.endsWith('.incoming.bak'));
  assert.equal(backups.length, 1);
}));

test('mergeLegacySessions preserves an older incoming source as .incoming.bak (destination wins)', () => withTempDir((root) => {
  const source = path.join(root, 'legacy');
  const dest = path.join(root, 'sessions');
  mkdirSync(path.join(dest, '--home-me-repo--'), { recursive: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(dest, '--home-me-repo--', 's.jsonl'), sessionJsonl('/home/me/repo', '2024-06-01T00:00:00.000Z'));
  writeFileSync(path.join(source, 's.jsonl'), sessionJsonl('/home/me/repo', '2024-01-01T00:00:00.000Z'));
  freezeMtime(path.join(dest, '--home-me-repo--', 's.jsonl'));
  freezeMtime(path.join(source, 's.jsonl'));
  const { totals } = mergeLegacySessions({ sources: [{ path: source, recursive: true }], destination: dest });
  assert.equal(totals.updated, 0);
  assert.equal(totals.conflicts, 1);
  // Destination unchanged (still the newer June content).
  assert.ok(readFileSync(path.join(dest, '--home-me-repo--', 's.jsonl'), 'utf8').includes('2024-06-01'));
  // Incoming older source preserved as .incoming.bak.
  const incoming = readdirSync(path.join(dest, '--home-me-repo--')).filter((f) => f.endsWith('.incoming.bak'));
  assert.equal(incoming.length, 1);
}));

test('mergeLegacySessions skips a source that resolves to the destination and de-duplicates', () => withTempDir((root) => {
  const dest = path.join(root, 'sessions');
  mkdirSync(dest, { recursive: true });
  const { perSource } = mergeLegacySessions({
    sources: [
      { path: dest, recursive: true },
      { path: dest, recursive: true }, // duplicate
    ],
    destination: dest,
  });
  assert.equal(perSource.length, 1);
  assert.equal(perSource[0].skipped, true);
}));

test('mergeLegacySessions respects per-source recursive=false (flat import)', () => withTempDir((root) => {
  const source = path.join(root, 'legacy');
  const dest = path.join(root, 'sessions');
  mkdirSync(path.join(source, 'nested'), { recursive: true });
  writeFileSync(path.join(source, 'top.jsonl'), sessionJsonl('/repo', '2024-01-01T00:00:00.000Z'));
  writeFileSync(path.join(source, 'nested', 'deep.jsonl'), sessionJsonl('/repo', '2024-01-01T00:00:00.000Z'));
  const { totals } = mergeLegacySessions({ sources: [{ path: source, recursive: false }], destination: dest });
  // Only the top-level file is imported; the nested one is ignored.
  assert.equal(totals.copied, 1);
  assert.equal(existsSync(path.join(dest, '--repo--', 'top.jsonl')), true);
  assert.equal(existsSync(path.join(dest, '--repo--', 'deep.jsonl')), false);
}));
