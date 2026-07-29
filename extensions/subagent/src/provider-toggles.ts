/**
 * Provider toggle parsing.
 *
 * Mirrors the provider-enablement JSON from PIE_PROVIDER_TOGGLES_JSON into
 * disabled-provider sets and model-id allowlists.
 */

import { parseJsonOrThrow } from "../../../shared/error-message.js";
import { qualifiedModelSpec } from "./bucket-config.js";

export const PROVIDER_TOGGLES_ENV = "PIE_PROVIDER_TOGGLES_JSON";
export const SUBAGENT_PROVIDER_DEFAULTS_ENV = "PIE_SUBAGENT_PROVIDER_DEFAULTS_JSON";
export const SUBAGENT_PROVIDER_TOGGLES_ENV = "PIE_SUBAGENT_PROVIDER_TOGGLES_BY_SESSION_JSON";

export interface ModelProviderRef {
  id: string;
  provider: string;
}

export function parseProviderToggles(
  raw: string | undefined,
): Record<string, boolean> {
  if (!raw) return {};

  try {
    const parsed = parseJsonOrThrow<unknown>(raw, "provider toggles");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};

    const toggles: Record<string, boolean> = {};
    for (const [provider, enabled] of Object.entries(parsed)) {
      if (typeof enabled === "boolean") toggles[provider] = enabled;
    }
    return toggles;
  } catch {
    return {};
  }
}

function comparableSessionPath(sessionPath: string): string {
  const slashNormalized = sessionPath.replace(/\\/g, "/");
  // Windows paths are case-insensitive. The host/webview and SDK can serialize
  // the same session path with different drive-letter casing and separators.
  return /^[a-z]:\//i.test(slashNormalized) ? slashNormalized.toLowerCase() : slashNormalized;
}

export function parseSessionProviderToggles(
  raw: string | undefined,
  sessionPath: string | undefined,
): Record<string, boolean> {
  if (!raw || !sessionPath) return {};
  try {
    const parsed = parseJsonOrThrow<unknown>(raw, "per-session subagent provider toggles");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const sessions = parsed as Record<string, unknown>;
    const sessionValue = sessions[sessionPath] ?? Object.entries(sessions).find(
      ([candidate]) => comparableSessionPath(candidate) === comparableSessionPath(sessionPath),
    )?.[1];
    if (!sessionValue || typeof sessionValue !== "object" || Array.isArray(sessionValue)) return {};
    const result: Record<string, boolean> = {};
    for (const [provider, enabled] of Object.entries(sessionValue)) {
      if (typeof enabled === "boolean") result[provider] = enabled;
    }
    return result;
  } catch {
    return {};
  }
}

export function resolveSubagentProviderToggles(
  defaults: Record<string, boolean>,
  sessionOverrides: Record<string, boolean>,
): Record<string, boolean> {
  return { ...defaults, ...sessionOverrides };
}

export function getDisabledProviders(
  providerToggles: Record<string, boolean>,
): Set<string> {
  return new Set(
    Object.entries(providerToggles)
      .filter(([, enabled]) => enabled === false)
      .map(([provider]) => provider),
  );
}

export function getAllowedModelIdsForProviders(
  models: ModelProviderRef[],
  disabledProviders: Set<string>,
): Set<string> | undefined {
  if (disabledProviders.size === 0) return undefined;

  const enabled = models.filter((model) => !disabledProviders.has(model.provider));
  return new Set(
    enabled.flatMap((model) => [model.id, qualifiedModelSpec(model.provider, model.id)]),
  );
}
