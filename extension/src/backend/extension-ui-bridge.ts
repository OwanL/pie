import * as crypto from 'node:crypto';

import type { ExtensionUIRequestPayload, ExtensionUIResponsePayload, ReviewHumanVerificationMetadata } from '../shared/protocol';

interface PendingRequest {
  settle: (response: ExtensionUIResponsePayload, deferContinuation?: boolean) => void;
  subagentCallId?: string;
}

interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
  subagentCallId?: string;
  toolCallId?: string;
  /** Ask-style select prompts may accept a value outside the preset options. */
  allowCustom?: boolean;
  /** Review display/audit metadata; never changes this bridge's session path. */
  reviewMeta?: ReviewHumanVerificationMetadata;
}

export interface ExtensionUIBridgeEmitter {
  (event: 'extension_ui.request', payload: ExtensionUIRequestPayload): void;
}

/**
 * Implements the SDK's ExtensionUIContext interface by emitting events to the
 * host and awaiting responses. Each confirm/select/input call creates a pending
 * promise that resolves when `resolveRequest()` is called with the matching id.
 */
export class ExtensionUIBridge {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly emit: ExtensionUIBridgeEmitter;
  private readonly sessionPath: string;
  private closed = false;

  constructor(sessionPath: string, emit: ExtensionUIBridgeEmitter) {
    this.sessionPath = sessionPath;
    this.emit = emit;
  }

  async confirm(title: string, message: string, opts?: DialogOptions): Promise<boolean> {
    const id = crypto.randomUUID();
    const payload: ExtensionUIRequestPayload = { id, method: 'confirm', title, message, sessionPath: this.sessionPath, subagentCallId: opts?.subagentCallId, toolCallId: opts?.toolCallId, timeout: opts?.timeout };
    const response = await this.emitAndAwait(id, payload, opts);
    if (response.cancelled) return false;
    return response.confirmed ?? false;
  }

  async select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined> {
    const id = crypto.randomUUID();
    const payload: ExtensionUIRequestPayload = { id, method: 'select', title, options, allowCustom: opts?.allowCustom, sessionPath: this.sessionPath, subagentCallId: opts?.subagentCallId, toolCallId: opts?.toolCallId, timeout: opts?.timeout, reviewMeta: opts?.reviewMeta };
    const response = await this.emitAndAwait(id, payload, opts);
    if (response.cancelled) return undefined;
    return response.value;
  }

  async input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined> {
    const id = crypto.randomUUID();
    const payload: ExtensionUIRequestPayload = { id, method: 'input', title, placeholder, sessionPath: this.sessionPath, subagentCallId: opts?.subagentCallId, toolCallId: opts?.toolCallId, timeout: opts?.timeout, reviewMeta: opts?.reviewMeta };
    const response = await this.emitAndAwait(id, payload, opts);
    if (response.cancelled) return undefined;
    return response.value;
  }

  notify(message: string, type?: 'info' | 'warning' | 'error', subagentCallId?: string): void {
    if (this.closed) return;
    const id = crypto.randomUUID();
    this.emit('extension_ui.request', { id, method: 'notify', message, notifyType: type, sessionPath: this.sessionPath, subagentCallId });
  }

  // Stubs for methods the SDK interface declares but we don't need in the webview.
  onTerminalInput(): () => void { return () => undefined; }
  setStatus(): void { /* noop */ }
  setWorkingMessage(): void { /* noop */ }
  setWorkingVisible(): void { /* noop */ }
  setWorkingIndicator(): void { /* noop */ }
  setHiddenThinkingLabel(): void { /* noop */ }
  setWidget(): void { /* noop */ }

  /**
   * Resolve a pending request with the response from the host.
   */
  resolveRequest(response: ExtensionUIResponsePayload): boolean {
    const pending = this.pending.get(response.id);
    if (!pending) return false;
    // Claim and clean up the request synchronously, but resume the extension on
    // the next event-loop turn. Resolving its promise here can let the resumed
    // extension perform long synchronous work before the backend writes the RPC
    // acknowledgement. The host then times out, restores an already-consumed
    // prompt, and every retry fails with UI_REQUEST_NOT_PENDING.
    pending.settle(response, true);
    return true;
  }

  /** Cancel only dialogs owned by one subagent call. A child timeout must not
   * dismiss sibling prompts from the same parallel parent tool call. */
  cancelSubagent(subagentCallId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.subagentCallId !== subagentCallId) continue;
      pending.settle({ id, cancelled: true });
    }
  }

  /**
   * Cancel all pending requests (e.g. on whole-session abort).
   */
  cancelAll(): void {
    for (const [id, pending] of this.pending) {
      pending.settle({ id, cancelled: true });
    }
    this.pending.clear();
  }

  /**
   * Permanently retire this bridge. Unlike {@link cancelAll}, disposal fences
   * every future SDK UI request from the runtime that owned it. This matters
   * when a runtime is replaced locally while its provider teardown is still
   * pending: late extension code must not surface zombie dialogs or notices.
   */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelAll();
  }

  private emitAndAwait(
    id: string,
    payload: ExtensionUIRequestPayload,
    opts?: DialogOptions,
  ): Promise<ExtensionUIResponsePayload> {
    if (this.closed) {
      return Promise.resolve({ id, cancelled: true });
    }
    return new Promise<ExtensionUIResponsePayload>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const onAbort = () => settle({ id, cancelled: true });
      const settle = (response: ExtensionUIResponsePayload, deferContinuation = false) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onAbort);
        if (deferContinuation) setImmediate(() => resolve(response));
        else resolve(response);
      };

      this.pending.set(id, { settle, subagentCallId: payload.subagentCallId });
      if (opts?.signal?.aborted) {
        settle({ id, cancelled: true });
        return;
      }
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts?.timeout && opts.timeout > 0) {
        timer = setTimeout(() => settle({ id, cancelled: true }), opts.timeout);
        timer.unref?.();
      }
      this.emit('extension_ui.request', payload);
    });
  }
}
