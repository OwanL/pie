/**
 * Source-aware inline confirmations (browser server plan §2.2/§9).
 *
 * The minimal M2 confirmation capability for browser sources: model-switch
 * confirm and destructive `revertFile` run through a host-owned inline
 * confirmation imperative delivered to the INITIATING browser renderer. The
 * host proceeds only on that renderer's explicit `inlineConfirmResponse`;
 * disconnect cancels the pending confirmation. The VS Code adapter keeps its
 * native modals for VS Code sources; this service is never used for a VS Code
 * source (the effect runner routes by the trusted source context).
 */

import * as crypto from 'node:crypto';

import type { HostToWebviewMessage } from '../../shared/protocol';

/** Default time bound for a pending inline confirmation. */
export const INLINE_CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

export interface InlineConfirmRequest {
  kind: 'model-switch' | 'destructive-revert';
  sessionPath?: string;
  message: string;
  confirmChoice: string;
}

export interface InlineConfirmationServiceOptions {
  /** Post a targeted imperative to one renderer (hub.postImperative). */
  postToRenderer(rendererId: string, message: HostToWebviewMessage): void;
  now?: () => number;
  timeoutMs?: number;
  /** Deterministic timers for tests. */
  setTimeout?(callback: () => void, delayMs: number): unknown;
  clearTimeout?(handle: unknown): void;
}

interface PendingConfirm {
  confirmId: string;
  resolve: (confirmed: boolean) => void;
  timer: unknown;
}

/**
 * Per-renderer pending confirmation registry. `request()` returns a promise
 * that resolves `true` only on the initiating renderer's explicit
 * `confirmed: true` response; `false` on explicit decline, timeout, or
 * disconnect (`cancelForRenderer`).
 */
export class InlineConfirmationService {
  private readonly pendingByRenderer = new Map<string, Map<string, PendingConfirm>>();
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly options: InlineConfirmationServiceOptions) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? INLINE_CONFIRM_TIMEOUT_MS;
  }

  /** Open a confirmation for one renderer; resolves with the explicit
   *  decision (false on decline, timeout, or disconnect). */
  request(rendererId: string, request: InlineConfirmRequest): Promise<boolean> {
    const confirmId = crypto.randomUUID();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (confirmed: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.clearTimer(timer);
        const byRenderer = this.pendingByRenderer.get(rendererId);
        byRenderer?.delete(confirmId);
        if (byRenderer && byRenderer.size === 0) this.pendingByRenderer.delete(rendererId);
        resolve(confirmed);
      };
      const timer = this.setTimer(() => settle(false), this.timeoutMs);
      const entry: PendingConfirm = { confirmId, resolve: settle, timer };
      let byRenderer = this.pendingByRenderer.get(rendererId);
      if (!byRenderer) {
        byRenderer = new Map();
        this.pendingByRenderer.set(rendererId, byRenderer);
      }
      byRenderer.set(confirmId, entry);
      this.options.postToRenderer(rendererId, {
        type: 'inlineConfirm',
        confirmId,
        kind: request.kind,
        ...(request.sessionPath !== undefined ? { sessionPath: request.sessionPath } : {}),
        message: request.message,
        confirmChoice: request.confirmChoice,
      });
    });
  }

  /** Handle one validated `inlineConfirmResponse` from a renderer. */
  handleResponse(rendererId: string, confirmId: string, confirmed: boolean): boolean {
    const byRenderer = this.pendingByRenderer.get(rendererId);
    const entry = byRenderer?.get(confirmId);
    if (!entry) return false;
    entry.resolve(confirmed);
    return true;
  }

  /** Disconnect/dispose: every pending confirmation for this renderer
   *  cancels (resolves false). */
  cancelForRenderer(rendererId: string): void {
    const byRenderer = this.pendingByRenderer.get(rendererId);
    if (!byRenderer) return;
    for (const entry of byRenderer.values()) entry.resolve(false);
    this.pendingByRenderer.delete(rendererId);
  }

  /** Number of pending confirmations for one renderer (debug/tests). */
  pendingCount(rendererId: string): number {
    return this.pendingByRenderer.get(rendererId)?.size ?? 0;
  }

  private setTimer(callback: () => void, delayMs: number): unknown {
    return this.options.setTimeout?.(callback, delayMs) ?? setTimeout(callback, delayMs);
  }

  private clearTimer(handle: unknown): void {
    if (this.options.clearTimeout) this.options.clearTimeout(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
