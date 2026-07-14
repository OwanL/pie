import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import {
  appendTriggerOp,
  readTriggerOps,
  replayTriggers,
  type TriggerOp,
} from '../../../src/host/deferred-triggers/store';

/**
 * deferred-triggers store: sidecar append/read + pure replay semantics.
 *
 * The replay is the load-bearing logic (shared conceptually with the
 * `defer_trigger` tool's own `list` action), so it gets the bulk of the tests:
 * register sets, fire deletes, cancel-with-targetId deletes one, cancel-all
 * deletes every trigger for a session, and a fire-then-reregister cycle
 * re-arms correctly.
 */

let dir: string;
let savedSessionDirEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-deferred-triggers-store-test-'));
  // Point the shared derivation at <dir>/sessions so the sidecar lands at
  // <dir>/deferred-triggers/triggers.jsonl.
  savedSessionDirEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(dir, 'sessions');
});

afterEach(() => {
  if (savedSessionDirEnv === undefined) {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  } else {
    process.env.PI_CODING_AGENT_SESSION_DIR = savedSessionDirEnv;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function register(id: string, sessionPath: string, triggers: unknown[], note = '', at = new Date().toISOString()): TriggerOp {
  return { id, op: 'register', sessionPath, triggers: triggers as never, note, at };
}

test('replay: register adds, fire removes the same id', () => {
  const ops: TriggerOp[] = [
    register('a', '/w.jsonl', [{ kind: 'session_finished' }]),
    { id: 'a', op: 'fire', sessionPath: '/w.jsonl', reason: 'x', at: new Date().toISOString() },
  ];
  assert.equal(replayTriggers(ops).size, 0);
});

test('replay: cancel with targetId removes only that id', () => {
  const ops: TriggerOp[] = [
    register('a', '/w.jsonl', [{ kind: 'user_input' }]),
    register('b', '/w.jsonl', [{ kind: 'user_input' }]),
    { op: 'cancel', sessionPath: '/w.jsonl', targetId: 'a', at: new Date().toISOString() },
  ];
  const map = replayTriggers(ops);
  assert.equal(map.size, 1);
  assert.ok(map.has('b'));
  assert.ok(!map.has('a'));
});

test('replay: cancel without targetId removes all triggers for that session only', () => {
  const ops: TriggerOp[] = [
    register('a', '/w.jsonl', [{ kind: 'user_input' }]),
    register('b', '/w.jsonl', [{ kind: 'timer', ms: 1000 }]),
    register('c', '/other.jsonl', [{ kind: 'user_input' }]),
    { op: 'cancel', sessionPath: '/w.jsonl', at: new Date().toISOString() },
  ];
  const map = replayTriggers(ops);
  assert.equal(map.size, 1);
  assert.ok(map.has('c'));
});

test('replay: a trigger can be registered again after firing (re-defer cycle)', () => {
  const at = new Date().toISOString();
  const ops: TriggerOp[] = [
    register('a', '/w.jsonl', [{ kind: 'session_finished' }], '', at),
    { id: 'a', op: 'fire', sessionPath: '/w.jsonl', reason: 'r', at },
    register('b', '/w.jsonl', [{ kind: 'session_finished' }], 'second', at),
  ];
  const map = replayTriggers(ops);
  assert.equal(map.size, 1);
  assert.ok(map.has('b'));
  assert.equal(map.get('b')!.note, 'second');
});

test('readTriggerOps + replay: malformed register lines are skipped, valid kept', () => {
  // `replayTriggers` trusts its input; the malformed-spec filtering happens
  // in `normalizeOp` on the read path, so this must go through `readTriggerOps`.
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  const lines = [
    { op: 'register', sessionPath: '/w.jsonl', id: 'x' }, // no triggers
    { op: 'register', sessionPath: '/w.jsonl', triggers: [{ kind: 'user_input' }] }, // no id
    { op: 'register', sessionPath: '/w.jsonl', id: 'y', triggers: [{ kind: 'bogus' }] }, // bad kind
    { op: 'register', sessionPath: '/w.jsonl', id: 'ok', triggers: [{ kind: 'user_input' }] }, // valid
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  const map = replayTriggers(readTriggerOps());
  assert.equal(map.size, 1);
  assert.ok(map.has('ok'));
});

test('append + read round-trips through the sidecar file', () => {
  appendTriggerOp(register('a', '/w.jsonl', [{ kind: 'session_finished' }], 'note'));
  appendTriggerOp({ op: 'cancel', sessionPath: '/w.jsonl', at: new Date().toISOString() });
  const ops = readTriggerOps();
  assert.equal(ops.length, 2);
  assert.equal(ops[0].op, 'register');
  assert.equal(ops[0].id, 'a');
  assert.equal(ops[1].op, 'cancel');
});

test('readTriggerOps tolerates a corrupt/malformed line without throwing', () => {
  appendTriggerOp(register('a', '/w.jsonl', [{ kind: 'user_input' }]));
  const file = path.join(dir, 'deferred-triggers', 'triggers.jsonl');
  fs.appendFileSync(file, 'not json\n{"op":"fire","id":"a","sessionPath":"/w.jsonl"}\n', 'utf8');
  const ops = readTriggerOps();
  assert.equal(ops.length, 2);
  assert.equal(ops[1].op, 'fire');
});
