import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { DEFAULT_PRUNING_SETTINGS, type PruningMode, type PruningSettings, type ThinkingLevel } from '../../shared/protocol';
import { THINKING_LEVEL_SET } from '../../shared/thinking-level.js';
import { parseJsonOrThrow } from '../util/error-message';
import { resolveSettingsPath } from '../util/settings-path';

export { resolveSettingsPath };

export function pruningSettingsFileExists(): boolean {
  const settingsPath = resolveSettingsPath();
  return settingsPath ? existsSync(settingsPath) : false;
}

const VALID_MODES = new Set<PruningMode>(['auto', 'shadow', 'off']);

function cloneDefaultPruningSettings(): PruningSettings {
  return {
    ...DEFAULT_PRUNING_SETTINGS,
    skillAlwaysKeep: [...DEFAULT_PRUNING_SETTINGS.skillAlwaysKeep],
    toolAlwaysKeep: [...DEFAULT_PRUNING_SETTINGS.toolAlwaysKeep],
  };
}

function parseStringArrayOrDefault(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return [...value];
  }
  return [...fallback];
}

/**
 * Read the pruning settings from the on-disk settings.json.
 * Returns defaults when the file is missing or the pruning key is absent.
 */
export async function readPruningSettings(): Promise<PruningSettings> {
  const settingsPath = resolveSettingsPath();
  if (!settingsPath) {
    return cloneDefaultPruningSettings();
  }

  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed = parseJsonOrThrow<Record<string, unknown>>(raw, `pruning settings (${settingsPath})`);
    const pruning = parsed.pruning as Record<string, unknown> | undefined;
    if (!pruning || typeof pruning !== 'object') {
      return cloneDefaultPruningSettings();
    }

    const mode = typeof pruning.mode === 'string' && VALID_MODES.has(pruning.mode as PruningMode)
      ? (pruning.mode as PruningMode)
      : DEFAULT_PRUNING_SETTINGS.mode;

    const skills = pruning.skills as Record<string, unknown> | undefined;
    const tools = pruning.tools as Record<string, unknown> | undefined;

    const skillCeiling = typeof skills?.ceiling === 'number' && skills.ceiling >= 1
      ? skills.ceiling
      : DEFAULT_PRUNING_SETTINGS.skillCeiling;

    const toolCeiling = typeof tools?.ceiling === 'number' && tools.ceiling >= 1
      ? tools.ceiling
      : DEFAULT_PRUNING_SETTINGS.toolCeiling;

    const skillAlwaysKeep = parseStringArrayOrDefault(
      skills?.alwaysKeep,
      DEFAULT_PRUNING_SETTINGS.skillAlwaysKeep,
    );

    const toolAlwaysKeep = parseStringArrayOrDefault(
      tools?.alwaysKeep,
      DEFAULT_PRUNING_SETTINGS.toolAlwaysKeep,
    );

    const model = typeof pruning.model === 'string' && pruning.model.length > 0
      ? pruning.model
      : DEFAULT_PRUNING_SETTINGS.model;

    const provider = typeof pruning.provider === 'string' && pruning.provider.length > 0
      ? pruning.provider
      : DEFAULT_PRUNING_SETTINGS.provider;

    const thinkingLevel = typeof pruning.thinkingLevel === 'string' && THINKING_LEVEL_SET.has(pruning.thinkingLevel as ThinkingLevel)
      ? (pruning.thinkingLevel as ThinkingLevel)
      : DEFAULT_PRUNING_SETTINGS.thinkingLevel;

    const prepassTimeoutSec = typeof pruning.prepassTimeoutSec === 'number' && Number.isFinite(pruning.prepassTimeoutSec) && pruning.prepassTimeoutSec > 0
      ? pruning.prepassTimeoutSec
      : DEFAULT_PRUNING_SETTINGS.prepassTimeoutSec;

    // Brief F #4: auto-skip threshold for small/trivial turns. Persisted so
    // the SDK skill-pruner can consume it (cross-repo follow-up). A positive
    // number enables it; anything else is treated as disabled (null).
    const rawAutoSkip = pruning.autoSkipBelowTokens;
    const autoSkipBelowTokens =
      typeof rawAutoSkip === 'number' && Number.isFinite(rawAutoSkip) && rawAutoSkip > 0
        ? rawAutoSkip
        : null;

    return { mode, skillCeiling, toolCeiling, skillAlwaysKeep, toolAlwaysKeep, model, provider, thinkingLevel, prepassTimeoutSec, autoSkipBelowTokens };
  } catch {
    return cloneDefaultPruningSettings();
  }
}

/**
 * Write a partial pruning settings update to settings.json.
 * Deep-merges into the existing `pruning` key so other fields
 * (pinned skills, tiers, dependencies, etc.) are preserved.
 */
export async function writePruningSettings(
  updates: Partial<PruningSettings>,
): Promise<PruningSettings> {
  const settingsPath = resolveSettingsPath();
  if (!settingsPath) {
    throw new Error('PI_CODING_AGENT_DIR is not set; cannot write pruning settings (set it to the pi config directory that contains settings.json).');
  }

  let existing: Record<string, unknown> = {};
  try {
    existing = parseJsonOrThrow<Record<string, unknown>>(await fs.readFile(settingsPath, 'utf8'), settingsPath);
  } catch {
    // File may not exist yet — start fresh.
  }

  const pruning = (existing.pruning && typeof existing.pruning === 'object'
    ? { ...(existing.pruning as Record<string, unknown>) }
    : {}) as Record<string, unknown>;

  if (updates.mode !== undefined) {
    pruning.mode = updates.mode;
  }

  if (updates.skillCeiling !== undefined) {
    const skills = (pruning.skills && typeof pruning.skills === 'object'
      ? { ...(pruning.skills as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    skills.ceiling = updates.skillCeiling;
    pruning.skills = skills;
  }

  if (updates.toolCeiling !== undefined) {
    const tools = (pruning.tools && typeof pruning.tools === 'object'
      ? { ...(pruning.tools as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    tools.ceiling = updates.toolCeiling;
    pruning.tools = tools;
  }

  if (updates.skillAlwaysKeep !== undefined) {
    const skills = (pruning.skills && typeof pruning.skills === 'object'
      ? { ...(pruning.skills as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    skills.alwaysKeep = [...updates.skillAlwaysKeep];
    pruning.skills = skills;
  }

  if (updates.toolAlwaysKeep !== undefined) {
    const tools = (pruning.tools && typeof pruning.tools === 'object'
      ? { ...(pruning.tools as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    tools.alwaysKeep = [...updates.toolAlwaysKeep];
    pruning.tools = tools;
  }

  if (updates.model !== undefined) {
    pruning.model = updates.model;
  }

  if (updates.provider !== undefined) {
    pruning.provider = updates.provider;
  }

  if (updates.thinkingLevel !== undefined) {
    pruning.thinkingLevel = updates.thinkingLevel;
  }

  if (updates.prepassTimeoutSec !== undefined) {
    pruning.prepassTimeoutSec = updates.prepassTimeoutSec;
  }

  if (updates.autoSkipBelowTokens !== undefined) {
    pruning.autoSkipBelowTokens = updates.autoSkipBelowTokens;
  }

  existing.pruning = pruning;
  await fs.writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  return await readPruningSettings();
}
