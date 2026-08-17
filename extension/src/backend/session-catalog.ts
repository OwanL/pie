import type { SessionSummary } from '../shared/protocol';
import type { SdkModule } from './sdk';
import { applySessionReviews, discoverSessionSummaries } from './session-metadata';
import { backendSessionPathKey, readBackendSessionInventorySignature } from './session-directory';

export interface SessionCatalogOptions {
  readInventorySignature?: typeof readBackendSessionInventorySignature;
}

export class SessionCatalog {
  /** SDK discovery reads every session file. Cache it until the cheap JSONL
   *  filename inventory changes; open runtimes provide fresh live metadata. */
  private basePromise?: Promise<SessionSummary[]>;
  /** null means the initial signature failed, so the next success must refresh. */
  private inventorySignature?: string | null;
  /** Forgotten paths remain excluded even if an older discovery was already
   * in flight or review-sidecar merging tries to synthesize a placeholder. */
  private readonly removedPathKeys = new Set<string>();
  private cacheGeneration = 0;
  private readonly readInventorySignature: typeof readBackendSessionInventorySignature;

  constructor(options: SessionCatalogOptions = {}) {
    this.readInventorySignature = options.readInventorySignature ?? readBackendSessionInventorySignature;
  }

  async list(
    sdk: SdkModule,
    sessionDir: string | undefined,
    liveSummaries: readonly SessionSummary[] = [],
    agentDir?: string,
  ): Promise<SessionSummary[]> {
    if (!this.basePromise) {
      const generation = this.cacheGeneration;
      const discovery = (async () => {
        let signature: string | null | undefined;
        if (agentDir) {
          try {
            signature = await this.readInventorySignature(agentDir, sessionDir);
          } catch {
            signature = null;
          }
        }
        const summaries = await discoverSessionSummaries(sdk, sessionDir);
        if (this.cacheGeneration === generation) this.inventorySignature = signature;
        return summaries;
      })().catch((error) => {
        if (this.basePromise === discovery) {
          this.basePromise = undefined;
          this.inventorySignature = undefined;
        }
        throw error;
      });
      this.basePromise = discovery;
    }

    const discovered = await this.basePromise;
    const byPath = new Map(discovered
      .filter((summary) => !this.removedPathKeys.has(backendSessionPathKey(summary.path)))
      .map((summary) => [backendSessionPathKey(summary.path), summary]));
    for (const summary of liveSummaries) {
      const key = backendSessionPathKey(summary.path);
      if (!this.removedPathKeys.has(key)) byPath.set(key, summary);
    }
    return applySessionReviews([...byPath.values()])
      .filter((summary) => !this.removedPathKeys.has(backendSessionPathKey(summary.path)))
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }

  /** Immediately and permanently exclude a forgotten path from this backend's
   * catalog, including cached/in-flight discovery and live/review overlays. */
  remove(sessionPath: string): void {
    this.removedPathKeys.add(backendSessionPathKey(sessionPath));
    this.invalidate();
  }

  async invalidateIfInventoryChanged(agentDir: string, sessionDir: string | undefined): Promise<boolean> {
    if (!this.basePromise || this.inventorySignature === undefined) return false;
    const signature = await this.readInventorySignature(agentDir, sessionDir);
    if (this.inventorySignature !== null && signature === this.inventorySignature) return false;
    this.invalidate();
    return true;
  }

  /** Explicit mutation invalidation for coordinator-owned cold commits whose
   * content may change without changing the filename inventory. */
  refresh(): void {
    this.invalidate();
  }

  private invalidate(): void {
    this.cacheGeneration += 1;
    this.basePromise = undefined;
    this.inventorySignature = undefined;
  }
}
