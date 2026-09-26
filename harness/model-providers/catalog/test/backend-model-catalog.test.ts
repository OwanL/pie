import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  listAvailableModels,
  loadAvailableModels,
  loadConfiguredModels,
  resolveActiveModel,
} from '../model-catalog';
import { buildCurrentSummary } from '../../../session-storage/metadata/session-metadata';
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

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-metadata-test-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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
