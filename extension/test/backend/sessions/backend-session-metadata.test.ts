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
  loadAvailableModels,
  loadConfiguredModels,
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
  assert.equal(summary.provider, undefined);
  assert.equal(summary.thinkingLevel, 'max');
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
            thinkingLevelMap: { minimal: null, xhigh: 'xhigh', max: 'max' },
            input: ['text', 'image'],
            contextWindow: 200000,
            maxTokens: 8192,
          }, {
            id: 'plain-model',
            name: 'Plain Model',
            provider: 'plain',
            reasoning: false,
            input: ['text'],
            contextWindow: 32000,
            maxTokens: 4096,
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
    thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    inputKinds: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  }, {
    id: 'plain-model',
    name: 'Plain Model',
    provider: 'plain',
    reasoning: false,
    thinkingLevels: ['off'],
    inputKinds: ['text'],
    contextWindow: 32000,
    maxTokens: 4096,
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

test('catalog loaders distinguish valid empty catalogs from retrieval failures', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({ providers: {} }), 'utf8');
    assert.deepEqual(await loadConfiguredModels(dir), { ok: true, models: [] });
  });

  await withTempDir(async (dir) => {
    const failed = await loadConfiguredModels(dir);
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.models, []);
  });

  const failingContext = makeContext({
    runtime: {
      session: {} as any,
      dispose: async () => undefined,
      services: {
        modelRegistry: {
          getAvailable: () => { throw new Error('registry unavailable'); },
          find: () => undefined,
        },
      },
    } as SessionContext['runtime'],
  });
  const failedRuntimeCatalog = loadAvailableModels(failingContext);
  assert.equal(failedRuntimeCatalog.ok, false);
  assert.deepEqual(failedRuntimeCatalog.models, []);
});

test('configured catalog uses the runtime-free registry so built-in model overrides remain visible', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({
      providers: {
        'openai-codex': {
          modelOverrides: {
            'gpt-5.6-sol': { name: 'GPT-5.6 Sol' },
          },
        },
      },
    }), 'utf8');

    let refreshes = 0;
    const registry = {
      refresh: () => { refreshes += 1; },
      getError: () => undefined,
      getAvailable: () => [{
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        provider: 'openai-codex',
        reasoning: true,
        thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
        input: ['text', 'image'] as Array<'text' | 'image'>,
        contextWindow: 272000,
        maxTokens: 128000,
      }],
      find: () => undefined,
    };

    assert.deepEqual(await loadConfiguredModels(dir, registry), {
      ok: true,
      models: [{
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        provider: 'openai-codex',
        reasoning: true,
        thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        inputKinds: ['text', 'image'],
        contextWindow: 272000,
        maxTokens: 128000,
      }],
    });
    assert.equal(refreshes, 1);
  });
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

  // A session provider disambiguates shared IDs. The registry order must not
  // relabel a Codex session as Copilot just because Copilot appears first.
  const sharedId = makeContext({
    session: { ...makeContext().session, model: { id: 'gpt-5.6', provider: 'openai-codex' } } as unknown as SessionContext['session'],
    runtime: {
      session: {} as any,
      dispose: async () => undefined,
      services: {
        modelRegistry: {
          getAvailable: () => [
            { id: 'gpt-5.6', name: 'Copilot GPT-5.6', provider: 'github-copilot', reasoning: true, input: ['text'] },
            { id: 'gpt-5.6', name: 'Codex GPT-5.6', provider: 'openai-codex', reasoning: true, input: ['text'] },
          ],
          find: () => undefined,
        },
      },
    } as SessionContext['runtime'],
  });
  assert.deepEqual(resolveActiveModel(sharedId), {
    modelId: 'gpt-5.6',
    provider: 'openai-codex',
    modelName: 'Codex GPT-5.6',
  });
  assert.equal(buildCurrentSummary(sharedId, '/startup').provider, 'openai-codex');

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

test('listSessions derives names from SDK metadata without rereading the transcript file', async () => {
  const missingPath = path.resolve('/not-present/session.jsonl');
  const sdk = {
    SessionManager: {
      listAll: async () => [{
        path: missingPath,
        cwd: '/repo',
        modified: new Date('2026-01-01T00:00:00.000Z'),
        messageCount: 1,
        firstMessage: 'Make session switching fast and transparent',
      }],
    },
  } as Pick<SdkModule, 'SessionManager'> as SdkModule;

  const sessions = await listSessions(sdk);

  assert.equal(sessions[0]?.name, 'Make Session Switching Fast');
  assert.equal(sessions[0]?.isPlaceholder, false);
});

test('listSessions lists only the configured canonical root and does not scan the SDK legacy default', async () => {
  const configuredDir = path.resolve('/configured/sessions');
  const canonicalPath = path.join(configuredDir, 'canonical.jsonl');
  const legacyPath = path.resolve('/sdk-default/sessions/legacy.jsonl');
  const sdk = {
    SessionManager: {
      listAll: async (sessionDir?: string) => sessionDir === configuredDir
        ? [{
            path: canonicalPath,
            cwd: '/repo',
            name: 'Canonical Session',
            modified: new Date('2026-01-02T00:00:00.000Z'),
            messageCount: 1,
          }]
        : [{
            path: legacyPath,
            cwd: '/repo',
            name: 'Legacy Session',
            modified: new Date('2026-01-01T00:00:00.000Z'),
            messageCount: 1,
          }],
    },
  } as Pick<SdkModule, 'SessionManager'> as SdkModule;

  const sessions = await listSessions(sdk, configuredDir);

  // The legacy SDK-default root is retired once a canonical root is configured;
  // its sessions are migrated by the installer and surfaced by `npm run doctor`.
  assert.deepEqual(sessions.map((session) => session.path), [canonicalPath]);
});

test('listSessions de-duplicates paths using platform filesystem semantics', async () => {
  const configuredDir = path.resolve('/configured/sessions');
  const canonicalPath = path.join(configuredDir, 'canonical.jsonl');
  const duplicatePath = process.platform === 'win32' ? canonicalPath.toUpperCase() : canonicalPath;
  const info = (pathname: string, name: string) => ({
    path: pathname,
    cwd: '/repo',
    name,
    modified: new Date('2026-01-01T00:00:00.000Z'),
    messageCount: 1,
  });
  const sdk = {
    SessionManager: {
      listAll: async (sessionDir?: string) => sessionDir
        ? [info(canonicalPath, 'Canonical'), info(duplicatePath, 'Duplicate')]
        : [],
    },
  } as Pick<SdkModule, 'SessionManager'> as SdkModule;

  const sessions = await listSessions(sdk, configuredDir);

  assert.deepEqual(sessions.map((session) => session.name), ['Canonical']);
});

test('listSessions includes migrated per-cwd directories under the configured root', async () => {
  await withTempDir(async (configuredDir) => {
    const nestedDir = path.join(configuredDir, '--workspace--');
    await fs.mkdir(nestedDir);
    const flatPath = path.join(configuredDir, 'flat.jsonl');
    const nestedPath = path.join(nestedDir, 'nested.jsonl');
    const sdk = {
      SessionManager: {
        listAll: async (sessionDir?: string) => {
          if (sessionDir === configuredDir) return [{
            path: flatPath, cwd: '/repo', name: 'Flat',
            modified: new Date('2026-01-02T00:00:00.000Z'), messageCount: 1,
          }];
          if (sessionDir === nestedDir) return [{
            path: nestedPath, cwd: '/repo', name: 'Nested',
            modified: new Date('2026-01-01T00:00:00.000Z'), messageCount: 1,
          }];
          return [];
        },
      },
    } as Pick<SdkModule, 'SessionManager'> as SdkModule;

    const sessions = await listSessions(sdk, configuredDir);

    assert.deepEqual(sessions.map((session) => session.path), [flatPath, nestedPath]);
  });
});
