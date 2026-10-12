/** Browser-safe provider management contracts. Credentials are never snapshot data. */
export type ProviderSetupPreference = 'unset' | 'yes' | 'no';
export type ProviderSetupCredentialSource = 'default' | 'saved' | 'environment' | 'none';
export type ProviderSetupKind = 'chatgpt' | 'openai' | 'anthropic' | 'copilot' | 'custom';
export interface ProviderSetupModel {
  id: string; name: string; visible: ProviderSetupPreference; subagentEligible: ProviderSetupPreference;
  pricing: { kind: 'unknown' | 'partial' | 'known'; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiered: boolean };
}
export interface ProviderSetupDraft {
  originalId: string | null; id: string; enabled: boolean; api: string; baseUrl: string;
  credentialSource: ProviderSetupCredentialSource; environmentName: string; models: ProviderSetupModel[];
  manualModelIds?: string[];
}
export type ProviderConnectionMethod = 'oauth' | 'api-key' | 'local';
export interface ProviderDefinition {
  id: string; name: string; kind: ProviderSetupKind; api: string; baseUrl: string;
  authMethods: ProviderConnectionMethod[];
  discovery: 'openai' | 'copilot' | 'unsupported';
}
export interface ManagedProviderSummary {
  id: string; name: string; configured: boolean; enabled: boolean; modelCount: number;
  credentials: 'saved' | 'missing' | 'environment' | 'default' | 'none';
  discovery: 'idle' | 'refreshing' | 'fresh' | 'cached' | 'error' | 'unsupported';
}
export type ProviderAuthPrompt =
  | { kind: 'browser'; operationId: string; url: string; instructions?: string }
  | { kind: 'device'; operationId: string; url: string; code: string }
  | { kind: 'input'; operationId: string; promptId: string; message: string; placeholder?: string; allowEmpty?: boolean }
  | { kind: 'select'; operationId: string; promptId: string; message: string; options: { id: string; label: string }[] }
  | { kind: 'progress'; operationId: string; message: string };
export interface ProviderManagementSnapshot {
  revision: number;
  configRevision: string | null;
  loaded: boolean;
  providers: ManagedProviderSummary[];
  definitions: ProviderDefinition[];
  protocols: readonly string[];
  auth?: ProviderAuthPrompt;
  /** Noncancelable configuration/credential commit; never credential data. */
  mutation?: { operationId: string; phase: 'saving' };
  /** Safe fixed summary, never raw provider exceptions or request bodies. */
  error?: string;
}
/** All mutations carry an operation identity; save uses the writer's full-document fence. */
export type ProviderManagementRequest =
  | { type: 'read'; operationId: string }
  | { type: 'read-provider'; operationId: string; id: string }
  | { type: 'save'; operationId: string; expectedRevision: string | null; draft: ProviderSetupDraft }
  | { type: 'connect'; operationId: string; expectedRevision: string | null; draft: ProviderSetupDraft; method: ProviderConnectionMethod; apiKey?: string }
  | { type: 'refresh'; operationId: string; id: string }
  | { type: 'cancel'; operationId: string; targetOperationId: string }
  | { type: 'auth-response'; operationId: string; targetOperationId: string; promptId: string; value: string };
export interface ProviderManagementResponse {
  snapshot: ProviderManagementSnapshot;
  operationId: string;
  status: 'ok' | 'conflict' | 'error' | 'cancelled';
  draft?: ProviderSetupDraft;
}
export interface ProviderManagementPort {
  request(request: ProviderManagementRequest): Promise<ProviderManagementResponse>;
}
