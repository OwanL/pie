import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { parseColdBrowseHelperInputFrame } from '../cold-browse-helper-entry';
import { coldBrowseSourceBytes, readColdBrowseFingerprintSync, type ColdBrowseHelperFence } from '../cold-browse-helper-protocol';
import { ColdBrowseProjectionCache } from '../cold-browse-projection-cache';
import { ColdBrowseHelperRuntime } from '../cold-browse-helper-runtime';
import { LIVE_PIPELINE_LIMITS } from '../../lib/rpc/live-pipeline';
import { DurableDetailNotFoundError, DurableDetailNotAddressableError } from '../../../session-storage/transcripts/durable-detail-store';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';

test('input parser admits only versioned control frames and known request operations', () => {
  const control = { protocolVersion: 2, kind: 'shutdown' };
  assert.equal(parseColdBrowseHelperInputFrame(control), control);
  const init = { protocolVersion: 2, kind: 'initialize', sdkPath: '/sdk', startupCwd: '/cwd', parentPid: 1, sdkRuntime: createSyntheticSourceTestSdkRuntime('/sdk') };
  assert.equal(parseColdBrowseHelperInputFrame(init), init);
  for (const field of ['sdkPath', 'startupCwd', 'parentPid']) {
    assert.equal(parseColdBrowseHelperInputFrame({ ...init, [field]: null }), undefined);
  }
  for (const operation of ['open', 'page', 'detail', 'durable-detail', 'invalidate']) {
    const request = { protocolVersion: 2, kind: 'request', requestId: 'r', payload: { operation } };
    assert.equal(parseColdBrowseHelperInputFrame(request), request);
  }
  for (const value of [null, false, [], 'frame', {}, { ...control, protocolVersion: 1 }, { ...control, kind: 4 }, { ...control, kind: 'unknown' },
    { protocolVersion: 2, kind: 'request', requestId: 1, payload: {} },
    ...[null, 'payload', [], {}, { operation: 'unknown' }].map(payload => ({ protocolVersion: 2, kind: 'request', requestId: 'r', payload })),
  ]) assert.equal(parseColdBrowseHelperInputFrame(value), undefined);
});

test('fingerprint weights reject malformed and unsafe sizes and stat failures remain visible', () => {
  assert.equal(coldBrowseSourceBytes('1:2:0:4:5'), 0);
  assert.equal(coldBrowseSourceBytes('1:2:123:4:5'), 123);
  for (const fingerprint of ['', 'missing', '1:2:-1:4:5', '1:2:x:4:5', '1:2:9007199254740992:4:5']) {
    assert.equal(coldBrowseSourceBytes(fingerprint), undefined);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-cold-fingerprint-'));
  try {
    assert.equal(readColdBrowseFingerprintSync(path.join(root, 'missing')), 'missing');
    assert.throws(() => readColdBrowseFingerprintSync(null as any), { code: 'ERR_INVALID_ARG_TYPE' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('weighted cache validates budgets and replacement weights without losing retained entries', () => {
  for (const budget of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ColdBrowseProjectionCache(budget), /byte budget/);
    assert.throws(() => new ColdBrowseProjectionCache(10, budget), /entry budget/);
  }
  assert.throws(() => new ColdBrowseProjectionCache(10, 0), /entry budget/);
  const cache = new ColdBrowseProjectionCache<string>(10, 2);
  const set = (key: string, sourceBytes: number, sessionPathKey = key) => cache.set({ key, sessionPathKey, sourceBytes, value: key });
  assert.equal(cache.get('missing'), undefined);
  set('a', 3); set('b', 3);
  for (const weight of [-1, NaN, 1.5]) assert.throws(() => set('a', weight), /byte weight/);
  assert.equal(cache.get('a'), 'a');
  set('a', 4);
  assert.equal(cache.snapshotStats(0).currentSourceBytes, 7);
  set('c', 4);
  assert.equal(cache.get('b'), undefined, 'replacement is newest and byte pressure evicts the oldest');
  cache.recordMiss(); cache.recordInflightJoin();
  cache.invalidatePath('a', 'a');
  assert.equal(cache.get('a'), 'a', 'exceptKey preserves the exact current projection');
  cache.invalidatePath('a');
  assert.equal(cache.get('a'), undefined);
  cache.clear(); cache.clear();
  const stats = cache.snapshotStats(2);
  assert.equal(stats.currentSourceBytes, 0);
  assert.equal(stats.invalidations, 2);
  assert.equal(stats.evictions, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.inflightJoins, 1);
  assert.equal(stats.inflight, 2);
  assert.ok(Object.isFrozen(stats));
  const oversized = new ColdBrowseProjectionCache<string>(0, 1);
  oversized.set({ key: 'large', sessionPathKey: 'large', sourceBytes: 20, value: 'large' });
  assert.equal(oversized.get('large'), 'large', 'one oversized current projection is retained');
});

function withRuntime(run: (runtime: ColdBrowseHelperRuntime, fence: ColdBrowseHelperFence, opens: () => number) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-cold-contract-'));
  const sessionPath = path.join(root, 'session.jsonl');
  fs.writeFileSync(sessionPath, 'durable source');
  const branch = [{ type: 'message', id: 'assistant', parentId: null, timestamp: '2026-08-25T00:00:00.000Z', message: {
    role: 'assistant', content: [{ type: 'thinking', thinking: 'small' }, { type: 'toolCall', id: 'tool', name: 'subagent', arguments: {} }],
    timestamp: 1, provider: 'mock', model: 'mock', stopReason: 'stop',
  } }, { type: 'message', id: 'result', parentId: 'assistant', timestamp: '2026-08-25T00:00:01.000Z', message: {
    role: 'toolResult', toolCallId: 'tool', details: { legacy: true }, timestamp: 2,
  } }, { type: 'message', id: 'user', parentId: 'result', timestamp: '2026-08-25T00:00:01.500Z', message: { role: 'user', content: 'next turn', timestamp: 2 } },
  { type: 'message', id: 'large', parentId: 'user', timestamp: '2026-08-25T00:00:02.000Z', message: {
    role: 'assistant', content: [{ type: 'thinking', thinking: 'x'.repeat(LIVE_PIPELINE_LIMITS.previewBytes + 1) }], timestamp: 3,
    provider: 'mock', model: 'mock', stopReason: 'stop',
  } }];
  let opens = 0;
  const runtime = new ColdBrowseHelperRuntime({ startupCwd: root, sdk: { SessionManager: { open: () => {
    opens++;
    return { getBranch: () => branch, getEntries: () => branch, getSessionName: () => undefined, getCwd: () => root,
      getSessionId: () => 'contract', buildSessionContext: () => ({ messages: [], thinkingLevel: 'medium', model: null }) };
  } } } as any });
  const fence = { sessionPath, sessionPathKey: sessionPath, fingerprint: readColdBrowseFingerprintSync(sessionPath), coordinatorGeneration: 1, ownershipRevision: 0 };
  return run(runtime, fence, () => opens).finally(() => { runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
}

test('detail retrieval distinguishes live ownership, missing, stale, loaded, and over-budget durable values', async () => {
  await withRuntime(async (runtime, fence, opens) => {
    const ref = { source: 'durable', kind: 'reasoning', messageId: 'assistant', partIndex: 0, key: 'detail', sizeBytes: 5, sessionPath: fence.sessionPath, summary: '' } as const;
    for (const [change, status, message] of [
      [{ source: 'live' }, 'unavailable', 'Live detail is owned'],
      [{ messageId: 'missing' }, 'unavailable', 'no longer available'],
      [{ sizeBytes: 4 }, 'stale', 'changed'],
      [{ messageId: 'large' }, 'unavailable', 'exceeds'],
      [{}, 'loaded', undefined],
    ] as const) {
      const response = await runtime.execute({ operation: 'detail', fence, ref: { ...ref, ...change } as any });
      const result = response.result as any;
      assert.equal(result.status, status);
      assert.equal(response.fingerprint, fence.fingerprint);
      if (message) assert.ok(result.message.includes(message), `${JSON.stringify(change)}: ${result.message}`);
      else { assert.equal(result.value, 'small'); assert.equal(result.sizeBytes, 5); }
    }
    assert.equal(opens(), 1);
  });
});

test('typed durable resolution failures do not poison the cached projection', async () => {
  await withRuntime(async (runtime, fence, opens) => {
    const address = { sessionPath: fence.sessionPath, turnId: 'turn', rootToolCallId: 'absent', rootAttemptId: 'attempt', lineage: [] };
    await assert.rejects(runtime.execute({ operation: 'durable-detail', fence, address }), DurableDetailNotFoundError);
    await assert.rejects(runtime.execute({ operation: 'durable-detail', fence, address: { ...address, rootToolCallId: 'tool' } }), DurableDetailNotAddressableError);
    assert.equal(opens(), 1);
    await runtime.execute({ operation: 'invalidate', sessionPathKey: fence.sessionPathKey });
    const payload = { operation: 'detail', fence, ref: { source: 'live', key: 'live' } } as any;
    await Promise.all([runtime.execute(payload), runtime.execute(payload)]);
    assert.equal(opens(), 2, 'concurrent misses join one in-flight projection load');
  });
});
