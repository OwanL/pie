import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackendServer } from '../../../src/backend/index';
import { SESSION_SNAPSHOT_MAX_LINE_BYTES, sessionSnapshotLineBytes } from '../../../src/shared/transcript-window';

const MODELS = [
  {
    id: 'profiled-model',
    name: 'Profiled Model',
    provider: 'mock',
    reasoning: true,
    input: ['text'],
    contextWindow: 1000,
    maxTokens: 100,
  },
  {
    id: 'unprofiled-model',
    name: 'Unprofiled Model',
    provider: 'mock',
    reasoning: false,
  },
];

const EXPECTED_MODELS = [
  {
    id: 'profiled-model',
    name: 'Profiled Model',
    provider: 'mock',
    reasoning: true,
    thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
    inputKinds: ['text'],
    contextWindow: 1000,
    maxTokens: 100,
    subagent: { eligible: true },
  },
  {
    id: 'unprofiled-model',
    name: 'Unprofiled Model',
    provider: 'mock',
    reasoning: false,
    thinkingLevels: ['off'],
    inputKinds: ['text'],
    contextWindow: undefined,
    maxTokens: undefined,
  },
];

function makeAgentDir(): string {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-backend-profiles-'));
  fs.writeFileSync(path.join(agentDir, 'model-profiles.json'), JSON.stringify({
    profiles: [
      {
        id: 'profiled-model',
        eligible: true,
      },
    ],
  }));
  return agentDir;
}

function makeServerWithSession(branch: unknown[] = []): { server: any; sessionPath: string } {
  const agentDir = makeAgentDir();
  const sessionPath = '/ws/sessions/test.jsonl';
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/ws' }) as any;
  server.agentDir = agentDir;
  server.sdk = {
    VERSION: 'test-sdk',
    formatSkillsForPrompt: undefined,
  };
  server.sessionContexts.set(sessionPath, {
    runtime: {
      services: {
        modelRegistry: {
          getAvailable: () => MODELS,
        },
      },
    },
    session: {
      isStreaming: false,
      messages: [],
      sessionManager: {
        getCwd: () => '/ws',
        getSessionName: () => undefined,
        getBranch: () => branch,
      },
    },
    sessionPath,
    unsubscribe: () => undefined,
    busySeq: 0,
  });
  return { server, sessionPath };
}

test('models.list includes subagent profile metadata from the backend agentDir', async () => {
  const { server, sessionPath } = makeServerWithSession();

  const result = await server.handleRequest({
    id: 'models-1',
    method: 'models.list',
    params: { sessionPath },
  });

  assert.deepEqual(result, EXPECTED_MODELS);
});

test('session.opened is busy and compacting when opened during history compaction', async () => {
  const { server, sessionPath } = makeServerWithSession();
  server.sessionContexts.get(sessionPath).session.isCompacting = true;

  const payload = await server.buildSessionOpenedPayload(sessionPath);

  assert.equal(payload.busy, true);
  assert.equal(payload.isCompacting, true);
  assert.equal(payload.runtimeReady, true);
});

test('session.opened carries whole-session usage even when its transcript payload is windowed', async () => {
  const branch = Array.from({ length: 61 }, (_, index) => [
    {
      type: 'message',
      id: `user-${index}`,
      timestamp: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      message: { role: 'user', content: `prompt ${index}` },
    },
    {
      type: 'message',
      id: `assistant-${index}`,
      timestamp: new Date(Date.UTC(2026, 0, 1) + index * 60_000 + 1_000).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `answer ${index}` }],
        model: 'profiled-model',
        provider: 'mock',
        usage: { input: 1_000, output: 100, totalTokens: 1_100, cost: { total: 0.01 } },
      },
    },
  ]).flat();
  const { server, sessionPath } = makeServerWithSession(branch);

  const payload = await server.buildSessionOpenedPayload(sessionPath);
  const warmPayload = await server.buildSessionOpenedPayload(sessionPath);

  assert.equal(payload.transcriptWindow.isPartial, true);
  assert.strictEqual(warmPayload.sessionUsage, payload.sessionUsage);
  assert.equal(payload.sessionUsage.samples.filter((sample: { kind: string }) => sample.kind === 'assistant').length, 61);
  const reportedCost = payload.sessionUsage.samples
    .reduce((total: number, sample: { reportedCostUsd?: number }) => total + (sample.reportedCostUsd ?? 0), 0);
  assert.ok(Math.abs(reportedCost - 0.61) < 1e-9);

  branch.push({
    type: 'message',
    id: 'user-new',
    timestamp: '2026-01-01T01:59:00.000Z',
    message: { role: 'user', content: 'new prompt' },
  }, {
    type: 'message',
    id: 'assistant-new',
    timestamp: '2026-01-01T02:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'new answer' }],
      model: 'profiled-model',
      provider: 'mock',
      usage: { input: 2_000, output: 200, totalTokens: 2_200, cost: { total: 0.02 } },
    },
  });
  const changedPayload = await server.buildSessionOpenedPayload(sessionPath);
  assert.notStrictEqual(changedPayload.sessionUsage, payload.sessionUsage);
  assert.equal(changedPayload.sessionUsage.samples.filter((sample: { kind: string }) => sample.kind === 'assistant').length, 62);
});

test('session.opened degrades an individually oversized durable row to a bounded explicit unavailable snapshot', async () => {
  const branch = [{
    type: 'message',
    id: 'oversized-user',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'image', data: 'a'.repeat(31 * 1024 * 1024), mimeType: 'image/png' }],
    },
  }];
  const { server, sessionPath } = makeServerWithSession(branch);

  const payload = await server.buildSessionOpenedPayload(sessionPath);

  assert.equal(payload.snapshotUnavailable?.code, 'SESSION_SNAPSHOT_TOO_LARGE');
  assert.equal(payload.transcript.length, 0);
  assert.equal(payload.transcriptWindow.totalCount, 1);
  assert.equal(payload.transcriptWindow.loadedStart, 1);
  assert.equal(payload.transcriptWindow.loadedEnd, 1);
  assert.ok(sessionSnapshotLineBytes(payload, { kind: 'event', event: 'session.opened' }) <= SESSION_SNAPSHOT_MAX_LINE_BYTES);
});

test('hot session.opened final fallback drops huge summary and runtime catalog metadata', async () => {
  const { server, sessionPath } = makeServerWithSession();
  const huge = 'x'.repeat(31 * 1024 * 1024);
  const context = server.sessionContexts.get(sessionPath);
  context.session.sessionManager.getSessionName = () => huge;
  context.runtime.services.modelRegistry.getAvailable = () => [{
    id: 'huge-model', provider: 'mock', name: huge, reasoning: false,
  }];

  const payload = await server.buildSessionOpenedPayload(sessionPath, 'hot-selection');

  assert.equal(payload.snapshotUnavailable?.code, 'SESSION_SNAPSHOT_TOO_LARGE');
  assert.equal(payload.session.path, sessionPath);
  assert.equal(payload.session.name, 'Conversation snapshot unavailable');
  assert.equal(payload.selectionToken, 'hot-selection');
  assert.equal(payload.runtimeReady, true);
  assert.equal(payload.availableModels, undefined);
  assert.ok(sessionSnapshotLineBytes(payload, { kind: 'event', event: 'session.opened' }) <= SESSION_SNAPSHOT_MAX_LINE_BYTES);
});

test('session.opened payload includes subagent profile metadata from the backend agentDir', async () => {
  const { server, sessionPath } = makeServerWithSession();

  const payload = await server.buildSessionOpenedPayload(sessionPath);

  assert.deepEqual(payload.availableModels, EXPECTED_MODELS);
});
