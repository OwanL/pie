import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  buildCurrentSummary,
  deriveSessionName,
  listAvailableModels,
  listSessions,
  resolveActiveModel,
} from '../../../src/backend/session-metadata';
import { NEW_SESSION_NAME } from '../../../src/shared/session-name';
import type { SessionContext } from '../../../src/backend/server-types';
import type { SdkModule } from '../../../src/backend/sdk';

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

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-metadata-test-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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
  assert.equal(derivedFromUser.name, 'Fix Broken Extension Tests');
  assert.equal(derivedFromUser.isPlaceholder, false);

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
  assert.deepEqual(placeholder, { name: NEW_SESSION_NAME, isPlaceholder: true });
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
  assert.equal(summary.name, 'Add Coverage-focused Tests');
  assert.equal(summary.isPlaceholder, false);
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.modelId, 'claude-test');
  assert.equal(summary.thinkingLevel, undefined);
});

test('listAvailableModels derives input kinds and tolerates missing or failing registries', () => {
  assert.deepEqual(listAvailableModels(undefined), []);

  const context = makeContext({
    runtime: {
      session: {} as any,
      dispose: async () => undefined,
      services: {
        modelRegistry: {
          getAvailable: () => [{
            id: 'claude-sonnet',
            name: 'Claude Sonnet',
            provider: 'anthropic',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 200000,
            maxTokens: 8192,
          }],
          find: () => undefined,
        },
      },
    } as SessionContext['runtime'],
  });

  assert.deepEqual(listAvailableModels(context), [{
    id: 'claude-sonnet',
    name: 'Claude Sonnet',
    provider: 'anthropic',
    reasoning: true,
    inputKinds: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  }]);

  const failingContext = makeContext({
    runtime: {
      session: {} as any,
      dispose: async () => undefined,
      services: {
        modelRegistry: {
          getAvailable: () => { throw new Error('boom'); },
          find: () => undefined,
        },
      },
    } as SessionContext['runtime'],
  });
  assert.deepEqual(listAvailableModels(failingContext), []);
});

test('resolveActiveModel names the active provider/model from the registry and tolerates failures', () => {
  // No model selected yet → empty info (callers render a neutral state).
  const noModel = makeContext({ session: { model: undefined } as unknown as SessionContext['session'] });
  assert.deepEqual(resolveActiveModel(noModel), {});

  // Model selected and found in the registry → provider/name resolved.
  const context = makeContext({
    session: { model: { id: 'claude-sonnet' } } as unknown as SessionContext['session'],
    runtime: {
      session: {} as any,
      dispose: async () => undefined,
      services: {
        modelRegistry: {
          getAvailable: () => [{
            id: 'claude-sonnet',
            name: 'Claude Sonnet',
            provider: 'anthropic',
            reasoning: true,
            input: ['text'],
          }],
          find: () => undefined,
        },
      },
    } as SessionContext['runtime'],
  });
  assert.deepEqual(resolveActiveModel(context), {
    modelId: 'claude-sonnet',
    provider: 'anthropic',
    modelName: 'Claude Sonnet',
  });

  // Model selected but missing from the registry → modelId only, no provider guess.
  const orphan = makeContext({
    session: { model: { id: 'mystery-model' } } as unknown as SessionContext['session'],
  });
  assert.deepEqual(resolveActiveModel(orphan), { modelId: 'mystery-model' });

  // Throwing or absent registry → modelId only, no crash, no provider guess.
  const throwing = makeContext({
    session: { model: { id: 'boom-model' } } as unknown as SessionContext['session'],
    runtime: {
      session: {} as any,
      dispose: async () => undefined,
      services: {
        modelRegistry: {
          getAvailable: () => { throw new Error('boom'); },
          find: () => undefined,
        },
      },
    } as SessionContext['runtime'],
  });
  assert.deepEqual(resolveActiveModel(throwing), { modelId: 'boom-model' });
});

test('listSessions derives placeholder names from the session file and sorts by modified time', async () => {
  await withTempDir(async (dir) => {
    const derivedFile = path.join(dir, 'derived.jsonl');
    const namedFile = path.join(dir, 'named.jsonl');

    await fs.writeFile(derivedFile, [
      '{not json}',
      JSON.stringify({ id: 'entry-1', type: 'message', message: { role: 'user', content: 'Refactor the analytics pipeline now' } }),
    ].join('\n'), 'utf8');
    await fs.writeFile(namedFile, '', 'utf8');

    const sdk = {
      SessionManager: {
        listAll: async () => [
          {
            path: derivedFile,
            cwd: '/repo',
            modified: new Date('2026-01-01T00:00:00.000Z'),
            messageCount: 2,
          },
          {
            path: namedFile,
            cwd: '/repo',
            name: 'Named Session',
            modified: new Date('2026-01-02T00:00:00.000Z'),
            messageCount: 1,
          },
        ],
      },
    } as Pick<SdkModule, 'SessionManager'> as SdkModule;

    const sessions = await listSessions(sdk);

    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]?.name, 'Named Session');
    assert.equal(sessions[0]?.isPlaceholder, false);
    assert.equal(sessions[1]?.name, 'Refactor Analytics Pipeline');
    assert.equal(sessions[1]?.isPlaceholder, false);
  });
});
