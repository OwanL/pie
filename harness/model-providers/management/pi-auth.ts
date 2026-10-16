import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { ProviderManagementAuthPort, ProviderOAuthCallbacks, StagedProviderCredential } from './auth-port';
import type { ProviderDefinition } from './contracts';

/** Structural public SDK boundary: the caller supplies its verified AuthStorage and getModels exports. */
export interface NativeOAuthProvider<Model> {
  readonly id: string;
  readonly name: string;
  modifyModels?(models: Model[], credentials: Extract<StagedProviderCredential, { type: 'oauth' }>): Model[];
}
export interface NativeAuthStorage<Model> {
  getOAuthProviders(): NativeOAuthProvider<Model>[];
  get(providerId: string): StagedProviderCredential | undefined;
  set(providerId: string, credential: StagedProviderCredential): void;
  remove(providerId: string): void;
  drainErrors(): Error[];
  login(providerId: string, callbacks: ProviderOAuthCallbacks): Promise<void>;
  getApiKey(providerId: string, options: { includeFallback: false }): Promise<string | undefined>;
}
export interface NativeAuthStorageConstructor<Model> {
  create(path: string): NativeAuthStorage<Model>;
  inMemory(): NativeAuthStorage<Model>;
}

/** Read-only private epoch check for synchronous SDK availability predicates. */
export function isRuntimeCredentialScopeCurrent(credentialFile: string, providerId: string, scope: string | undefined): boolean {
  if (!scope) return false;
  try {
    const scopes = JSON.parse(readFileSync(`${credentialFile}.runtime-scopes.json`, 'utf8'));
    return !!scopes && Object.hasOwn(scopes, providerId) && scopes[providerId] === scope;
  } catch { return false; }
}

/** credentialFile must be a caller-owned absolute path outside the checkout. No default user store is read. */
export function createPiProviderAuth<Model extends { provider: string; baseUrl: string }>(
  AuthStorageConstructor: NativeAuthStorageConstructor<Model>,
  credentialFile: string,
  getModels?: (provider: string) => Model[],
): ProviderManagementAuthPort {
  if (!isAbsolute(credentialFile)) throw new Error('An absolute credential file path is required');
  // Inspect only exact ancestors, including canonical ancestors for symlinked parents.
  const outsideCheckout = (path: string) => {
    let cursor = dirname(path);
    while (true) {
      if (existsSync(join(cursor, '.git'))) throw new Error('Provider credentials must be outside the checkout');
      if (existsSync(cursor)) {
        const canonical = realpathSync(cursor);
        if (canonical !== cursor) { outsideCheckout(join(canonical, 'credential-file')); break; }
      }
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  };
  outsideCheckout(credentialFile);
  const registry = AuthStorageConstructor.inMemory().getOAuthProviders();
  const customId = 'other';
  const storage = () => AuthStorageConstructor.create(credentialFile);
  const scopeFile = `${credentialFile}.runtime-scopes.json`;
  const failure = () => new Error('Provider credential storage failed');
  const readScopes = (): Record<string, string | null> => {
    try {
      const value: unknown = JSON.parse(readFileSync(scopeFile, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.values(value).some(scope => scope !== null && (typeof scope !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scope)))) throw failure();
      return Object.assign(Object.create(null), value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null);
      throw failure();
    }
  };
  const replaceScope = (providerId: string, scope: string | null = randomUUID()): string | null => {
    const scopes = readScopes();
    scopes[providerId] = scope;
    const temporary = `${scopeFile}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(scopeFile), { recursive: true });
      writeFileSync(temporary, JSON.stringify(scopes), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, scopeFile);
      return scope;
    } catch { throw failure(); }
    finally { try { rmSync(temporary, { force: true }); } catch { /* Best-effort private temporary cleanup. */ } }
  };
  const requireScope = (providerId: string, scope: string) => {
    if (!scope || readScopes()[providerId] !== scope) throw new Error('Provider credential scope is unavailable');
  };
  const checkErrors = (native: NativeAuthStorage<Model>) => {
    const errors = native.drainErrors();
    if (errors.length) throw failure();
  };
  const oauth = (id: string) => registry.find(provider => provider.id === id);
  const definition = (id: string, name: string, kind: ProviderDefinition['kind'], api: string,
    baseUrl: string, apiKey: boolean, discovery: ProviderDefinition['discovery']): ProviderDefinition => ({
    id, name, kind, api, baseUrl, discovery,
    authMethods: [...(oauth(id) ? ['oauth' as const] : []), ...(apiKey ? ['api-key' as const] : [])],
  });
  return {
    definitions() {
      const known = [
        definition('openai-codex', 'ChatGPT', 'chatgpt', 'openai-codex-responses', 'https://chatgpt.com/backend-api', false, 'unsupported'),
        definition('openai', 'OpenAI API', 'openai', 'openai-responses', 'https://api.openai.com/v1', true, 'openai'),
        definition('anthropic', 'Anthropic', 'anthropic', 'anthropic-messages', 'https://api.anthropic.com', true, 'unsupported'),
        definition('github-copilot', 'GitHub Copilot', 'copilot', 'openai-completions', 'https://api.githubcopilot.com', false, 'copilot'),
      ].filter(value => value.authMethods.length > 0);
      for (const provider of registry) {
        if (!known.some(value => value.id === provider.id)) {
          known.push(definition(provider.id, provider.name, 'custom', '', '', false, 'unsupported'));
        }
      }
      known.push({ id: 'ollama', name: 'Ollama (local and cloud)', kind: 'ollama', api: 'openai-completions',
        baseUrl: 'http://localhost:11434/v1', authMethods: ['local'], discovery: 'ollama' });
      known.push({ id: customId, name: 'Other provider', kind: 'custom', api: 'openai-completions',
        baseUrl: '', authMethods: ['api-key', 'local'], discovery: 'openai' });
      return known;
    },
    hasSavedCredential(providerId) { return storage().get(providerId) !== undefined; },
    async stageOAuthLogin(providerId, callbacks) {
      if (!oauth(providerId)) throw new Error('Unsupported OAuth provider');
      const staged = AuthStorageConstructor.inMemory();
      await staged.login(providerId, callbacks);
      checkErrors(staged);
      if (callbacks.signal?.aborted) throw new Error('Provider login cancelled');
      const credential = staged.get(providerId);
      if (credential?.type !== 'oauth') throw new Error('OAuth login did not produce credentials');
      return structuredClone(credential);
    },
    async saveCredential(providerId, credential) {
      // Invalidate captured epochs before attempting the canonical native write. A failed
      // native write does not restore the old epoch or claim a credential rollback.
      // Pending tombstone prevents another capture admitting the previous credential
      // under the replacement epoch while the canonical write is in progress.
      replaceScope(providerId, null);
      try {
        const native = storage();
        native.set(providerId, structuredClone(credential));
        checkErrors(native);
        replaceScope(providerId);
      } catch { throw failure(); }
    },
    async removeCredential(providerId) {
      // Revoke prior runtime captures before touching the canonical managed store.
      replaceScope(providerId, null);
      try {
        const native = storage();
        native.remove(providerId);
        checkErrors(native);
      } catch { throw failure(); }
    },
    async getApiKey(providerId) {
      const native = storage();
      const credential = native.get(providerId);
      if (credential?.type !== 'api_key' && credential?.type !== 'oauth') return undefined;
      const key = await native.getApiKey(providerId, { includeFallback: false });
      checkErrors(native);
      return key;
    },
    async getRuntimeCredentialScope(providerId) {
      try {
        const native = storage();
        const credential = native.get(providerId);
        checkErrors(native);
        if (!credential) return undefined;
        const scopes = readScopes();
        if (Object.hasOwn(scopes, providerId)) return scopes[providerId] ?? undefined;
        return replaceScope(providerId) ?? undefined;
      } catch { throw failure(); }
    },
    async getRuntimeApiKey(providerId, scope) {
      try {
        requireScope(providerId, scope);
        const native = storage();
        const credential = native.get(providerId);
        checkErrors(native);
        if (!credential) throw failure();
        const key = await native.getApiKey(providerId, { includeFallback: false });
        checkErrors(native);
        requireScope(providerId, scope);
        return key;
      } catch { throw failure(); }
    },
    async runtimeModels(providerId, models) {
      try {
        const native = storage();
        const credential = native.get(providerId);
        checkErrors(native);
        const provider = oauth(providerId);
        if (!provider?.modifyModels || credential?.type !== 'oauth') return models;
        return provider.modifyModels(models as unknown as Model[], credential) as unknown as typeof models;
      } catch { throw failure(); }
    },
    async discoveryBaseUrl(providerId, configuredBaseUrl) {
      if (providerId !== 'github-copilot') return configuredBaseUrl;
      const provider = oauth(providerId);
      const credential = storage().get(providerId);
      if (!provider?.modifyModels || !getModels || credential?.type !== 'oauth') {
        throw new Error('Credential-dependent provider discovery is unsupported');
      }
      const models = provider.modifyModels(getModels(providerId), credential);
      const endpoints = models.filter(model => model.provider === providerId).map(model => model.baseUrl);
      if (!endpoints.length || endpoints.some(endpoint => endpoint !== endpoints[0])) {
        throw new Error('Provider discovery endpoint is unavailable or ambiguous');
      }
      const endpoint = new URL(endpoints[0]);
      if (!['https:', 'http:'].includes(endpoint.protocol) || !endpoint.hostname) {
        throw new Error('Provider discovery endpoint is unsupported');
      }
      return endpoints[0];
    },
  };
}
