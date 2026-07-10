import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { parseJsonOrThrow } from '../shared/error-message';

import type { ModelSubagentInfo } from '../shared/protocol';
import { estimateNormalizedCost, loadModelPricing } from './pricing';

/**
 * Raw profile shape as stored in `<agentDir>/model-profiles.{yaml,json}`.
 * The subagent extension owns the authoritative type; we only consume fields needed
 * for picker ordering, so this is intentionally minimal and tolerant.
 */
interface RawSubagentProfile {
  id?: unknown;
  precision?: unknown;
  creativity?: unknown;
  thoroughness?: unknown;
  reasoning?: unknown;
  eligible?: unknown;
  disabled_reason?: unknown;
}

interface CacheEntry {
  mtimeMs: number;
  pricingMtimeMs: number;
  map: Map<string, ModelSubagentInfo>;
}

const cache = new Map<string, CacheEntry>();

function toNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parseProfilesFromObject(raw: unknown): Map<string, ModelSubagentInfo> {
  const out = new Map<string, ModelSubagentInfo>();
  if (!raw || typeof raw !== 'object') return out;

  const cfg = raw as Record<string, unknown>;
  const profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
  for (const entry of profiles as RawSubagentProfile[]) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) continue;
    const aggregate =
      toNumber(entry.precision) +
      toNumber(entry.creativity) +
      toNumber(entry.thoroughness) +
      toNumber(entry.reasoning);
    const info: ModelSubagentInfo = {
      eligible: entry.eligible === true,
      aggregate,
    };
    if (typeof entry.disabled_reason === 'string' && entry.disabled_reason.length > 0) {
      info.disabledReason = entry.disabled_reason;
    }
    out.set(entry.id, info);
  }
  return out;
}

function parseFile(raw: string, ext: string): Map<string, ModelSubagentInfo> {
  if (ext === '.yaml' || ext === '.yml') {
    return parseProfilesFromObject(parseYaml(raw));
  }
  return parseProfilesFromObject(parseJsonOrThrow<unknown>(raw, 'subagent profiles'));
}

/** Resolve the profiles file, preferring YAML. */
function resolveProfilesPath(agentDir: string): { filePath: string; ext: string } | null {
  const yamlPath = path.join(agentDir, 'model-profiles.yaml');
  if (fs.existsSync(yamlPath)) return { filePath: yamlPath, ext: '.yaml' };
  const ymlPath = path.join(agentDir, 'model-profiles.yml');
  if (fs.existsSync(ymlPath)) return { filePath: ymlPath, ext: '.yml' };
  const jsonPath = path.join(agentDir, 'model-profiles.json');
  if (fs.existsSync(jsonPath)) return { filePath: jsonPath, ext: '.json' };
  return null;
}

/**
 * Load subagent profiles for the picker, keyed by model id. Returns an empty map
 * when the shared `<agentDir>/model-profiles.{yaml,json}` is missing or unreadable so the
 * picker still renders (and the subagent extension falls back to inheriting the
 * caller's model). Cached by mtime of both the profiles file and models.json to
 * avoid re-parsing on every `models.list` request.
 */
export function loadSubagentProfiles(agentDir: string): Map<string, ModelSubagentInfo> {
  if (!agentDir) return new Map();
  const resolved = resolveProfilesPath(agentDir);
  if (!resolved) {
    cache.clear();
    return new Map();
  }
  const { filePath, ext } = resolved;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    cache.delete(filePath);
    return new Map();
  }

  // Also track models.json mtime for cache invalidation when pricing changes.
  const pricingPath = path.join(agentDir, 'models.json');
  let pricingMtimeMs = 0;
  try {
    pricingMtimeMs = fs.statSync(pricingPath).mtimeMs;
  } catch {
    // models.json is optional — proceed without pricing
  }

  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.pricingMtimeMs === pricingMtimeMs) {
    return cached.map;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const map = parseFile(raw, ext);

    // Enrich with pricing data from models.json when available.
    const pricingRecords = loadModelPricing(pricingPath);
    if (pricingRecords.size > 0) {
      for (const [modelId, info] of map) {
        const records = pricingRecords.get(modelId);
        if (records && records.length > 0) {
          const priced = records.find((r) => r.pricing !== undefined);
          if (priced?.pricing) {
            info.normalizedCost = estimateNormalizedCost(priced.pricing);
            info.pricing = { ...priced.pricing };
          }
        }
      }
    }

    cache.set(filePath, { mtimeMs: stat.mtimeMs, pricingMtimeMs, map });
    return map;
  } catch {
    return new Map();
  }
}
