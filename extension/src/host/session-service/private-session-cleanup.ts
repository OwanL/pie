import { appendPieLog } from '../util/pie-log';
import { toErrorMessage } from '../util/error-message';

/** Keep startup cleanup bounded without making the browser/backend startup wait
 * for a backend deletion that may be queued behind other work. */
export const PRIVATE_SESSION_CLEANUP_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONCURRENT_CLEANUPS = 4;

type CleanupRequest = (
  sessionPath: string,
  timeoutMs: number,
  onTransportSettled: () => void,
) => Promise<void>;

export interface PrivateSessionCleanupOptions {
  requestForget: CleanupRequest;
  /** Validate/freeze authoritative lifecycle privacy before irreversible analytics deletion. */
  prepareForget?: (
    sessionPath: string,
  ) => Promise<{ rootSessionId: string; pendingCreateOperationId?: string } | void>;
  /** Scrub host-local analytics before the durable session deletion marker can
   * be removed. The optional identities are the persisted create/duplicate
   * origin and stable root, never the cleanup operation that resumes the request. */
  forgetLocalAnalytics: (
    sessionPath: string,
    pendingCreateOperationId?: string,
    stableRootSessionId?: string,
  ) => Promise<void> | void;
  clearPrivacyMarker: (sessionPath: string) => void;
  persistMarkers: (
    sessionPaths: readonly string[],
    removedSessionPaths?: readonly string[],
  ) => Promise<void>;
  isBackendReady: () => boolean;
  getBackendGeneration: () => number;
  isSessionOpen?: (sessionPath: string) => boolean;
  maxConcurrent?: number;
}

interface CleanupRun {
  readonly id: number;
  readonly generation: number;
  readonly startedAt: number;
  count: number;
  succeeded: number;
  failed: number;
  markerRetained: number;
  settled: number;
}

interface InFlightCleanup {
  readonly generation: number;
  readonly run: CleanupRun;
  /** True only after the physical forget request has been admitted. A local
   * scrub can fail before there is any transport to await. */
  requestAdmitted: boolean;
  transportSettled: boolean;
  waiterSettled: boolean;
}

/**
 * Owns the best-effort removal of privacy markers for sessions that were not
 * restored as tabs. Requests are single-flight per path across backend
 * generations: a replacement backend waits for an old request to settle before
 * retrying that path, preventing a restart from issuing duplicate destructive
 * work. The durable marker is removed only after host-local analytics cleanup
 * and `session.forget` both succeed.
 */
export class PrivateSessionCleanup {
  private readonly maxConcurrent: number;
  private readonly pending = new Set<string>();
  private readonly inFlight = new Map<string, InFlightCleanup>();
  private readonly cleared = new Set<string>();
  private latestStoredMarkers: string[] = [];
  private currentGeneration = 0;
  private activeCount = 0;
  private runCounter = 0;
  private cleanupRun?: CleanupRun;
  private readonly runByPath = new Map<string, CleanupRun>();
  private markerPersistence: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: PrivateSessionCleanupOptions) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_CLEANUPS);
  }

  /** Queue one bounded cleanup pass. This method intentionally returns void:
   * startup must not wait for privacy deletion. */
  schedule(storedPrivatePaths: readonly string[], restoredTabPaths: readonly string[]): void {
    if (this.disposed) return;

    const stored = [...new Set(storedPrivatePaths)];
    const restored = new Set(restoredTabPaths);
    this.latestStoredMarkers = stored;
    // A marker removed by a previous successful request may still be present
    // in a stale globalState read during a restart. Keep it logically cleared
    // and retry only the durable marker write; never repeat the deletion.
    for (const sessionPath of [...this.cleared]) {
      if (!stored.includes(sessionPath)) this.cleared.delete(sessionPath);
    }

    const candidates = stored.filter((sessionPath) => !restored.has(sessionPath) && !this.cleared.has(sessionPath));
    const candidateSet = new Set(candidates);
    for (const sessionPath of this.pending) {
      if (!candidateSet.has(sessionPath) && !this.inFlight.has(sessionPath)) this.pending.delete(sessionPath);
    }

    this.currentGeneration = this.options.getBackendGeneration();
    let run = this.cleanupRun;
    if ((!run || run.generation !== this.currentGeneration) && candidates.length > 0) {
      run = this.cleanupRun = {
        id: ++this.runCounter,
        generation: this.currentGeneration,
        startedAt: performance.now(),
        count: 0,
        succeeded: 0,
        failed: 0,
        markerRetained: 0,
        settled: 0,
      };
    }
    for (const sessionPath of candidates) {
      this.pending.add(sessionPath);
      if (run && (!this.runByPath.has(sessionPath)
        || this.runByPath.get(sessionPath)?.generation !== this.currentGeneration)) {
        this.runByPath.set(sessionPath, run);
        run.count += 1;
      }
    }

    if (candidates.length > 0) {
      appendPieLog('info', 'startup', 'private session cleanup scheduled', {
        count: candidates.length,
        generation: this.currentGeneration,
        cleanupId: run?.id ?? null,
        timeoutMs: PRIVATE_SESSION_CLEANUP_TIMEOUT_MS,
      });
    }
    this.pump();
    // A previous successful deletion may have completed just before this
    // schedule call. Persist its marker removal even when no new request is
    // needed, without allowing a persistence failure to become unhandled.
    if (this.cleared.size > 0) void this.persistMarkers(undefined, [...this.cleared]);
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    this.runByPath.clear();
    // Do not reject or otherwise race in-flight backend requests. Backend
    // shutdown owns their transport settlement; their continuations are
    // already failure-contained below.
  }

  private pump(): void {
    if (this.disposed || !this.options.isBackendReady()) return;
    // Never send a new-generation forget while an old-generation request for
    // another path is still physically outstanding. BackendClient's timeout
    // or shutdown settlement is the duplicate-work boundary.
    for (const request of this.inFlight.values()) {
      if (request.generation !== this.currentGeneration) return;
    }

    while (this.activeCount < this.maxConcurrent && this.pending.size > 0) {
      const sessionPath = this.pending.values().next().value as string | undefined;
      if (!sessionPath) return;
      this.pending.delete(sessionPath);
      const run = this.runByPath.get(sessionPath);
      if (this.cleared.has(sessionPath) || this.options.isSessionOpen?.(sessionPath)) {
        if (run) {
          run.settled += 1;
          this.runByPath.delete(sessionPath);
          this.maybeLogRun(run);
        }
        continue;
      }
      this.start(sessionPath, this.currentGeneration, run);
    }
  }

  private start(sessionPath: string, generation: number, run?: CleanupRun): void {
    this.activeCount += 1;
    const cleanupRun = run ?? this.cleanupRun ?? {
      id: ++this.runCounter,
      generation,
      startedAt: performance.now(),
      count: 1,
      succeeded: 0,
      failed: 0,
      markerRetained: 0,
      settled: 0,
    };
    if (!this.cleanupRun) this.cleanupRun = cleanupRun;
    const inFlight: InFlightCleanup = {
      generation,
      run: cleanupRun,
      requestAdmitted: false,
      transportSettled: false,
      waiterSettled: false,
    };
    this.inFlight.set(sessionPath, inFlight);
    const requestStartedAt = performance.now();
    let markerRemovalAttempted = false;
    appendPieLog('info', 'startup', 'private session cleanup request sent', {
      sessionPath,
      generation,
      cleanupId: cleanupRun.id,
    });

    const release = (): void => {
      if (!inFlight.transportSettled || !inFlight.waiterSettled) return;
      if (this.inFlight.get(sessionPath) !== inFlight) return;
      this.inFlight.delete(sessionPath);
      this.activeCount -= 1;
      if (this.runByPath.get(sessionPath) === cleanupRun && !this.pending.has(sessionPath)) {
        this.runByPath.delete(sessionPath);
      }
      this.pump();
      this.maybeLogRun(cleanupRun);
    };

    void (async () => {
      try {
        // Use the same host-local cleanup seam as the interactive privacy
        // effect before deleting the durable session. If either side fails,
        // this catch leaves the marker in place and privacy remains hydrated
        // on the next host start.
        const lifecycle = await this.options.prepareForget?.(sessionPath);
        await this.options.forgetLocalAnalytics(
          sessionPath,
          lifecycle?.pendingCreateOperationId,
          lifecycle?.rootSessionId,
        );
        // The local scrub is awaited before any backend request is admitted.
        // Recheck all lifecycle inputs after that await so disposal, a backend
        // replacement, or tab restoration cannot start a stale destructive
        // request. The marker remains durable when this guard rejects.
        if (this.disposed
          || !this.options.isBackendReady()
          || this.currentGeneration !== generation
          || this.options.getBackendGeneration() !== generation
          || this.options.isSessionOpen?.(sessionPath)) {
          throw new Error('Private session cleanup request became stale before admission.');
        }
        inFlight.requestAdmitted = true;
        await this.options.requestForget(sessionPath, PRIVATE_SESSION_CLEANUP_TIMEOUT_MS, () => {
          inFlight.transportSettled = true;
          release();
        });
        const requestDurationMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
        // If the user restored the tab while the request was in flight, retain
        // the marker. Deletion succeeded, but clearing a newly-restored
        // privacy state would be less safe than a harmless retry marker.
        const markerCanClear = !this.options.isSessionOpen?.(sessionPath);
        if (markerCanClear) {
          // Claim the logical removal before entering the serialized marker
          // write. Concurrent successful cleanups must not overwrite one
          // another's durable removal with an older remaining list.
          markerRemovalAttempted = true;
          this.cleared.add(sessionPath);
          if (await this.persistMarkers(undefined, [...this.cleared])) {
            try {
              this.options.clearPrivacyMarker(sessionPath);
              cleanupRun.succeeded += 1;
            } catch (error) {
              // Do not leave the in-memory logical removal claimed when the
              // privacy-state commit itself fails after the marker write.
              this.cleared.delete(sessionPath);
              await this.persistMarkers(
                [...new Set([...this.latestStoredMarkers, sessionPath])],
              );
              throw error;
            }
          } else {
            this.cleared.delete(sessionPath);
            throw new Error('Failed to persist private session marker removal.');
          }
        } else {
          cleanupRun.markerRetained += 1;
          await this.persistMarkers();
          cleanupRun.succeeded += 1;
        }
        appendPieLog('info', 'startup', 'private session cleanup request completed', {
          sessionPath,
          generation,
          cleanupId: cleanupRun.id,
          durationMs: requestDurationMs,
          totalDurationMs: Math.max(0, Math.round(performance.now() - requestStartedAt)),
          markerCleared: this.cleared.has(sessionPath),
        });
      } catch (error) {
        // A local scrub or lifecycle guard can fail before a physical request
        // exists. Only that no-request case may settle the transport here;
        // an admitted request that timed out must keep its physical slot until
        // its transport callback arrives.
        if (!inFlight.requestAdmitted) inFlight.transportSettled = true;
        cleanupRun.failed += 1;
        cleanupRun.markerRetained += 1;
        this.cleared.delete(sessionPath);
        if (markerRemovalAttempted) {
          // A host storage adapter may reject after partially applying an
          // update. Reassert the marker before releasing this cleanup task so
          // a failure can never turn into an unmarked private session.
          await this.persistMarkers([...new Set([...this.latestStoredMarkers, sessionPath])]);
        }
        appendPieLog('warn', 'startup', 'private session cleanup request failed; retaining retry marker', {
          sessionPath,
          generation,
          cleanupId: cleanupRun.id,
          durationMs: Math.max(0, Math.round(performance.now() - requestStartedAt)),
          error: toErrorMessage(error),
        });
      } finally {
        // A later schedule may have queued the same path while this physical
        // request was timing out. Keep the logical run open for that retry;
        // the transport fence above still prevents overlap.
        const retryingSameRun = this.pending.has(sessionPath)
          && this.runByPath.get(sessionPath) === cleanupRun;
        if (!retryingSameRun) cleanupRun.settled += 1;
        inFlight.waiterSettled = true;
        release();
      }
    })();
  }

  private maybeLogRun(run: CleanupRun): void {
    if (run.settled < run.count) return;
    appendPieLog('info', 'startup', 'private session cleanup completed', {
      count: run.count,
      succeeded: run.succeeded,
      failed: run.failed,
      generation: run.generation,
      cleanupId: run.id,
      totalDurationMs: Math.max(0, Math.round(performance.now() - run.startedAt)),
      markerRetained: run.markerRetained > 0,
    });
    if (this.cleanupRun === run) this.cleanupRun = undefined;
  }

  private persistMarkers(
    remaining?: readonly string[],
    removedSessionPaths: readonly string[] = [],
  ): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const operation = this.markerPersistence.then(async () => {
      if (this.disposed) return;
      const removals = new Set([...removedSessionPaths, ...this.cleared]);
      const next = remaining
        ?? this.latestStoredMarkers.filter((sessionPath) => !this.cleared.has(sessionPath));
      await this.options.persistMarkers(next, [...removals]);
    });
    // Keep the queue usable after one failed write. The returned promise still
    // reports the individual failure to the caller that owns marker semantics.
    this.markerPersistence = operation.catch(() => undefined);
    return operation.then(
      () => true,
      (error) => {
        const count = remaining?.length
          ?? this.latestStoredMarkers.filter((sessionPath) => !this.cleared.has(sessionPath)).length;
        appendPieLog('warn', 'startup', 'private session marker persistence failed; retaining marker', {
          count,
          error: toErrorMessage(error),
        });
        return false;
      },
    );
  }
}
