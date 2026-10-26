import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AnalyticsObservation } from '../../../../analytics/contracts/contracts.js';
import {
  ANALYTICS_RUNTIME_BRIDGE_KEY,
  type InstalledAnalyticsRuntimeBridge,
} from '../../../../analytics/contracts/transport.js';
import { deriveAnalyticsIdempotencyKey } from '../../../../analytics/contracts/contracts.js';
import { readInitialContextHistory } from '../../../../analytics/queries/initial-context-history.js';
import type { CanonicalAnalyticsReadModel } from '../../../../analytics/queries/query-entry.js';
import { SqliteAnalyticsRecorder } from '../../../../analytics/recording/sqlite-recorder.js';
import { installInitialContextCapture } from '../initial-context-capture.js';
import { initialContextCohortKey } from '../../context-inventory/initial-context-cohort.js';

interface RequestContext {
  systemPrompt?: string;
  messages?: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ name: string }>;
}
interface CaptureAgent {
  streamFn: (model: object, context: RequestContext, ...args: unknown[]) => unknown;
  prepareModelRequest?: (context: RequestContext, ...args: unknown[]) => RequestContext | Promise<RequestContext>;
}

function installBridge(bridge: InstalledAnalyticsRuntimeBridge): () => void {
  const host = globalThis as unknown as Record<PropertyKey, unknown>;
  const previous = host[ANALYTICS_RUNTIME_BRIDGE_KEY];
  host[ANALYTICS_RUNTIME_BRIDGE_KEY] = bridge;
  return () => {
    if (previous === undefined) delete host[ANALYTICS_RUNTIME_BRIDGE_KEY];
    else host[ANALYTICS_RUNTIME_BRIDGE_KEY] = previous;
  };
}

function initialContextObservation(
  rootSessionId: string,
  cohortKey: string,
  tokens: number,
  sourceKey: string,
): AnalyticsObservation<object> {
  const stableOriginId = `seed:${rootSessionId}`;
  const base = {
    schemaVersion: 1,
    generationId: 'generation',
    producerKind: 'backend' as const,
    stableOriginId,
    sourceSequence: 1,
    sourceKey,
    entityKind: 'featureObservation' as const,
    entityKey: `initial-context:${rootSessionId}`,
    observationKind: 'observation' as const,
    idempotencyKey: '',
    observedAtMs: Date.now(),
    scope: { rootSessionId, sessionId: rootSessionId, workspaceCoverage: 'unknown' as const },
    captureSubject: { kind: 'session' as const, rootSessionId },
    producer: { buildId: 'build', processId: 1, processGeneration: 'process' },
    fields: { feature: 'initialContext', decision: 'post-pruning', ruleVersion: 'request-prefix-v1',
      initialContext: { cohortKey, tokens } },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

test('captured initial context reaches the canonical SQLite projection and history query', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'initial-context-capture-'));
  const databasePath = path.join(directory, 'analytics.sqlite');
  const recorder = new SqliteAnalyticsRecorder(databasePath);
  const rootSessionId = 'captured-root';
  const cohortKey = 'captured-cohort';
  const bridge: InstalledAnalyticsRuntimeBridge = {
    generationId: 'generation',
    captureSubject: { kind: 'session', rootSessionId },
    producer: { buildId: 'build', processId: 1, processGeneration: 'process' },
    submitObservation: (observation) => recorder.submit(observation),
    submitDetail: () => assert.fail('initial-context capture must not submit detail'),
    readFactAcknowledgement: () => undefined,
    isDetailComplete: () => false,
    releaseAcknowledgementInterest: () => undefined,
  };
  const restoreBridge = installBridge(bridge);
  try {
    const agent: CaptureAgent = {
      streamFn: () => 'provider-result',
      prepareModelRequest: async (context) => ({ ...context, systemPrompt: 'rewritten final prompt' }),
    };
    installInitialContextCapture({ agent, messages: [], branch: [], delegated: false, resolveCohortKey: () => cohortKey });
    const model = { provider: 'test', id: 'model' };
    const context = await agent.prepareModelRequest!({
      systemPrompt: 'unpruned prompt', tools: [], messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(agent.streamFn(model, context), 'provider-result');

    // Seed the remaining roots through the same installed analytics bridge, so
    // history is queryable while the captured fact itself is asserted below.
    for (let index = 0; index < 19; index++) {
      const root = `seed-root-${index}`;
      bridge.submitObservation(initialContextObservation(root, cohortKey, index * 10, `seed:${index}`));
    }

    const readDb = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = readDb.prepare(`SELECT root_session_id, feature, decision, rule_version,
        json_extract(payload_json, '$.fields.initialContext.cohortKey') AS cohort_key,
        json_extract(payload_json, '$.fields.initialContext.tokens') AS tokens
        FROM analytics_feature_observations WHERE root_session_id = ?`).all(rootSessionId) as Array<Record<string, unknown>>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.root_session_id, rootSessionId);
      assert.equal(rows[0]?.feature, 'initialContext');
      assert.equal(rows[0]?.decision, 'post-pruning');
      assert.equal(rows[0]?.rule_version, 'request-prefix-v1');
      assert.equal(rows[0]?.cohort_key, cohortKey);
      assert.equal(typeof rows[0]?.tokens, 'number');

      const reader: Pick<CanonicalAnalyticsReadModel, 'executeQuery'> = {
        executeQuery: async (request) => ({
          rows: readDb.prepare(request.sql).all(...request.parameters) as Array<Record<string, unknown>>,
          truncation: { rowLimit: false, byteLimit: false, cellLimit: false },
        }),
      };
      const history = await readInitialContextHistory(reader, cohortKey, Date.now() + 1_000);
      assert.ok(history);
      assert.equal(history.medianTokens, 85);
      assert.equal(history.p25Tokens, 38);
      assert.equal(history.p75Tokens, 133);
    } finally {
      readDb.close();
    }
  } finally {
    restoreBridge();
    recorder.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('captures first prepared root request only, preserves prepare hook rewriting, and fails open', async () => {
  const observations: AnalyticsObservation<object>[] = [];
  let released = 0;
  const restoreBridge = installBridge({
    generationId: 'generation', captureSubject: { kind: 'session', rootSessionId: 'root' },
    producer: { buildId: 'build', processId: 1, processGeneration: 'process' },
    submitObservation: (value) => { observations.push(value); if (observations.length > 1) throw new Error('bridge failed'); },
    submitDetail: () => undefined,
    readFactAcknowledgement: () => undefined,
    isDetailComplete: () => false,
    releaseAcknowledgementInterest: (_generationId, _originId, _payloadId, producerKind) => {
      assert.equal(producerKind, 'backend');
      released++;
    },
  });
  const sentinel = {};
  const agent: CaptureAgent = {
    streamFn(this: CaptureAgent) { assert.equal(this, agent); return sentinel; },
    prepareModelRequest: async (context) => ({ ...context, systemPrompt: 'rewritten' }),
  };
  try {
    installInitialContextCapture({ agent, messages: [], branch: [], delegated: false, resolveCohortKey: () => 'digest' });
    const model = { provider: 'test', id: 'model' };
    assert.equal(agent.streamFn(model, { systemPrompt: 'auxiliary' }), sentinel);
    const context = await agent.prepareModelRequest!({
      systemPrompt: 'original', tools: [], messages: [{ role: 'user', content: 'first' }],
    });
    assert.equal(context.systemPrompt, 'rewritten');
    assert.equal(agent.streamFn(model, { systemPrompt: 'compaction' }), sentinel);
    assert.equal(agent.streamFn(model, context), sentinel);
    assert.equal(agent.streamFn(model, context), sentinel);
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.fields.initialContext.cohortKey, 'digest');
    assert.equal(observations[0]?.fields.decision, 'post-pruning');
    assert.equal(released, 1);

    const failingAgent: CaptureAgent = {
      streamFn: () => sentinel,
      prepareModelRequest: (request) => request,
    };
    installInitialContextCapture({ agent: failingAgent, messages: [], branch: [], delegated: false, resolveCohortKey: () => 'failure' });
    const failingContext = await failingAgent.prepareModelRequest!({
      systemPrompt: 'prompt', tools: [], messages: [{ role: 'user', content: 'first' }],
    });
    assert.equal(failingAgent.streamFn(model, failingContext), sentinel, 'bridge failure must not affect provider execution');
    assert.equal(released, 2);
  } finally { restoreBridge(); }
});

test('reused, forked and delegated sessions do not install', () => {
  for (const extra of [
    { messages: [{ role: 'user' }] },
    { branch: [{ type: 'message', message: { role: 'assistant' } }] },
    { delegated: true },
  ]) {
    const streamFn: CaptureAgent['streamFn'] = () => undefined;
    const agent: CaptureAgent = { streamFn };
    installInitialContextCapture({ agent, messages: [], branch: [], delegated: false, resolveCohortKey: () => 'key', ...extra });
    assert.equal(agent.streamFn, streamFn);
  }
});

test('cohort resolves at the first actual stream after switching models', async () => {
  const observations: AnalyticsObservation<object>[] = [];
  const restore = installBridge({
    generationId: 'generation', captureSubject: { kind: 'session', rootSessionId: 'root' },
    producer: { buildId: 'build', processId: 1, processGeneration: 'process' },
    submitObservation: (value) => { observations.push(value); },
    submitDetail: () => undefined, readFactAcknowledgement: () => undefined,
    isDetailComplete: () => false, releaseAcknowledgementInterest: () => undefined,
  });
  try {
    let model = { provider: 'test', id: 'A' };
    let resolutions = 0;
    const agent: CaptureAgent = { streamFn: () => 'stream' };
    installInitialContextCapture({ agent, messages: [], branch: [], delegated: false,
      resolveCohortKey: (selected) => {
        resolutions++;
        return initialContextCohortKey('prompt', [], selected, {});
      } });
    assert.equal(resolutions, 0);
    model = { ...model, id: 'B' };
    agent.streamFn(model, { systemPrompt: 'auxiliary' });
    assert.equal(resolutions, 0);
    const request = await agent.prepareModelRequest!({ messages: [{ role: 'user' }] });
    agent.streamFn(model, request);
    agent.streamFn(model, request);
    assert.equal(resolutions, 1);
    assert.equal(observations[0]?.fields.initialContext.cohortKey, initialContextCohortKey('prompt', [], model, {}));
    assert.notEqual(observations[0]?.fields.initialContext.cohortKey,
      initialContextCohortKey('prompt', [], { ...model, id: 'A' }, {}));
  } finally { restore(); }
});

test('missing model/key and resolver failures omit samples without affecting streams', async () => {
  for (const [model, resolveCohortKey] of [
    [{}, () => assert.fail('invalid model must not resolve')],
    [{ provider: 'test', id: 'model' }, () => undefined],
    [{ provider: 'test', id: 'model' }, () => { throw new Error('projection failed'); }],
  ] as const) {
    const agent: CaptureAgent = { streamFn: () => 'stream' };
    installInitialContextCapture({ agent, messages: [], branch: [], delegated: false, resolveCohortKey });
    const request = await agent.prepareModelRequest!({ messages: [{ role: 'user' }] });
    assert.equal(agent.streamFn(model, request), 'stream');
  }
});

test('cohort normalizes only final SDK date and ignores tool source metadata', () => {
  const model = { provider: 'test', id: 'model' };
  const key = (prompt: string, tools: unknown[] = []) => initialContextCohortKey(prompt, tools, model, {});
  const prompt = 'project date: 2026-01-01\nCurrent date: 2026-01-01\nCurrent working directory: C:/project';
  assert.equal(key(prompt), key(prompt.replace('Current date: 2026-01-01', 'Current date: 2026-02-02')));
  assert.notEqual(key(prompt), key(prompt.replace('project date: 2026-01-01', 'project date: 2026-02-02')));
  assert.notEqual(key(prompt), key(prompt.replace('C:/project', 'C:/other')));
  assert.notEqual(key(prompt + '\ncustom'), key(prompt.replace('Current date: 2026-01-01', 'Current date: 2026-02-02') + '\ncustom'));
  const tool = { name: 'read', description: 'Read', parameters: { type: 'object' } };
  assert.equal(key(prompt, [tool]), key(prompt, [{ ...tool, sourceInfo: { path: 'other' } }]));
  assert.notEqual(key(prompt, [tool]), key(prompt, [{ ...tool, parameters: { type: 'string' } }]));
  assert.notEqual(key(prompt, [tool]), key(prompt, [{ ...tool, description: 'Other' }]));
});

test('cohort discriminates full catalogs, prompt, model and effective pruning, not api metadata', () => {
  const model = { provider: 'provider', id: 'id' };
  const key = (prompt = 'prompt', tools: unknown[] = [], selected = model, pruning: unknown = {}) =>
    initialContextCohortKey(prompt, tools, selected, pruning);
  assert.notEqual(key(), key('different'));
  assert.notEqual(key(), key('prompt', [{ name: 'hidden', parameters: { type: 'object' } }]));
  assert.notEqual(key(), key('prompt', [], { ...model, id: 'other' }));
  assert.notEqual(key(), key('prompt', [], model, { enabled: true }));
  assert.equal(key(), key('prompt', [], { ...model, api: 'extra' } as typeof model));
  assert.match(key(), /^request-prefix-v1:[a-f0-9]{64}$/);
});
