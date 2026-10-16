/** Browser-safe controlled provider management UI. Secrets use private callbacks, never view state. */
import type { ProviderSetupDraft, ProviderSetupKind, ProviderDefinition, ProviderConnectionMethod, ProviderAuthPrompt, ManagedProviderSummary } from '../../../harness/model-providers/management/contracts';
export type { ProviderSetupPreference, ProviderSetupCredentialSource, ProviderSetupModel, ProviderSetupDraft, ProviderSetupKind } from '../../../harness/model-providers/management/contracts';
export type ProviderSetupScreen = 'manage' | 'choose' | 'connect' | 'done' | 'models' | 'remove';
export interface ProviderSetupFlow {
  open: boolean; screen: ProviderSetupScreen; kind?: ProviderSetupKind;
  /** Host-owned return destination, retained across renderer remounts. */
  navigationOrigin?: 'home' | 'chooser';
  definitionId?: string; connectionMethod?: ProviderConnectionMethod;
  providerId?: string;
}
export interface ProviderSetupPreviewView {
  mode: 'preview' | 'management';
  flow?: ProviderSetupFlow;
  providers: (Pick<ManagedProviderSummary, 'id' | 'configured' | 'enabled' | 'modelCount'> & Partial<ManagedProviderSummary>)[];
  protocols: readonly string[];
  definitions?: ProviderDefinition[];
  draft: ProviderSetupDraft | null;
  status: 'idle' | 'loading' | 'connecting' | 'saving' | 'saved' | 'conflict' | 'error';
  loaded?: boolean;
  auth?: ProviderAuthPrompt;
  authBrowser?: import('../../../harness/model-providers/management/contracts').ProviderManagementSnapshot['authBrowser'];
  message?: string;
  issues?: { path: string; message: string }[];
}
export type ProviderSetupCommand =
  | { type: 'open' } | { type: 'close' } | { type: 'back' }
  | { type: 'choose'; kind: ProviderSetupKind; definitionId?: string }
  | { type: 'auth-method'; method: ProviderConnectionMethod }
  | { type: 'remove'; id: string } | { type: 'confirm-remove' }
  | { type: 'models'; id: string } | { type: 'add' } | { type: 'edit'; id: string }
  | { type: 'change'; field: 'id' | 'api' | 'baseUrl' | 'environmentName'; value: string }
  | { type: 'enabled'; value: boolean }
  | { type: 'credential'; value: 'default' | 'saved' | 'environment' }
  | { type: 'model-preference'; id: string; field: 'visible' | 'subagentEligible'; value: 'unset' | 'yes' | 'no' }
  | { type: 'manual-model-add'; id: string }
  | { type: 'refresh'; id: string }
  | { type: 'save' } | { type: 'cancel' } | { type: 'reload' };
export interface ProviderSetupPreviewProps {
  view: ProviderSetupPreviewView;
  onCommand: (command: ProviderSetupCommand) => void;
  disabled?: boolean;
  presentation?: 'launcher' | 'tab';
  onConnect?: (request: { method: 'signin' | 'api-key' | 'local'; apiKey?: string }) => void;
  onAuthResponse?: (request: { operationId: string; promptId: string; value: string }) => void;
}
