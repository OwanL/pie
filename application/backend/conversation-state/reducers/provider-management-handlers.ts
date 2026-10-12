import type { ArchState } from '../arch-state.js';
import type { ReducerResult } from './helpers.js';
import type { ProviderManagementCommand, ProviderManagementEvent, ProviderManagementEffect, ProviderManagementState, SafeProviderRequest } from '../../provider-management/state.js';
import type { ProviderSetupDraft } from '../../../../harness/model-providers/management/contracts.js';

export function handleProviderManagement(state: ArchState, input: ProviderManagementCommand | ProviderManagementEvent): ReducerResult {
  let p: ProviderManagementState = { ...state.providerManagement };
  const effects: ProviderManagementEffect[] = [];
  const done = (): ReducerResult => ({ state: { ...state, providerManagement: p }, effects });
  const rpc = (request: SafeProviderRequest, ticket?: string): void => {
    p.refreshFence++;
    p.operationId = request.operationId;
    effects.push({ kind: 'ProviderManagementRpc', request, generation: p.generation, fence: p.refreshFence, selectedId: p.selectedId, ...(ticket ? { ticket } : {}) });
  };
  const cancelAuth = (operationId: string): void => {
    if (p.authOperationId) effects.push({ kind: 'ProviderManagementRpc', request: { type: 'cancel', operationId: `${operationId}:cancel`, targetOperationId: p.authOperationId }, generation: p.generation, fence: p.refreshFence, selectedId: p.selectedId });
    p.authOperationId = null;
  };
  if (input.kind === 'ProviderManagementSnapshotUpdated' || input.kind === 'ProviderManagementResult') {
    if (!state.settings.backendReady || input.generation !== p.generation) return { state, effects: [] };
    if (input.kind === 'ProviderManagementResult' && input.requestType === 'cancel') return { state, effects: [] };
    if (input.kind === 'ProviderManagementResult' && input.requestType === 'auth-response') {
      const auth = p.snapshot.auth;
      if (!auth || !('promptId' in auth) || input.targetOperationId !== p.authOperationId || input.promptId !== auth.promptId) return { state, effects: [] };
    }
    if (input.kind === 'ProviderManagementResult' && input.requestType !== 'auth-response' && input.requestType !== 'cancel'
      && (input.fence !== p.refreshFence || input.response.operationId !== p.operationId)) return { state, effects: [] };
    const snapshot = input.kind === 'ProviderManagementResult' ? input.response.snapshot : input.snapshot;
    if (snapshot.revision >= p.snapshot.revision) {
      // Global facts may advance independently; mutation phase belongs only to the live operation.
      const { mutation, ...facts } = snapshot;
      const currentMutation = mutation?.operationId === p.operationId && p.operationId !== null
        && (input.kind !== 'ProviderManagementResult' || input.fence === p.refreshFence);
      p.snapshot = { ...facts, ...(currentMutation ? { mutation } : {}) };
      if (currentMutation && (p.status === 'connecting' || p.status === 'saving')) p.status = 'saving';
    }
    if (input.kind === 'ProviderManagementResult') {
      if (input.fence !== p.refreshFence || input.response.operationId !== p.operationId) return done();
      const status = input.response.status;
      if (input.requestType === 'read-provider' && input.selectedId === p.selectedId && input.response.draft && status === 'ok' && snapshot.revision >= state.providerManagement.snapshot.revision) {
        p.draft = input.response.draft; p.draftConfigRevision = snapshot.configRevision;
      }
      if (input.requestType === 'refresh' && input.selectedId === p.selectedId && input.response.draft && status === 'ok' && snapshot.revision >= state.providerManagement.snapshot.revision) {
        // Refresh discovery without discarding current preferences or typed fields.
        const draft = p.draft;
        if (draft) p.draft = { ...draft, models: input.response.draft.models.map(model => {
          const existing = draft.models.find(m => m.id === model.id);
          return existing ? { ...model, visible: existing.visible, subagentEligible: existing.subagentEligible } : model;
        }).concat(draft.models.filter(model => draft.manualModelIds?.includes(model.id) && !input.response.draft!.models.some(incoming => incoming.id === model.id))) };
      }
      p.status = status === 'conflict' ? 'conflict' : status === 'error' ? 'error' : status === 'cancelled' ? 'idle' : input.requestType === 'save' || input.requestType === 'connect' ? 'saved' : 'idle';
      p.message = status === 'conflict' ? 'Configuration changed. Reload before saving.' : status === 'error' ? 'Provider operation failed.' : undefined;
      if ((input.requestType === 'save' || input.requestType === 'connect') && status === 'ok') {
        p.draftConfigRevision = snapshot.configRevision;
        if (p.draft) p.draft = input.response.draft ?? { ...p.draft, originalId: p.draft.id };
      }
      if (input.requestType === 'connect' && status === 'ok') p.flow = { ...p.flow, screen: 'done' };
      if (input.requestType === 'connect') p.authOperationId = null;
      p.operationId = null;
      const { mutation: _mutation, ...settledSnapshot } = p.snapshot;
      p.snapshot = settledSnapshot;
    }
    return done();
  }
  if (input.generation < p.generation) {
    if ('ticket' in input && input.ticket) effects.push({ kind: 'ProviderManagementDiscardTicket', ticket: input.ticket });
    return { state, effects };
  }
  if (input.generation > p.generation) p = { ...p, generation: input.generation, snapshot: { ...p.snapshot, revision: -1 }, operationId: null, authOperationId: null, refreshFence: p.refreshFence + 1 };
  if (input.kind === 'ProviderManagementAuthResponse') {
    const auth = p.snapshot.auth;
    if (!auth || !('promptId' in auth) || auth.operationId !== p.authOperationId || input.targetOperationId !== auth.operationId || input.promptId !== auth.promptId) {
      effects.push({ kind: 'ProviderManagementDiscardTicket', ticket: input.ticket }); return done();
    }
    // Auth replies must not retire the owning connect operation/fence.
    effects.push({ kind: 'ProviderManagementRpc', request: { type: 'auth-response', operationId: input.operationId, targetOperationId: auth.operationId, promptId: auth.promptId }, generation: p.generation, fence: p.refreshFence, selectedId: p.selectedId, ticket: input.ticket });
    return done();
  }
  if (p.status === 'saving' || p.status === 'connecting' && (input.kind !== 'ProviderManagement' || !['cancel', 'close', 'back', 'add'].includes(input.command.type))) {
    if ('ticket' in input && input.ticket) effects.push({ kind: 'ProviderManagementDiscardTicket', ticket: input.ticket }); return done();
  }
  if (input.kind === 'ProviderManagementConnect') {
    if (!p.draft) { if (input.ticket) effects.push({ kind: 'ProviderManagementDiscardTicket', ticket: input.ticket }); return done(); }
    cancelAuth(input.operationId);
    p.status = 'connecting'; p.authOperationId = input.operationId;
    rpc({ type: 'connect', operationId: input.operationId, expectedRevision: p.draftConfigRevision, draft: p.draft, method: input.method }, input.ticket);
    return done();
  }
  const c = input.command;
  const op = input.operationId;
  switch (c.type) {
    case 'open': p.flow = { open: true, screen: 'manage' }; p.status = 'loading'; rpc({ type: 'read', operationId: op }); break;
    case 'reload': p.status = 'loading'; rpc(p.selectedId ? { type: 'read-provider', operationId: op, id: p.selectedId } : { type: 'read', operationId: op }); break;
    case 'close': case 'cancel': cancelAuth(op); p.refreshFence++; p.operationId = null; p.draft = null; p.selectedId = null; p.status = 'idle'; p.flow = { open: c.type !== 'close', screen: 'manage' }; break;
    case 'back': {
      const screen = p.flow.screen === 'connect' ? 'choose' : 'manage';
      cancelAuth(op); p.refreshFence++; p.operationId = null; p.status = 'idle';
      if (screen === 'manage') { p.draft = null; p.selectedId = null; }
      p.flow = { open: true, screen }; break;
    }
    case 'add': cancelAuth(op); p.refreshFence++; p.operationId = null; p.selectedId = null; p.draft = null; p.status = 'idle'; p.flow = { open: true, screen: 'choose' }; break;
    case 'choose': {
      if (!p.snapshot.loaded) break;
      const definition = p.snapshot.definitions.find(d => c.definitionId ? d.id === c.definitionId : d.kind === c.kind);
      if (!definition) break;
      cancelAuth(op); p.refreshFence++; p.operationId = null; p.selectedId = null;
      const base = definition.id;
      const isOther = base === 'other' && !definition.authMethods.includes('oauth') && definition.discovery === 'openai';
      let id = base; let n = 2;
      if (isOther) while (p.snapshot.providers.some(provider => provider.id === id && provider.configured)) id = `${base}-${n++}`;
      else if (p.snapshot.providers.some(provider => provider.id === id && provider.configured)) {
        p.selectedId = id; p.draft = null; p.status = 'loading';
        p.flow = { open: true, screen: 'connect', kind: definition.kind, definitionId: definition.id, connectionMethod: definition.authMethods[0] };
        rpc({ type: 'read-provider', operationId: op, id }); break;
      }
      p.draftConfigRevision = p.snapshot.configRevision;
      p.draft = { originalId: null, id, enabled: true, api: definition?.api ?? '', baseUrl: definition?.baseUrl ?? '', credentialSource: 'default', environmentName: '', models: [] };
      p.status = 'idle'; p.flow = { open: true, screen: 'connect', kind: definition.kind, definitionId: definition.id, connectionMethod: definition.authMethods[0] }; break;
    }
    case 'models': case 'edit': {
      cancelAuth(op); p.selectedId = c.id; p.draft = null;
      const definition = p.snapshot.definitions.find(d => d.id === c.id) ?? p.snapshot.definitions.find(d => d.id === 'other');
      p.flow = c.type === 'models' ? { open: true, screen: 'models' } : { open: true, screen: 'connect', kind: definition?.kind, definitionId: definition?.id, connectionMethod: definition?.authMethods[0] };
      p.status = 'loading'; rpc({ type: 'read-provider', operationId: op, id: c.id }); break;
    }
    case 'auth-method': p.flow = { ...p.flow, connectionMethod: c.method }; break;
    case 'refresh': p.status = 'loading'; rpc({ type: 'refresh', operationId: op, id: c.id }); break;
    case 'save': if (p.draft && !p.authOperationId) { p.status = 'saving'; rpc({ type: 'save', operationId: op, expectedRevision: p.draftConfigRevision, draft: p.draft }); } break;
    default: {
      if (!p.draft || p.status === 'connecting') break;
      let d: ProviderSetupDraft = { ...p.draft };
      if (c.type === 'change' && !(c.field === 'id' && d.originalId)) d = { ...d, [c.field]: c.value };
      if (c.type === 'enabled') d.enabled = c.value;
      if (c.type === 'credential') d.credentialSource = c.value;
      if (c.type === 'model-preference') d.models = d.models.map(m => m.id === c.id ? { ...m, [c.field]: c.value } : m);
      if (c.type === 'manual-model-add' && c.id && !d.models.some(m => m.id === c.id)) {
        d.models = [...d.models, { id: c.id, name: c.id, visible: 'unset', subagentEligible: 'unset', pricing: { kind: 'unknown', tiered: false } }];
        d.manualModelIds = [...(d.manualModelIds ?? []), c.id];
      }
      p.draft = d;
      // Edits retire a pending read-provider so its late response cannot overwrite the draft.
      if (p.status === 'loading') { p.refreshFence++; p.operationId = null; p.status = 'idle'; }
      break;
    }
  }
  return done();
}
