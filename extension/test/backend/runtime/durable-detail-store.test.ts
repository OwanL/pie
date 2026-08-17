import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DurableDetailNotAddressableError,
  DurableDetailNotFoundError,
  DurableDetailStore,
  resolveDurableDetailFromTranscript,
} from '../../../src/backend/durable-detail-store';
import { reassembleDetailPages } from '../../../src/shared/detail-segmentation';
import type { ChatMessage } from '../../../src/shared/protocol/messages';
import type {
  CoordinatorToHostDetailMessage,
  DetailJsonSegmentPayload,
  DetailPageRef,
  LiveSubagentDetailAddress,
} from '../../../src/shared/protocol/subagent-detail';

const SESSION_PATH = '/repo/session.jsonl';

const ADDRESS: LiveSubagentDetailAddress = {
  sessionPath: SESSION_PATH,
  turnId: 'turn-1',
  rootToolCallId: 'tool-1',
  rootAttemptId: 'attempt-root',
  lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
};

function addressableResult(value: unknown): Record<string, unknown> {
  return {
    lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
    liveAddressable: true,
    value,
  };
}

/** A durable transcript whose tool-1 result embeds the addressable record. */
function transcriptWithResult(result: unknown): ChatMessage[] {
  return [{
    id: 'msg-1',
    role: 'assistant',
    createdAt: '2026-08-15T00:00:00.000Z',
    markdown: '',
    status: 'completed',
    toolCalls: [{
      id: 'tool-1',
      name: 'subagent',
      input: {},
      result,
      status: 'completed',
    }],
  }];
}

function fence() {
  return { backendGeneration: 1, coordinatorGeneration: 1 };
}

function createStore(options: {
  transcript?: ChatMessage[];
  resolveOverride?: (sessionPath: string, address: LiveSubagentDetailAddress) => Promise<unknown>;
  budgets?: Partial<import('../../../src/backend/durable-detail-store').DurableDetailStoreBudgets>;
} = {}) {
  const emitted: CoordinatorToHostDetailMessage[] = [];
  const store = new DurableDetailStore({
    resolve: async (sessionPath, address) => {
      if (options.resolveOverride) {
        const value = await options.resolveOverride(sessionPath, address);
        return {
          value,
          sizeBytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
          messageId: `msg-${address.rootToolCallId}`,
          toolCallId: address.rootToolCallId,
          kind: 'tool-result' as const,
        };
      }
      const transcript = options.transcript ?? transcriptWithResult(addressableResult({ exitCode: 0, text: 'ok' }));
      const resolution = resolveDurableDetailFromTranscript(transcript, sessionPath, address);
      if (resolution.status === 'not-found') {
        throw new DurableDetailNotFoundError(resolution.message);
      }
      if (resolution.status === 'not-addressable') {
        throw new DurableDetailNotAddressableError(resolution.message);
      }
      return {
        value: resolution.value,
        sizeBytes: resolution.sizeBytes!,
        messageId: resolution.messageId!,
        toolCallId: resolution.toolCallId!,
        kind: 'tool-result' as const,
      };
    },
    emit: (message) => {
      emitted.push(message);
      return true;
    },
    budgets: { maxCanonicalBytes: 2 * 1024 * 1024, maxSources: 8, maxSubscriptions: 8, maxPageBytes: 4096, ...options.budgets },
  });
  return { store, emitted };
}

function startOf(emitted: CoordinatorToHostDetailMessage[], subscriptionId: string) {
  return emitted.find((message) => message.kind === 'detail.start' && message.subscriptionId === subscriptionId);
}

function pagesOf(emitted: CoordinatorToHostDetailMessage[], subscriptionId: string) {
  return emitted.filter((message) => message.kind === 'detail.page' && message.subscriptionId === subscriptionId);
}

function terminalOf(emitted: CoordinatorToHostDetailMessage[], subscriptionId: string) {
  return emitted.find((message) => message.kind === 'detail.terminal' && message.subscriptionId === subscriptionId);
}

function errorsOf(emitted: CoordinatorToHostDetailMessage[], subscriptionId: string) {
  return emitted.filter((message) => message.kind === 'detail.error' && message.subscriptionId === subscriptionId);
}

interface NarrowPage {
  ref: DetailPageRef;
  payload: DetailJsonSegmentPayload;
  payloadBytes: number;
  checksum: string;
}

function asPage(message: CoordinatorToHostDetailMessage): NarrowPage | undefined {
  return message.kind === 'detail.page' ? message : undefined;
}

function utf8RoundTrips(text: string): boolean {
  return Buffer.from(text, 'utf8').toString('utf8') === text;
}

test('subscribe streams exact durable pages and a terminal handoff, never one oversized message', async () => {
  const blocks: string[] = [];
  for (let index = 0; index < 200; index += 1) blocks.push('héllo 🌍 world '.repeat(200));
  const value = addressableResult({ blocks });
  const { store, emitted } = createStore({ transcript: transcriptWithResult(value) });

  await store.subscribe('req-1', 'subscription-1', ADDRESS, 1024, fence());

  const start = startOf(emitted, 'subscription-1');
  assert.ok(start, 'subscribe emits a detail.start');
  if (start?.kind === 'detail.start') {
    assert.equal(start.source, 'durable');
    assert.equal(start.address.sessionPath, SESSION_PATH);
    assert.ok(start.pageCount > 1, 'the value spans multiple pages');
    assert.equal(start.totalBytes, Buffer.byteLength(JSON.stringify(value), 'utf8'));
  }
  const pages = pagesOf(emitted, 'subscription-1');
  assert.equal(pages.length, start?.kind === 'detail.start' ? start.pageCount : 0);
  for (const page of pages) {
    const narrow = asPage(page);
    assert.ok(narrow, 'page messages are detail.page');
    if (narrow) {
      assert.ok(narrow.payloadBytes <= 1024, 'every page fits the tiny budget');
      const firstPage = asPage(pages[0]!);
      assert.equal(narrow.payload.segmentId, firstPage?.payload.segmentId);
      assert.ok(utf8RoundTrips(narrow.payload.text), 'page fragments are valid UTF-8');
    }
  }
  const terminal = terminalOf(emitted, 'subscription-1');
  assert.ok(terminal, 'subscribe ends with a terminal handoff');
  if (terminal?.kind === 'detail.terminal') {
    assert.equal(terminal.durableRef.messageId, 'msg-1');
    assert.equal(terminal.durableRef.toolCallId, 'tool-1');
    assert.equal(terminal.durableRef.available, true);
  }
  // The full baseline reassembles exactly from the streamed pages.
  const narrowPages = pages.map(asPage);
  assert.ok(narrowPages.every((page) => page !== undefined), 'all streamed messages are pages');
  assert.deepEqual(
    reassembleDetailPages(narrowPages as NarrowPage[]),
    value,
  );
  // The subscription is retained after the terminal handoff (evicted pages
  // stay refetchable) until an explicit unsubscribe.
  assert.equal(store.owns('subscription-1'), true);
  store.unsubscribe('req-x', 'subscription-1');
  assert.equal(store.owns('subscription-1'), false);
});

test('fetch re-emits the exact evicted page with stable identity and checksum', async () => {
  const value = addressableResult({ text: 'x'.repeat(50_000) });
  const { store, emitted } = createStore({ transcript: transcriptWithResult(value) });
  await store.subscribe('req-1', 'subscription-1', ADDRESS, 4096, fence());
  const original = pagesOf(emitted, 'subscription-1');

  // Drop the source cache so fetch must re-read the durable JSONL.
  const originalPage = asPage(original[2]!);
  assert.ok(originalPage, 'the third streamed message is a page');
  await store.fetch('req-2', 'subscription-1', ADDRESS, originalPage!.ref, 4096, fence());
  const refetched = pagesOf(emitted, 'subscription-1').slice(original.length);
  assert.equal(refetched.length, 1);
  const expected = asPage(original[2]!);
  const actual = asPage(refetched[0]!);
  assert.ok(expected && actual, 'both original and refetched messages are pages');
  if (expected && actual) {
    assert.deepEqual(actual.ref, expected.ref, 'the re-emitted page keeps the stable ref');
    assert.deepEqual(actual.payload, expected.payload, 'the re-emitted page is byte-exact');
    assert.equal(actual.checksum, expected.checksum, 'the re-emitted checksum is stable');
  }
});

test('fetch validates the subscription owner and the manifest before emitting', async () => {
  const value = addressableResult({ text: 'y'.repeat(20_000) });
  const { store, emitted } = createStore({ transcript: transcriptWithResult(value) });
  await store.subscribe('req-1', 'subscription-1', ADDRESS, 4096, fence());
  const firstPage = asPage(pagesOf(emitted, 'subscription-1')[0]!);
  assert.ok(firstPage, 'the first streamed message is a page');

  // Foreign subscription: rejected.
  await store.fetch('req-2', 'subscription-unknown', ADDRESS, firstPage!.ref, 4096, fence());
  const foreignError = errorsOf(emitted, 'subscription-unknown').at(-1);
  assert.equal(foreignError?.kind === 'detail.error' ? foreignError.code : '', 'SUBSCRIPTION_CONFLICT');

  // Stale manifest: rejected.
  await store.fetch('req-3', 'subscription-1', ADDRESS, { ...firstPage!.ref, baselineRevision: 99 }, 4096, fence());
  const staleError = errorsOf(emitted, 'subscription-1').at(-1);
  assert.equal(staleError?.kind === 'detail.error' ? staleError.code : '', 'NOT_FOUND');

  // Address mismatch: rejected.
  await store.fetch('req-4', 'subscription-1', { ...ADDRESS, rootToolCallId: 'other-tool' }, firstPage!.ref, 4096, fence());
  const addressError = errorsOf(emitted, 'subscription-1').at(-1);
  assert.equal(addressError?.kind === 'detail.error' ? addressError.code : '', 'SUBSCRIPTION_CONFLICT');
});

test('resolution failures map to typed stream errors', async () => {
  // Missing durable message.
  const notFound = createStore({ transcript: [] });
  await notFound.store.subscribe('req-1', 'subscription-missing', ADDRESS, 4096, fence());
  const missingError = errorsOf(notFound.emitted, 'subscription-missing').at(-1);
  assert.equal(missingError?.kind === 'detail.error' ? missingError.code : '', 'NOT_FOUND');

  // Legacy result without producer lineage is not producer-addressable.
  const legacy = createStore({
    transcript: [{
      id: 'msg-1', role: 'assistant', createdAt: '2026-08-15T00:00:00.000Z', markdown: '', status: 'completed',
      toolCalls: [{ id: 'tool-1', name: 'subagent', input: {}, result: { value: { exitCode: 0 } }, status: 'completed' }],
    }],
  });
  await legacy.store.subscribe('req-2', 'subscription-legacy', ADDRESS, 4096, fence());
  const legacyError = errorsOf(legacy.emitted, 'subscription-legacy').at(-1);
  assert.equal(legacyError?.kind === 'detail.error' ? legacyError.code : '', 'NOT_LIVE_ADDRESSABLE');

  // Resolver rejection maps to UNAVAILABLE.
  const failing = createStore({
    resolveOverride: async () => { throw new Error('disk read failed'); },
  });
  await failing.store.subscribe('req-3', 'subscription-failing', ADDRESS, 4096, fence());
  const failingError = errorsOf(failing.emitted, 'subscription-failing').at(-1);
  assert.equal(failingError?.kind === 'detail.error' ? failingError.code : '', 'UNAVAILABLE');
  assert.equal(failingError?.kind === 'detail.error' ? failingError.retryable : false, true);
});

test('source and subscription caches are bounded', async () => {
  const value = addressableResult({ text: 'z'.repeat(100_000) });
  const { store, emitted } = createStore({
    resolveOverride: async () => value,
    budgets: { maxCanonicalBytes: 300_000, maxSources: 2, maxSubscriptions: 2, maxPageBytes: 4096 },
  });
  const addressA = { ...ADDRESS, rootToolCallId: 'tool-a' };
  const addressB = { ...ADDRESS, rootToolCallId: 'tool-b' };
  const addressC = { ...ADDRESS, rootToolCallId: 'tool-c' };

  await store.subscribe('req-1', 'subscription-a', addressA, 4096, fence());
  await store.subscribe('req-2', 'subscription-b', addressB, 4096, fence());

  // A third distinct source is rejected by the subscription budget.
  await store.subscribe('req-3', 'subscription-c', addressC, 4096, fence());
  const overflowError = errorsOf(emitted, 'subscription-c').at(-1);
  assert.equal(overflowError?.kind === 'detail.error' ? overflowError.code : '', 'UNAVAILABLE');
  assert.equal(overflowError?.kind === 'detail.error' ? overflowError.retryable : false, true);

  // A superseding subscription for the same source frees the budget again.
  await store.subscribe('req-4', 'subscription-d', addressA, 4096, fence());
  assert.equal(errorsOf(emitted, 'subscription-d').length, 0);
  assert.equal(store.owns('subscription-a'), false, 'the prior same-source subscription is superseded');
  assert.equal(store.owns('subscription-d'), true);

  // The source cache stays under its caps regardless of subscription churn.
  const state = store.debugState();
  assert.ok(state.sources <= 2, `source cache bounded: ${state.sources}`);
  assert.ok(state.canonicalBytes <= 300_000, `canonical byte cache bounded: ${state.canonicalBytes}`);
  assert.equal(errorsOf(emitted, 'subscription-a').length, 0);
  assert.equal(errorsOf(emitted, 'subscription-b').length, 0);
});

test('durable resolution addresses the root tool call and the lineage child', () => {
  const value = addressableResult({ exitCode: 7 });
  const resolution = resolveDurableDetailFromTranscript(transcriptWithResult(value), SESSION_PATH, ADDRESS);
  assert.equal(resolution.status, 'resolved');
  if (resolution.status === 'resolved') {
    assert.deepEqual(resolution.value, value);
    assert.equal(resolution.messageId, 'msg-1');
    assert.equal(resolution.toolCallId, 'tool-1');
  }

  // A durableRef pointing at a different message is honored over the address.
  const refResolution = resolveDurableDetailFromTranscript(transcriptWithResult(value), SESSION_PATH, ADDRESS, {
    sessionPath: SESSION_PATH, messageId: 'missing-msg', key: 'k', kind: 'tool-result', source: 'durable', sizeBytes: 1, summary: 's', available: true, toolCallId: 'tool-1',
  });
  assert.equal(refResolution.status, 'not-found');

  // A wrong lineage does not match any addressable child.
  const wrongLineage = resolveDurableDetailFromTranscript(transcriptWithResult(value), SESSION_PATH, {
    ...ADDRESS, lineage: [{ childId: 'child-9', spawningToolCallId: 'tool-1', attemptId: 'attempt-9' }],
  });
  assert.equal(wrongLineage.status, 'not-addressable');

  // Missing root tool call is not found.
  const missingRoot = resolveDurableDetailFromTranscript(transcriptWithResult(value), SESSION_PATH, {
    ...ADDRESS, rootToolCallId: 'tool-missing',
  });
  assert.equal(missingRoot.status, 'not-found');
});
