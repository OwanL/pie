import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveContextUsageFromBranch } from '../../../src/backend/context-usage';
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
