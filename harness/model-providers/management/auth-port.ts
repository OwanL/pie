import type { ProviderDefinition } from './contracts';

/** Backend-private staged credentials. Never send these through state/events. */
export type StagedProviderCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number; [key: string]: unknown };
export interface ProviderOAuthCallbacks {
  onAuth(info: { url: string; instructions?: string }): void;
  onDeviceCode(info: { userCode: string; verificationUri: string }): void;
  onPrompt(prompt: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
  onProgress?(message: string): void;
  onManualCodeInput?(): Promise<string>;
  onSelect(prompt: { message: string; options: { id: string; label: string }[] }): Promise<string | undefined>;
  signal?: AbortSignal;
}
export interface ProviderManagementAuthPort {
  definitions(): ProviderDefinition[];
  /** Stored presence only, not authenticated access. Never resolve environment fallbacks. */
  hasSavedCredential(providerId: string): boolean;
  stageOAuthLogin(providerId: string, callbacks: ProviderOAuthCallbacks): Promise<StagedProviderCredential>;
  saveCredential(providerId: string, credential: StagedProviderCredential): Promise<void>;
  /** Explicit discovery effect only. OAuth may refresh through Pi's storage lock. */
  getApiKey(providerId: string): Promise<string | undefined>;
  /** Backend-private saved credential epoch; never include in public state. */
  getRuntimeCredentialScope?(providerId: string): Promise<string | undefined>;
  /** Resolve only the saved credential belonging to this epoch; never use fallback auth. */
  getRuntimeApiKey?(providerId: string, scope: string): Promise<string | undefined>;
  /** Apply native OAuth model adjustments to the caller's native model baseline. */
  runtimeModels?<Model extends { provider: string; baseUrl: string }>(providerId: string, models: Model[]): Promise<Model[]>;
  /** Preserve Pi's credential-dependent endpoint selection, especially Copilot enterprise. */
  discoveryBaseUrl(providerId: string, configuredBaseUrl: string): Promise<string>;
}
