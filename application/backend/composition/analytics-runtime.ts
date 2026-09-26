import {
  ActivationManifestError,
  type AnalyticsBackendDescriptor,
} from '../../../analytics/authority/activation.js';
import {
  AnalyticsRuntimeAuthority,
  type AnalyticsRuntimeActivationSnapshot,
} from '../../../analytics/authority/analytics-runtime.js';
import {
  canonicalAnalyticsDatabasePath,
  type CanonicalAggregateRequest,
} from '../../../analytics/queries/query-entry.js';
import {
  AnalyticsRecorderSupervisor,
  type AnalyticsRecorderWriterAdmission,
} from '../../../analytics/recording/recorder-supervisor.js';
import { AnalyticsQueryClient } from '../../../analytics/queries/query-client.js';

/** Explicit per-extension paths the runtime needs. Everything is derived, never
 * searched for: the whole point of the authority switch is that there is exactly
 * one canonical root. */
function validateAnalyticsTimeZone(configuredTimeZone: string): string {
  try {
    // The Intl formatter is the production IANA authority, including aliases
    // accepted by the runtime's calendar implementation.
    new Intl.DateTimeFormat('en-US', { timeZone: configuredTimeZone }).format(new Date(0));
  } catch {
    throw new ActivationManifestError(`Analytics timezone is not a valid IANA name: ${configuredTimeZone}`);
  }
  return configuredTimeZone;
}

export interface AnalyticsRuntimeOptions {
  stateDir: string;
  analyticsDir: string;
  /** Packaged `analytics-recorder-worker.js` in the loaded runtime generation. */
  recorderWorkerScript: string;
  /** Packaged `analytics-query-worker.js` in the loaded runtime generation. */
  queryWorkerScript: string;
  /** Identity compiled into the bundle that is actually loaded (`PIE_BUILD_ID`).
   * This is the *candidate marker* space: producer identity, lifecycle registry
   * rows and authenticated host status all carry it. */
  buildId: string;
  /** Identity the activation manifest commits, i.e. the qualification's
   * coordinated build id. Admission binds the plan's `buildId` to the
   * qualification report and to the candidate trial, and the restart owner
   * validates loaded/terminal evidence against it, so when a source-equivalence
   * receipt is bound it legitimately differs from the loaded marker above. The
   * manifest is the authority this runtime is comparing against, so when the two
   * spaces are distinguished the comparison below is made in the manifest's
   * space; omitting it preserves the strict marker-equals-manifest check used by
   * single-space callers. */
  manifestBuildId?: string;
  workspaceId: string;
  /** Fresh per host process; distinct from workspaceId. */
  processGeneration: string;
  /** Activation bytes read while constructing the host. Startup must use this
   * same authority snapshot, and fail closed if it changes before helpers are
   * ready. */
  activationSnapshot?: AnalyticsRuntimeActivationSnapshot;
  /** Optional helper-issued restart correlation nonce for loaded evidence. */
  restartNonce?: string | null;
  /** Exact helper-issued destination for terminal restart evidence. It is
   * required whenever restartNonce is present. */
  terminalRestartReceiptPath?: string;
  /** Optional host-scoped destination for controlled-restart loaded evidence.
   * Ordinary boots retain the canonical shared diagnostic filename. */
  loadedGenerationPath?: string;
  /** Stable active IANA calendar zone for the canonical projection. It is
   * captured once per host and never selected from competing read requests. */
  timeZone?: string;
  /** Durable lifecycle admission for recorder persistence. */
  writerAdmission?: AnalyticsRecorderWriterAdmission;
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

/** Narrow host seam implemented by the canonical runtime. */
export interface AnalyticsRuntimePort {
  readonly analyticsTimeZone: string;
  start(): Promise<AnalyticsRuntimeReadiness>;
  recordLoadedGeneration(): void;
  backendDescriptor(): AnalyticsBackendDescriptor | undefined;
  /** Revoke producer admission and drain already accepted recorder writes. */
  fenceWriters(timeoutMs?: number): Promise<number>;
  /** Record terminal restart evidence only after the complete host readiness
   * sequence has succeeded. */
  recordTerminalRestartReceipt(): void;
  stop(): Promise<void>;
}

interface AnalyticsHelperStartup {
  recorder: AnalyticsRecorderSupervisor;
  queryClient: AnalyticsQueryClient;
  recorderSchemaVersion: number;
  projectionRevision: string | null;
}

/** Shared real-helper startup probe: the single production recorder/query
 * startup sequence, used by the canonical runtime. Starts the same
 * production helpers and proves the read path independently; a failure leaves
 * no half-started recorder behind. */
async function startAnalyticsHelpers(options: {
  label: string;
  recorderWorkerScript: string;
  queryWorkerScript: string;
  databasePath: string;
  writerAdmission?: AnalyticsRecorderWriterAdmission;
}): Promise<AnalyticsHelperStartup> {
  const recorder = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript: options.recorderWorkerScript,
    databasePath: options.databasePath,
    writerAdmission: options.writerAdmission,
  });
  try {
    await recorder.start();
    const stats = await recorder.workerStats();
    if (!stats) throw new ActivationManifestError(`${options.label} recorder did not report worker stats.`);
    const recorderSchemaVersion = Number(stats.recorder?.databaseSchemaVersion ?? Number.NaN);
    if (!Number.isSafeInteger(recorderSchemaVersion)) {
      throw new ActivationManifestError(`${options.label} recorder did not report a schema version.`);
    }

    // A disposable query helper proves the read path independently of capture.
    const queryClient = new AnalyticsQueryClient({
      databasePath: options.databasePath,
      workerScript: options.queryWorkerScript,
      timeoutMs: 10_000,
    });
    const schema = await queryClient.query<{ databaseSchemaVersion: number }>({ type: 'schema' });
    const projection = await queryClient.query<{ rows: Array<{ revision?: unknown }> }>({
      type: 'query',
      sql: 'SELECT revision FROM analytics_projection_state WHERE singleton = 1',
    });
    const revisionValue = projection.rows[0]?.revision;
    const projectionRevision = revisionValue === undefined || revisionValue === null
      ? null
      : String(revisionValue);
    if (schema.databaseSchemaVersion !== recorderSchemaVersion) {
      throw new ActivationManifestError(
        `${options.label} schema mismatch: recorder reports ${recorderSchemaVersion}, query reports ${schema.databaseSchemaVersion}.`,
      );
    }
    return { recorder, queryClient, recorderSchemaVersion, projectionRevision };
  } catch (error) {
    // Never leave a half-started recorder behind on a failed probe.
    await recorder.shutdown().catch(() => { /* preserve the original failure */ });
    throw error;
  }
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
export class AnalyticsRuntime implements AnalyticsRuntimePort {
  private readonly authority: AnalyticsRuntimeAuthority;
  private recorder: AnalyticsRecorderSupervisor | undefined;
  private queryClient: AnalyticsQueryClient | undefined;
  private readiness: AnalyticsRuntimeReadiness | undefined;
  private readonly timeZone: string;
  private preparedDailyProjectionKey: string | undefined;
  private preparingDailyProjection: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly options: AnalyticsRuntimeOptions) {
    this.authority = new AnalyticsRuntimeAuthority(options);
    const configuredTimeZone = options.timeZone?.trim()
      || Intl.DateTimeFormat().resolvedOptions().timeZone
      || 'UTC';
    // Validate once at construction so a malformed machine/configuration
    // value cannot become a late read-path mutation or fallback.
    this.timeZone = validateAnalyticsTimeZone(configuredTimeZone);
  }

  /** Validated activation state, or null when no manifest exists. Throws on a
   * malformed manifest so a corrupt authority record cannot be ignored. */
  readActivation(): AnalyticsRuntimeActivationSnapshot {
    return this.authority.readActivation();
  }

  get databasePath(): string {
    return canonicalAnalyticsDatabasePath(this.options.analyticsDir);
  }

  /** Bounded identity for the active generation. Derived from validated bytes so
   * a stale in-memory value cannot outlive an on-disk change. */
  activeDescriptor(): AnalyticsBackendDescriptor {
    return this.authority.activeDescriptor();
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

  /** Start helpers only if canonical authority is active. Returns the readiness
   * snapshot; `recorderReady` is false under legacy authority by design. */
  async start(): Promise<AnalyticsRuntimeReadiness> {
    const activation = this.readActivation();
    this.authority.assertStartupActivationUnchanged(activation);
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
    const descriptor = this.authority.descriptorFromActivation(activation);
    // The activation manifest carries the qualification's coordinated build id,
    // while this bundle's compiled marker (`buildId`) is the candidate space that
    // lifecycle rows and authenticated status identities use. Under the
    // two-space convention those differ by design, and a source-equivalence
    // receipt binds them; the host cannot re-verify that receipt because it is
    // not host-owned, so the loaded-versus-committed correspondence is proven by
    // the loaded-generation marker and terminal receipt together with the
    // restart owner's authenticated replacement census. What this runtime can
    // still check locally is that the descriptor it is about to publish names
    // the manifest identity it was constructed for, in whichever space the
    // caller distinguished. Fail closed on any divergence.
    const expectedManifestBuildId = this.options.manifestBuildId ?? this.options.buildId;
    if (descriptor.buildId !== expectedManifestBuildId) {
      // Running one build while the manifest names another is exactly the state
      // that makes "which code is loaded" unknowable; fail closed.
      throw new ActivationManifestError(
        `Active analytics generation build ${descriptor.buildId} does not match the loaded build ${expectedManifestBuildId}.`,
      );
    }
    this.authority.setDescriptor(descriptor);
    try {
      const helpers = await startAnalyticsHelpers({
        label: 'Canonical',
        recorderWorkerScript: this.options.recorderWorkerScript,
        queryWorkerScript: this.options.queryWorkerScript,
        databasePath: this.databasePath,
        writerAdmission: this.options.writerAdmission,
      });
      this.recorder = helpers.recorder;
      this.queryClient = helpers.queryClient;
      const recorderSchemaVersion = helpers.recorderSchemaVersion;
      const projectionRevision = helpers.projectionRevision;
      // The helper probe may have yielded while the activation writer replaced
      // the manifest. Never publish readiness for a descriptor that no longer
      // names the current authority snapshot.
      const currentActivation = this.readActivation();
      this.authority.assertStartupActivationUnchanged(currentActivation);
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
    this.authority.recordLoadedGeneration(this.readiness?.authority === 'canonical');
  }

  /** Publish terminal evidence only for a helper-issued restart. Unlike the
   * diagnostic loaded marker, failure here is fatal: the cutover must not
   * reopen admission or claim readiness without durable terminal evidence. */
  recordTerminalRestartReceipt(): void {
    this.authority.recordTerminalRestartReceipt(this.readiness?.authority === 'canonical');
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
    return this.authority.backendDescriptor(this.readiness?.authority === 'canonical');
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

  /** Revoke recorder producer admission and wait until every accepted capture
   * and lifecycle control write has been acknowledged by the recorder. */
  async fenceWriters(timeoutMs = 10_000): Promise<number> {
    const recorder = this.recorder;
    if (!recorder) return 0;
    await recorder.fence(timeoutMs);
    const backlog = recorder.backlog;
    return backlog.queuedRecords + backlog.inFlightRecords;
  }

  /** Stop every helper. Terminal and idempotent: never restarts workers.
   * The query client is stateless — each request forks a disposable child that
   * terminates with its response — so only the recorder needs shutting down. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.authority.clearDescriptor();
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

export { ActivationManifestError };
