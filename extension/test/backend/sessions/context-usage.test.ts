import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveContextUsageFromBranch } from '../../../src/backend/context-usage';
import { BackendServer } from '../../../src/backend';
import type { SessionEntryLike } from '../../../src/backend/transcript';

test('deriveContextUsageFromBranch returns undefined without a valid context window', () => {
  const entries: SessionEntryLike[] = [
    {
      id: '1',
      type: 'message',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', usage: { input: 10, output: 5 } },
    },
  ];

  assert.equal(deriveContextUsageFromBranch(entries, undefined), undefined);
  assert.equal(deriveContextUsageFromBranch(entries, 0), undefined);
  assert.equal(deriveContextUsageFromBranch(entries, Number.NaN), undefined);
});

test('deriveContextUsageFromBranch uses latest assistant prompt footprint', () => {
  const entries: SessionEntryLike[] = [
    {
      id: 'old',
      type: 'message',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', usage: { input: 30, output: 20, cacheRead: 5 } },
    },
    {
      id: 'latest',
      type: 'message',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        usage: { prompt_tokens: 40, completion_tokens: 11, prompt_tokens_details: { cached_tokens: 7 } },
      },
    },
  ];

  assert.deepEqual(deriveContextUsageFromBranch(entries, 100), {
    tokens: 40,
    contextWindow: 100,
    percent: 40,
  });
});

test('deriveContextUsageFromBranch falls back to total tokens and clamps percent', () => {
  const entries: SessionEntryLike[] = [
    {
      id: '1',
      type: 'message',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', usage: { total_tokens: 400 } },
    },
  ];

  assert.deepEqual(deriveContextUsageFromBranch(entries, 100), {
    tokens: 400,
    contextWindow: 100,
    percent: 100,
  });
});

test('deriveContextUsageFromBranch clears stale usage at a compaction boundary', () => {
  const entries: SessionEntryLike[] = [
    {
      id: 'before',
      type: 'message',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', usage: { input: 90, output: 5 } },
    },
    {
      id: 'compact',
      type: 'compaction',
      timestamp: new Date().toISOString(),
      summary: 'Condensed history',
    },
  ];

  assert.equal(deriveContextUsageFromBranch(entries, 100), undefined);

  entries.push({
    id: 'after',
    type: 'message',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', usage: { input: 25, output: 5 } },
  });
  assert.deepEqual(deriveContextUsageFromBranch(entries, 100), {
    tokens: 25,
    contextWindow: 100,
    percent: 25,
  });
});

test('BackendServer retains the post-compaction estimate until measured usage arrives', () => {
  const entries: SessionEntryLike[] = [{
    id: 'compact',
    type: 'compaction',
    timestamp: new Date().toISOString(),
    summary: 'Condensed history',
  }];
  const context = {
    runtime: {},
    sessionPath: '/workspace/session.jsonl',
    unsubscribe() {},
    busySeq: 0,
    session: {
      model: { id: 'model', contextWindow: 100_000 },
      sessionManager: { getBranch: () => entries },
    },
  };
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/workspace' }) as any;
  const emitted: Array<{ event: string; payload: unknown }> = [];
  server.emit = (event: string, payload: unknown) => emitted.push({ event, payload });
  server.emitSessionOpened = async () => undefined;
  server.emitSessionListChanged = async () => undefined;

  server.handleSessionEvent(context, {
    type: 'compaction_end',
    result: {
      summary: 'Condensed history',
      firstKeptEntryId: 'kept-entry',
      tokensBefore: 100_000,
      estimatedTokensAfter: 12_500,
      details: {},
    },
  });

  assert.equal((context as { postCompactionEstimatedTokens?: number }).postCompactionEstimatedTokens, 12_500);
  assert.deepEqual(server.getContextUsage(context), {
    tokens: 12_500,
    contextWindow: 100_000,
    percent: 12.5,
  });

  entries.push({
    id: 'after',
    type: 'message',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', usage: { input: 15_000, output: 500 } },
  });
  assert.deepEqual(server.getContextUsage(context), {
    tokens: 15_000,
    contextWindow: 100_000,
    percent: 15,
  });
  assert.equal((context as { postCompactionEstimatedTokens?: number }).postCompactionEstimatedTokens, undefined);
  assert.equal(emitted.some(({ event }) => event === 'contextUsage.changed'), true);
});

test('deriveContextUsageFromBranch returns undefined when no assistant usage exists', () => {
  const entries: SessionEntryLike[] = [
    {
      id: '1',
      type: 'message',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'hello' },
    },
  ];

  assert.equal(deriveContextUsageFromBranch(entries, 100), undefined);
});
