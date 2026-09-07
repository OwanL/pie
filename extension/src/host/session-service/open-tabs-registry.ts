import type { SessionSummary } from '../../shared/protocol';
import { isPendingTabPath } from '../../shared/tab-behavior';
import type { ArchState } from '../core/reducer';

export type OpenTabsRegistryEntry = Pick<SessionSummary,
  'path' | 'name' | 'cwd' | 'modifiedAt' | 'messageCount' | 'modelId' | 'provider' | 'thinkingLevel'
> & {
  pinned: boolean;
  isRunning: boolean;
};

/** Project the one host authority consumed by session-review tools. */
export function selectOpenTabsRegistry(state: ArchState): OpenTabsRegistryEntry[] {
  const { sessions, openTabPaths, pinnedTabPaths, runningSessionPaths } = state.sessions;
  const sessionsByPath = new Map(sessions.map((session) => [session.path, session]));
  return openTabPaths.filter((sessionPath) => !isPendingTabPath(sessionPath)).flatMap((sessionPath) => {
    const session = sessionsByPath.get(sessionPath);
    return session
      ? [{
          path: session.path,
          name: session.name,
          cwd: session.cwd,
          modifiedAt: session.modifiedAt,
          messageCount: session.messageCount,
          ...(session.modelId ? { modelId: session.modelId } : {}),
          ...(session.provider ? { provider: session.provider } : {}),
          ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
          pinned: pinnedTabPaths.includes(sessionPath),
          isRunning: runningSessionPaths.includes(sessionPath),
        }]
      : [];
  });
}

export type OpenTabsRegistryInputs = Pick<
  ArchState['sessions'],
  'sessions' | 'openTabPaths' | 'pinnedTabPaths' | 'runningSessionPaths'
>;

/** Cheap reducer-boundary guard; the publisher performs the structural dedupe. */
export function didOpenTabsRegistryInputsChange(
  before: OpenTabsRegistryInputs,
  after: OpenTabsRegistryInputs,
): boolean {
  return before.sessions !== after.sessions
    || before.openTabPaths !== after.openTabPaths
    || before.pinnedTabPaths !== after.pinnedTabPaths
    || before.runningSessionPaths !== after.runningSessionPaths;
}

export interface OpenTabsRegistryPublisherScheduler {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface OpenTabsRegistryPublisherOptions {
  /** The promise is the local waiter; `onTransportSettled` is the physical
   * JSON-RPC boundary. A timed-out waiter must not start another request while
   * the old request still occupies the backend client's correlation map. */
  request(
    snapshot: { revision: number; tabs: OpenTabsRegistryEntry[] },
    options: { onTransportSettled: () => void },
  ): Promise<void>;
  onError?(error: unknown, context: { revision: number; retryAttempt: number }): void;
  retryDelaysMs?: readonly number[];
  scheduler?: OpenTabsRegistryPublisherScheduler;
}

interface DesiredRegistrySnapshot {
  revision: number;
  json: string;
  tabs: OpenTabsRegistryEntry[];
  needsSend: boolean;
  urgentResend: boolean;
}

const defaultScheduler: OpenTabsRegistryPublisherScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

const DEFAULT_RETRY_DELAYS_MS = [250, 1_000, 5_000] as const;

/**
 * Latest-wins, readiness-gated host→coordinator publisher. A retry reuses the
 * same source revision, so a lost response cannot apply the snapshot twice; a
 * new host snapshot supersedes a queued retry immediately. Snapshots received
 * before readiness are retained and the current snapshot is re-sent whenever a
 * new backend generation becomes ready.
 */
export class OpenTabsRegistryPublisher {
  private readonly scheduler: OpenTabsRegistryPublisherScheduler;
  private readonly retryDelaysMs: readonly number[];
  private desired?: DesiredRegistrySnapshot;
  private nextRevision = 1;
  private inFlight?: {
    target: DesiredRegistrySnapshot;
    generation: number;
    waiterSettled: boolean;
    transportSettled: boolean;
    failed: boolean;
  };
  private backendGeneration = 0;
  private backendReady = false;
  private retryAttempt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly options: OpenTabsRegistryPublisherOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.retryDelaysMs = options.retryDelaysMs?.length
      ? options.retryDelaysMs
      : DEFAULT_RETRY_DELAYS_MS;
  }

  /** Update the actual backend readiness barrier. The host calls this after
   * every reducer turn, not when the child process merely spawns, so restart
   * transitions and generation changes cannot publish to a stopped backend. */
  setBackendReady(ready: boolean, generation: number): void {
    if (this.disposed) return;
    const generationChanged = this.backendGeneration !== generation;
    const readinessChanged = this.backendReady !== ready;
    this.backendGeneration = generation;
    this.backendReady = ready;
    if (!generationChanged && !readinessChanged) return;
    this.cancelRetry();

    if (!ready) {
      // Preserve the latest snapshot across a restart. If a request is in
      // flight, its completion is fenced below and the replacement generation
      // will re-send rather than trusting an old coordinator acknowledgement.
      if (this.desired) {
        this.desired.needsSend = true;
        this.desired.urgentResend = true;
      }
      return;
    }

    if (generationChanged && this.desired) {
      this.desired.needsSend = true;
      this.desired.urgentResend = true;
      this.retryAttempt = 0;
    }
    void this.drain();
  }

  publish(tabs: OpenTabsRegistryEntry[], options: { force?: boolean } = {}): number | undefined {
    if (this.disposed) return undefined;
    let json: string;
    try {
      json = JSON.stringify(tabs);
    } catch (error) {
      this.options.onError?.(error, { revision: this.desired?.revision ?? 0, retryAttempt: 0 });
      return undefined;
    }

    let shouldDrain = false;
    if (!this.desired || this.desired.json !== json) {
      this.desired = {
        revision: this.nextRevision,
        json,
        tabs: JSON.parse(json) as OpenTabsRegistryEntry[],
        needsSend: true,
        urgentResend: false,
      };
      this.nextRevision += 1;
      this.retryAttempt = 0;
      shouldDrain = true;
    } else if (options.force) {
      // Backend replacement keeps the same host authority revision. Reusing
      // it is safe because the new coordinator starts with an empty source
      // revision ledger, while an old coordinator treats it as idempotent.
      this.desired.needsSend = true;
      this.desired.urgentResend = true;
      shouldDrain = true;
    }

    if (shouldDrain) {
      this.cancelRetry();
      void this.drain();
    }
    return this.desired.revision;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRetry();
    this.desired = undefined;
  }

  private async drain(): Promise<void> {
    if (this.disposed || !this.backendReady || this.inFlight || !this.desired?.needsSend) return;
    const target = this.desired;
    const requestGeneration = this.backendGeneration;
    const request = {
      target,
      generation: requestGeneration,
      waiterSettled: false,
      transportSettled: false,
      failed: false,
    };
    target.needsSend = false;
    target.urgentResend = false;
    this.inFlight = request;

    const onTransportSettled = (): void => {
      request.transportSettled = true;
      this.releaseInFlight(request);
    };

    try {
      await this.options.request(
        { revision: target.revision, tabs: target.tabs },
        { onTransportSettled },
      );
      // A successful promise is itself a transport settlement. Production
      // BackendClient also invokes the hook before resolving; this fallback
      // keeps small test/adaptor implementations from pinning the publisher.
      request.transportSettled = true;
      if (this.desired === target && requestGeneration === this.backendGeneration && this.backendReady) {
        this.retryAttempt = 0;
      }
    } catch (error) {
      request.failed = true;
      // BackendClient invokes the hook for ordinary transport failures. A
      // synchronous adapter throw has no physical request, so only a timeout
      // is allowed to retain the transport fence when the hook was not called.
      if (!request.transportSettled && !(error instanceof Error && error.name === 'RequestTimeoutError')) {
        request.transportSettled = true;
      }
      const staleGeneration = requestGeneration !== this.backendGeneration || !this.backendReady;
      if (this.desired === target && !this.disposed) {
        target.needsSend = true;
        if (!staleGeneration) {
          this.retryAttempt += 1;
          this.options.onError?.(error, { revision: target.revision, retryAttempt: this.retryAttempt });
          if (!target.urgentResend && request.transportSettled) this.scheduleRetry();
        }
      }
    } finally {
      request.waiterSettled = true;
      this.releaseInFlight(request);
    }
  }

  /** Release the publisher slot only after both the application waiter and the
   * physical transport have settled. This makes a timeout a bounded retry
   * episode rather than permission to create an unbounded set of expired
   * backend requests. */
  private releaseInFlight(request: NonNullable<OpenTabsRegistryPublisher['inFlight']>): void {
    if (!request.waiterSettled || !request.transportSettled || this.inFlight !== request) return;
    this.inFlight = undefined;
    const staleGeneration = request.generation !== this.backendGeneration;
    if (staleGeneration && this.desired === request.target && !this.disposed) {
      // A response from the old backend cannot establish the new coordinator's
      // registry. Re-send the latest authority immediately once the replacement
      // generation is ready.
      request.target.needsSend = true;
      request.target.urgentResend = true;
      this.retryAttempt = 0;
    }

    if (this.disposed || !this.backendReady) return;
    if (this.desired !== request.target
      || (request.target.needsSend && (!request.failed || request.target.urgentResend || staleGeneration))) {
      void this.drain();
    } else if (request.failed && request.target.needsSend && !request.target.urgentResend) {
      // A timeout may have settled the local waiter before the physical
      // response. The retry is armed only at this release boundary.
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.disposed || !this.backendReady || this.retryTimer || !this.desired?.needsSend) return;
    const delayIndex = Math.min(Math.max(0, this.retryAttempt - 1), this.retryDelaysMs.length - 1);
    const delayMs = this.retryDelaysMs[delayIndex] ?? 5_000;
    const retryGeneration = this.backendGeneration;
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = undefined;
      // A timer armed for an old generation must not issue a request to the
      // replacement coordinator. setBackendReady(true, generation) owns the
      // immediate resync after restart.
      if (retryGeneration !== this.backendGeneration || !this.backendReady) return;
      void this.drain();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private cancelRetry(): void {
    if (this.retryTimer === undefined) return;
    this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}
