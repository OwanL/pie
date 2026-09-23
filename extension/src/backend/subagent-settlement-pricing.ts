/**
 * Catalog pricing resolver for subagent provider settlements.
 *
 * Subagent provider settlements are captured by the child producer, which has
 * no pricing-catalog access. The backend worker owns the runtime catalog
 * (`models.json` plus the generated historical pricing catalog) and exposes a
 * resolver through the analytics runtime bridge so complete-channel settlements
 * can be catalog-priced with an oracle-v1 rate snapshot instead of remaining
 * unknown-cost.
 *
 * Semantics mirror the host billable-accounting pricing path
 * (`BillableAccounting#pricingFor`): provider-qualified catalog lookup with
 * provider-prefix tolerance, the shared applicability resolver (original
 * request timestamps for scheduled pricing; unsupported cache-read usage
 * stays unpriced), long-context tier selection by prompt footprint, and
 * explicit `undefined` when no qualified catalog rates exist. Missing
 * pricing stays unknown — never a fabricated zero or an inferred cost.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  loadModelPricing,
  type ModelPricingRecord,
} from './pricing';
import {
  pricingForPromptTokens,
  resolveApplicablePricing,
  type ModelTokenPricing,
  type PricingIntervalEvidence,
} from '../../../shared/pricing-core.js';
import {
  resolvePricingCatalogKey,
} from '../shared/model-id';
import type {
  SubagentSettlementPricingRequest,
  SubagentSettlementPricingResolver,
} from '../../../shared/analytics/transport.js';

interface PricingCatalogCache {
  signature: string;
  catalogVersion: string;
  map: Map<string, ModelPricingRecord[]>;
}

let cache: PricingCatalogCache | undefined;

/** Content identity over the active models.json and the (optional) generated
 *  history catalog, length-framed so the parts cannot collide across a split
 *  point. History participates because catalog rates are reproducible only
 *  with the exact history that produced them. */
function catalogIdentity(modelsRaw: string, historyRaw: string | undefined): string {
  const hash = crypto.createHash('sha256');
  hash.update(`${modelsRaw.length}:`).update(modelsRaw).update('|');
  hash.update(historyRaw === undefined ? 'missing' : `${historyRaw.length}:${historyRaw}`);
  return `sha256:${hash.digest('hex')}`;
}

function loadCatalog(agentDir: string): PricingCatalogCache | undefined {
  const modelsPath = path.join(agentDir, 'models.json');
  const historyPath = path.join(agentDir, 'analysis', 'model-pricing-history.json');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(modelsPath);
  } catch {
    return undefined;
  }
  // The history file feeds loadModelPricing, so it must participate in the
  // cache signature exactly like the active catalog (its absence stays part of
  // the signature so creating the generated file invalidates the cache).
  let historySignature = `:missing:${historyPath}`;
  let historyRaw: string | undefined;
  try {
    const historyStat = fs.statSync(historyPath);
    historySignature = `:${historyPath}:${historyStat.mtimeMs}:${historyStat.size}`;
    historyRaw = fs.readFileSync(historyPath, 'utf8');
  } catch {
    // History is optional for portable/custom agent dirs.
  }
  const signature = `${modelsPath}:${stat.mtimeMs}:${stat.size}${historySignature}`;
  if (cache?.signature === signature) return cache;
  let raw: string;
  try {
    raw = fs.readFileSync(modelsPath, 'utf8');
  } catch {
    return undefined;
  }
  cache = {
    signature,
    catalogVersion: catalogIdentity(raw, historyRaw),
    map: loadModelPricing(modelsPath, historyPath),
  };
  return cache;
}

/** Evidence interval for applicability resolution, only when both endpoints
 *  are real observed epoch-millisecond timestamps. Invalid, negative, or
 *  reversed endpoints are never repaired into synthetic evidence. */
function settlementInterval(
  startedAtMs: unknown,
  endedAtMs: unknown,
): PricingIntervalEvidence | undefined {
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs) || startedAtMs < 0) {
    return undefined;
  }
  if (typeof endedAtMs !== 'number' || !Number.isFinite(endedAtMs) || endedAtMs < 0) {
    return undefined;
  }
  return { startedAtMs, endedAtMs };
}

/** Resolve the catalog rates that apply to one settled subagent provider
 *  invocation. Returns `undefined` when the model is not catalog-qualified —
 *  the settlement then stays explicitly unpriced. */
export function subagentSettlementPricingResolver(agentDir: string): SubagentSettlementPricingResolver {
  return (request: SubagentSettlementPricingRequest) => {
    if (!request.model) return undefined;
    const catalog = loadCatalog(agentDir);
    if (!catalog) return undefined;
    const key = resolvePricingCatalogKey(request.model, (candidate) => catalog.map.has(candidate));
    const records = key ? catalog.map.get(key) : undefined;
    if (!records) return undefined;
    // Host parity: a matching provider wins; a unique record is unambiguous
    // only when the provider dimension is absent. An explicitly named provider
    // without a matching record stays unknown — never another provider's rate.
    const pricing = request.provider
      ? records.find((record) => record.provider === request.provider)?.pricing
      : records.length === 1 ? records[0]?.pricing : undefined;
    if (!pricing) return undefined;
    // Shared eligibility resolution with the original observed timestamps:
    // scheduled (peak-window) pricing requires valid interval evidence that
    // lies entirely within one band, and unsupported cache-read usage stays
    // unpriced. Missing/band-crossing evidence keeps the settlement unknown.
    const band = resolveApplicablePricing(pricing, {
      interval: settlementInterval(request.startedAtMs, request.endedAtMs),
      cacheReadTokens: request.usage.cacheRead,
    });
    if (!band) return undefined;
    const effective: ModelTokenPricing = pricingForPromptTokens(
      band,
      request.usage.input,
      request.usage.cacheRead,
      request.usage.cacheWrite,
    );
    return {
      inputUsdPerMillionTokens: effective.input,
      outputUsdPerMillionTokens: effective.output,
      cacheReadUsdPerMillionTokens: effective.cacheRead,
      cacheWriteUsdPerMillionTokens: effective.cacheWrite,
      catalogVersion: catalog.catalogVersion,
    };
  };
}