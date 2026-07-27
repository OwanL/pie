import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackendServer } from '../../../src/backend/index';

const MODELS = [
  {
    id: 'ranked-model',
    name: 'Ranked Model',
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
    id: 'ranked-model',
    name: 'Ranked Model',
    provider: 'mock',
    reasoning: true,
    inputKinds: ['text'],
    contextWindow: 1000,
    maxTokens: 100,
    subagent: { eligible: true, aggregate: 18 },
  },
  {
    id: 'unprofiled-model',
    name: 'Unprofiled Model',
    provider: 'mock',
    reasoning: false,
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
        id: 'ranked-model',
        precision: 5,
        creativity: 4,
        thoroughness: 5,
        reasoning: 4,
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
        model: 'ranked-model',
        provider: 'mock',
        usage: { input: 1_000, output: 100, totalTokens: 1_100, cost: { total: 0.01 } },
      },
    },
  ]).flat();
  const { server, sessionPath } = makeServerWithSession(branch);

  const payload = await server.buildSessionOpenedPayload(sessionPath);

  assert.equal(payload.transcriptWindow.isPartial, true);
  assert.equal(payload.sessionUsage.samples.filter((sample: { kind: string }) => sample.kind === 'assistant').length, 61);
  const reportedCost = payload.sessionUsage.samples
    .reduce((total: number, sample: { reportedCostUsd?: number }) => total + (sample.reportedCostUsd ?? 0), 0);
  assert.ok(Math.abs(reportedCost - 0.61) < 1e-9);
});

test('session.opened payload includes subagent profile metadata from the backend agentDir', async () => {
  const { server, sessionPath } = makeServerWithSession();

  const payload = await server.buildSessionOpenedPayload(sessionPath);

  assert.deepEqual(payload.availableModels, EXPECTED_MODELS);
});
