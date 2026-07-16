import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionManagerFence,
  FENCED_ENTRY_ID,
} from '../../../src/backend/session-manager-fence';
import type { MutableSdkSessionManager } from '../../../src/backend/session-manager-fence';

type Call = { method: string; args: unknown[] };

function createMockManager(): MutableSdkSessionManager & Record<string, unknown> {
  const calls: Call[] = [];
  return {
    getCwd: () => '/repo',
    getSessionFile: () => '/repo/session.jsonl',
    getSessionName: () => 'test',
    getBranch: () => [],
    getEntries: () => [],
    appendMessage: (message: unknown) => {
      calls.push({ method: 'appendMessage', args: [message] });
      return 'msg-1';
    },
    appendCustomMessageEntry: (customType: unknown, content: unknown, display: unknown, details: unknown) => {
      calls.push({ method: 'appendCustomMessageEntry', args: [customType, content, display, details] });
      return 'custom-1';
    },
    appendCustomEntry: (customType: unknown, data: unknown) => {
      calls.push({ method: 'appendCustomEntry', args: [customType, data] });
      return 'entry-1';
    },
    branch: (branchFromId: unknown) => {
      calls.push({ method: 'branch', args: [branchFromId] });
    },
    resetLeaf: () => {
      calls.push({ method: 'resetLeaf', args: [] });
    },
    createBranchedSession: (leafId: unknown) => {
      calls.push({ method: 'createBranchedSession', args: [leafId] });
      return '/repo/branched.jsonl';
    },
    _persist: (entry: unknown) => {
      calls.push({ method: '_persist', args: [entry] });
    },
    calls,
  } as unknown as MutableSdkSessionManager & Record<string, unknown>;
}

test('read APIs pass through to the underlying manager', () => {
  const manager = createMockManager();
  const { manager: wrapped } = createSessionManagerFence(manager);

  assert.equal(wrapped.getCwd(), '/repo');
  assert.equal(wrapped.getSessionFile(), '/repo/session.jsonl');
  assert.equal(wrapped.getSessionName(), 'test');
  assert.deepEqual(wrapped.getBranch(), []);
  assert.deepEqual(wrapped.getEntries(), []);
});

test('mutation methods delegate before invalidation', () => {
  const manager = createMockManager();
  const { manager: wrapped } = createSessionManagerFence(manager);

  assert.equal(wrapped.appendMessage({ role: 'user' }), 'msg-1');
  assert.equal(wrapped.appendCustomMessageEntry('type', 'content', true, {}), 'custom-1');
  assert.equal(wrapped.appendCustomEntry('type', {}), 'entry-1');
  wrapped.branch('root');
  wrapped.resetLeaf();
  assert.equal(wrapped.createBranchedSession('leaf-1'), '/repo/branched.jsonl');
  wrapped._persist({ type: 'message' });

  assert.deepEqual(manager.calls as Call[], [
    { method: 'appendMessage', args: [{ role: 'user' }] },
    { method: 'appendCustomMessageEntry', args: ['type', 'content', true, {}] },
    { method: 'appendCustomEntry', args: ['type', {}] },
    { method: 'branch', args: ['root'] },
    { method: 'resetLeaf', args: [] },
    { method: 'createBranchedSession', args: ['leaf-1'] },
    { method: '_persist', args: [{ type: 'message' }] },
  ]);
});

test('mutation methods are no-ops after invalidation', () => {
  const manager = createMockManager();
  const { manager: wrapped, fence } = createSessionManagerFence(manager);

  fence.invalidate();

  assert.equal(wrapped.appendMessage({ role: 'user' }), FENCED_ENTRY_ID);
  assert.equal(wrapped.appendCustomMessageEntry('type', 'content', true, {}), FENCED_ENTRY_ID);
  assert.equal(wrapped.appendCustomEntry('type', {}), FENCED_ENTRY_ID);
  assert.equal(wrapped.branch('root'), undefined);
  assert.equal(wrapped.resetLeaf(), undefined);
  assert.equal(wrapped.createBranchedSession('leaf-1'), undefined);
  assert.equal(wrapped._persist({ type: 'message' }), undefined);

  assert.deepEqual(manager.calls as Call[], []);
});

test('read APIs still work after invalidation', () => {
  const manager = createMockManager();
  const { manager: wrapped, fence } = createSessionManagerFence(manager);

  fence.invalidate();

  assert.equal(wrapped.getCwd(), '/repo');
  assert.equal(wrapped.getSessionFile(), '/repo/session.jsonl');
  assert.deepEqual(wrapped.getBranch(), []);
});

test('invalidation is idempotent', () => {
  const manager = createMockManager();
  const { fence } = createSessionManagerFence(manager);

  fence.invalidate();
  fence.invalidate();
  fence.invalidate();

  assert.equal(fence.isInvalidated(), true);
});

test('independent fences do not affect each other', () => {
  const managerA = createMockManager();
  const managerB = createMockManager();
  const { manager: wrappedA, fence: fenceA } = createSessionManagerFence(managerA);
  const { manager: wrappedB, fence: fenceB } = createSessionManagerFence(managerB);

  fenceA.invalidate();

  assert.equal(fenceA.isInvalidated(), true);
  assert.equal(fenceB.isInvalidated(), false);
  assert.equal(wrappedA.appendMessage({ role: 'user' }), FENCED_ENTRY_ID);
  assert.equal(wrappedB.appendMessage({ role: 'user' }), 'msg-1');
});

test('unknown properties pass through unchanged', () => {
  const manager = createMockManager();
  manager.customField = 'custom-value';
  const { manager: wrapped, fence } = createSessionManagerFence(manager);

  assert.equal(wrapped.customField, 'custom-value');
  fence.invalidate();
  assert.equal(wrapped.customField, 'custom-value');
});
