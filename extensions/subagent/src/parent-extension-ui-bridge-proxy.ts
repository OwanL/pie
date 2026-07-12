/**
 * ParentExtensionUIBridgeProxy — thin decorator that implements
 * `ExtensionUIContext` for subagent sessions by delegating dialog methods
 * (`select`, `input`, `confirm`, `notify`) to the parent session's
 * `ExtensionUIBridge`, stamping every request payload with `subagentCallId`.
 *
 * TUI-specific methods (`setTheme`, `setStatus`, `setWidget`, etc.) are
 * no-ops — subagents have no terminal UI.
 *
 * The parent bridge owns the promises; the proxy just awaits them.
 * No parallel promise tracking, no subscription lifecycle, no new event types.
 */

import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@mariozechner/pi-coding-agent";

/**
 * Minimal interface for the parent bridge — we only need the dialog methods
 * that the ask_user extension (and safeguard) actually call.
 */
export interface ParentBridge {
  select(title: string, options: string[], opts?: { signal?: AbortSignal; subagentCallId?: string; toolCallId?: string }): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: { signal?: AbortSignal; subagentCallId?: string; toolCallId?: string }): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal; subagentCallId?: string; toolCallId?: string }): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error", subagentCallId?: string): void;
  cancelAll(): void;
  cancelSubagent?(subagentCallId: string): void;
}

export class ParentExtensionUIBridgeProxy implements ExtensionUIContext {
  private readonly parentBridge: ParentBridge;
  private readonly subagentCallId: string;

  constructor(parentBridge: ParentBridge, subagentCallId: string) {
    this.parentBridge = parentBridge;
    this.subagentCallId = subagentCallId;
  }

  /**
   * Build the options to forward to the parent bridge. For a nested proxy
   * chain, the innermost proxy has already stamped the depth-N identity onto
   * `opts`; forwarding that (rather than overwriting with this proxy's own
   * depth-1 id) keeps the request matching the webview's depth-N
   * `SubagentCallContext.id` so the inline `ask_user` card lands on the right
   * block. Overwriting stamped every nested dialog with the depth-1 id and
   * orphaned the depth-2+ card (routed to the bottom ExtensionUIPrompt strip).
   */
  private forwardOpts(opts?: ExtensionUIDialogOptions): {
    signal?: AbortSignal;
    subagentCallId?: string;
    toolCallId?: string;
  } {
    const inner = opts as ForwardedDialogOptions | undefined;
    const subagentCallId = inner?.subagentCallId ?? this.subagentCallId;
    const toolCallId = inner?.toolCallId ?? this.subagentCallId;
    return { signal: opts?.signal, subagentCallId, toolCallId };
  }

  // ── Dialog methods (delegated to parent bridge) ──────────────────────────

  async select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.parentBridge.select(title, options, this.forwardOpts(opts));
  }

  async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    return this.parentBridge.confirm(title, message, this.forwardOpts(opts));
  }

  async input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.parentBridge.input(title, placeholder, this.forwardOpts(opts));
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.parentBridge.notify(message, type, this.subagentCallId);
  }

  /** Cancel only this child call's dialogs. Parallel siblings share the host
   * bridge, so delegating to cancelAll() would incorrectly dismiss every
   * sibling when one child times out. Nested proxies forward the innermost id. */
  cancelAll(): void {
    this.cancelSubagent(this.subagentCallId);
  }

  cancelSubagent(subagentCallId: string): void {
    if (this.parentBridge.cancelSubagent) {
      this.parentBridge.cancelSubagent(subagentCallId);
    } else {
      // Compatibility with older/non-pie bridge implementations.
      this.parentBridge.cancelAll();
    }
  }

  // ── TUI methods (no-ops for subagent sessions) ────────────────────────────

  onTerminalInput(): () => void { return () => undefined; }
  setStatus(): void { /* noop */ }
  setWorkingMessage(): void { /* noop */ }
  setWorkingVisible(): void { /* noop */ }
  setWorkingIndicator(): void { /* noop */ }
  setHiddenThinkingLabel(): void { /* noop */ }
  setWidget(): void { /* noop */ }
  setFooter(): void { /* noop */ }
  setHeader(): void { /* noop */ }
  setTitle(): void { /* noop */ }
  async custom<T>(): Promise<T> { throw new Error("custom() not available in subagent sessions"); }
  pasteToEditor(): void { /* noop */ }
  setEditorText(): void { /* noop */ }
  getEditorText(): string { return ""; }
  async editor(): Promise<string | undefined> { return undefined; }
  addAutocompleteProvider(): void { /* noop */ }
  setEditorComponent(): void { /* noop */ }
  getEditorComponent(): undefined { return undefined; }
  get theme(): any { return {} as any; }
  getAllThemes(): { name: string; path: string | undefined }[] { return []; }
  getTheme(): any { return undefined; }
  setTheme(): { success: boolean; error?: string } { return { success: false, error: "not available in subagent" }; }
  getToolsExpanded(): boolean { return false; }
  setToolsExpanded(): void { /* noop */ }
}
