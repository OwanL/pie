import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import {
  DEFAULT_PROXY_SETTINGS,
  mergeProxySettings,
  type ProxyProviderUpstream,
  type ProxySettings,
  type ProxySettingsUpdate,
} from '../../shared/protocol';
import { parseJsonOrThrow } from '../util/error-message';
import { resolveSettingsPath } from './pruning-settings';

export function proxySettingsFileExists(): boolean {
  const settingsPath = resolveSettingsPath();
  return settingsPath ? existsSync(settingsPath) : false;
}

function cloneDefaultProxySettings(): ProxySettings {
  return mergeProxySettings(DEFAULT_PROXY_SETTINGS, {});
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return [...value];
  }
  return undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') return undefined;
    out[k] = v;
  }
  return out;
}

/** Coerce an unknown stored provider entry into a valid `ProxyProviderUpstream`, */
function coerceProvider(name: string, raw: unknown): ProxyProviderUpstream | null {
  if (!isPlainObject(raw)) return null;
  const fallback = DEFAULT_PROXY_SETTINGS.providers.umans;
  const apiBase = typeof raw.apiBase === 'string' ? raw.apiBase : '';
  const apiKeyEnv = typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv : '';
  const litellmProvider = typeof raw.litellmProvider === 'string' ? raw.litellmProvider : '';
  const maxConcurrentRequests =
    typeof raw.maxConcurrentRequests === 'number' && raw.maxConcurrentRequests >= 1
      ? raw.maxConcurrentRequests
      : fallback.maxConcurrentRequests;
  const litellmModelInfoId = typeof raw.litellmModelInfoId === 'string' ? raw.litellmModelInfoId : '';
  const modelListOrder = asStringArray(raw.modelListOrder) ?? [];
  const alias = asStringRecord(raw.alias) ?? {};
  void name;
  return { apiBase, apiKeyEnv, litellmProvider, maxConcurrentRequests, litellmModelInfoId, modelListOrder, alias };
}

/**
 * Read the proxy settings from the on-disk settings.json `proxy` key.
 * Returns defaults when the file is missing or the proxy key is absent/invalid.
 */
export async function readProxySettings(): Promise<ProxySettings> {
  const settingsPath = resolveSettingsPath();
  if (!settingsPath) {
    return cloneDefaultProxySettings();
  }

  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed = parseJsonOrThrow<Record<string, unknown>>(raw, `proxy settings (${settingsPath})`);
    const proxy = parsed.proxy as Record<string, unknown> | undefined;
    if (!isPlainObject(proxy)) {
      return cloneDefaultProxySettings();
    }

    const gatewayRaw = proxy.gateway as Record<string, unknown> | undefined;
    const gateway = isPlainObject(gatewayRaw)
      ? {
          routerSettings: isPlainObject(gatewayRaw.routerSettings)
            ? {
                numRetries: typeof gatewayRaw.routerSettings.numRetries === 'number' ? gatewayRaw.routerSettings.numRetries : DEFAULT_PROXY_SETTINGS.gateway.routerSettings.numRetries,
                retryAfter: typeof gatewayRaw.routerSettings.retryAfter === 'boolean' ? gatewayRaw.routerSettings.retryAfter : DEFAULT_PROXY_SETTINGS.gateway.routerSettings.retryAfter,
                timeout: typeof gatewayRaw.routerSettings.timeout === 'number' ? gatewayRaw.routerSettings.timeout : DEFAULT_PROXY_SETTINGS.gateway.routerSettings.timeout,
              }
            : DEFAULT_PROXY_SETTINGS.gateway.routerSettings,
          litellmSettings: isPlainObject(gatewayRaw.litellmSettings)
            ? {
                dropParams: typeof gatewayRaw.litellmSettings.dropParams === 'boolean' ? gatewayRaw.litellmSettings.dropParams : DEFAULT_PROXY_SETTINGS.gateway.litellmSettings.dropParams,
              }
            : DEFAULT_PROXY_SETTINGS.gateway.litellmSettings,
          generalSettings: isPlainObject(gatewayRaw.generalSettings)
            ? {
                masterKeyEnv: typeof gatewayRaw.generalSettings.masterKeyEnv === 'string' && gatewayRaw.generalSettings.masterKeyEnv.length > 0
                  ? gatewayRaw.generalSettings.masterKeyEnv
                  : DEFAULT_PROXY_SETTINGS.gateway.generalSettings.masterKeyEnv,
              }
            : DEFAULT_PROXY_SETTINGS.gateway.generalSettings,
        }
      : DEFAULT_PROXY_SETTINGS.gateway;

    const providersRaw = proxy.providers as Record<string, unknown> | undefined;
    const providers: Record<string, ProxyProviderUpstream> = {};
    if (isPlainObject(providersRaw)) {
      for (const [name, entry] of Object.entries(providersRaw)) {
        const coerced = coerceProvider(name, entry);
        if (coerced) providers[name] = coerced;
      }
    }
    if (Object.keys(providers).length === 0) {
      providers.umans = { ...DEFAULT_PROXY_SETTINGS.providers.umans, modelListOrder: [...DEFAULT_PROXY_SETTINGS.providers.umans.modelListOrder], alias: { ...DEFAULT_PROXY_SETTINGS.providers.umans.alias } };
    }

    return { gateway, providers };
  } catch {
    return cloneDefaultProxySettings();
  }
}

/** True when a (post-merge) provider entry has all required fields populated. */
function isValidProvider(p: ProxyProviderUpstream): boolean {
  return (
    typeof p.apiBase === 'string' && p.apiBase.length > 0 &&
    typeof p.apiKeyEnv === 'string' && p.apiKeyEnv.length > 0 &&
    typeof p.litellmProvider === 'string' && p.litellmProvider.length > 0 &&
    typeof p.maxConcurrentRequests === 'number' && p.maxConcurrentRequests >= 1 &&
    typeof p.litellmModelInfoId === 'string' && p.litellmModelInfoId.length > 0 &&
    Array.isArray(p.modelListOrder) &&
    isPlainObject(p.alias)
  );
}

function validateProxySettings(settings: ProxySettings): void {
  const { gateway } = settings;
  if (
    typeof gateway.routerSettings.numRetries !== 'number' ||
    typeof gateway.routerSettings.retryAfter !== 'boolean' ||
    typeof gateway.routerSettings.timeout !== 'number' ||
    typeof gateway.litellmSettings.dropParams !== 'boolean' ||
    typeof gateway.generalSettings.masterKeyEnv !== 'string' || gateway.generalSettings.masterKeyEnv.length === 0
  ) {
    throw new Error('Invalid proxy settings: gateway fields missing or wrong type.');
  }
  for (const [name, p] of Object.entries(settings.providers)) {
    if (!isValidProvider(p)) {
      throw new Error(`Invalid proxy settings: provider "${name}" is missing required fields (apiBase, apiKeyEnv, litellmProvider, maxConcurrentRequests>=1, litellmModelInfoId, modelListOrder, alias).`);
    }
  }
}

/**
 * Write a partial proxy settings update to settings.json.
 * Deep-merges into the existing `proxy` key (preserving all other settings.json
 * keys) using the same semantics as {@link mergeProxySettings}, validates the
 * result, and returns the merged proxy settings.
 */
export async function writeProxySettings(
  updates: ProxySettingsUpdate,
): Promise<ProxySettings> {
  const settingsPath = resolveSettingsPath();
  if (!settingsPath) {
    throw new Error('PI_CODING_AGENT_DIR is not set; cannot write proxy settings (set it to the pi config directory that contains settings.json).');
  }

  let existing: Record<string, unknown> = {};
  try {
    existing = parseJsonOrThrow<Record<string, unknown>>(await fs.readFile(settingsPath, 'utf8'), settingsPath);
  } catch {
    // File may not exist yet — start fresh.
  }

  const current = await readProxySettings();
  const merged = mergeProxySettings(current, updates);
  validateProxySettings(merged);

  // Write the merged `proxy` block back, preserving all other settings.json keys.
  existing.proxy = {
    gateway: merged.gateway,
    providers: merged.providers,
  };
  await fs.writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  return merged;
}