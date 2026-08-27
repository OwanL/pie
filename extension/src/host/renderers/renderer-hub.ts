/**
 * Host-owned renderer hub (browser server plan §4.1).
 *
 * Sits between `PieExtension`/`SidebarViewProvider` and renderer transports.
 * Owns the registry of `RendererSession`s, the shared debounced schedule
 * fan-out, the shared projected `ViewState` (one expensive projection per
 * logical render), and targeted/broadcast imperative routing.
 *
 * Host event-loop isolation: per-renderer delivery controllers isolate
 * delivery state, but projection/envelope assembly still runs on the
 * extension host event loop. The hub therefore projects the `ViewState` at
 * most once per logical render (lazily, at the first snapshot build after a
 * schedule) and every session builds its own bounded envelope from that
 * shared body. No post/commit gate is shared across renderers.
 */

import * as crypto from 'node:crypto';

import type {
  HostToWebviewMessage,
  RendererCommandContext,
  ViewState,
  WebviewToHostMessage,
} from '../../shared/protocol';
import type { StateDeliveryClock } from '../sidebar/state-delivery-controller';
import { RendererSession } from './renderer-session';
import type { DisposableLike, RendererRegistration, RendererTarget, RendererTransport } from './types';

const SCHEDULE_DEBOUNCE_MS = 50;
// Full snapshots cross the Chromium structured-clone boundary and commit a
// transcript tree. Posting them at 60 ms starved pointer/click handling on
// tool-heavy turns. 150 ms is the established UI cadence (~7 fps): live text
// remains fluid through the webview's buffered reveal while controls retain
// main-thread time.
const STREAMING_SCHEDULE_DEBOUNCE_MS = 150;
const MEDIUM_TRANSCRIPT_SCHEDULE_DEBOUNCE_MS = 400;
const HEAVY_TRANSCRIPT_SCHEDULE_DEBOUNCE_MS = 750;
const MEDIUM_TRANSCRIPT_PARTS = 128;
const HEAVY_TRANSCRIPT_PARTS = 256;
const MEDIUM_TRANSCRIPT_TEXT_CHARS = 256 * 1024;
const HEAVY_TRANSCRIPT_TEXT_CHARS = 1024 * 1024;

/** Keep multi-megabyte, tool-heavy full snapshots from monopolising the
 * renderer main thread. Ordered-part count is a cheap, deterministic proxy for
 * snapshot complexity and is evaluated once per shared projection, not on
 * every incoming stream event. */
export function streamingScheduleDebounceMs(viewState: ViewState): number {
  let partCount = 0;
  let textChars = 0;
  for (const message of viewState.transcript) {
    partCount += message.parts?.length ?? message.toolCalls?.length ?? 1;
    textChars += message.markdown.length + (message.thinking?.length ?? 0);
    for (const part of message.parts ?? []) {
      if (part.kind === 'text' || part.kind === 'reasoning') textChars += part.text.length;
      else textChars += part.toolCall.argumentsText?.length ?? 0;
    }
    if (partCount >= HEAVY_TRANSCRIPT_PARTS || textChars >= HEAVY_TRANSCRIPT_TEXT_CHARS) {
      return HEAVY_TRANSCRIPT_SCHEDULE_DEBOUNCE_MS;
    }
  }
  return partCount >= MEDIUM_TRANSCRIPT_PARTS || textChars >= MEDIUM_TRANSCRIPT_TEXT_CHARS
    ? MEDIUM_TRANSCRIPT_SCHEDULE_DEBOUNCE_MS
    : STREAMING_SCHEDULE_DEBOUNCE_MS;
}

const SYSTEM_CLOCK: StateDeliveryClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RendererHubOptions {
  clock?: StateDeliveryClock;
  /** Shared extension-host incarnation. Supply this when multiple hubs serve
   *  different renderer transports from the same host process. */
  hostInstanceId?: string;
  /** Shared projected `ViewState`; called at most once per logical render. */
  getViewState(): ViewState;
  /** Command routing for validated non-evidence messages. */
  onMessage(msg: WebviewToHostMessage, context: RendererCommandContext): void;
  /** Release resources owned by the renderer generation being invalidated. */
  onRendererInvalidated?(rendererId: string, rendererGeneration: number): void;
  getRunningSessionCount(): number;
  settlementTimeoutMs?: number;
  commitTimeoutMs?: number;
  retryDelayMs?: number;
  maxRetryAttempts?: number;
  acceptedLedgerCapacity?: number;
}

export class RendererHub implements DisposableLike {
  private readonly sessions: Record<string, RendererSession> = {};
  private readonly clock: StateDeliveryClock;
  /** Shared extension-host incarnation (browser server plan §5.1): every
   *  renderer session carries the same `hostInstanceId`; per-renderer
   *  identity is `rendererId`/`rendererGeneration`. */
  private readonly hostInstanceId: string;
  private scheduleTimer: unknown = undefined;
  /** Shared projected state body; lazily refreshed at the first snapshot
   *  build after a schedule so N renderers share one projection per logical
   *  render. */
  private sharedViewState: ViewState | null = null;
  private sharedStateDirty = true;
  private streamingDebounceMs = STREAMING_SCHEDULE_DEBOUNCE_MS;
  private disposed = false;

  constructor(private readonly options: RendererHubOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.hostInstanceId = options.hostInstanceId ?? crypto.randomUUID();
  }

  /** Debounced fan-out of one logical render to every renderer session. */
  scheduleState(): void {
    if (this.disposed) return;
    this.sharedStateDirty = true;
    let needsDebounce = false;
    for (const session of Object.values(this.sessions)) {
      if (!session.canPostSnapshotToView() || !session.isVisible()) {
        // Blocked/hidden renderers record dirty now; eligible ones debounce.
        session.markDirty();
      } else {
        needsDebounce = true;
      }
    }
    if (!needsDebounce || this.scheduleTimer !== undefined) return;
    const debounceMs = this.options.getRunningSessionCount() > 0
      ? this.streamingDebounceMs
      : SCHEDULE_DEBOUNCE_MS;
    this.scheduleTimer = this.clock.setTimeout(() => {
      this.scheduleTimer = undefined;
      if (this.disposed) return;
      for (const session of Object.values(this.sessions)) session.markDirty();
    }, debounceMs);
  }

  /** Interaction-critical selection fan-out (bounded fast path). */
  scheduleSelectionState(): void {
    if (this.disposed) return;
    this.sharedStateDirty = true;
    this.clearScheduleTimer();
    for (const session of Object.values(this.sessions)) session.markPriorityDirty();
  }

  /** One immediate authoritative snapshot for a specific renderer. The
   *  pending broadcast (if any) is still owed to every other renderer: the
   *  debounce timer is cleared and the target posts now, while the remaining
   *  sessions are marked dirty so the shared logical render is not lost.
   *  Without a pending broadcast, requestState is strictly renderer-scoped.
   *  `'all'` posts every session immediately (no debounce). */
  requestState(target: RendererTarget): void {
    if (this.disposed) return;
    this.sharedStateDirty = true;
    if (target === 'all') {
      this.clearScheduleTimer();
      for (const session of Object.values(this.sessions)) session.requestState();
      return;
    }
    const hadPendingBroadcast = this.scheduleTimer !== undefined;
    this.clearScheduleTimer();
    const session = this.sessions[target];
    session?.requestState();
    if (hadPendingBroadcast) {
      for (const [rendererId, other] of Object.entries(this.sessions)) {
        if (rendererId !== target) other.markDirty();
      }
    }
  }

  isRendererOwnerCurrent(rendererId: string, viewGeneration: number, rendererGeneration: number): boolean {
    const session = this.sessions[rendererId];
    return session !== undefined
      && session.getViewGeneration() === viewGeneration
      && session.getRendererGeneration() === rendererGeneration;
  }

  /** Targeted or broadcast imperative. */
  postImperative(message: HostToWebviewMessage, target?: RendererTarget): void {
    if (this.disposed) return;
    if (target === undefined || target === 'all') {
      for (const session of Object.values(this.sessions)) session.postImperative(message);
      return;
    }
    this.sessions[target]?.postImperative(message);
  }

  registerRenderer(transport: RendererTransport): RendererRegistration {
    if (this.disposed) throw new Error('RendererHub is disposed.');
    const rendererId = crypto.randomUUID();
    const session = new RendererSession({
      rendererId,
      kind: transport.kind,
      hostInstanceId: this.hostInstanceId,
      clock: this.clock,
      getViewState: () => this.getSharedViewState(),
      onMessage: (msg, context) => this.options.onMessage(msg, context),
      onRendererInvalidated: this.options.onRendererInvalidated,
      getRunningSessionCount: this.options.getRunningSessionCount,
      transport,
      settlementTimeoutMs: this.options.settlementTimeoutMs,
      commitTimeoutMs: this.options.commitTimeoutMs,
      retryDelayMs: this.options.retryDelayMs,
      maxRetryAttempts: this.options.maxRetryAttempts,
      acceptedLedgerCapacity: this.options.acceptedLedgerCapacity,
    });
    this.sessions[rendererId] = session;
    // The session's dispose unregisters it from the registry (via the hub
    // callback below), so a replaced renderer (browser reconnect) never
    // accumulates stale entries. The adapter owns the transport lifecycle.
    session.setUnregisterHandler(() => {
      if (this.sessions[rendererId] === session) delete this.sessions[rendererId];
    });
    return session;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearScheduleTimer();
    for (const session of Object.values(this.sessions)) session.dispose();
    for (const key of Object.keys(this.sessions)) delete this.sessions[key];
  }

  /** Shared projected state body: one projection per logical render. */
  getSharedViewState(): ViewState {
    if (this.sharedStateDirty) {
      this.sharedViewState = this.options.getViewState();
      this.streamingDebounceMs = streamingScheduleDebounceMs(this.sharedViewState);
      this.sharedStateDirty = false;
    }
    return this.sharedViewState as ViewState;
  }

  private clearScheduleTimer(): void {
    if (this.scheduleTimer !== undefined) {
      this.clock.clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
  }
}
