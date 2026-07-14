import * as crypto from 'node:crypto';

import type { ExtensionUIRequestPayload, ExtensionUIResponsePayload } from '../shared/protocol';

interface PendingRequest {
  resolve: (response: ExtensionUIResponsePayload) => void;
  subagentCallId?: string;
}

interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
  subagentCallId?: string;
  toolCallId?: string;
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
    const payload: ExtensionUIRequestPayload = { id, method: 'select', title, options, sessionPath: this.sessionPath, subagentCallId: opts?.subagentCallId, toolCallId: opts?.toolCallId, timeout: opts?.timeout };
    const response = await this.emitAndAwait(id, payload, opts);
    if (response.cancelled) return undefined;
    return response.value;
  }

  async input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined> {
    const id = crypto.randomUUID();
    const payload: ExtensionUIRequestPayload = { id, method: 'input', title, placeholder, sessionPath: this.sessionPath, subagentCallId: opts?.subagentCallId, toolCallId: opts?.toolCallId, timeout: opts?.timeout };
    const response = await this.emitAndAwait(id, payload, opts);
    if (response.cancelled) return undefined;
    return response.value;
  }

  notify(message: string, type?: 'info' | 'warning' | 'error', subagentCallId?: string): void {
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
    pending.resolve(response);
    return true;
  }

  /** Cancel only dialogs owned by one subagent call. A child timeout must not
   * dismiss sibling prompts from the same parallel parent tool call. */
  cancelSubagent(subagentCallId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.subagentCallId !== subagentCallId) continue;
      pending.resolve({ id, cancelled: true });
    }
  }

  /**
   * Cancel all pending requests (e.g. on whole-session abort).
   */
  cancelAll(): void {
    for (const [id, pending] of this.pending) {
      pending.resolve({ id, cancelled: true });
    }
    this.pending.clear();
  }

  private emitAndAwait(
    id: string,
    payload: ExtensionUIRequestPayload,
    opts?: DialogOptions,
  ): Promise<ExtensionUIResponsePayload> {
    return new Promise<ExtensionUIResponsePayload>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => finish({ id, cancelled: true });
      const finish = (response: ExtensionUIResponsePayload) => {
        if (!this.pending.delete(id)) return;
        if (timer) clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onAbort);
        resolve(response);
      };

      this.pending.set(id, { resolve: finish, subagentCallId: payload.subagentCallId });
      if (opts?.signal?.aborted) {
        finish({ id, cancelled: true });
        return;
      }
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts?.timeout && opts.timeout > 0) {
        timer = setTimeout(() => finish({ id, cancelled: true }), opts.timeout);
        timer.unref?.();
      }
      this.emit('extension_ui.request', payload);
    });
  }
}
