import { readFileSync } from 'node:fs';
import { parseProviderConfig, type ProviderConfig } from '../catalog/provider-config';
import { resolveProviderConfigPaths } from '../catalog/provider-config-paths';
import type { RuntimeSnapshot } from './contracts';

/** Selector masks are live policy; runtime definitions and credential epochs remain pinned. */
export function applyProviderSelectorPolicy(snapshot: RuntimeSnapshot, config: ProviderConfig): RuntimeSnapshot {
  return { ...snapshot, models: snapshot.models.map(row => ({ ...row,
    visible: config.providers[row.providerId]?.removed !== true && !(Object.hasOwn(config.providers, row.providerId)
      && Object.hasOwn(config.providers[row.providerId].modelPreferences ?? {}, row.id)
      && config.providers[row.providerId].modelPreferences![row.id].visible === false),
  })) };
}

/** Invalid/unavailable settings retain the captured selector policy. No auth or registry refresh. */
export function readCurrentProviderSelectorPolicy(): ProviderConfig | undefined {
  try {
    const paths = resolveProviderConfigPaths({ configDir: process.env.PIE_PROVIDER_CONFIG_DIR });
    const parsed = parseProviderConfig(readFileSync(paths.configFile, 'utf8'));
    return parsed.status === 'valid' ? parsed.config : undefined;
  } catch { return undefined; }
}

/** Only explicit removal revokes live admission; missing/disabled entries do not. */
export function isProviderRemoved(provider: string): boolean {
  const config = readCurrentProviderSelectorPolicy();
  return !!config && Object.hasOwn(config.providers, provider) && config.providers[provider].removed === true;
}

export function filterCurrentProviderSelectorModels<T extends { provider: string; id: string }>(models: T[]): T[] {
  const config = readCurrentProviderSelectorPolicy();
  return config ? models.filter(model => config.providers[model.provider]?.removed !== true && !(Object.hasOwn(config.providers, model.provider)
    && Object.hasOwn(config.providers[model.provider].modelPreferences ?? {}, model.id)
    && config.providers[model.provider].modelPreferences![model.id].visible === false)) : models;
}

export function currentProviderSelectorSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  try {
    const config = readCurrentProviderSelectorPolicy();
    return config ? applyProviderSelectorPolicy(snapshot, config) : snapshot;
  } catch { return snapshot; }
}
