import type { GenerationPiRuntimeDescriptor } from '../../../lib/pi-runtime/artifact.mjs';

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

/** Explicitly selected backend launch inputs. Runtime verification and Node
 * target selection belong to the owning host composition, not backend common. */
export interface BackendLaunchPaths {
  nodePath: string;
  sdkPath: string;
  sourceArtifactDescriptor?: GenerationPiRuntimeDescriptor;
  sdkRuntimeSelection?: {
    kind: 'workspace-development';
    workspaceRoot: string;
  };
}

/** Narrow host-owned backend preflight port. The early development-profile
 * step runs before session settings are loaded; the final environment step
 * runs immediately before spawn. */
export interface BackendStartupPlatform {
  prepareDevelopmentEnvironment(): void;
  resolveBackendLaunchPaths(): Promise<BackendLaunchPaths>;
  prepareBackendEnvironment(onNotice: (notice: string) => void): void;
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
  /** Host-owned preflight for resolving the selected SDK/Node target and
   * preparing the child process environment. */
  readonly backendStartup: BackendStartupPlatform;
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
