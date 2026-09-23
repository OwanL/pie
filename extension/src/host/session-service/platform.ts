/**
 * Platform-neutral seam between the session service and its host
 * environment. The VS Code composition in `extension-host.ts` supplies the
 * production adapter; unit tests supply plain-object stubs. Nothing in this
 * module may import `vscode`, and nothing outside the VS Code composition may
 * implement it with VS Code types — that boundary is what keeps
 * `session-service` loadable (and testable) outside the extension host.
 */

/** Platform-neutral replacement for `vscode.Disposable`: the only shape the
 * session service ever needs from its subscriptions. */
export interface HostDisposable {
  dispose(): void;
}

/** Persisted key/value storage (VS Code `globalState` in production). The
 * persisted key strings are owned by the session-service feature modules and
 * must stay byte-identical across platform adapters so existing installs
 * restore their state. */
export interface SessionHostStorage {
  get<T>(key: string): T | undefined;
  update<T>(key: string, value: T | undefined): PromiseLike<void>;
}

export interface SessionHostPlatform {
  readonly storage: SessionHostStorage;
  /** Loaded extension install directory (VS Code `extensionPath`). */
  readonly extensionPath: string;
  /** Build-generated runtime output directory (staged generation, falling
   * back to the extension's `out/` directory). */
  getRuntimeOutputDirectory(): string;
  /** First workspace folder path, falling back to the process cwd. */
  getWorkspaceCwd(): string;
  /**
   * Read a workspace configuration value against the `pie` configuration
   * section. When `fallbackName` is provided the legacy root
   * `piAssistant.<fallbackName>` setting is consulted with the exact
   * trimmed-string fallback the runtime path resolution has always used: a
   * `pie` value that is absent or empty after trimming defers to the
   * fallback. Implementations MUST preserve this pie → piAssistant ordering.
   */
  getSetting<T>(name: string, fallbackName?: string): T | undefined;
  /** Best-effort window attention request (completion and extension
   * prompts). Hosts without a window flash may implement this as a no-op. */
  requestWindowAttention(): void;
}

/**
 * The exact trimmed-string `pie` → `piAssistant` fallback used by runtime
 * path resolution: a blank (absent or whitespace-only) primary value defers
 * to the legacy fallback. Shared by the VS Code adapter so the contract has
 * one implementation and one test surface.
 */
export function selectRuntimeSetting(
  primary: string | undefined,
  fallback: string | undefined,
): string | undefined {
  return primary?.trim() || fallback?.trim() || undefined;
}