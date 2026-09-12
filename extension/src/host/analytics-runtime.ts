import { createHash } from 'node:crypto';

import {
  ActivationManifestError,
  type ActivationManifest,
} from '../../../shared/analytics/activation.js';
import { canonicalAnalyticsDatabasePath } from '../analytics/query-entry.js';
import { AnalyticsRecorderSupervisor } from '../analytics/recorder-supervisor.js';
import { AnalyticsQueryClient } from '../analytics/query-client.js';
import { ActivationStore } from '../analytics/activation-store.js';

/** Explicit per-extension paths the runtime needs. Everything is derived, never
 * searched for: the whole point of the authority switch is that there is exactly
 * one canonical root. */
export interface AnalyticsRuntimeOptions {
  stateDir: string;
  analyticsDir: string;
  /** Packaged `analytics-recorder-worker.js` in the loaded runtime generation. */
  recorderWorkerScript: string;
  /** Packaged `analytics-query-worker.js` in the loaded runtime generation. */
  queryWorkerScript: string;
  buildId: string;
  workspaceId: string;
  /** Fresh per host process; distinct from workspaceId. */
  processGeneration: string;
  onError?: (error: unknown, stage: string) => void;
}

export interface AnalyticsRuntimeReadiness {
  authority: 'legacy' | 'canonical';
  manifestRevision: number | null;
  manifestSha256: string | null;
  generationId: string | null;
  /** Bounded schema/revision probe result; null under legacy authority. */
  recorderSchemaVersion: number | null;
  projectionRevision: string | null;
  recorderReady: boolean;
  queryReady: boolean;
}

/** Owns the canonical recorder and query helpers for the extension host.
 *
 * Deliberately dormant until a valid **active** manifest exists. Under legacy
 * authority this starts no helper at all, so the rework costs nothing while it
 * is unactivated and there is no accidental dual-write.
 *
 * Startup is a bounded readiness probe, not a claim: the recorder must reach
 * `spawned, ready, terminal` for a disposable query and expose the expected
 * schema and projection revision before capture is considered ready. Any
 * failure raises so the host can fail closed rather than capturing into an
 * authority it cannot read back. */
export class AnalyticsRuntime {
  private readonly store: ActivationStore;
  private recorder: AnalyticsRecorderSupervisor | undefined;
  private queryClient: AnalyticsQueryClient | undefined;
  private readiness: AnalyticsRuntimeReadiness | undefined;
  private stopped = false;

  constructor(private readonly options: AnalyticsRuntimeOptions) {
    this.store = new ActivationStore({ stateDir: options.stateDir });
  }

  /** Validated activation state, or null when no manifest exists. Throws on a
   * malformed manifest so a corrupt authority record cannot be ignored. */
  readActivation(): { manifest: ActivationManifest | null; sha256: string | null; authority: 'legacy' | 'canonical' } {
    const read = this.store.read();
    return { manifest: read.manifest, sha256: read.sha256, authority: read.authority };
  }

  get databasePath(): string {
    return canonicalAnalyticsDatabasePath(this.options.analyticsDir);
  }

  /** Bounded identity for the active generation. Derived from validated bytes so
   * a stale in-memory value cannot outlive an on-disk change. */
  activeDescriptor(): {
    generationId: string;
    buildId: string;
    manifestRevision: number;
    manifestSha256: string;
    workspaceId: string;
    hostInstanceId: string;
  } {
    const { manifest, sha256, authority } = this.readActivation();
    if (authority !== 'canonical' || !manifest?.activeGeneration || !sha256) {
      throw new ActivationManifestError('No active canonical analytics generation is recorded.');
    }
    return {
      generationId: manifest.activeGeneration.identity.generationId,
      buildId: manifest.activeGeneration.identity.buildId,
      manifestRevision: manifest.revision,
      manifestSha256: sha256,
      workspaceId: this.options.workspaceId,
      hostInstanceId: this.options.processGeneration,
    };
  }

  /** Start helpers only if canonical authority is active. Returns the readiness
   * snapshot; `recorderReady` is false under legacy authority by design. */
  async start(): Promise<AnalyticsRuntimeReadiness> {
    const { manifest, sha256, authority } = this.readActivation();
    if (authority !== 'canonical') {
      // No helper, no probe, no database creation. Legacy authority stays the
      // sole writer until an explicit activation happens.
      this.readiness = {
        authority,
        manifestRevision: manifest?.revision ?? null,
        manifestSha256: sha256,
        generationId: null,
        recorderSchemaVersion: null,
        projectionRevision: null,
        recorderReady: false,
        queryReady: false,
      };
      return this.readiness;
    }
    const descriptor = this.activeDescriptor();
    if (descriptor.buildId !== this.options.buildId) {
      // Running one build while the manifest names another is exactly the state
      // that makes "which code is loaded" unknowable; fail closed.
      throw new ActivationManifestError(
        `Active analytics generation build ${descriptor.buildId} does not match the loaded build ${this.options.buildId}.`,
      );
    }
    const recorder = new AnalyticsRecorderSupervisor({
      enabled: true,
      workerScript: this.options.recorderWorkerScript,
      databasePath: this.databasePath,
    });
    try {
      await recorder.start();
      this.recorder = recorder;
      const stats = await recorder.workerStats();
      if (!stats) throw new ActivationManifestError('Canonical recorder did not report worker stats.');
      const recorderSchemaVersion = Number(stats.recorder?.databaseSchemaVersion ?? Number.NaN);
      if (!Number.isSafeInteger(recorderSchemaVersion)) {
        throw new ActivationManifestError('Canonical recorder did not report a schema version.');
      }

      // A disposable query helper proves the read path independently of capture.
      const queryClient = new AnalyticsQueryClient({
        databasePath: this.databasePath,
        workerScript: this.options.queryWorkerScript,
        timeoutMs: 10_000,
      });
      const schema = await queryClient.query<{ databaseSchemaVersion: number }>({ type: 'schema' });
      const projection = await queryClient.query<{ rows: Array<{ revision?: unknown }> }>({
        type: 'query',
        sql: 'SELECT revision FROM analytics_projection_state WHERE singleton = 1',
      });
      this.queryClient = queryClient;
      const revisionValue = projection.rows[0]?.revision;
      const projectionRevision = revisionValue === undefined || revisionValue === null
        ? null
        : String(revisionValue);
      if (schema.databaseSchemaVersion !== recorderSchemaVersion) {
        throw new ActivationManifestError(
          `Canonical schema mismatch: recorder reports ${recorderSchemaVersion}, query reports ${schema.databaseSchemaVersion}.`,
        );
      }
      this.readiness = {
        authority,
        manifestRevision: manifest!.revision,
        manifestSha256: sha256,
        generationId: descriptor.generationId,
        recorderSchemaVersion,
        projectionRevision,
        recorderReady: true,
        queryReady: true,
      };
      return this.readiness;
    } catch (error) {
      // A failed activation must not leave a half-started helper behind.
      await this.stop();
      this.options.onError?.(error, 'canonical-startup');
      throw error;
    }
  }

  getReadiness(): AnalyticsRuntimeReadiness | undefined {
    return this.readiness;
  }

  /** The started recorder, usable as the capture's fact/detail/lifecycle sink.
   *
   * Exposed so the host can hand the canonical recorder to
   * `CanonicalAnalyticsCapture` after a successful activation. `undefined` under
   * legacy authority and before `start()`, so a host that wires this cannot
   * accidentally capture into a helper that was never started. The supervisor's
   * `submit`, `submitDetail`, `bindPendingCreate` and `deleteSession` already
   * match the sink interfaces, so no adapter is needed. */
  get sink(): AnalyticsRecorderSupervisor | undefined {
    return this.recorder;
  }

  /** The started query client, for canonical reads after activation. */
  get reads(): AnalyticsQueryClient | undefined {
    return this.queryClient;
  }

  /** Identity used for the backend's activation descriptor echo. Null under
   * legacy authority, where the backend carries no canonical descriptor. */
  backendDescriptorArguments(): string[] {
    if (this.readiness?.authority !== 'canonical') return [];
    const descriptor = this.activeDescriptor();
    return [
      `--analyticsGenerationId=${descriptor.generationId}`,
      `--analyticsBuildId=${descriptor.buildId}`,
      `--analyticsManifestRevision=${descriptor.manifestRevision}`,
      `--analyticsManifestSha256=${descriptor.manifestSha256}`,
      `--analyticsWorkspaceId=${descriptor.workspaceId}`,
      `--analyticsHostInstanceId=${descriptor.hostInstanceId}`,
    ];
  }

  /** Stop every helper. Terminal and idempotent: never restarts workers.
   * The query client is stateless — each request forks a disposable child that
   * terminates with its response — so only the recorder needs shutting down. */
  async stop(): Promise<void> {
    this.stopped = true;
    const recorder = this.recorder;
    this.recorder = undefined;
    this.queryClient = undefined;
    if (recorder) await recorder.shutdown().catch(() => { /* preserve caller error */ });
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}

/** Stable workspace identity helper shared by capture and the descriptor. */
export function analyticsWorkspaceId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

export { ActivationManifestError };
