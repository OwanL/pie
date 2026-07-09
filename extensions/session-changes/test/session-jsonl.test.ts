import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  deriveFileChangesFromSessionEntries,
  parseSessionFileChanges,
  readSessionCwd,
} from '../src/session-jsonl';
import type { FileChange } from '../src/types';

// Helpers to build JSONL-shaped entries concisely.
function header(cwd = '/proj'): Record<string, unknown> {
  return { type: 'session', version: 3, id: 's1', timestamp: 't0', cwd };
}
function assistantMsg(
  id: string,
  timestamp: string,
  toolCalls: Record<string, unknown>[],
): Record<string, unknown> {
  return { type: 'message', id, timestamp, message: { role: 'assistant', content: toolCalls } };
}
function toolResult(
  id: string,
  timestamp: string,
  toolCallId: string,
  toolName: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'message', id, timestamp,
    message: { role: 'toolResult', toolCallId, toolName, content: 'ok', isError: false, ...extra },
  };
}
function tc(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { type: 'toolCall', id, name, arguments: args };
}

function derive(entries: Record<string, unknown>[]): FileChange[] {
  return deriveFileChangesFromSessionEntries(entries as never);
}

// ─── readSessionCwd ─────────────────────────────────────────────────────────

test('readSessionCwd: returns the header cwd', () => {
  assert.equal(readSessionCwd([header('/my/proj')] as never), '/my/proj');
});

test('readSessionCwd: undefined when no session header', () => {
  assert.equal(readSessionCwd([assistantMsg('m1', 't1', [])] as never), undefined);
});

// ─── basic derivation + the arguments→input mapping ────────────────────────

test('derive: write toolCall → created, input mapped from arguments', () => {
  const changes = derive([
    header(),
    assistantMsg('m1', 't1', [tc('c1', 'write', { path: 'a.ts', content: 'x\ny\nz' })]),
    toolResult('tr1', 't1', 'c1', 'write'),
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, 'a.ts');
  assert.equal(changes[0].kind, 'created');
  assert.equal(changes[0].additions, 3);
  assert.equal(changes[0].messageId, 'm1');
});

test('derive: edit toolCall → modified with churn', () => {
  const changes = derive([
    header(),
    assistantMsg('m1', 't1', [tc('c1', 'edit', { path: 'a.ts', oldText: 'a\nb', newText: 'a\nb\nc' })]),
    toolResult('tr1', 't1', 'c1', 'edit'),
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'modified');
  assert.equal(changes[0].additions, 3);
  assert.equal(changes[0].deletions, 2);
});

test('derive: bash rm → deleted entries (multi-file)', () => {
  const changes = derive([
    header(),
    assistantMsg('m1', 't1', [tc('c1', 'bash', { command: 'rm a.txt b.txt' })]),
    toolResult('tr1', 't1', 'c1', 'bash'),
  ]);
  assert.equal(changes.length, 2);
  const paths = changes.map((c) => c.path).sort();
  assert.deepEqual(paths, ['a.txt', 'b.txt']);
  for (const c of changes) assert.equal(c.kind, 'deleted');
});

test('derive: non-file tool (read) produces nothing', () => {
  const changes = derive([
    header(),
    assistantMsg('m1', 't1', [tc('c1', 'read', { path: 'a.ts' })]),
    toolResult('tr1', 't1', 'c1', 'read'),
  ]);
  assert.equal(changes.length, 0);
});

// ─── the join: subagent details on the SEPARATE toolResult entry ───────────

test('derive: subagent inner changes attributed via the joined toolResult details', () => {
  const details = {
    mode: 'single', agentScope: 'user', projectAgentsDir: null,
    results: [{
      agent: 'worker', task: 't', exitCode: 0,
      messages: [{ role: 'assistant', content: [tc('inner', 'write', { path: 'sub.ts', content: 'd\ne' })] }],
      stderr: '', usage: {},
    }],
  };
  const changes = derive([
    header(),
    assistantMsg('m1', 't1', [tc('c1', 'subagent', { agent: 'worker', task: 't' })]),
    toolResult('tr1', 't1', 'c1', 'subagent', { details }),
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, 'sub.ts');
  assert.equal(changes[0].kind, 'created');
  // Synthetic id derived from the parent toolCallId (c1) — proves the join fed
  // details to the subagent recursion (a plain content scan would drop this).
  assert.ok(changes[0].toolCallId.startsWith('c1-sa'));
});

test('derive: subagent with NO joined result produces nothing (no details to scan)', () => {
  // The assistant toolCall part carries no details; with no toolResult entry
  // joined, there's nothing to recurse into — 'subagent' isn't file-modifying.
  const changes = derive([
    header(),
    assistantMsg('m1', 't1', [tc('c1', 'subagent', { agent: 'worker', task: 't' })]),
    // no toolResult entry
  ]);
  assert.equal(changes.length, 0);
});

// ─── the join: failed edits (isError) are skipped ───────────────────────────

test('derive: toolCall whose toolResult.isError=true is skipped', () => {
  const changes = derive([
    header(),
    assistantMsg('m1', 't1', [tc('c1', 'edit', { path: 'bad.ts', oldText: 'a', newText: 'b' })]),
    toolResult('tr1', 't1', 'c1', 'edit', { isError: true }),
  ]);
  assert.equal(changes.length, 0);
});

test('derive: toolCall with NO toolResult entry is NOT skipped (matches host running/completed)', () => {
  // The host only skips status==='failed'; a call with no result is treated as
  // non-failed. The extension matches: no joined result → not skipped.
  const changes = derive([
    header(),
    assistantMsg('m1', 't1', [tc('c1', 'write', { path: 'a.ts', content: 'x' })]),
    // no toolResult entry
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, 'a.ts');
});

// ─── accumulation + net no-op ───────────────────────────────────────────────

test('derive: accumulates churn across multiple edits to the same file', () => {
  const changes = derive([
    header(),
    assistantMsg('m1', 't1', [tc('c1', 'edit', { path: 'a.ts', oldText: 'x', newText: 'a\nb' })]),
    toolResult('tr1', 't1', 'c1', 'edit'),
    assistantMsg('m2', 't2', [tc('c2', 'edit', { path: 'a.ts', oldText: 'a\nb', newText: 'a\nb\nc\nd' })]),
    toolResult('tr2', 't2', 'c2', 'edit'),
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].additions, 6); // 2 (edit1) + 4 (edit2)
  assert.equal(changes[0].deletions, 3); // 1 (edit1) + 2 (edit2)
});

test('derive: created-then-deleted is a net no-op', () => {
  const changes = derive([
    header(),
    assistantMsg('m1', 't1', [tc('c1', 'write', { path: 'tmp.ts', content: 'x' })]),
    toolResult('tr1', 't1', 'c1', 'write'),
    assistantMsg('m2', 't2', [tc('c2', 'bash', { command: 'rm tmp.ts' })]),
    toolResult('tr2', 't2', 'c2', 'bash'),
  ]);
  assert.equal(changes.length, 0);
});

// ─── parseSessionFileChanges (read-from-disk) ───────────────────────────────

test('parseSessionFileChanges: reads cwd from header + derives from a JSONL file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-sc-'));
  const file = path.join(dir, 'session.jsonl');
  const lines = [
    JSON.stringify(header('/the/cwd')),
    JSON.stringify(assistantMsg('m1', 't1', [tc('c1', 'write', { path: 'a.ts', content: 'hi' })])),
    JSON.stringify(toolResult('tr1', 't1', 'c1', 'write')),
    // a malformed line is skipped, not fatal
    '{not json',
    '', // blank line skipped
  ];
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
  try {
    const parsed = parseSessionFileChanges(file);
    assert.equal(parsed.cwd, '/the/cwd');
    assert.equal(parsed.changes.length, 1);
    assert.equal(parsed.changes[0].path, 'a.ts');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('parseSessionFileChanges: throws a clear message on a missing file', () => {
  assert.throws(
    () => parseSessionFileChanges('/no/such/file.jsonl'),
    /Could not read session file/,
  );
});
