import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderManagementService } from '../../../../harness/model-providers/management/service';
import { createInitialArchState, reducer } from '../../conversation-state/reducer';
import type { ProviderSetupCommand } from '../../../lib/protocol/provider-setup-preview';
import type { ProviderManagementEffect } from '../../provider-management/state';

test('real remove result reconciles terminal failure, transport uncertainty and retry through host reducer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-remove-host-'));
  const revoked: string[] = [];
  const forgotten: string[] = [];
  const service = createProviderManagementService({
    configFile: join(dir, 'providers.yaml'), modelCacheDir: join(dir, 'cache'),
    auth: { definitions: () => [], hasSavedCredential: () => false,
      stageOAuthLogin: async () => { throw new Error('Unexpected login'); }, saveCredential: async () => {},
      removeCredential: async id => { revoked.push(id); if (revoked.length === 1) throw new Error('synthetic failure'); },
      getApiKey: async () => { throw new Error('Unexpected key lookup'); }, discoveryBaseUrl: async (_, url) => url },
    existingConnections: () => ['target', 'other'].map(id => ({ id, modelCount: 0, credentials: 'saved' as const, canForgetCredential: true, models: {} })),
    forgetExistingCredential: async id => { forgotten.push(id); },
    fetch: async () => { throw new Error('Unexpected network'); },
  });
  let state = createInitialArchState();
  let serial = 0;
  const command = (command: ProviderSetupCommand) => {
    const next = reducer(state, { kind: 'Command', cmd: { kind: 'ProviderManagement', generation: 1, operationId: `op-${++serial}`, corrId: 'test', command } });
    state = next.state;
    return next.effects.filter((e): e is Extract<ProviderManagementEffect, { kind: 'ProviderManagementRpc' }> => e.kind === 'ProviderManagementRpc');
  };
  const settle = (effect: Extract<ProviderManagementEffect, { kind: 'ProviderManagementRpc' }>, response: Awaited<ReturnType<typeof service.request>>) => {
    state = reducer(state, { kind: 'ProviderManagementResult', generation: 1, fence: effect.fence, selectedId: effect.selectedId, requestType: effect.request.type, response }).state;
  };
  try {
    const initial = await service.request({ type: 'read', operationId: 'initial' });
    state = { ...state, settings: { ...state.settings, backendReady: true }, providerManagement: { ...state.providerManagement, generation: 1, snapshot: initial.snapshot } };
    command({ type: 'remove', id: 'target' });
    const first = command({ type: 'confirm-remove' })[0]!;
    assert.equal(command({ type: 'confirm-remove' }).length, 0);
    const failed = await service.request(first.request);
    assert.equal(failed.status, 'error');
    assert.deepEqual(failed.snapshot.providers.map(p => p.id), ['other']);
    assert.notEqual(failed.snapshot.configRevision, initial.snapshot.configRevision);
    // Simulate a lost response. Replaying must retain the original ID/revision.
    settle(first, { operationId: first.request.operationId, status: 'error', snapshot: { ...initial.snapshot, loaded: false, revision: -1 } });
    const replay = command({ type: 'confirm-remove' })[0]!;
    assert.deepEqual(replay.request, first.request);
    assert.equal(await service.request(replay.request), failed);
    settle(replay, failed);
    const retry = command({ type: 'confirm-remove' })[0]!;
    assert.notEqual(retry.request.operationId, first.request.operationId);
    assert.equal(retry.request.type, 'remove');
    if (retry.request.type === 'remove') assert.equal(retry.request.expectedRevision, failed.snapshot.configRevision);
    const success = await service.request(retry.request);
    settle(retry, success);
    assert.equal(success.status, 'ok');
    assert.equal(state.providerManagement.flow.screen, 'manage');
    assert.equal(state.providerManagement.removal, undefined);
    assert.deepEqual(success.snapshot.providers.map(p => p.id), ['other']);
    assert.deepEqual(revoked, ['target', 'target']);
    assert.deepEqual(forgotten, ['target']);
  } finally { service.dispose(); await rm(dir, { recursive: true, force: true }); }
});
