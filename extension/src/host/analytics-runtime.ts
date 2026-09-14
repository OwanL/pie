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
import {
  AnalyticsRecorderSupervisor,
  type AnalyticsRecorderWriterAdmission,
} from '../analytics/recorder-supervisor.js';
import { AnalyticsQueryClient } from '../analytics/query-client.js';
import { ActivationStore, type ActivationReadResult } from '../analytics/activation-store.js';
import {
  CandidateTrialAuthority,
  type CandidateTrialCleanupReceipt,
} from '../analytics/candidate-trial-authority.js';
import { CanonicalAnalyticsCapture } from '../analytics/canonical-capture.js';
import {
  CANDIDATE_TRIAL_DESCRIPTOR_KIND,
  validateCandidateTrialDescriptor,
  type CandidateTrialDescriptor,
} from '../../../shared/analytics/candidate-trial.js';

/** Written by a host that completed canonical readiness, so post-restart
 * evidence can show which generation is loaded rather than only which one the
 * manifest records. */
export const LOADED_GENERATION_FILENAME = 'analytics-loaded-generation-v1.json';
export const TERMINAL_RESTART_RECEIPT_KIND = 'pie-p7-terminal-restart-v1' as const;

export interface AnalyticsTerminalRestartReceipt {
  readonly schemaVersion: 1;
  readonly kind: typeof TERMINAL_RESTART_RECEIPT_KIND;
  readonly status: 'ready';
  readonly generationId: string;
  readonly buildId: string;
  readonly restartNonce: string;
  readonly hostInstanceId: string;
  readonly processId: number;
  readonly loadedAt: string;
  readonly verifiedAt: string;
}

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

/** Write the terminal receipt at the exact helper-provided destination. The
 * caller supplies a path rather than the runtime searching for one, and the
 * rename keeps readers from observing partial JSON. */
export function writeTerminalRestartReceiptAtomically(
  destination: string,
  payload: AnalyticsTerminalRestartReceipt,
): void {
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}-${randomUUID()}.tmp`);
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  let descriptor: number | undefined;
  try {
    mkdirSync(directory, { recursive: true });
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
  /** Exact helper-issued destination for terminal restart evidence. It is
   * required whenever restartNonce is present. */
  terminalRestartReceiptPath?: string;
  /** Stable active IANA calendar zone for the canonical projection. It is
   * captured once per host and never selected from competing read requests. */
  timeZone?: string;
  /** Durable lifecycle admission for recorder persistence. */
  writerAdmission?: AnalyticsRecorderWriterAdmission;
  onError?: (error: unknown, stage: string) => void;
}

export type AnalyticsRuntimeActivationSnapshot = Pick<
  ActivationReadResult,
  'manifest' | 'sha256' | 'authority'
>;

export interface AnalyticsRuntimeReadiness {
  /** `candidate-trial` is the disposable in-memory trial authority; it never
   * carries manifest-derived evidence and never selects a canonical descriptor. */
  authority: 'legacy' | 'canonical' | 'candidate-trial';
  manifestRevision: number | null;
  manifestSha256: string | null;
  generationId: string | null;
  /** Bounded schema/revision probe result; null under legacy authority. */
  recorderSchemaVersion: number | null;
  projectionRevision: string | null;
  recorderReady: boolean;
  queryReady: boolean;
}

/** Narrow host seam shared by the normal canonical runtime and the
 * filesystem-free rehearsal runtime. */
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

/** Runtime used by the total-disabled rehearsal. It has no activation store,
 * recorder, query worker, loaded receipt, or filesystem side effect. */
export class DisabledAnalyticsRuntime implements AnalyticsRuntimePort {
  readonly analyticsTimeZone = 'UTC';

  async start(): Promise<AnalyticsRuntimeReadiness> {
    return {
      authority: 'legacy',
      manifestRevision: null,
      manifestSha256: null,
      generationId: null,
      recorderSchemaVersion: null,
      projectionRevision: null,
      recorderReady: false,
      queryReady: false,
    };
  }

  recordLoadedGeneration(): void { /* no activation receipt in this mode */ }

  recordTerminalRestartReceipt(): void { /* no terminal receipt in this mode */ }

  backendDescriptor(): undefined { return undefined; }

  async fenceWriters(): Promise<number> { return 0; }

  async stop(): Promise<void> { /* no helper to stop */ }
}

interface AnalyticsHelperStartup {
  recorder: AnalyticsRecorderSupervisor;
  queryClient: AnalyticsQueryClient;
  recorderSchemaVersion: number;
  projectionRevision: string | null;
}

/** Shared real-helper startup probe: the single production recorder/query
 * startup sequence, used by the canonical runtime and by the disposable
 * candidate-trial runtime against its own factory-owned root. Starts the same
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
  private readonly store: ActivationStore;
  private recorder: AnalyticsRecorderSupervisor | undefined;
  private queryClient: AnalyticsQueryClient | undefined;
  private readiness: AnalyticsRuntimeReadiness | undefined;
  /** Descriptor captured at canonical startup. A later manifest update must
   * fail the next backend spawn instead of silently changing this host's
   * worker authority mid-process. */
  private activationDescriptor: AnalyticsBackendDescriptor | undefined;
  private loadedGeneration: AnalyticsLoadedGenerationReceipt | undefined;
  private readonly timeZone: string;
  private preparedDailyProjectionKey: string | undefined;
  private preparingDailyProjection: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly options: AnalyticsRuntimeOptions) {
    this.store = new ActivationStore({ stateDir: options.stateDir });
    const configuredTimeZone = options.timeZone?.trim()
      || Intl.DateTimeFormat().resolvedOptions().timeZone
      || 'UTC';
    // Validate once at construction so a malformed machine/configuration
    // value cannot become a late read-path mutation or fallback.
    this.timeZone = validateAnalyticsTimeZone(configuredTimeZone);
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
      this.loadedGeneration = payload;
    } catch {
      // Diagnostic only. Never fail a working activation over this record.
    }
  }

  /** Publish terminal evidence only for a helper-issued restart. Unlike the
   * diagnostic loaded marker, failure here is fatal: the cutover must not
   * reopen admission or claim readiness without durable terminal evidence. */
  recordTerminalRestartReceipt(): void {
    if (this.readiness?.authority !== 'canonical' || this.options.restartNonce === null
      || this.options.restartNonce === undefined) return;
    const destination = this.options.terminalRestartReceiptPath;
    if (!destination || !path.isAbsolute(destination) || destination.length > 4_096) {
      throw new ActivationManifestError('Terminal restart receipt path is missing or invalid.');
    }
    const loaded = this.loadedGeneration;
    const descriptor = this.activationDescriptor;
    if (!loaded || !descriptor || loaded.restartNonce !== this.options.restartNonce) {
      throw new ActivationManifestError('Loaded-generation evidence is missing for the terminal restart receipt.');
    }
    const current = this.readActivation();
    this.assertStartupActivationUnchanged(current);
    if (current.authority !== 'canonical'
      || current.sha256 !== descriptor.manifestSha256
      || current.manifest?.revision !== descriptor.manifestRevision
      || current.manifest.activeGeneration?.identity.generationId !== descriptor.generationId) {
      throw new ActivationManifestError('Analytics activation changed before terminal restart evidence could be recorded.');
    }
    const payload: AnalyticsTerminalRestartReceipt = {
      schemaVersion: 1,
      kind: TERMINAL_RESTART_RECEIPT_KIND,
      status: 'ready',
      generationId: descriptor.generationId,
      buildId: descriptor.buildId,
      restartNonce: this.options.restartNonce,
      hostInstanceId: descriptor.hostInstanceId,
      processId: process.pid,
      loadedAt: loaded.loadedAt,
      verifiedAt: new Date().toISOString(),
    };
    writeTerminalRestartReceiptAtomically(destination, payload);
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

export interface CandidateTrialRuntimeOptions {
  recorderWorkerScript: string;
  queryWorkerScript: string;
  /** Fresh per host process identity, like the canonical runtime's. */
  hostInstanceId: string;
  timeZone?: string;
  onError?: (error: unknown, stage: string) => void;
}

/** The disposable candidate-trial runtime seam. It shares the production port
 * so the same helper seams can be exercised, but its descriptor surface is
 * deliberately different: `backendDescriptor()` is always undefined because a
 * trial has no manifest-derived canonical routing, and the real backend/host
 * transport binding remains a later unit — it is never faked here. */
export interface CandidateTrialRuntimePort extends AnalyticsRuntimePort {
  readonly trialAuthority: CandidateTrialAuthority;
  readonly capture: CanonicalAnalyticsCapture;
  candidateTrialDescriptor(): CandidateTrialDescriptor | undefined;
  getReadiness(): AnalyticsRuntimeReadiness | undefined;
  get cleanupReceipt(): CandidateTrialCleanupReceipt | undefined;
}

/** Disposable candidate-trial runtime: the SAME production recorder/query/
 * capture helpers started against one factory-owned unique OS-temp root under
 * the distinct `candidate-trial` readiness authority. It never constructs an
 * activation store, so it can never create a manifest or tombstone, and it
 * holds no manifest-derived identity. */
/** Module-private brand so only the module-level strict factory can construct
 * a trial runtime; ordinary construction is rejected at runtime. */
const candidateTrialRuntimeToken = Symbol('pie.analytics.candidate-trial-runtime');

export class CandidateTrialRuntime implements CandidateTrialRuntimePort {
  readonly analyticsTimeZone: string;
  private recorder: AnalyticsRecorderSupervisor | undefined;
  private queryClient: AnalyticsQueryClient | undefined;
  private readiness: AnalyticsRuntimeReadiness | undefined;
  private cleanup: CandidateTrialCleanupReceipt | undefined;
  private trialStopped = false;

  constructor(
    public readonly trialAuthority: CandidateTrialAuthority,
    public readonly capture: CanonicalAnalyticsCapture,
    private readonly descriptor: CandidateTrialDescriptor,
    initialReadiness: AnalyticsRuntimeReadiness,
    helpers: { recorder: AnalyticsRecorderSupervisor; queryClient: AnalyticsQueryClient },
    options: { timeZone?: string },
    brand: typeof candidateTrialRuntimeToken,
  ) {
    if (brand !== candidateTrialRuntimeToken) {
      throw new ActivationManifestError('Candidate-trial runtime must be created by its strict factory.');
    }
    this.readiness = initialReadiness;
    this.recorder = helpers.recorder;
    this.queryClient = helpers.queryClient;
    this.analyticsTimeZone = validateAnalyticsTimeZone(options.timeZone?.trim() || 'UTC');
  }

  /** Start is part of the shared port; the factory already performed the real
   * startup, so this only republishes the single readiness snapshot. */
  async start(): Promise<AnalyticsRuntimeReadiness> {
    if (this.trialStopped || !this.readiness) {
      throw new ActivationManifestError('Candidate-trial runtime has stopped; a grant is single use.');
    }
    return this.readiness;
  }

  getReadiness(): AnalyticsRuntimeReadiness | undefined {
    return this.readiness;
  }

  /** No loaded-generation receipt exists for a trial: there is no manifest and
   * no canonical generation loaded. */
  recordLoadedGeneration(): void { /* no manifest evidence exists in trial mode */ }

  recordTerminalRestartReceipt(): void { /* terminal restart evidence requires canonical authority */ }

  /** Always undefined in trial mode: a candidate trial must never pretend to
   * carry manifest-derived canonical routing to a backend. */
  backendDescriptor(): undefined { return undefined; }

  /** The separate, explicitly-named trial descriptor for the dedicated trial
   * producer surface. It carries no manifest revision/hash and no trialSha256. */
  candidateTrialDescriptor(): CandidateTrialDescriptor {
    return this.descriptor;
  }

  /** Revoke trial producer admission and drain accepted capture writes. */
  async fenceWriters(timeoutMs = 10_000): Promise<number> {
    const recorder = this.recorder;
    if (!recorder) return 0;
    await recorder.fence(timeoutMs);
    const backlog = recorder.backlog;
    return backlog.queuedRecords + backlog.inFlightRecords;
  }

  /** The started trial recorder, for explicit trial producer wiring only. */
  get sink(): AnalyticsRecorderSupervisor | undefined {
    return this.recorder;
  }

  /** The started trial query client, for reads inside the disposable root. */
  get reads(): AnalyticsQueryClient | undefined {
    return this.queryClient;
  }

  get isStopped(): boolean {
    return this.trialStopped;
  }

  get cleanupReceipt(): CandidateTrialCleanupReceipt | undefined {
    return this.cleanup;
  }

  /** Stop helpers, then remove ONLY the factory-owned root. Cleanup failure
   * preserves the receipt facts and is reported, never reported as success. */
  async stop(): Promise<void> {
    if (this.trialStopped) return;
    this.trialStopped = true;
    const receipt = await this.trialAuthority.dispose(async () => {
      const recorder = this.recorder;
      this.recorder = undefined;
      this.queryClient = undefined;
      if (recorder) await recorder.shutdown();
    });
    this.cleanup = receipt;
    if (!receipt.completed) {
      throw new ActivationManifestError(
        `Candidate-trial cleanup failed: ${receipt.failureReasons.join('; ')}`,
      );
    }
  }
}

/** Strict factory: the only way to obtain a running candidate-trial runtime.
 *
 * Ordering invariants: every caller-visible descriptor/option is validated
 * BEFORE the single-use grant is consumed, so an invalid input leaves the
 * grant unconsumed and its root caller-owned (an explicit `dispose()` removes
 * it; nothing is cleaned up automatically). `consume()` itself stays outside
 * the failure-dispose try: a rejected reuse while a first trial is still
 * active must never dispose that first active root or stop its helpers. A
 * post-consume failure stops every started helper BEFORE the owned root is
 * deleted, and the rethrown error preserves the primary reason plus the real
 * cleanup receipt instead of discarding it or faking a clean result. */
export async function startCandidateTrialRuntime(
  authority: CandidateTrialAuthority,
  options: CandidateTrialRuntimeOptions,
): Promise<CandidateTrialRuntime> {
  const grant = authority.grant;
  const descriptor = validateCandidateTrialDescriptor({
    kind: CANDIDATE_TRIAL_DESCRIPTOR_KIND,
    trialId: grant.identity.trialId,
    generationId: grant.identity.generationId,
    buildId: grant.identity.buildId,
    workspaceId: grant.workspaceId,
    hostInstanceId: options.hostInstanceId,
    trialPlanSha256: grant.planSha256,
    trialAuthorityRevision: grant.authorityRevision,
  });
  if (typeof options.recorderWorkerScript !== 'string' || options.recorderWorkerScript.trim().length === 0
    || typeof options.queryWorkerScript !== 'string' || options.queryWorkerScript.trim().length === 0) {
    throw new ActivationManifestError('Candidate-trial recorder/query worker scripts are required.');
  }
  // Validate before consuming the single-use grant, matching the production
  // runtime's IANA validation and leaving invalid caller input reusable.
  const timeZone = validateAnalyticsTimeZone(options.timeZone?.trim() || 'UTC');
  // Outside the try on purpose: if consume() rejects (already consumed or
  // expired) this caller never owned the trial, so disposing here could delete
  // the first active trial's root or stop its helpers.
  authority.consume();
  let startedRecorder: AnalyticsRecorderSupervisor | undefined;
  try {
    const helpers = await startAnalyticsHelpers({
      label: 'Candidate-trial',
      recorderWorkerScript: options.recorderWorkerScript,
      queryWorkerScript: options.queryWorkerScript,
      databasePath: canonicalAnalyticsDatabasePath(grant.resolvedPaths.analyticsDir),
    });
    startedRecorder = helpers.recorder;
    const capture = new CanonicalAnalyticsCapture({
      authority: 'canonical',
      generationId: grant.identity.generationId,
      workspaceId: grant.workspaceId,
      buildId: grant.identity.buildId,
      processGeneration: options.hostInstanceId,
      sink: helpers.recorder,
      detailSink: helpers.recorder,
      lifecycleSink: helpers.recorder,
    });
    const runtime = new CandidateTrialRuntime(
      authority,
      capture,
      descriptor,
      {
        authority: 'candidate-trial',
        manifestRevision: null,
        manifestSha256: null,
        generationId: grant.identity.generationId,
        recorderSchemaVersion: helpers.recorderSchemaVersion,
        projectionRevision: helpers.projectionRevision,
        recorderReady: true,
        queryReady: true,
      },
      { recorder: helpers.recorder, queryClient: helpers.queryClient },
      { ...options, timeZone },
      candidateTrialRuntimeToken,
    );
    return runtime;
  } catch (error) {
    const primaryReason = error instanceof Error ? error.message : String(error);
    // A failed trial must not leave helpers running or the root owned: stop
    // every started helper before the owned root delete, then keep the real
    // receipt facts instead of discarding them or faking a clean result.
    const receipt = await authority.dispose(async () => {
      if (startedRecorder) await startedRecorder.shutdown();
    });
    const failure = new ActivationManifestError(
      `Candidate-trial startup failed: ${primaryReason}; owned-root cleanup ${
        receipt.completed ? 'completed' : `failed: ${receipt.failureReasons.join('; ')}`
      }.`,
    );
    const startupFailure = failure as Error & { candidateTrialCleanupReceipt?: CandidateTrialCleanupReceipt };
    startupFailure.candidateTrialCleanupReceipt = receipt;
    options.onError?.(failure, 'candidate-trial-startup');
    throw failure;
  }
}

export { ActivationManifestError };
