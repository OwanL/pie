import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  DEFAULT_SESSION_TITLES_SETTINGS,
  type SessionTitlesSettings,
} from '../../shared/protocol';
import { updateSettingsJsonObject } from '../../shared/settings-json-update';
import { isThinkingLevel } from '../../shared/thinking-level';
import { parseJsonOrThrow } from '../util/error-message';
import { resolveSettingsPath } from '../util/settings-path';

export { resolveSettingsPath } from '../util/settings-path';

export function sessionTitlesSettingsFileExists(): boolean {
  const settingsPath = resolveSettingsPath();
  return settingsPath ? existsSync(settingsPath) : false;
}

function cloneDefaultSessionTitlesSettings(): SessionTitlesSettings {
  return { ...DEFAULT_SESSION_TITLES_SETTINGS };
}

/**
 * Read the session-title settings from the on-disk settings.json.
 * Returns defaults when the file is missing or the sessionTitles key is absent.
 */
export async function readSessionTitlesSettings(): Promise<SessionTitlesSettings> {
  const settingsPath = resolveSettingsPath();
  if (!settingsPath) {
    return cloneDefaultSessionTitlesSettings();
  }

  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed = parseJsonOrThrow<Record<string, unknown>>(raw, `session-title settings (${settingsPath})`);
    const sessionTitles = parsed.sessionTitles as Record<string, unknown> | undefined;
    if (!sessionTitles || typeof sessionTitles !== 'object') {
      return cloneDefaultSessionTitlesSettings();
    }

    const enabled = typeof sessionTitles.enabled === 'boolean'
      ? sessionTitles.enabled
      : DEFAULT_SESSION_TITLES_SETTINGS.enabled;

    const provider = typeof sessionTitles.provider === 'string' && sessionTitles.provider.length > 0
      ? sessionTitles.provider
      : DEFAULT_SESSION_TITLES_SETTINGS.provider;

    const model = typeof sessionTitles.model === 'string' && sessionTitles.model.length > 0
      ? sessionTitles.model
      : DEFAULT_SESSION_TITLES_SETTINGS.model;
    const thinkingLevel = isThinkingLevel(sessionTitles.thinkingLevel)
      ? sessionTitles.thinkingLevel
      : DEFAULT_SESSION_TITLES_SETTINGS.thinkingLevel;
    const timeoutSec = typeof sessionTitles.timeoutSec === 'number'
      && Number.isInteger(sessionTitles.timeoutSec)
      && sessionTitles.timeoutSec >= 1
      && sessionTitles.timeoutSec <= 60
      ? sessionTitles.timeoutSec
      : DEFAULT_SESSION_TITLES_SETTINGS.timeoutSec;

    return { enabled, provider, model, thinkingLevel, timeoutSec };
  } catch {
    return cloneDefaultSessionTitlesSettings();
  }
}

/**
 * Write a partial session-titles settings update to settings.json.
 * Deep-merges into the existing `sessionTitles` key so other fields are
 * preserved.
 */
export async function writeSessionTitlesSettings(
  updates: Partial<SessionTitlesSettings>,
): Promise<SessionTitlesSettings> {
  const settingsPath = resolveSettingsPath();
  if (!settingsPath) {
    throw new Error('PI_CODING_AGENT_DIR is not set; cannot write session-title settings (set it to the pi config directory that contains settings.json).');
  }

  await updateSettingsJsonObject(settingsPath, (existing) => {
    const sessionTitles = (existing.sessionTitles && typeof existing.sessionTitles === 'object'
      ? { ...(existing.sessionTitles as Record<string, unknown>) }
      : {}) as Record<string, unknown>;

    if (updates.enabled !== undefined) {
      sessionTitles.enabled = updates.enabled;
    }

    if (updates.provider !== undefined) {
      sessionTitles.provider = updates.provider;
    }

    if (updates.model !== undefined) {
      sessionTitles.model = updates.model;
    }

    if (updates.thinkingLevel !== undefined) {
      sessionTitles.thinkingLevel = updates.thinkingLevel;
    }

    if (updates.timeoutSec !== undefined) {
      sessionTitles.timeoutSec = updates.timeoutSec;
    }

    return { ...existing, sessionTitles };
  });
  return await readSessionTitlesSettings();
}