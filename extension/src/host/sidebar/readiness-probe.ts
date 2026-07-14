import { bootLog } from '../util/audit';
import { appendPieLog } from '../util/pie-log';

/** Provisional values preserved pending real VS Code/Chromium calibration. */
export const READINESS_PROBE_INTERVAL_MS = 1_500;
export const READINESS_PROBE_MAX_ATTEMPTS = 40;
export const RELOAD_STUCK_SKIPS = 4;

export interface WebviewReadinessProbeDeps {
  getViewExists(): boolean;
  getViewVisible(): boolean;
  getWebviewReady(): boolean;
  getGlobalDirty(): boolean;
  isReloading(): boolean;
  /** Must route through StateDeliveryController.probe(), never post directly. */
  onProbe(): Promise<boolean> | boolean;
  onForceClearReloading(): void;
  onExhausted(): void;
}

/** Autonomous recovery for a stale webviewReady=false belief. */
export class WebviewReadinessProbe {
  private timer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private reloadingSkips = 0;
  private visible = true;
  private disposed = false;

  constructor(private readonly deps: WebviewReadinessProbeDeps) {}

  arm(): void {
    if (this.disposed || !this.visible || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, READINESS_PROBE_INTERVAL_MS);
  }

  /** Clear an episode after readiness succeeds or a view generation changes. */
  clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.attempts = 0;
    this.reloadingSkips = 0;
  }

  /** Hidden time consumes neither attempts nor reload-skip budget. */
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (!visible) {
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      return;
    }
    if (this.isStuck()) this.arm();
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }

  isArmed(): boolean {
    return this.timer !== undefined;
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.disposed || !this.visible || !this.deps.getViewVisible()) return;

    if (!this.isStuck()) {
      this.attempts = 0;
      this.reloadingSkips = 0;
      return;
    }

    if (this.deps.isReloading()) {
      this.reloadingSkips += 1;
      if (this.reloadingSkips < RELOAD_STUCK_SKIPS) {
        // Self-rearm: a quiet/idle reload cannot depend on another reducer event.
        this.arm();
        return;
      }
      this.deps.onForceClearReloading();
      this.reloadingSkips = 0;
      const context = { attempts: this.attempts };
      appendPieLog('warn', 'sidebar-provider', 'readiness probe force-cleared stale reload state', context);
      bootLog('sidebar-provider', 'readinessProbe.forceClearedReloading', context);
    } else {
      this.reloadingSkips = 0;
    }

    if (this.attempts >= READINESS_PROBE_MAX_ATTEMPTS) {
      const context = { attempts: this.attempts };
      appendPieLog('warn', 'sidebar-provider', 'readiness probe exhausted', context);
      bootLog('sidebar-provider', 'readinessProbe.exhausted', context);
      this.deps.onExhausted();
      return;
    }

    this.attempts += 1;
    let delivered = false;
    try {
      const result = this.deps.onProbe();
      delivered = typeof result === 'boolean' ? result : await result;
    } catch {
      // Classification only: never copy a rejected error body into telemetry.
      bootLog('sidebar-provider', 'readinessProbe.rejected', { attempt: this.attempts });
    }

    if (!delivered && this.isStuck() && this.visible && this.deps.getViewVisible()) {
      this.arm();
    } else if (delivered || !this.isStuck()) {
      this.attempts = 0;
      this.reloadingSkips = 0;
    }
  }

  private isStuck(): boolean {
    return this.deps.getViewExists()
      && !this.deps.getWebviewReady()
      && this.deps.getGlobalDirty();
  }
}
