/** Read-only, non-atomic diagnostic snapshot; never authorizes recovery or admission. */
export function inspectDevelopmentWorkspace(workspaceRoot: string): Promise<{
  workspaceRoot: string;
  readers: Array<{ path: string; record: Record<string, unknown> }>;
  writer?: Record<string, unknown>;
  problems: Array<{ path: string; reason: string; record?: unknown }>;
}>;

export interface DevelopmentReaderReleaseOptions {
  /** Set true only after all resources owned by this reader have been torn down. */
  teardownConfirmed: boolean;
}

export interface DevelopmentReader {
  /**
   * Release the durable reader registration after confirmed teardown.
   * Passing false intentionally retains the registration and continues to block writers.
   */
  release(options: DevelopmentReaderReleaseOptions): Promise<void>;
}

export interface DevelopmentReaderOptions {
  /** Nonsecret diagnostic metadata only; never command lines, environment or user content.
   * Operation and invocation start with an ASCII letter/digit, are at most 256
   * characters, and otherwise use ASCII letters/digits, spaces, or _ . : / \\ -.
   * Evidence is a nonempty filesystem diagnostic string of at most 32,767
   * characters, with no control characters. It is a reference, not proof of teardown.
   */
  metadata?: { operation?: string; invocation?: string; evidence?: string };
}

/** Register this process as a reader of a canonical Pi workspace. */
export function acquireDevelopmentReader(workspaceRoot: string, options?: DevelopmentReaderOptions): Promise<DevelopmentReader>;

/**
 * Run a development-only writer operation while no reader or writer is registered.
 * The operation is not invoked when the gate is blocked.
 */
export function withDevelopmentWriter<T>(
  workspaceRoot: string,
  operation: () => T | PromiseLike<T>,
): Promise<T>;
