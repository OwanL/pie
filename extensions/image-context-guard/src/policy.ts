/**
 * Provider-qualified image-policy loader.
 *
 * Reads the generated catalog (`models.json` in the agent dir) and builds a
 * `{provider}\0{id}` -> maxImagesPerRequest map for every image-capable model.
 * The upstream SDK `Model` type does not retain pie's `maxImagesPerRequest`
 * field, so the runtime image-context guard reads the policy from this
 * generated catalog rather than depending on incidental SDK passthrough (see
 * the extension README's policy-source contract).
 *
 * `overrideOnly` entries surface in models.json as `providers.<p>.modelOverrides`
 * (keyed by id, without their own `id` field); the loader folds their `input`
 * and `maxImagesPerRequest` into the same provider-qualified map so a duplicate
 * id under another provider is never confused with the override.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Conservative fail-safe used when an image-capable model is absent from the
 *  generated policy. The plan requires that such a model must never receive an
 *  unbounded image context; one is the safest non-zero maximum. */
export const FAIL_SAFE_MAX_IMAGES_PER_REQUEST = 1;

type CatalogModel = { id?: unknown; input?: unknown; maxImagesPerRequest?: unknown };
type CatalogProvider = { models?: CatalogModel[]; modelOverrides?: Record<string, CatalogModel> };
type Catalog = { providers?: Record<string, CatalogProvider> };

/** Stable provider-qualified key. Uses a NUL separator so provider/id pairs
 *  cannot collide with raw id strings. */
export function policyKey(provider: string, id: string): string {
  return `${provider}\0${id}`;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function acceptsImages(input: unknown): boolean {
  return Array.isArray(input) && input.includes('image');
}

/** Record one catalog model's image policy into the map (no-op for text-only). */
function recordPolicyEntry(map: Map<string, number>, provider: string, id: unknown, entry: CatalogModel): void {
  if (typeof id !== 'string' || id.length === 0) return;
  if (!acceptsImages(entry.input)) return;
  const max = entry.maxImagesPerRequest;
  // Prefer the configured maximum; ignore malformed values (the sync-models
  // validator rejects them at generation time, but be defensive at load).
  if (isPositiveInteger(max)) map.set(policyKey(provider, id), max);
}

/** Build the provider-qualified image-policy map from a parsed catalog. */
export function buildImagePolicy(catalog: Catalog): Map<string, number> {
  const map = new Map<string, number>();
  for (const [provider, config] of Object.entries(catalog.providers ?? {})) {
    for (const model of config.models ?? []) {
      recordPolicyEntry(map, provider, model.id, model);
    }
    for (const [id, override] of Object.entries(config.modelOverrides ?? {})) {
      recordPolicyEntry(map, provider, id, { ...override });
    }
  }
  return map;
}

interface CachedPolicy {
  catalogPath: string;
  mtimeMs: number;
  map: Map<string, number>;
}

let cache: CachedPolicy | undefined;

/** Parse models.json from the agent dir. Returns undefined on read/parse
 *  failure so callers fall through to the per-request fail-safe. */
export function parseCatalog(agentDir: string): Catalog | undefined {
  try {
    return JSON.parse(readFileSync(path.join(agentDir, 'models.json'), 'utf8')) as Catalog;
  } catch {
    return undefined;
  }
}

/** Load the image policy, caching by models.json mtime so mid-session Copilot
 *  catalog refreshes are picked up without a per-request file read overhead.
 *  The caller supplies the agent dir (the pi runtime resolves it via
 *  `getAgentDir()`); keeping the IO wiring out of this module makes the policy
 *  logic unit-testable without resolving the SDK package. */
export function loadImagePolicy(agentDir: string): Map<string, number> {
  const catalogPath = path.join(agentDir, 'models.json');
  let mtimeMs: number;
  try {
    mtimeMs = statSync(catalogPath).mtimeMs;
  } catch {
    cache = undefined;
    return new Map();
  }
  if (cache && cache.catalogPath === catalogPath && cache.mtimeMs === mtimeMs) return cache.map;
  const catalog = parseCatalog(agentDir);
  const map = catalog ? buildImagePolicy(catalog) : new Map<string, number>();
  cache = { catalogPath, mtimeMs, map };
  return map;
}

/** Drop the in-memory cache. Exposed for tests and forced reloads. */
export function invalidateImagePolicyCache(): void {
  cache = undefined;
}

export interface ResolvedImagePolicy {
  /** Effective per-request image maximum. Zero for text-only models. */
  maxImagesPerRequest: number;
  /** True when the maximum came from the generated catalog; false when the
   *  active image-capable model was absent from the policy and the conservative
   *  fail-safe of one was used. Always true for text-only models (zero is the
   *  correct configured value, not a fail-safe). */
  configured: boolean;
}

/** Resolve the effective image policy for the active provider-qualified model.
 *
 *  Image capability comes from the runtime model's `input` (authoritative,
 *  provider-qualified). The maximum comes from the generated catalog; an
 *  image-capable model absent from the policy gets the fail-safe of one plus a
 *  diagnostic. A text-only model gets zero. */
export function resolveImagePolicy(
  provider: string,
  id: string,
  modelInput: unknown,
  policy: Map<string, number>,
): ResolvedImagePolicy {
  if (!acceptsImages(modelInput)) return { maxImagesPerRequest: 0, configured: true };
  const configured = policy.get(policyKey(provider, id));
  if (isPositiveInteger(configured)) {
    return { maxImagesPerRequest: configured, configured: true };
  }
  return { maxImagesPerRequest: FAIL_SAFE_MAX_IMAGES_PER_REQUEST, configured: false };
}
