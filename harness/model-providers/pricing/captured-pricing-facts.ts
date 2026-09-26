/**
 * Captured pricing facts for settlement consumers.
 *
 * The provider pricing owner (this module) loads the active `models.json`
 * catalog plus the generated historical pricing catalog and hands the loaded
 * facts across the boundary; settlement accounting (analytics) prices from
 * the supplied facts and never resolves runtime catalogs itself
 * (plan 3.2: catalog/rate selection is provider-owned; analytics owns
 * settlement).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadModelPricing } from './pricing.js';
import type { ModelPricingRecord } from './pricing-core.js';

/** Loaded provider/model pricing facts plus the catalog identity they were
 *  captured from. `catalogVersion` is the sha256 of the active `models.json`
 *  content, matching the legacy settlement rate-snapshot provenance. */
export interface CapturedPricingFacts {
  readonly catalogVersion: string;
  readonly map: ReadonlyMap<string, ModelPricingRecord[]>;
}

export interface CapturedPricingFactsLoaderDeps {
  /** Resolve the catalog directory containing `models.json` and the generated
   *  historical pricing catalog. Returns null when unresolved. */
  getAgentDir: () => string | null;
}

/** Generated historical pricing catalog, relocated with the tracked analysis
 *  workspace (B6). Optional for portable/custom agent dirs. */
const HISTORICAL_PRICING_RELATIVE_PATH = path.join('analytics', 'analysis', 'model-pricing-history.json');

/** Stat-signature cached, synchronous loader for captured pricing facts. The
 *  signature covers the active catalog stat so repeated settlements do not
 *  re-read `models.json` per row while a rewritten catalog is picked up. */
export class CapturedPricingFactsLoader {
  private readonly deps: CapturedPricingFactsLoaderDeps;
  private cached?: { signature: string; facts: CapturedPricingFacts };

  constructor(deps: CapturedPricingFactsLoaderDeps) {
    this.deps = deps;
  }

  /** The captured facts for the current catalog, or undefined when the agent
   *  directory or active catalog is unavailable (consumers stay unpriced). */
  get(): CapturedPricingFacts | undefined {
    const agentDir = this.deps.getAgentDir();
    if (!agentDir) return undefined;
    const modelsPath = path.join(agentDir, 'models.json');
    let stat: fs.Stats;
    let raw: string;
    try {
      stat = fs.statSync(modelsPath);
      raw = fs.readFileSync(modelsPath, 'utf8');
    } catch {
      return undefined;
    }
    const signature = `${modelsPath}:${stat.mtimeMs}:${stat.size}`;
    if (this.cached?.signature === signature) return this.cached.facts;
    const facts: CapturedPricingFacts = {
      catalogVersion: `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`,
      map: loadModelPricing(modelsPath, path.join(agentDir, HISTORICAL_PRICING_RELATIVE_PATH)),
    };
    this.cached = { signature, facts };
    return facts;
  }
}