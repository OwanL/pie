import assert from 'node:assert/strict';
import test from 'node:test';

import { installAuxiliaryLlmMeter } from '../../../src/backend/auxiliary-llm-meter';

// Usage variants the meter must tolerate: provider-reported cost, the SDK
// catalog estimate (`cost.total`), and no usage at all.
type TestUsage =
  | { input: number; output: number; cacheRead: number; cacheWrite: number; reportedCostUsd: number }
  | { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };

interface TestSession {
  agent: {
    streamFn: (model?: unknown) => Promise<{ result: () => Promise<{ usage?: TestUsage }> }>;
  };
  _compactionAbortController: unknown;
  _autoCompactionAbortController: unknown;
  _branchSummaryAbortController: unknown;
}

function makeSession(): TestSession {
  return {
    agent: {
      streamFn: async (_model?: unknown) => ({
        result: async () => ({
          usage: {
            input: 10,
            output: 2,
            cacheRead: 3,
            cacheWrite: 1,
            reportedCostUsd: 0.25,
          },
        }),
      }),
    },
    _compactionAbortController: undefined as unknown,
    _autoCompactionAbortController: undefined as unknown,
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
      tokenChannelsKnown: true,
      tokenChannelPresence: { input: true, output: true, cacheRead: true, cacheWrite: true },
      reportedCostUsd: 0.25,
      durationMs: 125,
    },
  }]);
});

test('does not promote the SDK catalog total to provider-reported cost', async () => {
  const session = makeSession();
  session.agent.streamFn = async () => ({ result: async () => ({
    usage: {
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 1,
      cost: { total: 0.25 },
    },
  }) });
  session._compactionAbortController = {};
  const payloads: Array<{ reportedCostUsd?: number; instrumentationGap?: boolean }> = [];
  installAuxiliaryLlmMeter(session, '/session.jsonl', (_event, payload) => payloads.push(payload));

  await (await session.agent.streamFn({ id: 'model-a', provider: 'provider-a' })).result();

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.reportedCostUsd, undefined);
  assert.equal(payloads[0]?.instrumentationGap, undefined);
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

test('unexpected controller-free stream calls emit other while known conversation calls remain unmetered', async () => {
  const session = makeSession();
  const payloads: Array<{ kind: string; instrumentationGap?: boolean }> = [];
  let ordinary = true;
  installAuxiliaryLlmMeter(
    session,
    '/session.jsonl',
    (_event, payload) => payloads.push(payload),
    Date.now,
    () => ordinary,
  );

  await (await session.agent.streamFn({ id: 'chat', provider: 'provider-a' })).result();
  ordinary = false;
  await (await session.agent.streamFn({ id: 'automation', provider: 'provider-a' })).result();

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.kind, 'other');
  assert.equal(payloads[0]?.instrumentationGap, undefined);
});

test('unexpected auxiliary calls without usage emit one explicit other gap', async () => {
  const session = makeSession();
  session.agent.streamFn = async () => ({ result: async () => ({ usage: undefined as never }) });
  const payloads: Array<{ kind: string; instrumentationGap?: boolean }> = [];
  installAuxiliaryLlmMeter(
    session,
    '/session.jsonl',
    (_event, payload) => payloads.push(payload),
    Date.now,
    () => false,
  );

  const stream = await session.agent.streamFn({ id: 'automation', provider: 'provider-a' });
  await stream.result();
  await stream.result();
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.kind, 'other');
  assert.equal(payloads[0]?.instrumentationGap, true);
});

test('meters automatic threshold/overflow compaction in the root scope exactly once', async () => {
  const session = makeSession();
  const payloads: Array<{ sessionPath: string; kind: string; sourceId: string }> = [];
  // Overflow auto compaction runs while the root request is still active, so
  // the ordinary-conversation classifier would otherwise swallow the call.
  let ordinary = true;
  installAuxiliaryLlmMeter(
    session,
    '/session.jsonl',
    (_event, payload) => payloads.push(payload),
    Date.now,
    () => ordinary,
  );

  session._autoCompactionAbortController = {};
  const overflow = await session.agent.streamFn({ id: 'model-a', provider: 'provider-a' });
  const overflowUsage = await overflow.result();
  assert.equal(overflowUsage.usage?.input, 10);
  // The stream wrapper must stay transparent to the SDK caller.
  await overflow.result();

  // A later threshold compaction while the request is still classified as an
  // ordinary conversation call must also meter exactly once.
  const threshold = await session.agent.streamFn({ id: 'model-a', provider: 'provider-a' });
  await threshold.result();

  session._autoCompactionAbortController = undefined;
  ordinary = true;
  await (await session.agent.streamFn({ id: 'model-a', provider: 'provider-a' })).result();

  assert.equal(payloads.length, 2);
  for (const payload of payloads) {
    assert.equal(payload.sessionPath, '/session.jsonl');
    assert.equal(payload.kind, 'history_compaction');
  }
  assert.notEqual(payloads[0]?.sourceId, payloads[1]?.sourceId);
});

test('automatic compaction failures emit one explicit gap and remain unmetered once cleared', async () => {
  const session = makeSession();
  session.agent.streamFn = async () => ({ result: async () => ({ usage: undefined as never }) });
  const payloads: Array<{ kind: string; instrumentationGap?: boolean; instrumentationGapReason?: string; outcome?: string }> = [];
  installAuxiliaryLlmMeter(
    session,
    '/session.jsonl',
    (_event, payload) => payloads.push(payload),
    Date.now,
    () => true,
  );

  session._autoCompactionAbortController = {};
  await (await session.agent.streamFn({ id: 'model-a', provider: 'provider-a' })).result();

  session._autoCompactionAbortController = undefined;
  await (await session.agent.streamFn({ id: 'model-a', provider: 'provider-a' })).result();

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.kind, 'history_compaction');
  assert.equal(payloads[0]?.instrumentationGap, true);
  assert.match(String(payloads[0]?.instrumentationGapReason), /no provider usage/);
});

test('aborted compaction and branch-summary invocations settle as cancelled, not failed', async () => {
  const session = makeSession();
  session.agent.streamFn = async () => ({ result: async () => { throw new Error('aborted'); } });
  const payloads: Array<{ kind: string; outcome?: string; instrumentationGap?: boolean }> = [];
  installAuxiliaryLlmMeter(
    session,
    '/session.jsonl',
    (_event, payload) => payloads.push(payload as { kind: string }),
    Date.now,
    () => true,
  );

  // Aborted controller at call time → the stream failure is a cancellation.
  session._compactionAbortController = { signal: { aborted: true } };
  await assert.rejects((await session.agent.streamFn({ id: 'm', provider: 'p' })).result());
  assert.equal(payloads[0]?.kind, 'history_compaction');
  assert.equal(payloads[0]?.outcome, 'cancelled');
  assert.equal(payloads[0]?.instrumentationGap, true);

  // Same for a branch-summary attempt aborted mid-stream.
  session._compactionAbortController = undefined;
  session._branchSummaryAbortController = { signal: { aborted: true } };
  await assert.rejects((await session.agent.streamFn({ id: 'm', provider: 'p' })).result());
  assert.equal(payloads[1]?.kind, 'branch_summary');
  assert.equal(payloads[1]?.outcome, 'cancelled');

  // A controller whose signal never aborted (e.g. legacy plain-object stubs)
  // keeps the failed classification.
  session._branchSummaryAbortController = undefined;
  session._compactionAbortController = {};
  await assert.rejects((await session.agent.streamFn({ id: 'm', provider: 'p' })).result());
  assert.equal(payloads[2]?.outcome, 'failed');
  assert.equal(payloads.length, 3);
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
