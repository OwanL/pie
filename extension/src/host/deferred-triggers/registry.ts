import { randomUUID } from 'node:crypto';

import { createLocalMessageId } from '../../shared/local-message-id';
import type { ArchState } from '../core/arch-state';
import type { Event } from '../core/events';
import {
  appendTriggerOp,
  readTriggerOps,
  replayTriggers,
  startTriggerWatcher,
  type ActiveTrigger,
  type TriggerSpec,
} from './store';

/**
 * Host-side deferred-trigger registry.
 *
 * Owns the in-memory active-trigger set (replayed from the sidecar) and fires a
 * trigger when its condition is met. On fire, it dispatches a synthetic
 * `Send` Command into the watcher's session — the same path a user-typed
 * message takes — so the agent resumes with a wake-up message. If the watcher
 * is busy, the existing `message.send` → `followUp` path queues the wake-up
 * after the current turn.
 *
 * Trigger types:
 *  - `session_finished`: fires when a session (specific path, or any) finishes
 *    streaming. Never fires on the watcher's OWN session (avoids a self-wake
 *    loop when the watcher's own deferring turn ends).
 *  - `timer`: fires after `ms`. Re-armed on reload using the remaining time.
 *  - `user_input`: fires when the user sends a message in the watcher's session
 *    (the literal "resume on type").
 *
 * Multiple specs in one trigger use OR semantics: the first to fire wins and
 * consumes the whole trigger.
 */
export interface DeferredTriggerRegistryDeps {
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
  /** Schedule a webview re-render after the active-trigger set changes (register
   *  via sidecar watcher, cancel, or fire). The active set is projected into
   *  `ViewState.deferredTriggers` by `PieExtension.buildViewState`, so a render
   *  must be requested whenever it mutates — `fire`'s wake-up dispatch only
   *  renders when the watcher's tab is open, and a sidecar `register`/`cancel`
   *  by the backend tool otherwise wouldn't surface. Optional (tests omit it). */
  scheduleRender?: () => void;
  /** Override the sidecar watcher (tests pass a no-op to avoid `fs.watch`).
   *  Defaults to {@link startTriggerWatcher}. */
  startWatcher?: () => () => void;
}

/** Prefix on the synthetic wake-up `Send` corrId (debugging + future filtering). */
const TRIGGER_CORR_PREFIX = 'deferred-trigger:';

export class DeferredTriggerRegistry {
  private readonly triggers = new Map<string, ActiveTrigger>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopWatcher?: () => void;

  constructor(private readonly deps: DeferredTriggerRegistryDeps) {}

  /** Load the sidecar + start watching for changes. Idempotent — safe to call
   *  again on `restart()` (the registry survives backend restarts). */
  start(): void {
    if (this.stopWatcher) return;
    this.reload();
    const start = this.deps.startWatcher ?? (() => startTriggerWatcher(() => this.reload()));
    this.stopWatcher = start();
  }

  /** A session finished streaming (busy → false). Fires matching `session_finished` triggers. */
  onSessionFinished(finishedPath: string): void {
    for (const [id, t] of [...this.triggers.entries()]) {
      // Never self-wake: a session finishing its own deferring turn must not
      // trigger a `session_finished` wake on itself.
      if (t.sessionPath === finishedPath) continue;
      const spec = t.triggers.find(
        (s) =>
          s.kind === 'session_finished' &&
          (s.sessionPath === undefined || s.sessionPath === finishedPath),
      );
      if (spec) {
        const reason =
          spec.sessionPath === undefined
            ? 'session finished (any open session)'
            : `session finished: ${spec.sessionPath}`;
        this.fire(id, reason);
      }
    }
  }

  /** The user sent a message in `sessionPath` (webview Send path). Fires `user_input` triggers. */
  onUserInput(sessionPath: string): void {
    for (const [id, t] of [...this.triggers.entries()]) {
      if (t.sessionPath !== sessionPath) continue;
      if (t.triggers.some((s) => s.kind === 'user_input')) {
        this.fire(id, 'user input received in this session');
      }
    }
  }

  /** Snapshot of the currently-active triggers, for projection into
   *  `ViewState.deferredTriggers`. Returns a fresh array (the caller
   *  serializes it across the postMessage boundary, so internal mutation
   *  after the snapshot is harmless). */
  getActiveTriggers(): ActiveTrigger[] {
    return Array.from(this.triggers.values());
  }

  /** Cancel a trigger (or all triggers for `sessionPath` when `targetId` is
   *  omitted). Mirrors the `defer_trigger` tool's `cancel` action: appends a
   *  `cancel` op to the sidecar and updates the in-memory set immediately so
   *  the webview reflects the removal without waiting for the debounced
   *  sidecar watcher. Best-effort persist (see `fire`). */
  cancel(sessionPath: string, targetId?: string): void {
    if (targetId) {
      this.clearTimer(targetId);
      this.triggers.delete(targetId);
    } else {
      for (const [id, t] of [...this.triggers.entries()]) {
        if (t.sessionPath === sessionPath) {
          this.clearTimer(id);
          this.triggers.delete(id);
        }
      }
    }
    try {
      appendTriggerOp({ op: 'cancel', sessionPath, targetId, at: new Date().toISOString() });
    } catch {
      // Sidecar unavailable (env unset) or write error — in-memory is still
      // cleared; a later reload may re-arm from the sidecar's register op
      // (the same acceptable rare case as `fire`).
    }
    this.deps.scheduleRender?.();
  }

  /** Fire a trigger: persist a `fire` op, deliver the wake-up, disarm. No-op if already fired/cancelled. */
  fire(id: string, reason: string): void {
    const t = this.triggers.get(id);
    if (!t) return;
    this.clearTimer(id);
    this.triggers.delete(id);
    // Persist the fire so a restart does not re-arm an already-consumed trigger.
    // Best-effort: if the append fails (sidecar unavailable or write error),
    // the in-memory state is still consumed (deleted above); a later reload
    // may then re-arm from the sidecar's register op — an acceptable rare case
    // (idempotent `fire` guards against double-delivery within one process).
    try {
      appendTriggerOp({
        id,
        op: 'fire',
        sessionPath: t.sessionPath,
        reason,
        at: new Date().toISOString(),
      });
    } catch {
      // Sidecar unavailable (env unset) or write error — see comment above.
    }
    if (this.deps.getArchState().sessions.openTabPaths.includes(t.sessionPath)) {
      this.dispatchWakeUp(t, reason);
    }
    // Watcher's tab no longer open → skip delivery; the trigger is consumed regardless.
    // Request a render so the active-set change (trigger removed) is reflected
    // in `ViewState.deferredTriggers` even when delivery was skipped (tab closed).
    this.deps.scheduleRender?.();
  }

  private dispatchWakeUp(t: ActiveTrigger, reason: string): void {
    const note = t.note.trim() || '(no note provided)';
    const text =
      `[deferred trigger fired: ${reason}]\n\n` +
      'A deferred trigger you registered fired. Re-evaluate your pending task and either complete it now or call `defer_trigger` with action `register` again to keep waiting.\n\n' +
      `Task note:\n${note}`;
    this.deps.dispatchArch({
      kind: 'Command',
      cmd: {
        kind: 'Send',
        corrId: `${TRIGGER_CORR_PREFIX}${randomUUID()}`,
        sessionPath: t.sessionPath,
        text,
        inputs: [],
        composedText: text,
        localId: createLocalMessageId('send'),
        previousSummary: null,
        timestamp: Date.now(),
        // Tag the optimistic user message so the webview can render it as an
        // auto-resume rather than a typed message. Not forwarded to the
        // backend RPC; `mapUserMessage` re-derives this from the text prefix
        // on reload (the SDK persists user messages without custom metadata).
        customType: 'deferred-trigger',
        customDetails: { reason },
      },
    });
  }

  /** Re-read the sidecar and sync in-memory state (add new, drop gone, keep timers for persistent ids). */
  private reload(): void {
    const next = replayTriggers(readTriggerOps());
    for (const id of [...this.triggers.keys()]) {
      if (!next.has(id)) {
        this.clearTimer(id);
        this.triggers.delete(id);
      }
    }
    for (const [id, t] of next) {
      if (this.triggers.has(id)) continue; // already tracked; keep its timer
      this.triggers.set(id, t);
      this.armTimer(t);
    }
    // Surface sidecar-driven changes (a `register`/`cancel` appended by the
    // backend `defer_trigger` tool, or a `fire`/`cancel` from another host
    // instance) to the webview. The watcher debounces ~200ms, so this fires
    // once per settled sidecar change.
    this.deps.scheduleRender?.();
  }

  private armTimer(t: ActiveTrigger): void {
    const timerSpecs = t.triggers.filter(isTimerSpec);
    if (timerSpecs.length === 0) return;
    // OR semantics across specs: the earliest deadline wins (a trigger with
    // multiple timer specs fires at the shortest delay, not the first listed).
    const spec = timerSpecs.reduce((a, b) => (a.ms <= b.ms ? a : b));
    const registeredAt = Date.parse(t.registeredAt);
    const base = Number.isFinite(registeredAt) ? registeredAt : Date.now();
    const remaining = base + spec.ms - Date.now();
    const fire = (): void => this.fire(t.id, `timer elapsed after ${spec.ms}ms`);
    if (remaining <= 0) {
      // Already elapsed (e.g. process was down) — fire on the next tick to
      // avoid re-entrancy during reload.
      setImmediate(fire);
      return;
    }
    this.timers.set(t.id, setTimeout(fire, remaining));
  }

  private clearTimer(id: string): void {
    const handle = this.timers.get(id);
    if (handle) {
      clearTimeout(handle);
      this.timers.delete(id);
    }
  }

  dispose(): void {
    this.stopWatcher?.();
    this.stopWatcher = undefined;
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
    this.triggers.clear();
  }
}

function isTimerSpec(s: TriggerSpec): s is TriggerSpec & { kind: 'timer'; ms: number } {
  return s.kind === 'timer' && typeof s.ms === 'number' && s.ms > 0;
}
