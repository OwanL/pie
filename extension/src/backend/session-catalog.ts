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
      this.basePromise = (async () => {
        let signature: string | null | undefined;
        if (agentDir) {
          try {
            signature = await this.readInventorySignature(agentDir, sessionDir);
          } catch {
            signature = null;
          }
        }
        const summaries = await discoverSessionSummaries(sdk, sessionDir);
        this.inventorySignature = signature;
        return summaries;
      })().catch((error) => {
        this.basePromise = undefined;
        this.inventorySignature = undefined;
        throw error;
      });
    }

    const byPath = new Map((await this.basePromise).map((summary) => [backendSessionPathKey(summary.path), summary]));
    for (const summary of liveSummaries) byPath.set(backendSessionPathKey(summary.path), summary);
    return applySessionReviews([...byPath.values()])
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }

  async invalidateIfInventoryChanged(agentDir: string, sessionDir: string | undefined): Promise<boolean> {
    if (!this.basePromise || this.inventorySignature === undefined) return false;
    const signature = await this.readInventorySignature(agentDir, sessionDir);
    if (this.inventorySignature !== null && signature === this.inventorySignature) return false;
    this.basePromise = undefined;
    this.inventorySignature = undefined;
    return true;
  }
}
