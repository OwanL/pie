import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCurrentSummary, deriveSessionName } from '../session-metadata';
import type { SessionContext } from '../../../agent-processes/coordinator/server-types.js';

function makeContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    runtime: {
      services: {
        modelRegistry: {
          getAvailable: () => [],
          find: () => undefined,
        },
      },
      dispose: async () => undefined,
      session: {} as any,
    },
    session: {
      sessionName: undefined,
      thinkingLevel: 'high',
      model: { id: 'claude-test' },
      messages: [{}, {}],
      sessionManager: {
        getSessionName: () => undefined,
        getCwd: () => '/repo',
        getSessionFile: () => '/repo/session.jsonl',
        getBranch: () => [],
        getEntries: () => [],
      },
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      isStreaming: false,
    },
    sessionPath: '/repo/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    ...overrides,
  } as SessionContext;
}

test('deriveSessionName prefers explicit sdk names and falls back to user content or placeholder', () => {
  const explicitName = deriveSessionName(makeContext({
    session: {
      ...makeContext().session,
      sessionName: 'Saved Name',
      sessionManager: {
        ...makeContext().session.sessionManager,
        getSessionName: () => 'Ignored Manager Name',
      },
    },
  }));
  assert.deepEqual(explicitName, { name: 'Saved Name', isPlaceholder: false });

  const derivedFromUser = deriveSessionName(makeContext({
    session: {
      ...makeContext().session,
      sessionManager: {
        ...makeContext().session.sessionManager,
        getBranch: () => [{
          id: 'entry-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'message',
          message: { role: 'user', content: 'Fix the broken extension tests before release' },
        }],
      },
    },
  }));
  assert.equal(derivedFromUser.name, 'Fix the broken extension tests before r…');
  assert.equal(derivedFromUser.isPlaceholder, true);

  const placeholder = deriveSessionName(makeContext({
    session: {
      ...makeContext().session,
      sessionManager: {
        ...makeContext().session.sessionManager,
        getBranch: () => [{
          id: 'entry-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'message',
          message: { role: 'user', content: 'help' },
        }],
      },
    },
  }));
  assert.deepEqual(placeholder, { name: 'help', isPlaceholder: true });
});

test('buildCurrentSummary falls back to startup cwd and normalizes thinking level', () => {
  const summary = buildCurrentSummary(makeContext({
    session: {
      ...makeContext().session,
      thinkingLevel: 'max',
      sessionManager: {
        ...makeContext().session.sessionManager,
        getCwd: () => undefined as unknown as string,
        getBranch: () => [{
          id: 'entry-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'message',
          message: { role: 'user', content: 'Add coverage-focused tests now' },
        }],
      },
    },
  }), '/startup');

  assert.equal(summary.cwd, '/startup');
  assert.equal(summary.name, 'Add coverage-focused tests now');
  assert.equal(summary.isPlaceholder, true);
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.modelId, 'claude-test');
  assert.equal(summary.provider, undefined);
  assert.equal(summary.thinkingLevel, 'max');
});

test('buildCurrentSummary forwards the stable SDK session identity', () => {
  const summary = buildCurrentSummary(makeContext({
    session: {
      ...makeContext().session,
      sessionManager: {
        ...makeContext().session.sessionManager,
        getSessionId: () => '  stable-session-id  ',
      },
    },
  }), '/startup');

  assert.equal(summary.sessionId, 'stable-session-id');
});
