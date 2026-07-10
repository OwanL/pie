import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  type ToolResultPruningRuleToggles,
  type ToolResultPruningSettings,
} from '../../shared/protocol';
import { parseJsonOrThrow } from '../util/error-message';
import { resolveSettingsPath } from '../util/settings-path';

export { resolveSettingsPath } from '../util/settings-path';

export function toolResultPruningSettingsFileExists(): boolean {
  const settingsPath = resolveSettingsPath();
  return settingsPath ? existsSync(settingsPath) : false;
}

function cloneDefaultToolResultPruningSettings(): ToolResultPruningSettings {
  return {
    ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
    rules: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules },
  };
}

const VALID_PROFILES = new Set<ToolResultPruningSettings['profile']>(['default', 'security']);

function parseRuleToggles(value: unknown): ToolResultPruningRuleToggles {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules };
  }
  const v = value as Record<string, unknown>;
  return {
    ansi: typeof v.ansi === 'boolean' ? v.ansi : DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules.ansi,
    whitespace: typeof v.whitespace === 'boolean' ? v.whitespace : DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules.whitespace,
    blankRun: typeof v.blankRun === 'boolean' ? v.blankRun : DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules.blankRun,
    jsonMinify: typeof v.jsonMinify === 'boolean' ? v.jsonMinify : DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules.jsonMinify,
    lsLong: typeof v.lsLong === 'boolean' ? v.lsLong : DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules.lsLong,
    gitLog: typeof v.gitLog === 'boolean' ? v.gitLog : DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules.gitLog,
    grepGroup: typeof v.grepGroup === 'boolean' ? v.grepGroup : DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules.grepGroup,
  };
}

/** Coerce the `tools` allowlist: `null`/absent → null (all non-read tools);
 *  an array → only non-empty string entries kept (others dropped). */
function parseToolsAllowlist(value: unknown): string[] | null {
  if (value === undefined || value === null) return DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.tools;
  if (!Array.isArray(value)) return DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.tools;
  const tools: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) tools.push(entry);
  }
  return tools;
}

/**
 * Read the tool-result pruning settings from the on-disk settings.json.
 * Returns defaults when the file is missing or the toolResultPruning key is absent.
 */
export async function readToolResultPruningSettings(): Promise<ToolResultPruningSettings> {
  const settingsPath = resolveSettingsPath();
  if (!settingsPath) {
    return cloneDefaultToolResultPruningSettings();
  }

  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed = parseJsonOrThrow<Record<string, unknown>>(raw, `tool-result pruning settings (${settingsPath})`);
    const toolResultPruning = parsed.toolResultPruning as Record<string, unknown> | undefined;
    if (!toolResultPruning || typeof toolResultPruning !== 'object') {
      return cloneDefaultToolResultPruningSettings();
    }

    const enabled = typeof toolResultPruning.enabled === 'boolean'
      ? toolResultPruning.enabled
      : DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.enabled;

    const profile = typeof toolResultPruning.profile === 'string' && VALID_PROFILES.has(toolResultPruning.profile as ToolResultPruningSettings['profile'])
      ? (toolResultPruning.profile as ToolResultPruningSettings['profile'])
      : DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.profile;

    const rules = parseRuleToggles(toolResultPruning.rules);

    const tools = parseToolsAllowlist(toolResultPruning.tools);

    return { enabled, profile, rules, tools };
  } catch {
    return cloneDefaultToolResultPruningSettings();
  }
}

/**
 * Write a partial tool-result pruning settings update to settings.json.
 * Deep-merges into the existing `toolResultPruning` key so other fields
 * are preserved.
 */
export async function writeToolResultPruningSettings(
  updates: Partial<ToolResultPruningSettings>,
): Promise<ToolResultPruningSettings> {
  const settingsPath = resolveSettingsPath();
  if (!settingsPath) {
    throw new Error('PI_CODING_AGENT_DIR is not set; cannot write tool-result pruning settings (set it to the pi config directory that contains settings.json).');
  }

  let existing: Record<string, unknown> = {};
  try {
    existing = parseJsonOrThrow<Record<string, unknown>>(await fs.readFile(settingsPath, 'utf8'), settingsPath);
  } catch {
    // File may not exist yet — start fresh.
  }

  const toolResultPruning = (existing.toolResultPruning && typeof existing.toolResultPruning === 'object'
    ? { ...(existing.toolResultPruning as Record<string, unknown>) }
    : {}) as Record<string, unknown>;

  if (updates.enabled !== undefined) {
    toolResultPruning.enabled = updates.enabled;
  }

  if (updates.profile !== undefined) {
    toolResultPruning.profile = updates.profile;
  }

  if (updates.rules !== undefined) {
    const mergedRules = parseRuleToggles(toolResultPruning.rules);
    const incoming = parseRuleToggles(updates.rules);
    toolResultPruning.rules = {
      ansi: updates.rules.ansi !== undefined ? incoming.ansi : mergedRules.ansi,
      whitespace: updates.rules.whitespace !== undefined ? incoming.whitespace : mergedRules.whitespace,
      blankRun: updates.rules.blankRun !== undefined ? incoming.blankRun : mergedRules.blankRun,
      jsonMinify: updates.rules.jsonMinify !== undefined ? incoming.jsonMinify : mergedRules.jsonMinify,
      lsLong: updates.rules.lsLong !== undefined ? incoming.lsLong : mergedRules.lsLong,
      gitLog: updates.rules.gitLog !== undefined ? incoming.gitLog : mergedRules.gitLog,
      grepGroup: updates.rules.grepGroup !== undefined ? incoming.grepGroup : mergedRules.grepGroup,
    };
  }

  if (updates.tools !== undefined) {
    toolResultPruning.tools = parseToolsAllowlist(updates.tools);
  }

  existing.toolResultPruning = toolResultPruning;
  await fs.writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  return await readToolResultPruningSettings();
}
