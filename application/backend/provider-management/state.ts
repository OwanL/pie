import type { ProviderManagementRequest, ProviderManagementResponse, ProviderManagementSnapshot, ProviderSetupDraft } from '../../../harness/model-providers/management/contracts.js';
import { providerProtocolOptions } from '../../../harness/model-providers/catalog/provider-config.js';
import type { ProviderSetupCommand, ProviderSetupFlow, ProviderSetupPreviewView } from '../../lib/protocol/provider-setup-preview.js';

export type SafeProviderRequest = Exclude<ProviderManagementRequest, { type: 'auth-response' } | { type: 'connect' }> | Omit<Extract<ProviderManagementRequest, { type: 'connect' }>, 'apiKey'> | Omit<Extract<ProviderManagementRequest, { type: 'auth-response' }>, 'value'>;
export interface ProviderManagementState {
  snapshot: ProviderManagementSnapshot;
  draft: ProviderSetupDraft | null;
  draftConfigRevision: string | null;
  flow: ProviderSetupFlow;
  status: ProviderSetupPreviewView['status'];
  operationId: string | null;
  generation: number;
  refreshFence: number;
  selectedId: string | null;
  authOperationId: string | null;
  message?: string;
}
export type ProviderManagementCommand = { kind: 'ProviderManagement'; corrId: string; operationId: string; generation: number; command: ProviderSetupCommand }
  | { kind: 'ProviderManagementConnect'; corrId: string; operationId: string; generation: number; method: 'oauth' | 'api-key' | 'local'; ticket?: string }
  | { kind: 'ProviderManagementAuthResponse'; corrId: string; operationId: string; generation: number; targetOperationId: string; promptId: string; ticket: string };
export type ProviderManagementEvent = { kind: 'ProviderManagementSnapshotUpdated'; snapshot: ProviderManagementSnapshot; generation: number }
  | { kind: 'ProviderManagementResult'; response: ProviderManagementResponse; generation: number; fence: number; selectedId: string | null; requestType: SafeProviderRequest['type']; targetOperationId?: string; promptId?: string };
export type ProviderManagementEffect = { kind: 'ProviderManagementRpc'; request: SafeProviderRequest; generation: number; fence: number; selectedId: string | null; ticket?: string }
  | { kind: 'ProviderManagementDiscardTicket'; ticket: string };
export function createProviderManagementState(): ProviderManagementState {
  return { snapshot: { revision: -1, configRevision: null, loaded: false, providers: [], definitions: [], protocols: providerProtocolOptions }, draft: null, draftConfigRevision: null,
    flow: { open: false, screen: 'manage' }, status: 'idle', operationId: null, generation: 0, refreshFence: 0, selectedId: null, authOperationId: null };
}
export function projectProviderManagementView(state: ProviderManagementState): ProviderSetupPreviewView {
  return { mode: 'management', providers: state.snapshot.providers, definitions: state.snapshot.definitions, protocols: state.snapshot.protocols,
    loaded: state.snapshot.loaded, draft: state.draft, flow: state.flow, status: !state.snapshot.loaded && state.flow.screen === 'choose' ? 'loading' : state.status,
    ...(state.snapshot.auth && state.snapshot.auth.operationId === state.authOperationId ? { auth: state.snapshot.auth } : {}),
    ...(state.snapshot.authBrowser && state.snapshot.authBrowser.operationId === state.authOperationId ? { authBrowser: state.snapshot.authBrowser } : {}),
    ...(state.snapshot.error || state.message ? { message: state.snapshot.error || state.message } : {}) };
}
