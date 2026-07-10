import { bootLog } from '../util/audit';
import { appendPieLog } from '../util/pie-log';

/** Grace period before the first probe and interval between retries. Long
 *  enough that a normal `ready` handshake restores readiness first (so the
 *  probe does not fire on every benign reload), short enough that a stale
 *  belief self-heals well within a streaming turn. */
export const READINESS_PROBE_INTERVAL_MS = 1_500;
/** Cap probe attempts so a genuinely-unresponsive webview does not spin
 *  forever. At 1.5s intervals this bounds probing to ~60s; beyond that the
 *  next visibility transition / user refocus / watchdog force-reload handles
 *  recovery. */
export const READINESS_PROBE_MAX_ATTEMPTS = 40;
/** Consecutive reloading-skips after which a reload is treated as stale (a
 *  reload loop whose every `ready` is consumed by the asset-mismatch branch,
 *  or a lost `ready` from a renderer that never finished loading) and
 *  force-cleared, so the probe can heal the stall it exists to heal. At 1.5s
 *  intervals this is ~6s — well beyond any legitimate reload (re-render +
 *  renderer load, typically <2s) but well inside an annoying freeze. Without
 *  this, `tick()` would bail on every firing while `reloading` is stuck, never
 *  increment `attempts`, and never heal — and with the watchdog force-reload
 *  suppressed while streaming, the webview would freeze until the user
 *  interrupts. */
export const RELOAD_STUCK_SKIPS = 4;

export interface WebviewReadinessProbeDeps {
  getViewExists(): boolean;
  getWebviewReady(): boolean;
  getGlobalDirty(): boolean;
  /** Whether a webview reload is in progress (reload start → next
   *  bridge-ready). The probe must not post to / adopt readiness from a
   *  renderer being replaced — it would skip the new renderer's `ready`
   *  bridge-ready block (missed imperative flush + resnapshot-flag reset). */
  isReloading(): boolean;
  /** Push the pending snapshot to the webview despite a stale `webviewReady=false`
   *  belief. Resolves true if the webview accepted it (delivered) — the belief
   *  was stale and the caller has adopted readiness. May return a boolean
   *  synchronously (kept on the fast path; no microtask yield). */
  onProbe(): Promise<boolean> | boolean;
  /** Force-clear a stale `reloading` flag. Called once a reload has been "in
   *  progress" past {@link RELOAD_STUCK_SKIPS} consecutive probe skips — a
   *  reload loop or a lost `ready` — so the probe can post and adopt readiness,
   *  healing the stall. */
  onForceClearReloading(): void;
}

/**
 * Self-heal for a stale `webviewReady=false` belief in the sidebar provider.
 *
 * `canPostSnapshotToView()` gates posting on `hasView && webviewReady`.
 * `webviewReady` is the host's *belief*: it flips `false` on every webview
 * reload (asset-version mismatch, hot reload, watchdog force-reload) and is
 * restored only by an inbound `ready`/`refreshState` message reaching the
 * readiness setter. If that handshake does not restore it — a lost `ready`, or
 * an asset-version reload loop whose handshake is consumed by the mismatch
 * branch before the readiness setter — the host marks `globalDirty` and posts
 * nothing indefinitely. The agent keeps advancing host-side while the webview
 * freezes on its last frame, recovered only when the user refocuses (whose
 * `refreshState` restores readiness): the "transcript doesn't refresh until I
 * click the panel" freeze.
 *
 * The probe breaks that silent stall: while the view exists, readiness is
 * believed false, and state is dirty, it periodically pushes the pending
 * snapshot directly and adopts `postMessage`'s `delivered=true` as the
 * readiness signal. `postMessage` resolves `true` iff the webview is alive and
 * will receive the message, so a delivered probe proves readiness and un-sticks
 * the post loop without user interaction. Bounded by
 * {@link READINESS_PROBE_MAX_ATTEMPTS} so a genuinely-unresponsive webview does
 * not spin indefinitely (left to the watchdog force-reload / visibility
 * transitions).
 */
export class WebviewReadinessProbe {
  private timer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private reloadingSkips = 0;

  constructor(private readonly deps: WebviewReadinessProbeDeps) {}

  /** Arm a one-shot probe (no-op if already armed). Idempotent. */
  arm(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, READINESS_PROBE_INTERVAL_MS);
  }

  /** Cancel any pending probe and reset the attempt counter. */
  clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.attempts = 0;
    this.reloadingSkips = 0;
  }

  /** Alias for {@link clear} (mirrors `StateAppliedWatchdog.dispose`). */
  dispose(): void {
    this.clear();
  }

  isArmed(): boolean {
    return this.timer !== undefined;
  }

  private async tick(): Promise<void> {
    this.timer = undefined;

    // No longer stuck (view gone, readiness restored, or nothing pending) —
    // reset and stop. The common exit: a normal `ready` handshake restored
    // readiness between arming and firing.
    if (!this.deps.getViewExists() || this.deps.getWebviewReady() || !this.deps.getGlobalDirty()) {
      this.attempts = 0;
      this.reloadingSkips = 0;
      return;
    }

    // A reload is in progress — the renderer is being replaced. For the first
    // few skips we honour that: don't post to a dying/loading renderer; the
    // reload's `ready` handshake owns readiness, and `scheduleState` re-arms
    // once it settles if still stuck. But a reload that never settles (a reload
    // loop whose every `ready` is consumed by the asset-mismatch branch, or a
    // lost `ready` from a renderer that never finished loading) would otherwise
    // trap the probe here forever — `attempts` never increments on a skip, so
    // the probe neither heals nor exhausts, and with the watchdog force-reload
    // suppressed while streaming the webview freezes until the user interrupts.
    // Past the stuck threshold we treat `reloading` as stale, force-clear it,
    // and fall through to the probe below so the self-heal actually fires.
    if (this.deps.isReloading()) {
      this.reloadingSkips += 1;
      if (this.reloadingSkips < RELOAD_STUCK_SKIPS) {
        return;
      }
      this.deps.onForceClearReloading();
      this.reloadingSkips = 0;
      const forceClearContext = { attempts: this.attempts };
      appendPieLog('warn', 'sidebar-provider', 'readiness probe force-cleared stale reloading flag', forceClearContext);
      bootLog('sidebar-provider', 'readinessProbe.forceClearedReloading', forceClearContext);
      // fall through — post and adopt readiness as normal.
    } else {
      this.reloadingSkips = 0;
    }

    if (this.attempts >= READINESS_PROBE_MAX_ATTEMPTS) {
      const exhaustedContext = { attempts: this.attempts };
      appendPieLog('warn', 'sidebar-provider', 'readiness probe exhausted; webview may be unresponsive', exhaustedContext);
      bootLog('sidebar-provider', 'readinessProbe.exhausted', exhaustedContext);
      return;
    }

    this.attempts += 1;
    // Stay on the synchronous fast path when the caller returns a boolean
    // (unit-testable without microtask plumbing); only await a real promise.
    const maybe = this.deps.onProbe();
    const delivered = typeof maybe === 'boolean' ? maybe : await maybe;

    // `onProbe` adopted readiness (delivered=true) ⇒ the normal post loop
    // resumes; no need to re-arm. Otherwise back off and retry while still
    // stuck.
    if (
      !delivered
      && this.deps.getViewExists()
      && !this.deps.getWebviewReady()
      && this.deps.getGlobalDirty()
    ) {
      this.arm();
    } else {
      this.attempts = 0;
    }
  }
}
