import * as crypto from 'node:crypto';
import type * as vscode from 'vscode';

/**
 * Env var that sources BOTH the LiteLLM proxy `master_key` and the backend's
 * Authorization header when calling a proxied provider. Pie sets it in
 * process.env before spawning the proxy + backend (both inherit it).
 *
 * This is the LOCAL localhost gate — decoupled from every provider's upstream
 * key — so multiple proxied providers (each with their own upstream key via
 * `proxy.providers.<p>.apiKeyEnv`) all auth to the proxy with this single value.
 * (LiteLLM is DB-less, so the Authorization MUST match `master_key`.)
 */
export const PROXY_MASTER_KEY_ENV = 'PIE_PROXY_MASTER_KEY';

const STORAGE_KEY = 'pie.proxyMasterKey';

/**
 * Get-or-generate-and-persist the random local master key that gates the
 * LiteLLM proxy. Generated once on first run and stored in VS Code
 * SecretStorage, so it is stable across reloads (a reused proxy from a prior
 * run keeps a valid master_key) without any user setup.
 */
export async function ensureProxyMasterKey(secrets: vscode.SecretStorage): Promise<string> {
  let key = await secrets.get(STORAGE_KEY);
  if (!key || key.length === 0) {
    key = crypto.randomUUID();
    await secrets.store(STORAGE_KEY, key);
  }
  return key;
}
