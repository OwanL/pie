import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { DeferredTriggerStore, replayTriggers, type TriggerOp } from '../../deferred-triggers/store';
import { readTriggerOps as readToolOps, replayTriggers as replayToolTriggers } from '../../../../harness/tools/deferred-triggers/store';

test('host and tool parsers/replay agree on durable timer starts and legacy behavior', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-timer-metadata-test-'));
  const saved = process.env.PIE_TRIGGERS_DIR;
  process.env.PIE_TRIGGERS_DIR = dir;
  try {
    const file = path.join(dir, 'triggers.jsonl');
    const store = new DeferredTriggerStore(file);
    const start = '2026-01-01T00:00:01.000Z';
    const later = '2026-01-01T00:00:02.000Z';
    const ops: TriggerOp[] = [];
    const ids = ['wake', 'legacy', 'immediate', 'non-timer', 'claimed', 'retryable', 'cancelled', 'fired'];
    for (const id of ids) {
      ops.push({ id, op: 'register', sessionPath: '/creator', targetSession: '/target',
        triggers: id === 'non-timer' ? [{ kind: 'user_input' }] : [{ kind: 'timer', ms: 1000 }],
        ...(id === 'legacy' ? {} : { wakeupMode: id !== 'immediate' }) });
    }
    ops.push(
      { id: 'claimed', op: 'claim', sessionPath: '/creator', claimId: 'claim' },
      { id: 'retryable', op: 'failed', sessionPath: '/creator' },
      { op: 'cancel', sessionPath: '/creator', targetId: 'cancelled' },
      { id: 'fired', op: 'fire', sessionPath: '/creator' },
      { id: 'wake', op: 'timer-started', sessionPath: '/target', at: start },
      { id: 'wake', op: 'timer-started', sessionPath: '/creator', at: 'January 1 2026' },
      { id: 'wake', op: 'timer-started', sessionPath: '/creator', at: '2026-02-30T00:00:00.000Z' },
    );
    assert.equal(replayTriggers(ops).get('wake')?.timerStartedAt, undefined);
    assert.deepEqual(replayTriggers(ops), replayToolTriggers(ops));
    for (const id of [...ids, 'missing']) {
      ops.push({ id, op: 'timer-started', sessionPath: '/creator', at: start });
      ops.push({ id, op: 'timer-started', sessionPath: '/creator', at: later });
    }
    fs.writeFileSync(file, ops.map((op) => JSON.stringify(op)).join('\n') + '\n');
    const hostOps = store.readOps();
    assert.deepEqual(hostOps, readToolOps());
    const active = replayTriggers(hostOps);
    assert.deepEqual(active, replayToolTriggers(hostOps));
    assert.equal(active.get('wake')?.timerStartedAt, start);
    assert.equal(active.get('legacy')?.wakeupMode, false);
    assert.equal(active.get('immediate')?.wakeupMode, false);
    for (const id of ['legacy', 'immediate', 'non-timer', 'claimed', 'retryable']) {
      assert.equal(active.get(id)?.timerStartedAt, undefined, id);
    }
    for (const id of ['cancelled', 'fired', 'missing']) assert.equal(active.has(id), false);

    fs.appendFileSync(file, [
      { op: 'register', id: 'bad-mode', sessionPath: '/creator', triggers: [{ kind: 'timer', ms: 1 }], wakeupMode: 'true' },
      { op: 'timer-started', sessionPath: '/creator', at: start },
      { op: 'timer-started', id: 'wake', sessionPath: '/creator' },
    ].map((op) => JSON.stringify(op)).join('\n'));
    assert.deepEqual(store.readOps(), hostOps);
    assert.deepEqual(readToolOps(), hostOps);
  } finally {
    if (saved === undefined) delete process.env.PIE_TRIGGERS_DIR;
    else process.env.PIE_TRIGGERS_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
