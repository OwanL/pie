// Config loader for the tool-result-pruner extension.
//
// Reads the `toolResultPruning` block from settings.json (the pi agent dir is
// PI_CODING_AGENT_DIR = this repo root). Mirrors skill-pruner/config.ts's
// defensive parse style: malformed fields warn and fall back to defaults
// rather than throwing — a bad config never breaks the agent.
//
// The result is cached for the process lifetime: settings.json changes take
// effect on session restart (/reload re-runs the extension factory). The
// cache is resettable for tests.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseJsonOrThrow, toErrorMessage } from "../../shared/error-message.js";
import { DEFAULT_CONFIG, DEFAULT_RULE_TOGGLES, RULE_KEY_BY_NAME, VALID_PROFILES, type Profile, type ToolResultPruningConfig } from "./types.js";

/** Root of the pi-config repo, resolved from this extension's known position. */
const CONFIG_ROOT = path.resolve(import.meta.dirname, "..", "..");

const SETTINGS_PATH = path.join(CONFIG_ROOT, "settings.json");

let cached: ToolResultPruningConfig | null = null;
let cachedMtimeMs: number | null = null;
let overrideActive = false;

function warn(message: string): void {
  console.warn(`[tool-result-pruner] ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/** Deep-clone a config so the `rules` sub-object is never shared with
 *  `DEFAULT_CONFIG` or the cache. parseConfig mutates `config.rules[key]`,
 *  and loadConfig returns clones so callers can't mutate the cache — both
 *  require the nested `rules` object to be copied, not aliased. */
function cloneConfig(config: ToolResultPruningConfig): ToolResultPruningConfig {
  return { ...config, rules: { ...config.rules }, tools: config.tools ? [...config.tools] : null };
}

/** Parse the `toolResultPruning` block, validating each field. Unknown
 *  fields are ignored; invalid fields fall back to defaults with a warning. */
function parseConfig(raw: unknown): ToolResultPruningConfig {
  const config: ToolResultPruningConfig = cloneConfig(DEFAULT_CONFIG);
  if (!isRecord(raw)) {
    warn("settings.toolResultPruning must be an object; using defaults");
    return config;
  }

  if (typeof raw.enabled === "boolean") {
    config.enabled = raw.enabled;
  } else if (raw.enabled !== undefined) {
    warn(`invalid toolResultPruning.enabled '${String(raw.enabled)}'; using default '${DEFAULT_CONFIG.enabled}'`);
  }

  if (typeof raw.profile === "string" && VALID_PROFILES.has(raw.profile as Profile)) {
    config.profile = raw.profile as Profile;
  } else if (raw.profile !== undefined) {
    warn(`invalid toolResultPruning.profile '${String(raw.profile)}'; using default '${DEFAULT_CONFIG.profile}'`);
  }

  // Per-rule toggles. Each of the 4 booleans is parsed defensively; an invalid
  // value falls back to the default for that key with a warning. Unknown keys
  // are ignored. A missing/invalid `rules` object keeps all defaults.
  if (raw.rules === undefined) {
    // keep DEFAULT_CONFIG.rules
  } else if (isRecord(raw.rules)) {
    for (const key of Object.values(RULE_KEY_BY_NAME)) {
      const value = (raw.rules as Record<string, unknown>)[key];
      if (typeof value === "boolean") {
        config.rules[key] = value;
      } else if (value !== undefined) {
        warn(`invalid toolResultPruning.rules.${key} '${String(value)}'; using default '${DEFAULT_RULE_TOGGLES[key]}'`);
      }
    }
  } else {
    warn("settings.toolResultPruning.rules must be an object; using defaults");
  }

  // Allowlist of tool names pruning acts on. `null` (or absent) = all non-read
  // tools (default). An array (incl. empty) restricts to the listed tools.
  // Each entry must be a non-empty string; invalid entries are dropped.
  if (raw.tools === undefined || raw.tools === null) {
    // keep DEFAULT_CONFIG.tools (null)
  } else if (Array.isArray(raw.tools)) {
    const tools: string[] = [];
    for (const entry of raw.tools) {
      if (typeof entry === "string" && entry.length > 0) {
        tools.push(entry);
      } else {
        warn(`invalid toolResultPruning.tools entry '${String(entry)}'; dropped`);
      }
    }
    config.tools = tools;
  } else {
    warn("settings.toolResultPruning.tools must be an array of tool names or null; using default (all non-read tools)");
  }

  return config;
}

/** Load the config, with an mtime-based cache so repeated tool_result calls
 *  don't re-read settings.json from disk. Returns a clone so callers can't
 *  mutate the cache. */
export function loadConfig(settingsPath: string = SETTINGS_PATH): ToolResultPruningConfig {
  // Test override short-circuits before any disk access.
  if (overrideActive && cached) return cloneConfig(cached);

  let mtimeMs: number | null = null;
  try {
    if (existsSync(settingsPath)) mtimeMs = statSync(settingsPath).mtimeMs;
  } catch {
    mtimeMs = null;
  }

  if (cached && cachedMtimeMs !== null && mtimeMs === cachedMtimeMs) {
    return cloneConfig(cached);
  }

  if (mtimeMs === null) {
    // settings.json missing or unreadable: use defaults (cached).
    cached = cloneConfig(DEFAULT_CONFIG);
    cachedMtimeMs = null;
    return cloneConfig(cached);
  }

  let parsed: unknown;
  try {
    parsed = parseJsonOrThrow(readFileSync(settingsPath, "utf-8"), "tool-result-pruner settings");
  } catch (error) {
    warn(`failed to parse settings.json at ${settingsPath}; using defaults: ${toErrorMessage(error)}`);
    cached = cloneConfig(DEFAULT_CONFIG);
    cachedMtimeMs = mtimeMs;
    return cloneConfig(cached);
  }

  if (!isRecord(parsed) || !("toolResultPruning" in parsed)) {
    // No block present: defaults (this is the common path until the user opts in).
    cached = cloneConfig(DEFAULT_CONFIG);
    cachedMtimeMs = mtimeMs;
    return cloneConfig(cached);
  }

  cached = parseConfig(parsed.toolResultPruning);
  cachedMtimeMs = mtimeMs;
  return cloneConfig(cached);
}

/** Test seam: reset the cache so the next loadConfig() re-reads disk. */
export function resetConfigCache(): void {
  cached = null;
  cachedMtimeMs = null;
  overrideActive = false;
}

/** Test seam: inject a config without touching disk. Pass null to clear. */
export function setConfigOverrideForTesting(config: ToolResultPruningConfig | null): void {
  if (config) {
    cached = cloneConfig(config);
    overrideActive = true;
  } else {
    cached = null;
    overrideActive = false;
    cachedMtimeMs = null;
  }
}

/** Whether the extension has been turned off via the global toggle env var
 *  (PIE_EXTENSION_TOGGLES_JSON, keyed by extension id). Mirrors skill-pruner's
 *  isExtensionDisabledByToggle so the user can disable this extension without
 *  touching settings.json. */
export function isExtensionDisabledByToggle(extensionId = "tool-result-pruner"): boolean {
  const raw = process.env["PIE_EXTENSION_TOGGLES_JSON"];
  if (!raw) return false;
  try {
    const parsed = parseJsonOrThrow<Record<string, unknown>>(raw, "extension toggles");
    if (!parsed || typeof parsed !== "object") return false;
    return parsed[extensionId] === false;
  } catch {
    return false;
  }
}