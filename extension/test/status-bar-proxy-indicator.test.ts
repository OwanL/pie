import test from 'node:test';
import assert from 'node:assert/strict';

import { initialArchState } from '../src/host/core/reducer';
import {
  buildProxyLoadTooltipLines,
  formatProxyLoadSummary,
  getProxyOverview,
} from '../src/host/status-bar';
import { buildProxyProviderEntry, type ModelInfo, type SessionSummary } from '../src/shared/protocol';

function session(path: string, modelId?: string): SessionSummary {
  return {
    path,
    name: path,
    cwd: 'c:/repo',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 0,
    modelId,
  };
}

function model(id: string, provider: string): ModelInfo {
  return {
    id,
    name: id,
    provider,
    reasoning: true,
    inputKinds: ['text'],
  };
}

test('getProxyOverview counts proxied sessions, excludes tool execution, and marks overflow as queued', () => {
  const umans = buildProxyProviderEntry({
    name: 'umans',
    apiBase: 'https://example.com/umans',
    apiKey: 'sk-umans',
    litellmProvider: 'openai',
    maxConcurrentRequests: 2,
  });
  const openrouter = buildProxyProviderEntry({
    name: 'openrouter',
    apiBase: 'https://example.com/openrouter',
    apiKey: 'sk-openrouter',
    litellmProvider: 'openai',
    maxConcurrentRequests: 1,
  });
  assert.ok(umans);
  assert.ok(openrouter);

  const state = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [
        session('a', 'umans-model'),
        session('b', 'umans-model'),
        session('c', 'umans-model'),
        session('d', 'openrouter-model'),
        session('e', 'copilot-model'),
      ],
      runningSessionPaths: ['a', 'b', 'c', 'd', 'e'],
    },
    settings: {
      ...initialArchState.settings,
      proxySettings: {
        ...initialArchState.settings.proxySettings,
        providers: {
          umans,
          openrouter,
        },
      },
      availableModelsBySession: {
        a: [model('umans-model', 'umans')],
        b: [model('umans-model', 'umans')],
        c: [model('umans-model', 'umans')],
        d: [model('openrouter-model', 'openrouter')],
        e: [model('copilot-model', 'github-copilot')],
      },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        a: [
          { id: 'user-a', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', markdown: 'go', status: 'completed' },
          { id: 'assistant-a', role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', markdown: '', status: 'streaming' },
        ] as any,
        b: [
          {
            id: 'assistant-b',
            role: 'assistant',
            createdAt: '2026-01-01T00:00:00.000Z',
            parts: [],
            toolCalls: [{ id: 'tool-1', status: 'running' }],
          },
        ] as any,
        c: [
          { id: 'user-c', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', markdown: 'go', status: 'completed' },
        ] as any,
      },
    },
  };

  const overview = getProxyOverview(state);

  assert.deepEqual(overview.loads, [
    {
      provider: 'umans',
      activeSessions: 2,
      queuedSessions: 0,
      maxConcurrentRequests: 2,
      maxedOut: true,
    },
    {
      provider: 'openrouter',
      activeSessions: 1,
      queuedSessions: 0,
      maxConcurrentRequests: 1,
      maxedOut: true,
    },
  ]);
  assert.deepEqual(overview.bySession, {
    a: {
      provider: 'umans',
      state: 'active',
      activeSessions: 2,
      queuedSessions: 0,
      maxConcurrentRequests: 2,
    },
    c: {
      provider: 'umans',
      state: 'active',
      activeSessions: 2,
      queuedSessions: 0,
      maxConcurrentRequests: 2,
    },
    d: {
      provider: 'openrouter',
      state: 'active',
      activeSessions: 1,
      queuedSessions: 0,
      maxConcurrentRequests: 1,
    },
  });
});

test('getProxyOverview marks surplus not-yet-started sessions as queued and falls back across model registries', () => {
  const umans = buildProxyProviderEntry({
    name: 'umans',
    apiBase: 'https://example.com/umans',
    apiKey: 'sk-umans',
    litellmProvider: 'openai',
    maxConcurrentRequests: 2,
  });
  assert.ok(umans);

  const state = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [session('a', 'umans-model'), session('b', 'umans-model'), session('c', 'umans-model')],
      runningSessionPaths: ['a', 'b', 'c'],
    },
    settings: {
      ...initialArchState.settings,
      proxySettings: {
        ...initialArchState.settings.proxySettings,
        providers: { umans },
      },
      availableModelsBySession: {
        other: [model('umans-model', 'umans')],
      },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        a: [
          { id: 'user-a', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', markdown: 'go', status: 'completed' },
          { id: 'assistant-a', role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', markdown: '', status: 'streaming' },
        ] as any,
        b: [
          { id: 'user-b', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', markdown: 'go', status: 'completed' },
        ] as any,
      },
    },
  };

  const overview = getProxyOverview(state);

  assert.deepEqual(overview.loads, [
    {
      provider: 'umans',
      activeSessions: 2,
      queuedSessions: 1,
      maxConcurrentRequests: 2,
      maxedOut: true,
    },
  ]);
  assert.deepEqual(overview.bySession.b, {
    provider: 'umans',
    state: 'queued',
    activeSessions: 2,
    queuedSessions: 1,
    maxConcurrentRequests: 2,
  });
  assert.deepEqual(getProxyOverview(state, { proxyEnabled: false }), { loads: [], bySession: {} });
});

test('formatProxyLoadSummary and tooltip lines surface queued providers clearly', () => {
  const loads = [
    { provider: 'openrouter', activeSessions: 1, queuedSessions: 2, maxConcurrentRequests: 1, maxedOut: true },
    { provider: 'umans', activeSessions: 2, queuedSessions: 0, maxConcurrentRequests: 3, maxedOut: false },
  ];

  assert.equal(
    formatProxyLoadSummary(loads),
    'proxy openrouter 1/1 +2q, umans 2/3',
  );
  assert.deepEqual(buildProxyLoadTooltipLines(loads), [
    'Proxy load:',
    '• openrouter: 1/1 · 2 queued',
    '• umans: 2/3',
  ]);
  assert.equal(formatProxyLoadSummary([]), null);
  assert.deepEqual(buildProxyLoadTooltipLines([]), []);
});
