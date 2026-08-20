import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { appendTriggerOp, listActiveForSession, readTriggerOps, replayTriggers } from '../src/store.js';

/**
 * store.ts unit tests: the op log round-trips through the sidecar and the
 * replay semantics (register / fire / cancel-with-targetId / cancel-all)
 * match the host registry. `normalizeOp` is not exported, so it is exercised
 * through `readTriggerOps`.
 */

const TRIGGERS_DIR_ENV = 'PIE_TRIGGERS_DIR';
const TRIGGERS_FILE = 'triggers.jsonl';

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-deferred-triggers-ext-test-'));
  savedEnv = process.env[TRIGGERS_DIR_ENV];
  process.env[TRIGGERS_DIR_ENV] = dir;
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[TRIGGERS_DIR_ENV];
  } else {
    process.env[TRIGGERS_DIR_ENV] = savedEnv;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('append + read round-trips a register op', () => {
  appendTriggerOp({
    id: 't1',
    op: 'register',
    sessionPath: '/w.jsonl',
    triggers: [{ kind: 'session_finished' }],
    note: 'note',
    at: '2026-01-01T00:00:00.000Z',
  });
  const ops = readTriggerOps();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'register');
  assert.equal(ops[0].id, 't1');
});

test('replay: fire removes the trigger', () => {
  appendTriggerOp({ id: 't1', op: 'register', sessionPath: '/w.jsonl', triggers: [{ kind: 'user_input' }], at: new Date().toISOString() });
  appendTriggerOp({ id: 't1', op: 'fire', sessionPath: '/w.jsonl', reason: 'r', at: new Date().toISOString() });
  assert.equal(replayTriggers(readTriggerOps()).size, 0);
});

test('replay: cancel-all removes only that session’s triggers', () => {
  appendTriggerOp({ id: 'a', op: 'register', sessionPath: '/w.jsonl', triggers: [{ kind: 'user_input' }], at: new Date().toISOString() });
  appendTriggerOp({ id: 'b', op: 'register', sessionPath: '/w.jsonl', triggers: [{ kind: 'timer', ms: 1000 }], at: new Date().toISOString() });
  appendTriggerOp({ id: 'c', op: 'register', sessionPath: '/other.jsonl', triggers: [{ kind: 'user_input' }], at: new Date().toISOString() });
  appendTriggerOp({ op: 'cancel', sessionPath: '/w.jsonl', at: new Date().toISOString() });
  const map = replayTriggers(readTriggerOps());
  assert.equal(map.size, 1);
  assert.ok(map.has('c'));
});

test('listActiveForSession filters to the requested session', () => {
  appendTriggerOp({ id: 'a', op: 'register', sessionPath: '/w.jsonl', triggers: [{ kind: 'user_input' }], note: 'w-task', at: new Date().toISOString() });
  appendTriggerOp({ id: 'b', op: 'register', sessionPath: '/other.jsonl', triggers: [{ kind: 'user_input' }], at: new Date().toISOString() });
  const list = listActiveForSession('/w.jsonl');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'a');
  assert.equal(list[0].note, 'w-task');
});

test('normalize: timer without ms, and bad kind, are rejected on read', () => {
  const file = path.join(dir, TRIGGERS_FILE);
  const lines = [
    { id: 'bad1', op: 'register', sessionPath: '/w.jsonl', triggers: [{ kind: 'timer' }], at: 'x' }, // timer no ms
    { id: 'bad2', op: 'register', sessionPath: '/w.jsonl', triggers: [{ kind: 'nope' }], at: 'x' }, // bad kind
    { id: 'ok', op: 'register', sessionPath: '/w.jsonl', triggers: [{ kind: 'session_finished' }], at: 'x' }, // valid
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  const map = replayTriggers(readTriggerOps());
  assert.equal(map.size, 1);
  assert.ok(map.has('ok'));
});

test('readTriggerOps tolerates corrupt lines without throwing', () => {
  appendTriggerOp({ id: 'a', op: 'register', sessionPath: '/w.jsonl', triggers: [{ kind: 'user_input' }], at: new Date().toISOString() });
  const file = path.join(dir, TRIGGERS_FILE);
  fs.appendFileSync(file, 'not json\n', 'utf8');
  const ops = readTriggerOps();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].id, 'a');
});
