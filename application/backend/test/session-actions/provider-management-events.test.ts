import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialArchState } from '../../conversation-state/arch-state.js';
import type { ArchState } from '../../conversation-state/arch-state.js';
import { reducer } from '../../conversation-state/reducer.js';
import type { Event } from '../../conversation-state/events.js';
import { NOOP_RUN_OBSERVER } from '../../analytics-views';
import { SessionService } from '../../session-actions/service.js';
import { BackendClient } from '../../agent-connection/client.js';
import { readProviderConfig } from '../../../../harness/model-providers/catalog/provider-config.js';
import type { ProviderManagementSnapshot } from '../../../../harness/model-providers/management/contracts.js';

function createContext() {
  return {
    globalState: { get: () => undefined, update: async () => undefined },
    workspaceState: { update: async () => undefined },
  } as any;
}

function createPlatform() {
  const unexpected = (): never => { throw new Error('Unexpected backend startup in provider event test'); };
  return {
    storage: { get: () => undefined, update: async () => undefined },
    extensionPath: '/test-extension', getRuntimeOutputDirectory: () => '/test-out',
    getWorkspaceCwd: () => '/test-workspace', getSetting: () => undefined,
    requestWindowAttention: () => undefined,
    backendStartup: { prepareDevelopmentEnvironment: unexpected, resolveBackendLaunchPaths: async () => unexpected(), prepareBackendEnvironment: unexpected },
  } as any;
}

test('providers.changed ingress advances the saved reducer snapshot only for the current generation and canonical revisions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pie-provider-event-'));
  const configFile = join(directory, 'provider-config.yaml');
  const configX = 'version: 1\nproviders: {}\n';
  const configY = 'version: 1\nproviders:\n  custom: { enabled: true, api: openai-completions }\n';
  try {
    await writeFile(configFile, configX, 'utf8');
    const parsedX = await readProviderConfig(configFile);
    assert.equal(parsedX.status, 'valid');
    if (parsedX.status !== 'valid') return;
    await writeFile(configFile, configY, 'utf8');
    const parsedY = await readProviderConfig(configFile);
    assert.equal(parsedY.status, 'valid');
    if (parsedY.status !== 'valid') return;
    assert.match(parsedX.revision, /^sha256:[a-f0-9]{64}$/);
    assert.match(parsedY.revision, /^sha256:[a-f0-9]{64}$/);

    const initial = createInitialArchState();
    let archState: ArchState = {
      ...initial,
      settings: { ...initial.settings, backendReady: true },
      providerManagement: {
        ...initial.providerManagement,
        generation: 1,
        snapshot: {
          revision: 1, configRevision: parsedX.revision, loaded: true, providers: [],
          definitions: [{ id: 'custom', name: 'Custom', kind: 'custom', api: 'openai-completions', baseUrl: '', authMethods: ['api-key'], discovery: 'openai' }],
          protocols: ['openai-completions'],
        },
      },
    };
    const dispatched: Event[] = [];
    const dispatchArch = (event: Event) => { dispatched.push(event); archState = reducer(archState, event).state; };
    let renders = 0;
    const backend = new BackendClient();
    t.mock.method(backend, 'getGeneration', () => 1);
    const service = new SessionService(
      createPlatform(), backend, () => { renders += 1; }, () => undefined,
      dispatchArch, () => archState, undefined, NOOP_RUN_OBSERVER,
    );
    try {
      (service as any).state.adoptBackendGeneration(1);
      const events = (service as any).events as { handleBackendEvent(event: unknown): void };
      const saving = reducer(archState, { kind: 'Command', cmd: { kind: 'ProviderManagement', command: { type: 'choose', kind: 'custom' }, operationId: 'save-op', corrId: 'save-op', generation: 1 } });
      archState = saving.state;
      const save = reducer(archState, { kind: 'Command', cmd: { kind: 'ProviderManagement', command: { type: 'save' }, operationId: 'save-op', corrId: 'save-op', generation: 1 } });
      archState = save.state;
      const rpc = save.effects.find(effect => effect.kind === 'ProviderManagementRpc');
      assert.ok(rpc?.kind === 'ProviderManagementRpc' && rpc.request.type === 'save');
      dispatchArch({
        kind: 'ProviderManagementResult', generation: 1, fence: rpc.fence, selectedId: null, requestType: 'save',
        response: { operationId: 'save-op', status: 'ok', snapshot: {
          revision: 2, configRevision: parsedX.revision, loaded: true, providers: [],
          definitions: archState.providerManagement.snapshot.definitions, protocols: ['openai-completions'],
        } },
      });
      assert.equal(archState.providerManagement.status, 'saved');

      const fresh: ProviderManagementSnapshot = {
        revision: 3, configRevision: parsedY.revision, loaded: true,
        providers: [{ id: 'custom', name: 'Custom', configured: true, enabled: true, modelCount: 1, credentials: 'missing', discovery: 'fresh' }],
        definitions: archState.providerManagement.snapshot.definitions, protocols: ['openai-completions'],
      };
      events.handleBackendEvent({ event: 'providers.changed', payload: { snapshot: fresh, backendGeneration: 1 } });
      assert.equal(dispatched.at(-1)?.kind, 'ProviderManagementSnapshotUpdated');
      assert.strictEqual(archState.providerManagement.snapshot.providers[0], fresh.providers[0]);
      assert.equal(archState.providerManagement.snapshot.revision, 3);
      assert.equal(archState.providerManagement.snapshot.providers[0]?.modelCount, 1);
      assert.equal(archState.providerManagement.snapshot.providers[0]?.discovery, 'fresh');
      assert.equal(archState.providerManagement.status, 'saved');

      const acceptedCount = dispatched.length;
      events.handleBackendEvent({ event: 'providers.changed', payload: { snapshot: { ...fresh, revision: 4 }, backendGeneration: 0 } });
      events.handleBackendEvent({ event: 'providers.changed', payload: { snapshot: { ...fresh, revision: 5, configRevision: 'sha256:not-a-canonical-digest' }, backendGeneration: 1 } });
      assert.equal(dispatched.length, acceptedCount, 'stale generation and malformed revision never reach the reducer');
      assert.equal(archState.providerManagement.snapshot.revision, 3);
      assert.equal(renders, 1);
    } finally {
      service.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
