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
  request(snapshot: { revision: number; tabs: OpenTabsRegistryEntry[] }): Promise<void>;
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
 * Latest-wins, retrying host→coordinator publisher. A retry reuses the same
 * source revision, so a lost response cannot apply the snapshot twice; a new
 * host snapshot supersedes a queued retry immediately.
 */
export class OpenTabsRegistryPublisher {
  private readonly scheduler: OpenTabsRegistryPublisherScheduler;
  private readonly retryDelaysMs: readonly number[];
  private desired?: DesiredRegistrySnapshot;
  private nextRevision = 1;
  private inFlight = false;
  private retryAttempt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly options: OpenTabsRegistryPublisherOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.retryDelaysMs = options.retryDelaysMs?.length
      ? options.retryDelaysMs
      : DEFAULT_RETRY_DELAYS_MS;
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
    if (this.disposed || this.inFlight || !this.desired?.needsSend) return;
    const target = this.desired;
    target.needsSend = false;
    target.urgentResend = false;
    this.inFlight = true;
    let failed = false;
    try {
      await this.options.request({ revision: target.revision, tabs: target.tabs });
      if (this.desired === target) this.retryAttempt = 0;
    } catch (error) {
      failed = true;
      if (this.desired === target && !this.disposed) {
        target.needsSend = true;
        this.retryAttempt += 1;
        this.options.onError?.(error, { revision: target.revision, retryAttempt: this.retryAttempt });
        if (!target.urgentResend) this.scheduleRetry();
      }
    } finally {
      this.inFlight = false;
      // A newer snapshot, or an explicit force while this request was in
      // flight, runs immediately. Ordinary failures respect retry backoff.
      if (!this.disposed
        && (this.desired !== target || (target.needsSend && (!failed || target.urgentResend)))) {
        void this.drain();
      }
    }
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer || !this.desired?.needsSend) return;
    const delayIndex = Math.min(Math.max(0, this.retryAttempt - 1), this.retryDelaysMs.length - 1);
    const delayMs = this.retryDelaysMs[delayIndex] ?? 5_000;
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = undefined;
      void this.drain();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private cancelRetry(): void {
    if (!this.retryTimer) return;
    this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}
