import { randomUUID } from 'node:crypto';

import { createLocalMessageId } from '../../shared/local-message-id';
import type { DeferredTriggerView } from '../../shared/protocol';
import type { ArchState } from '../core/arch-state';
import type { Event } from '../core/events';
import {
  checkProcessOwnerLiveness,
  DeferredTriggerStore,
  replayTriggers,
  startTriggerWatcher,
  type ActiveTrigger,
  type CheckClaimOwnerLiveness,
  type TriggerClaim,
  type TriggerSpec,
} from './store';

/**
 * Host-side deferred-trigger registry.
 *
 * Owns the in-memory active-trigger set (replayed from the sidecar) and fires a
 * trigger when its condition is met. Timer/session-finished fires dispatch a
 * synthetic `Send`; user_input is consumed by the real prompt and never adds
 * a second Send. Durable filesystem claims prevent two host processes from
 * dispatching the same trigger.
 *
 * Trigger types:
 *  - `session_finished`: fires when a session (specific path, or any) finishes
 *    streaming. Never fires on the watcher's OWN session (avoids a self-wake
 *    loop when the watcher's own deferring turn ends).
 *  - `timer`: fires after `ms`. Re-armed on reload using the remaining time.
 *  - `user_input`: is consumed when the user sends a real message in the
 *    watcher's session (the literal "resume on type").
 *
 * Multiple specs in one trigger use OR semantics: the first to fire wins and
 * consumes the whole trigger.
 */
export interface DeferredTriggerRegistryDeps {
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
  getBackendGeneration?: () => number;
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
  /** Store/identity injection makes cross-registry races deterministic in tests. */
  store?: DeferredTriggerStore;
  instanceId?: string;
  /** OS ownership/liveness injection for deterministic crash-recovery tests. */
  ownerPid?: number;
  checkOwnerLiveness?: CheckClaimOwnerLiveness;
}

/** Prefix on the synthetic wake-up `Send` corrId (debugging + future filtering). */
const TRIGGER_CORR_PREFIX = 'deferred-trigger:';

/** Node clamps larger setTimeout delays to 1ms, which would make a timer over
 *  ~24.8 days fire immediately. Long deadlines are therefore scheduled in
 *  bounded slices and checked against their absolute deadline after each one. */
export const MAX_TIMER_SLICE_MS = 2_147_483_647;

export function boundedTimerSlice(remainingMs: number): number {
  return Math.max(1, Math.min(remainingMs, MAX_TIMER_SLICE_MS));
}

export class DeferredTriggerRegistry {
  private readonly triggers = new Map<string, ActiveTrigger>();
  private readonly timers = new Map<string, NodeJS.Timeout | NodeJS.Immediate>();
  private readonly pendingClaimsByCorrId = new Map<string, TriggerClaim[]>();
  private readonly attemptedAutomaticRecoveries = new Set<string>();
  private readonly store: DeferredTriggerStore;
  private readonly instanceId: string;
  private readonly ownerPid: number;
  private readonly checkOwnerLiveness: CheckClaimOwnerLiveness;
  private stopWatcher?: () => void;

  constructor(private readonly deps: DeferredTriggerRegistryDeps) {
    this.store = deps.store ?? new DeferredTriggerStore();
    this.instanceId = deps.instanceId ?? randomUUID();
    this.ownerPid = deps.ownerPid ?? process.pid;
    this.checkOwnerLiveness = deps.checkOwnerLiveness ?? checkProcessOwnerLiveness;
  }

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
    // The backend can append a register op immediately before this event while
    // the debounced fs.watch callback is still pending. Reconcile synchronously
    // at event boundaries so a newly registered trigger cannot miss its only
    // matching event.
    this.reload();
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

  /** The user sent a real message in `sessionPath`. That already-dispatched
   * prompt is the wake-up: consume matching triggers without dispatching a
   * second synthetic Send. */
  onUserInput(sessionPath: string, corrId: string): void {
    // See onSessionFinished: the sidecar writer and this host event can be
    // adjacent, so do not rely solely on the debounced filesystem watcher.
    this.reload();
    for (const [id, t] of [...this.triggers.entries()]) {
      if (t.sessionPath !== sessionPath) continue;
      if (t.triggers.some((s) => s.kind === 'user_input')) {
        this.consumeWithClaim(id, 'user input received in this session', corrId);
      }
    }
  }

  /** Snapshot of the currently-active triggers, for projection into
   * `ViewState.deferredTriggers`. Internal claim ids never cross the renderer
   * boundary. */
  getActiveTriggers(): DeferredTriggerView[] {
    return Array.from(
      this.triggers.values(),
      ({
        claimId: _claimId,
        claimOwnerId: _claimOwnerId,
        claimOwnerPid: _claimOwnerPid,
        claimAt: _claimAt,
        dispatchStartedAt: _dispatchStartedAt,
        wakeReason: _wakeReason,
        ...trigger
      }) => trigger,
    );
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
      this.store.append({ op: 'cancel', sessionPath, targetId, at: new Date().toISOString() });
    } catch {
      // Sidecar unavailable (env unset) or write error — in-memory is still
      // cleared; a later reload may re-arm from the sidecar's register op
      // (the same acceptable rare case as `fire`).
    }
    this.deps.scheduleRender?.();
  }

  /** Fire a timer/session-finished trigger through a durable cross-host claim.
   * Closed-tab and definite dispatch failures leave the trigger retryable. */
  fire(id: string, reason: string): void {
    const trigger = this.triggers.get(id);
    if (!trigger || trigger.deliveryState === 'claimed') return;
    if (!this.deps.getArchState().sessions.openTabPaths.includes(trigger.sessionPath)) {
      const detail = 'watcher tab is closed; delivery remains retryable';
      try {
        this.store.recordDeliveryFailure(id, trigger.sessionPath, reason, detail);
      } catch {
        // If even failure persistence is unavailable, retaining the in-memory
        // trigger is safer than silently consuming it.
      }
      this.clearTimer(id);
      this.triggers.set(id, { ...trigger, deliveryState: 'retryable', deliveryDetail: detail });
      this.deps.scheduleRender?.();
      return;
    }
    const corrId = `${TRIGGER_CORR_PREFIX}${randomUUID()}`;
    this.consumeWithClaim(
      id,
      reason,
      corrId,
      (claimedTrigger) => this.dispatchWakeUp(claimedTrigger, reason, corrId),
    );
  }

  /** Settle claims when the ordinary Send lifecycle reports whether the prompt
   * was accepted. This includes both synthetic wakes and real user_input. */
  onSendResult(corrId: string, ok: boolean, error?: string): void {
    const claims = this.pendingClaimsByCorrId.get(corrId);
    if (!claims) return;
    this.pendingClaimsByCorrId.delete(corrId);
    for (const claim of claims) {
      try {
        if (ok) {
          this.store.completeClaim(claim);
        } else {
          this.store.releaseClaim(claim, error || 'send was rejected; delivery remains retryable');
        }
      } catch {
        // A completion/release persistence failure retains the claim artifact,
        // making the ambiguous attempt visible without permitting a duplicate.
      }
    }
    this.reload();
    this.deps.scheduleRender?.();
  }

  /** Retry retained synthetic wakes after their watcher tab is opened again. */
  onSessionOpened(sessionPath: string): void {
    this.reload();
    for (const [id, trigger] of [...this.triggers.entries()]) {
      if (trigger.sessionPath !== sessionPath || trigger.deliveryState !== 'retryable') continue;
      if (trigger.triggers.some((spec) => spec.kind === 'timer' || spec.kind === 'session_finished')) {
        this.fire(id, trigger.wakeReason ?? 'retrying deferred-trigger delivery');
      }
    }
  }

  private consumeWithClaim(
    id: string,
    reason: string,
    corrId: string,
    deliver?: (trigger: ActiveTrigger) => void,
  ): void {
    const trigger = this.triggers.get(id);
    if (!trigger || trigger.deliveryState === 'claimed') return;

    let claim: TriggerClaim | undefined;
    try {
      // `user_input` arrives only after the real prompt was dispatched, so its
      // initial artifact must be acknowledgement-ambiguous. Synthetic wakes
      // cross that boundary separately immediately before dispatch.
      claim = this.store.tryClaim(
        id,
        trigger.sessionPath,
        this.instanceId,
        this.ownerPid,
        reason,
        deliver === undefined,
      );
    } catch {
      try {
        this.store.recordDeliveryFailure(
          id,
          trigger.sessionPath,
          reason,
          'durable claim failed; delivery remains retryable',
        );
      } catch {
        // The sidecar itself is unavailable; retain the in-memory trigger.
      }
      this.reload();
      return;
    }
    if (!claim) {
      this.reload();
      return;
    }

    // A tab can close after the pre-claim check but before dispatch. User-input
    // consumption has no synthetic delivery: the real prompt already proved
    // delivery and is the sole Send for this wake.
    if (deliver && !this.deps.getArchState().sessions.openTabPaths.includes(trigger.sessionPath)) {
      this.releaseClaim(claim, 'watcher tab closed before dispatch; delivery remains retryable');
      return;
    }

    const pending = this.pendingClaimsByCorrId.get(corrId) ?? [];
    pending.push(claim);
    this.pendingClaimsByCorrId.set(corrId, pending);
    try {
      if (deliver) this.store.markDispatchStarted(claim);
      deliver?.(trigger);
    } catch {
      const remaining = pending.filter((candidate) => candidate.claimId !== claim.claimId);
      if (remaining.length > 0) this.pendingClaimsByCorrId.set(corrId, remaining);
      else this.pendingClaimsByCorrId.delete(corrId);
      this.releaseClaim(claim, 'host dispatch failed; delivery remains retryable');
      return;
    }

    // The claim remains durable until SendResult proves acceptance or definite
    // rejection. Merely enqueueing a Command is not delivery completion.
    this.reload();
    this.deps.scheduleRender?.();
  }

  private releaseClaim(claim: TriggerClaim, reason: string): void {
    try {
      this.store.releaseClaim(claim, reason);
    } catch {
      // A failed release remains claimed (visible and non-duplicating) rather
      // than pretending the trigger is safely retryable.
    }
    this.reload();
    this.deps.scheduleRender?.();
  }

  private dispatchWakeUp(t: ActiveTrigger, reason: string, corrId: string): void {
    const note = t.note.trim() || '(no note provided)';
    const text =
      `[deferred trigger fired: ${reason}]\n\n` +
      'A deferred trigger you registered fired. Re-evaluate your pending task and either complete it now or call `defer_trigger` with action `register` again to keep waiting.\n\n' +
      `Task note:\n${note}`;
    this.deps.dispatchArch({
      kind: 'Command',
      cmd: {
        kind: 'Send',
        corrId,
        operationId: randomUUID(),
        operationAttempt: 1,
        operationSource: { kind: 'host' },
        backendGeneration: this.deps.getBackendGeneration?.() ?? 0,
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
    try {
      // Only a confirmed-dead process owner whose durable dispatch boundary
      // was never crossed is safe to release. Healthy, unknown/legacy, and
      // acknowledgement-ambiguous claims remain fail-closed.
      this.store.recoverDeadOwnerClaims(this.checkOwnerLiveness);
    } catch {
      // Recovery is best-effort and fail-closed: the old artifact remains the
      // authority if liveness checking or durable release fails.
    }
    const next = replayTriggers(this.store.readOps());
    for (const id of [...this.triggers.keys()]) {
      if (!next.has(id)) {
        this.clearTimer(id);
        this.attemptedAutomaticRecoveries.delete(id);
        this.triggers.delete(id);
      }
    }
    for (const [id, trigger] of next) {
      this.triggers.set(id, trigger);
      if (
        trigger.deliveryState === 'retryable'
        && trigger.recoveryState === 'dead-owner-recovered'
        && trigger.triggers.some((spec) => spec.kind === 'timer' || spec.kind === 'session_finished')
        && this.deps.getArchState().sessions.openTabPaths.includes(trigger.sessionPath)
      ) {
        // A stale local deadline may still be armed if this registry missed
        // the foreign claim before observing its recovery. Safe recovery owns
        // an immediate retry rather than waiting for that unrelated deadline.
        if (!this.attemptedAutomaticRecoveries.has(id)) {
          this.clearTimer(id);
          this.scheduleRecoveredDelivery(trigger);
        }
      } else if (trigger.deliveryState !== 'pending') {
        this.clearTimer(id);
      } else if (!this.timers.has(id)) {
        this.armTimer(trigger);
      }
    }
    // Surface sidecar-driven changes (a `register`/`cancel` appended by the
    // backend `defer_trigger` tool, or a `fire`/`cancel` from another host
    // instance) to the webview. The watcher debounces ~200ms, so this fires
    // once per settled sidecar change.
    this.deps.scheduleRender?.();
  }

  private scheduleRecoveredDelivery(trigger: ActiveTrigger): void {
    if (this.timers.has(trigger.id) || this.attemptedAutomaticRecoveries.has(trigger.id)) return;
    this.attemptedAutomaticRecoveries.add(trigger.id);
    const handle = setImmediate(() => {
      this.timers.delete(trigger.id);
      const current = this.triggers.get(trigger.id);
      if (
        current?.deliveryState !== 'retryable'
        || current.recoveryState !== 'dead-owner-recovered'
      ) {
        return;
      }
      this.fire(current.id, current.wakeReason ?? 'retrying delivery after host recovery');
    });
    this.timers.set(trigger.id, handle);
  }

  private armTimer(t: ActiveTrigger): void {
    const timerSpecs = t.triggers.filter(isTimerSpec);
    if (timerSpecs.length === 0) return;
    // OR semantics across specs: the earliest deadline wins (a trigger with
    // multiple timer specs fires at the shortest delay, not the first listed).
    const spec = timerSpecs.reduce((a, b) => (a.ms <= b.ms ? a : b));
    const registeredAt = Date.parse(t.registeredAt);
    const base = Number.isFinite(registeredAt) ? registeredAt : Date.now();
    const deadline = base + spec.ms;
    const fire = (): void => this.fire(t.id, `timer elapsed after ${spec.ms}ms`);
    const scheduleNextSlice = (): void => {
      if (!this.triggers.has(t.id)) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        fire();
        return;
      }
      this.timers.set(t.id, setTimeout(scheduleNextSlice, boundedTimerSlice(remaining)));
    };
    if (deadline <= Date.now()) {
      // Already elapsed (e.g. process was down) — fire on the next turn to
      // avoid re-entrancy during reload. Track the immediate so a claim/reload
      // can disarm it just like a future timer.
      this.timers.set(t.id, setImmediate(fire));
      return;
    }
    scheduleNextSlice();
  }

  private clearTimer(id: string): void {
    const handle = this.timers.get(id);
    if (handle) {
      clearTimeout(handle as NodeJS.Timeout);
      clearImmediate(handle as NodeJS.Immediate);
      this.timers.delete(id);
    }
  }

  dispose(): void {
    this.stopWatcher?.();
    this.stopWatcher = undefined;
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
    this.triggers.clear();
    this.pendingClaimsByCorrId.clear();
    this.attemptedAutomaticRecoveries.clear();
  }
}

function isTimerSpec(s: TriggerSpec): s is TriggerSpec & { kind: 'timer'; ms: number } {
  return s.kind === 'timer' && typeof s.ms === 'number' && s.ms > 0;
}
