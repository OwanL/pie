/**
 * Opt-in >64 MiB durable paged detail verification. Excluded from `npm test`
 * (test discovery only picks up `*.test.ts`): run explicitly with
 * `npm run test:large-detail` from the repo root (or
 * `npm --prefix extension run test:large-detail`).
 *
 * The Phase 5 authority contract verified here:
 * - durable `detail.subscribe` streams exact pages read from the durable
 *   JSONL/tool result, and `detail.fetch` re-emits evicted pages exactly;
 * - page identifiers and checksums are stable and UTF-8-safe (no fragment
 *   ever splits a multi-byte code point);
 * - no single emitted message exceeds the page budget (far below the 30 MiB
 *   single-response ceiling), so a >64 MiB detail never produces one huge
 *   payload;
 * - the generic `session.loadDetail` path remains bounded and rejects values
 *   above the preview budget.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DurableDetailNotFoundError,
  DurableDetailNotAddressableError,
  DurableDetailStore,
  resolveDurableDetailFromTranscript,
} from '../src/backend/durable-detail-store';
import { reassembleDetailPages, type DetailSegmentPage } from '../src/shared/detail-segmentation';
import { LIVE_PIPELINE_LIMITS } from '../src/shared/live-pipeline-protocol';
import type { ChatMessage } from '../src/shared/protocol/messages';
import type {
  CoordinatorToHostDetailMessage,
  LiveSubagentDetailAddress,
} from '../src/shared/protocol/subagent-detail';

const SESSION_PATH = '/repo/session.jsonl';
const MIB = 1024 * 1024;
/** Far below the 30 MiB single-response ceiling; a huge detail is delivered as
 *  many bounded pages, never as one payload close to the ceiling. */
const PAGE_BUDGET = 128 * 1024;
const SINGLE_RESPONSE_CEILING_BYTES = 30 * MIB;

const ADDRESS: LiveSubagentDetailAddress = {
  sessionPath: SESSION_PATH,
  turnId: 'turn-1',
  rootToolCallId: 'tool-1',
  rootAttemptId: 'attempt-root',
  lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
};

/** Build a >64 MiB serialized detail that exercises multi-byte UTF-8 (4-byte
 *  emoji incl. a ZWJ sequence, 3-byte CJK, 2-byte accents/RTL) plus deep
 *  nesting, mirroring what a subagent tool result can contain. */
function buildHugeValue(): Record<string, unknown> {
  const payload = 'héllo 🌍 世界 مرحبا 👨‍👩‍👧‍👦 '.repeat(3000);
  const blocks: string[] = [];
  let bytes = 0;
  while (bytes < 66 * MIB) {
    const block = JSON.stringify({ index: blocks.length, payload, nested: { depth: [1, 2, 3] } });
    blocks.push(block);
    bytes += Buffer.byteLength(block, 'utf8');
  }
  return { blocks, meta: { count: blocks.length, encoding: 'utf8' } };
}

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

function asPage(message: CoordinatorToHostDetailMessage): DetailSegmentPage | undefined {
  return message.kind === 'detail.page' ? message : undefined;
}

test('a >64 MiB durable detail streams in bounded pages and reassembles exactly', async () => {
  const value = { ...buildHugeValue(), liveAddressable: true, lineage: ADDRESS.lineage };
  const serializedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  assert.ok(serializedBytes > 64 * MIB, `fixture is >64 MiB (${(serializedBytes / MIB).toFixed(1)} MiB)`);

  const emitted: CoordinatorToHostDetailMessage[] = [];
  const store = new DurableDetailStore({
    resolve: async (sessionPath, address) => {
      const resolution = resolveDurableDetailFromTranscript(transcriptWithResult(value), sessionPath, address);
      if (resolution.status === 'not-found') throw new DurableDetailNotFoundError(resolution.message);
      if (resolution.status === 'not-addressable') throw new DurableDetailNotAddressableError(resolution.message);
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
    budgets: { maxCanonicalBytes: 128 * MIB, maxSources: 4, maxSubscriptions: 4, maxPageBytes: PAGE_BUDGET },
  });

  await store.subscribe('req-1', 'subscription-1', ADDRESS, PAGE_BUDGET, fence());

  const start = emitted.find((message) => message.kind === 'detail.start');
  assert.ok(start && start.kind === 'detail.start', 'subscribe emits detail.start');
  assert.equal(start.source, 'durable');
  assert.equal(start.totalBytes, serializedBytes);

  const pages = emitted.filter((message) => message.kind === 'detail.page').map(asPage);
  assert.equal(pages.length, start.kind === 'detail.start' ? start.pageCount : 0);
  assert.equal(start.totalCodePoints, pages[0]?.payload.totalCodePoints, 'start carries the exact assembly manifest');
  let maxPayloadBytes = 0;
  for (const page of pages) {
    assert.ok(page!.payloadBytes > 0 && page!.payloadBytes <= PAGE_BUDGET, 'every page fits the budget');
    assert.ok(page!.payloadBytes < SINGLE_RESPONSE_CEILING_BYTES, 'no page approaches the 30 MiB ceiling');
    assert.ok(Buffer.from(page!.payload.text, 'utf8').toString('utf8') === page!.payload.text, 'fragments are valid UTF-8');
    maxPayloadBytes = Math.max(maxPayloadBytes, page!.payloadBytes);
  }
  assert.ok(maxPayloadBytes < SINGLE_RESPONSE_CEILING_BYTES / 200, 'peak page is far below the 30 MiB ceiling');
  assert.ok(pages.length > 500, `a >64 MiB detail yields many pages (${pages.length})`);

  const terminal = emitted.find((message) => message.kind === 'detail.terminal');
  assert.ok(terminal && terminal.kind === 'detail.terminal', 'subscribe ends with a terminal handoff');

  // The complete baseline reassembles byte-exactly from the streamed pages.
  const reassembled = reassembleDetailPages(pages as DetailSegmentPage[]);
  assert.deepEqual(reassembled, value);

  // The generic load-detail bound is unchanged: the same value would be
  // rejected by the preview-budget gate that keeps session.loadDetail bounded.
  assert.ok(serializedBytes > LIVE_PIPELINE_LIMITS.previewBytes,
    `huge detail (${(serializedBytes / MIB).toFixed(1)} MiB) exceeds the ${(LIVE_PIPELINE_LIMITS.previewBytes / MIB).toFixed(0)} MiB preview bound`);
});

test('an evicted >64 MiB page refetches byte-exact with stable identity', async () => {
  const value = { ...buildHugeValue(), liveAddressable: true, lineage: ADDRESS.lineage };
  const emitted: CoordinatorToHostDetailMessage[] = [];
  const store = new DurableDetailStore({
    resolve: async (sessionPath, address) => {
      const resolution = resolveDurableDetailFromTranscript(transcriptWithResult(value), sessionPath, address);
      if (resolution.status !== 'resolved') throw new DurableDetailNotFoundError(resolution.message);
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
    budgets: { maxCanonicalBytes: 128 * MIB, maxSources: 4, maxSubscriptions: 4, maxPageBytes: PAGE_BUDGET },
  });

  await store.subscribe('req-1', 'subscription-1', ADDRESS, PAGE_BUDGET, fence());
  const original = emitted.filter((message) => message.kind === 'detail.page').map(asPage);

  // Refetch a mid-baseline page (as the webview LRU does after eviction).
  const targetIndex = Math.floor(original.length / 3);
  await store.fetch('req-2', 'subscription-1', ADDRESS, original[targetIndex]!.ref, PAGE_BUDGET, fence());
  const refetched = emitted.filter((message) => message.kind === 'detail.page').map(asPage).slice(original.length);
  assert.equal(refetched.length, 1);
  assert.deepEqual(refetched[0]!.ref, original[targetIndex]!.ref, 'stable page ref');
  assert.deepEqual(refetched[0]!.payload, original[targetIndex]!.payload, 'byte-exact payload');
  assert.equal(refetched[0]!.checksum, original[targetIndex]!.checksum, 'stable checksum');

  // A stale manifest ref is rejected without emitting a plausible page.
  await store.fetch('req-3', 'subscription-1', ADDRESS, { ...original[0]!.ref, baselineRevision: 9999 }, PAGE_BUDGET, fence());
  const error = emitted.filter((message) => message.kind === 'detail.error').at(-1);
  assert.equal(error?.kind === 'detail.error' ? error.code : '', 'NOT_FOUND');
});
