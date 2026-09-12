import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  ANALYTICS_LOADED_GENERATION_SCHEMA_VERSION,
  ActivationManifestError,
  isAnalyticsRestartNonce,
  type ActivationManifest,
  type AnalyticsBackendDescriptor,
  type AnalyticsLoadedGenerationReceipt,
  validateAnalyticsLoadedGenerationReceipt,
} from '../../../shared/analytics/activation.js';
import {
  canonicalAnalyticsDatabasePath,
  type CanonicalAggregateRequest,
} from '../analytics/query-entry.js';
import { AnalyticsRecorderSupervisor } from '../analytics/recorder-supervisor.js';
import { AnalyticsQueryClient } from '../analytics/query-client.js';
import { ActivationStore, type ActivationReadResult } from '../analytics/activation-store.js';

/** Written by a host that completed canonical readiness, so post-restart
 * evidence can show which generation is loaded rather than only which one the
 * manifest records. */
export const LOADED_GENERATION_FILENAME = 'analytics-loaded-generation-v1.json';

export function writeLoadedGenerationReceiptAtomically(stateDir: string, payload: AnalyticsLoadedGenerationReceipt): void {
  const destination = path.join(stateDir, LOADED_GENERATION_FILENAME);
  const temporary = path.join(stateDir, `.${LOADED_GENERATION_FILENAME}.${process.pid}-${randomUUID()}.tmp`);
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  let descriptor: number | undefined;
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx' });
    descriptor = openSync(temporary, 'r+');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
    try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

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
  /** Activation bytes read while constructing the host. Startup must use this
   * same authority snapshot, and fail closed if it changes before helpers are
   * ready. */
  activationSnapshot?: Pick<ActivationReadResult, 'manifest' | 'sha256' | 'authority'>;
  /** Optional helper-issued restart correlation nonce for loaded evidence. */
  restartNonce?: string | null;
  /** Stable active IANA calendar zone for the canonical projection. It is
   * captured once per host and never selected from competing read requests. */
  timeZone?: string;
  onError?: (error: unknown, stage: string) => void;
}

export type AnalyticsRuntimeActivationSnapshot = Pick<
  ActivationReadResult,
  'manifest' | 'sha256' | 'authority'
>;

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
  /** Descriptor captured at canonical startup. A later manifest update must
   * fail the next backend spawn instead of silently changing this host's
   * worker authority mid-process. */
  private activationDescriptor: AnalyticsBackendDescriptor | undefined;
  private readonly timeZone: string;
  private preparedDailyProjectionKey: string | undefined;
  private preparingDailyProjection: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly options: AnalyticsRuntimeOptions) {
    this.store = new ActivationStore({ stateDir: options.stateDir });
    const configuredTimeZone = options.timeZone?.trim()
      || Intl.DateTimeFormat().resolvedOptions().timeZone
      || 'UTC';
    try {
      // Validate once at construction so a malformed machine/configuration
      // value cannot become a late read-path mutation or fallback.
      new Intl.DateTimeFormat('en-US', { timeZone: configuredTimeZone }).format(new Date(0));
    } catch {
      throw new ActivationManifestError(`Analytics timezone is not a valid IANA name: ${configuredTimeZone}`);
    }
    this.timeZone = configuredTimeZone;
    if (options.restartNonce !== undefined && options.restartNonce !== null
      && !isAnalyticsRestartNonce(options.restartNonce)) {
      throw new ActivationManifestError('Analytics restart correlation nonce has an invalid format or exceeds 128 bytes.');
    }
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
  activeDescriptor(): AnalyticsBackendDescriptor {
    if (this.activationDescriptor) return this.activationDescriptor;
    return this.descriptorFromActivation(this.readActivation());
  }

  /** The stable zone selected for this runtime instance. */
  get analyticsTimeZone(): string {
    return this.timeZone;
  }

  /** Prepare the writer-owned local-day window before a read. Requests for a
   * competing zone fail closed; this runtime never turns every UI read into a
   * last-writer-wins timezone rebuild. The window key excludes its moving
   * `now` endpoint, while callers provide the next local midnight endpoint. */
  async prepareProviderDailyProjection(request: CanonicalAggregateRequest): Promise<void> {
    if (this.stopped) throw new ActivationManifestError('Analytics runtime has stopped.');
    if (request.timeZone !== undefined && request.timeZone !== this.timeZone) {
      throw new ActivationManifestError(
        `Analytics aggregate timezone ${request.timeZone} does not match the configured runtime timezone ${this.timeZone}.`,
      );
    }
    const windowStartMs = request.dailyWindowStartMs ?? request.weekStartMs;
    const windowEndMs = request.dailyWindowEndMs ?? request.weekEndMs;
    if (!Number.isSafeInteger(windowStartMs) || !Number.isSafeInteger(windowEndMs)
      || windowStartMs >= windowEndMs) {
      throw new RangeError('Analytics daily projection window is invalid.');
    }
    const key = `${this.timeZone}\0${windowStartMs}\0${windowEndMs}`;
    for (;;) {
      if (this.preparedDailyProjectionKey === key) return;
      const pending = this.preparingDailyProjection;
      if (!pending) break;
      await pending;
    }
    const recorder = this.recorder;
    if (!recorder || this.readiness?.authority !== 'canonical') {
      throw new ActivationManifestError('Canonical recorder is not ready for daily projection preparation.');
    }
    const promise = (async () => {
      await recorder.prepareProviderDailyProjection(
        this.timeZone,
        windowStartMs,
        windowEndMs,
        false,
      );
      if (this.stopped) throw new ActivationManifestError('Analytics runtime stopped during daily projection preparation.');
      this.preparedDailyProjectionKey = key;
    })();
    this.preparingDailyProjection = promise;
    try {
      await promise;
    } finally {
      if (this.preparingDailyProjection === promise) this.preparingDailyProjection = undefined;
    }
  }

  private descriptorFromActivation(
    activation: AnalyticsRuntimeActivationSnapshot,
  ): AnalyticsBackendDescriptor {
    const { manifest, sha256, authority } = activation;
    if (authority !== 'canonical' || !manifest?.activeGeneration || !sha256) {
      throw new ActivationManifestError('No active canonical analytics generation is recorded.');
    }
    return Object.freeze({
      generationId: manifest.activeGeneration.identity.generationId,
      buildId: manifest.activeGeneration.identity.buildId,
      manifestRevision: manifest.revision,
      manifestSha256: sha256,
      workspaceId: this.options.workspaceId,
      hostInstanceId: this.options.processGeneration,
    });
  }

  private assertStartupActivationUnchanged(current: AnalyticsRuntimeActivationSnapshot): void {
    const expected = this.options.activationSnapshot;
    if (!expected) return;
    if (expected.authority !== current.authority
      || expected.sha256 !== current.sha256
      || (expected.manifest?.revision ?? null) !== (current.manifest?.revision ?? null)) {
      throw new ActivationManifestError(
        'Analytics activation changed during host startup; refusing to mix authority snapshots.',
      );
    }
  }

  /** Start helpers only if canonical authority is active. Returns the readiness
   * snapshot; `recorderReady` is false under legacy authority by design. */
  async start(): Promise<AnalyticsRuntimeReadiness> {
    const activation = this.readActivation();
    this.assertStartupActivationUnchanged(activation);
    const { manifest, sha256, authority } = activation;
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
    const descriptor = this.descriptorFromActivation(activation);
    if (descriptor.buildId !== this.options.buildId) {
      // Running one build while the manifest names another is exactly the state
      // that makes "which code is loaded" unknowable; fail closed.
      throw new ActivationManifestError(
        `Active analytics generation build ${descriptor.buildId} does not match the loaded build ${this.options.buildId}.`,
      );
    }
    this.activationDescriptor = descriptor;
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
      // The helper probe may have yielded while the activation writer replaced
      // the manifest. Never publish readiness for a descriptor that no longer
      // names the current authority snapshot.
      const currentActivation = this.readActivation();
      this.assertStartupActivationUnchanged(currentActivation);
      if (currentActivation.authority !== 'canonical'
        || currentActivation.sha256 !== descriptor.manifestSha256
        || currentActivation.manifest?.revision !== descriptor.manifestRevision
        || currentActivation.manifest.activeGeneration?.identity.generationId !== descriptor.generationId) {
        throw new ActivationManifestError(
          'Analytics activation changed while canonical helpers were starting; refusing readiness.',
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

  /** Record that this host process loaded and passed its readiness probe.
   *
   * The manifest says which generation *should* be running; this says which one
   * actually is. They are different claims, and the runbook requires the
   * post-restart evidence to distinguish them, so the loaded state is written to
   * a separate file rather than inferred from the manifest. Only written under
   * canonical authority, and only after the helpers reached readiness, so its
   * presence is itself evidence that the loaded build agreed with the manifest.
   *
   * A best-effort diagnostic: a failure to write it must not fail startup, since
   * capture readiness is the functional requirement and this file exists only to
   * make the load observable. */
  recordLoadedGeneration(): void {
    if (this.readiness?.authority !== 'canonical') return;
    try {
      const descriptor = this.activationDescriptor;
      if (!descriptor) return;
      const current = this.readActivation();
      if (current.authority !== 'canonical'
        || current.sha256 !== descriptor.manifestSha256
        || current.manifest?.revision !== descriptor.manifestRevision
        || current.manifest.activeGeneration?.identity.generationId !== descriptor.generationId) {
        this.options.onError?.(
          new ActivationManifestError('Analytics activation changed before loaded evidence could be recorded.'),
          'loaded-generation',
        );
        return;
      }
      const payload = validateAnalyticsLoadedGenerationReceipt({
        schemaVersion: ANALYTICS_LOADED_GENERATION_SCHEMA_VERSION,
        generationId: descriptor.generationId,
        buildId: descriptor.buildId,
        manifestRevision: descriptor.manifestRevision,
        manifestSha256: descriptor.manifestSha256,
        workspaceId: descriptor.workspaceId,
        hostInstanceId: descriptor.hostInstanceId,
        restartNonce: this.options.restartNonce ?? null,
        loadedAt: new Date().toISOString(),
      });
      mkdirSync(this.options.stateDir, { recursive: true });
      writeLoadedGenerationReceiptAtomically(this.options.stateDir, payload);
    } catch {
      // Diagnostic only. Never fail a working activation over this record.
    }
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

  /** The immutable descriptor a production backend must echo and validate.
   * It is available only after canonical readiness; legacy, candidate and
   * ready-only manifests cannot accidentally opt a child into capture. */
  backendDescriptor(): AnalyticsBackendDescriptor | undefined {
    if (this.readiness?.authority !== 'canonical') return undefined;
    return this.activationDescriptor;
  }

  /** Identity used for the backend's activation descriptor echo. Null under
   * legacy authority, where the backend carries no canonical descriptor. */
  backendDescriptorArguments(): string[] {
    const descriptor = this.backendDescriptor();
    if (!descriptor) return [];
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
    this.activationDescriptor = undefined;
    this.preparedDailyProjectionKey = undefined;
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
