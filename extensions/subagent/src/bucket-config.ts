/**
 * Bucket configuration loading and parsing.
 *
 * Handles:
 * - YAML/JSON model-profile loading
 * - User-configured bucket assignment parsing (PIE_SUBAGENT_BUCKETS_JSON)
 * - Nested-bucket allowlist parsing (PIE_SUBAGENT_NESTED_ALLOWED_BUCKETS_JSON)
 * - Bucket downgrade logic for nested subagents
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseJsonOrThrow } from "../../../shared/error-message.js";

// --- Types ---

/** Pi reasoning levels. `off` is the explicit no-reasoning assignment. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Mirror Pi's exact model-level reasoning contract. Standard levels through
 * `high` are supported unless explicitly null; `xhigh`/`max` are opt-in, and
 * non-reasoning models support only `off`. */
export function getRuntimeThinkingSupport(model: {
  reasoning?: unknown;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}): ReadonlySet<ThinkingLevel> {
  if (model.reasoning !== true) return new Set(["off"]);
  const supported = new Set<ThinkingLevel>();
  for (const level of ["off", "minimal", "low", "medium", "high"] as const) {
    if (model.thinkingLevelMap?.[level] !== null) supported.add(level);
  }
  for (const level of ["xhigh", "max"] as const) {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped !== undefined && mapped !== null) supported.add(level);
  }
  return supported;
}

/** Simplified model config entry (from model-profiles.yaml). */
export interface SimpleModelConfig {
  provider?: string;
  id: string;
  eligible: boolean;
  thinking: ThinkingLevel[];
  disabled_reason: string | null;
}

/** A parsed bucket model spec. Qualified specs use canonical
 * `provider/id`; legacy specs contain only the bare model id. */
export interface ParsedModelSpec {
  provider?: string;
  id: string;
}

/** Parse a canonical provider-qualified spec while preserving legacy bare ids.
 * The first slash separates provider from id so model ids may themselves
 * contain slashes. Empty provider/id components are treated as a legacy id. */
export function parseModelSpec(spec: string): ParsedModelSpec {
  const separator = spec.indexOf("/");
  if (separator <= 0 || separator === spec.length - 1) return { id: spec };
  return { provider: spec.slice(0, separator), id: spec.slice(separator + 1) };
}

/** Return the bare id used for model-profile/thinking lookups. */
export function modelIdFromSpec(spec: string): string {
  return parseModelSpec(spec).id;
}

/** Canonical provider-qualified identity used by selection and retry routing. */
export function qualifiedModelSpec(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/** One explicit model/reasoning assignment in a bucket. `model` is normally
 * provider-qualified (`provider/id`), but a bare id remains useful for manual
 * configuration and is resolved against the enabled runtime registry. */
export interface BucketAssignment {
  model: string;
  thinkingLevel: ThinkingLevel;
}

/** Per-bucket explicit model/reasoning assignments. */
export interface BucketAssignments {
  small: BucketAssignment[];
  medium: BucketAssignment[];
  frontier: BucketAssignment[];
}

/** The three valid bucket keys, ordered from highest tier to lowest (for downgrade walks). */
const BUCKET_TIERS_DESC = ["frontier", "medium", "small"] as const;
/** A single bucket tier. */
export type BucketTier = (typeof BUCKET_TIERS_DESC)[number];

/** The three valid bucket keys, in display order (lowest → highest tier). */
const BUCKET_KEYS = ["small", "medium", "frontier"] as const;

/**
 * Per-bucket allowlist governing which tiers *nested* subagents (depth ≥ 1)
 * may use. Mirrored to the in-process subagent extension via
 * {@link NESTED_ALLOWED_BUCKETS_ENV}. When a nested subagent requests a bucket
 * that is not allowed, the selector downgrades to the highest allowed bucket at
 * or below the requested tier (and, if none are at/below, the cheapest allowed
 * bucket overall) so the cap is always respected. All-true (the default) leaves
 * behaviour unchanged.
 */
export interface NestedAllowedBuckets {
  small: boolean;
  medium: boolean;
  frontier: boolean;
}

/** All buckets allowed — the default before the user restricts nested tiers. */
export const ALL_NESTED_BUCKETS_ALLOWED: NestedAllowedBuckets = {
  small: true,
  medium: true,
  frontier: true,
};

/** Result of applying the nested-bucket allowlist to a requested tier. */
export interface NestedBucketResolution {
  /** The effective bucket to use, or `""` when no bucket is allowed at all
   *  (the caller should fall back to the parent's active model). */
  bucket: string;
  /** True when the returned bucket differs from the request (including the
   *  `""` exhaustion case). */
  downgraded: boolean;
}

// --- Constants ---

/** Environment key used by the pie host to mirror the user-configured subagent buckets. */
export const SUBAGENT_BUCKETS_ENV = "PIE_SUBAGENT_BUCKETS_JSON";

/** Environment key used by the pie host to mirror the nested-bucket allowlist
 *  (which tiers nested subagents may use) to the in-process subagent extension.
 *  Value is JSON {@link NestedAllowedBuckets}. */
export const NESTED_ALLOWED_BUCKETS_ENV = "PIE_SUBAGENT_NESTED_ALLOWED_BUCKETS_JSON";

// --- YAML loading ---

let _yamlParse: ((raw: string) => unknown) | null | undefined;
function getYamlParse(): ((raw: string) => unknown) | undefined {
  if (_yamlParse !== undefined) return _yamlParse ?? undefined;

  const baseRequire = createRequire(import.meta.url);
  const candidates = [baseRequire];
  try {
    candidates.push(
      createRequire(
        new URL("../../../extension/package.json", import.meta.url),
      ),
    );
  } catch {
    // extension package not available in this environment
  }
  try {
    candidates.push(
      createRequire(baseRequire.resolve("@mariozechner/pi-coding-agent/package.json")),
    );
  } catch {
    try {
      candidates.push(
        createRequire(baseRequire.resolve("@mariozechner/pi-coding-agent")),
      );
    } catch {
      // pi SDK not resolvable from this environment
    }
  }

  for (const req of candidates) {
    try {
      const yaml = req("yaml") as { parse: (raw: string) => unknown };
      _yamlParse = yaml.parse.bind(yaml);
      return _yamlParse;
    } catch {
      // try next candidate
    }
  }

  _yamlParse = null;
  return undefined;
}

// --- Config loading ---

/**
 * Load the simple model config from model-profiles.yaml.
 * Falls back to model-profiles.json for backward compatibility.
 */
export function loadModelConfig(configPath: string): SimpleModelConfig[] {
  const yamlPath = configPath.replace(/\.json$/, ".yaml");
  const parseYaml = getYamlParse();
  if (parseYaml && existsSync(yamlPath)) {
    const raw = readFileSync(yamlPath, "utf-8");
    const parsed = parseYaml(raw) as { profiles?: SimpleModelConfig[] };
    return parsed.profiles ?? [];
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseJsonOrThrow<{ profiles?: SimpleModelConfig[] }>(raw, "model profiles");
  return parsed.profiles ?? [];
}

// --- User-configured buckets (mirrored via PIE_SUBAGENT_BUCKETS_JSON) ---

/** Fresh empty buckets (new array references each call — `parseBucketConfig`
 *  mutates the arrays it returns, so never share a module-level constant). */
function emptyBuckets(): BucketAssignments {
  return { small: [], medium: [], frontier: [] };
}

/**
 * Parse the user-configured bucket JSON (from {@link SUBAGENT_BUCKETS_ENV}).
 *
 * Accepts `{ small: BucketAssignment[], medium: BucketAssignment[], frontier:
 * BucketAssignment[] }` — extra keys are ignored and missing keys default to
 * empty. Legacy string entries and malformed objects are deliberately dropped
 * so existing buckets require explicit reasoning reconfiguration. Duplicate
 * models within a bucket are de-duplicated (the first assignment wins).
 *
 * Returns empty assignments for undefined / malformed input so the caller
 * falls back to the active model. Never throws.
 */
export function parseBucketConfig(raw: string | undefined): BucketAssignments {
  if (!raw) return emptyBuckets();
  let parsed: unknown;
  try {
    parsed = parseJsonOrThrow<unknown>(raw, "subagent buckets");
  } catch {
    return emptyBuckets();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyBuckets();
  }

  const obj = parsed as Record<string, unknown>;
  const out: BucketAssignments = emptyBuckets();
  for (const key of BUCKET_KEYS) {
    const value = obj[key];
    if (!Array.isArray(value)) continue;
    const seen = new Set<string>();
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const { model, thinkingLevel } = entry as Record<string, unknown>;
      const normalizedModel = typeof model === "string" ? model.trim() : "";
      if (
        !normalizedModel
        || typeof thinkingLevel !== "string"
        || !(THINKING_LEVELS as readonly string[]).includes(thinkingLevel)
        || seen.has(normalizedModel)
      ) continue;
      seen.add(normalizedModel);
      out[key].push({ model: normalizedModel, thinkingLevel: thinkingLevel as ThinkingLevel });
    }
  }
  return out;
}

/**
 * Read + parse the user-configured buckets from the process environment.
 *
 * The pie host mirrors `ChatPrefs.subagentBuckets` into
 * `PIE_SUBAGENT_BUCKETS_JSON` via the `runtimePrefs.set` RPC on startup and on
 * every change. Returns empty assignments when the env var is unset (e.g. when
 * running under stock pi without the pie host), causing `selectModel` to fall
 * back to the caller's active model.
 */
export function readBucketAssignments(): BucketAssignments {
  return parseBucketConfig(process.env[SUBAGENT_BUCKETS_ENV]);
}

/**
 * Parse the nested-allowed-buckets JSON (from {@link NESTED_ALLOWED_BUCKETS_ENV}).
 *
 * Accepts `{ small, medium, frontier }` of booleans; missing keys default to
 * `true` (allowed) and non-boolean values are ignored (treated as allowed) so a
 * malformed mirror never silently blocks every nested tier. Never throws.
 */
export function parseNestedAllowedBuckets(raw: string | undefined): NestedAllowedBuckets {
  const out: NestedAllowedBuckets = { ...ALL_NESTED_BUCKETS_ALLOWED };
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = parseJsonOrThrow<unknown>(raw, "nested allowed buckets");
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  const obj = parsed as Record<string, unknown>;
  for (const key of BUCKET_KEYS) {
    const v = obj[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

/** Read + parse the nested-allowed-buckets config from the process environment. */
export function readNestedAllowedBuckets(): NestedAllowedBuckets {
  return parseNestedAllowedBuckets(process.env[NESTED_ALLOWED_BUCKETS_ENV]);
}

/**
 * Resolve the effective bucket for a nested subagent (depth ≥ 1) under the
 * nested-bucket allowlist.
 *
 * - If the requested bucket is allowed, it is returned unchanged (`downgraded: false`).
 * - Otherwise, walk DOWN from the requested tier and return the highest allowed
 *   bucket at or below it (e.g. frontier → medium → small). This matches the
 *   "highest available gets chosen" rule: of the allowed tiers at or below the
 *   request, the highest is used.
 * - If no bucket is allowed at or below the requested tier, return the cheapest
 *   allowed bucket overall (the lowest allowed tier) so the cap is still
 *   respected rather than falling back to an uncapped active model.
 * - If no bucket is allowed at all, returns `bucket: ""` to signal that the
 *   caller should fall back to the parent's active model.
 *
 * An unknown/invalid `requested` tier is treated as `"medium"`.
 */
export function downgradeBucketForNested(
  requested: string,
  allowed: NestedAllowedBuckets,
): NestedBucketResolution {
  const reqTier: BucketTier = (BUCKET_TIERS_DESC as readonly string[]).includes(requested)
    ? (requested as BucketTier)
    : "medium";
  if (allowed[reqTier]) return { bucket: reqTier, downgraded: false };

  const reqIdx = BUCKET_TIERS_DESC.indexOf(reqTier);

  // Downgrade: highest allowed tier at or below the request.
  for (let i = reqIdx; i < BUCKET_TIERS_DESC.length; i++) {
    const tier = BUCKET_TIERS_DESC[i];
    if (allowed[tier]) return { bucket: tier, downgraded: true };
  }

  // No allowed tier at/below: use the cheapest allowed tier above the request
  // (closest to the request = lowest index difference), so the cap is respected.
  for (let i = reqIdx - 1; i >= 0; i--) {
    const tier = BUCKET_TIERS_DESC[i];
    if (allowed[tier]) return { bucket: tier, downgraded: true };
  }

  // Nothing allowed at all → caller falls back to the active model.
  return { bucket: "", downgraded: true };
}
