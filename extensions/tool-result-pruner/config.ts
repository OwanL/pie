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
import { DEFAULT_CONFIG, VALID_PROFILES, type Profile, type ToolResultPruningConfig } from "./types.js";

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

/** Parse the `toolResultPruning` block, validating each field. Unknown
 *  fields are ignored; invalid fields fall back to defaults with a warning. */
function parseConfig(raw: unknown): ToolResultPruningConfig {
  const config: ToolResultPruningConfig = { ...DEFAULT_CONFIG };
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

  return config;
}

/** Load the config, with an mtime-based cache so repeated tool_result calls
 *  don't re-read settings.json from disk. Returns a clone so callers can't
 *  mutate the cache. */
export function loadConfig(settingsPath: string = SETTINGS_PATH): ToolResultPruningConfig {
  // Test override short-circuits before any disk access.
  if (overrideActive && cached) return { ...cached };

  let mtimeMs: number | null = null;
  try {
    if (existsSync(settingsPath)) mtimeMs = statSync(settingsPath).mtimeMs;
  } catch {
    mtimeMs = null;
  }

  if (cached && cachedMtimeMs !== null && mtimeMs === cachedMtimeMs) {
    return { ...cached };
  }

  if (mtimeMs === null) {
    // settings.json missing or unreadable: use defaults (cached).
    cached = { ...DEFAULT_CONFIG };
    cachedMtimeMs = null;
    return { ...cached };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonOrThrow(readFileSync(settingsPath, "utf-8"), "tool-result-pruner settings");
  } catch (error) {
    warn(`failed to parse settings.json at ${settingsPath}; using defaults: ${toErrorMessage(error)}`);
    cached = { ...DEFAULT_CONFIG };
    cachedMtimeMs = mtimeMs;
    return { ...cached };
  }

  if (!isRecord(parsed) || !("toolResultPruning" in parsed)) {
    // No block present: defaults (this is the common path until the user opts in).
    cached = { ...DEFAULT_CONFIG };
    cachedMtimeMs = mtimeMs;
    return { ...cached };
  }

  cached = parseConfig(parsed.toolResultPruning);
  cachedMtimeMs = mtimeMs;
  return { ...cached };
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
    cached = { ...config };
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