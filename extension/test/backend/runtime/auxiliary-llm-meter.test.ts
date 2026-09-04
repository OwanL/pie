import assert from 'node:assert/strict';
import test from 'node:test';

import { installAuxiliaryLlmMeter } from '../../../src/backend/auxiliary-llm-meter';

function makeSession() {
  return {
    agent: {
      streamFn: async (_model?: unknown) => ({
        result: async () => ({
          usage: {
            input: 10,
            output: 2,
            cacheRead: 3,
            cacheWrite: 1,
            cost: { total: 0.25 },
          },
        }),
      }),
    },
    _compactionAbortController: undefined as unknown,
    _branchSummaryAbortController: undefined as unknown,
  };
}

test('meters native/custom history compaction and preserves provider-qualified identity', async () => {
  const session = makeSession();
  const events: Array<{ event: string; payload: unknown }> = [];
  let now = 1_000;
  installAuxiliaryLlmMeter(session, '/session.jsonl', (event, payload) => events.push({ event, payload }), () => now);

  session._compactionAbortController = {};
  const stream = await session.agent.streamFn({ id: 'gpt-5.6-sol', provider: 'openai-codex' });
  now = 1_125;
  await stream.result();

  assert.deepEqual(events, [{
    event: 'auxiliary-llm.usage',
    payload: {
      sessionPath: '/session.jsonl',
      kind: 'history_compaction',
      sourceId: 'history_compaction:1000:1',
      occurredAt: '1970-01-01T00:00:01.125Z',
      modelId: 'gpt-5.6-sol',
      provider: 'openai-codex',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      reportedCostUsd: 0.25,
      durationMs: 125,
    },
  }]);
});

test('emits an explicit gap when a summarization response omits provider usage', async () => {
  const session = makeSession();
  session.agent.streamFn = async () => ({ result: async () => ({
    usage: undefined as never,
  }) });
  session._compactionAbortController = {};
  const payloads: Array<{
    instrumentationGap?: boolean;
    outcome?: string;
    instrumentationGapReason?: string;
  }> = [];
  installAuxiliaryLlmMeter(session, '/session.jsonl', (_event, payload) => payloads.push(payload));

  await (await session.agent.streamFn({ id: 'model-a', provider: 'provider-a' })).result();

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.instrumentationGap, true);
  assert.equal(payloads[0]?.outcome, undefined);
  assert.match(String(payloads[0]?.instrumentationGapReason), /no provider usage/);
});

test('classifies branch summaries separately and ignores ordinary assistant streams', async () => {
  const session = makeSession();
  const kinds: string[] = [];
  installAuxiliaryLlmMeter(session, '/session.jsonl', (_event, payload) => kinds.push(payload.kind));

  await (await session.agent.streamFn({ id: 'same-id', provider: 'github-copilot' })).result();
  session._branchSummaryAbortController = {};
  await (await session.agent.streamFn({ id: 'same-id', provider: 'github-copilot' })).result();

  assert.deepEqual(kinds, ['branch_summary']);
});
