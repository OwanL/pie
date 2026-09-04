import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';

import { loadModelPricing } from '../backend/pricing';
import type { ModelPricingRecord } from '../../../shared/pricing-core';
import { appendPieLog } from './util/pie-log';
import { toErrorMessage } from './util/error-message';

/** Loaded pricing catalog plus the stat signature that produced it. */
export interface PricingCatalog {
  signature: string;
  map: Map<string, ModelPricingRecord[]>;
}

/**
 * Owns the aggregate-strip pricing cache: active and historical pricing keyed
 * by their stat signatures so `models.json` / pricing-history mutations
 * invalidate the catalog without re-reading on every tick.
 */
export class AggregatePricingCache {
  private cachedCatalog: PricingCatalog | null = null;
  private readonly getAgentDir: () => string | null;

  constructor(deps: { getAgentDir: () => string | null }) {
    this.getAgentDir = deps.getAgentDir;
  }

  /** The last successfully loaded catalog, or null before the first load. */
  get cached(): PricingCatalog | null {
    return this.cachedCatalog;
  }

  /** Load + cache active and historical pricing by their stat signatures. */
  async load(): Promise<PricingCatalog> {
    const agentDir = this.getAgentDir();
    if (!agentDir) return this.cachePricing('unresolved', new Map());

    const modelsJsonPath = path.join(agentDir, 'models.json');
    const historicalPricingPath = path.join(agentDir, 'analysis', 'model-pricing-history.json');
    let signature: string;
    try {
      const stat = await fsAsync.stat(modelsJsonPath);
      signature = `${modelsJsonPath}:${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      appendPieLog('debug', 'aggregate-stats', 'models.json stat failed; no pricing available', {
        error: toErrorMessage(error),
      });
      return this.cachePricing(`missing:${modelsJsonPath}`, new Map());
    }
    try {
      const stat = await fsAsync.stat(historicalPricingPath);
      signature += `:${historicalPricingPath}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      // History is optional for portable/custom agent dirs. Keep its absence in
      // the signature so creating the generated file invalidates the cache.
      signature += `:missing:${historicalPricingPath}`;
    }
    if (this.cachedCatalog?.signature === signature) return this.cachedCatalog;
    return this.cachePricing(signature, loadModelPricing(modelsJsonPath, historicalPricingPath));
  }

  private cachePricing(signature: string, map: Map<string, ModelPricingRecord[]>): PricingCatalog {
    if (this.cachedCatalog?.signature === signature) return this.cachedCatalog;
    this.cachedCatalog = { signature, map };
    return this.cachedCatalog;
  }
}