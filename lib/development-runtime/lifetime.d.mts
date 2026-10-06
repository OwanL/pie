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

/** Register this process as a reader of a canonical Pi workspace. */
export function acquireDevelopmentReader(workspaceRoot: string): Promise<DevelopmentReader>;

/**
 * Run a development-only writer operation while no reader or writer is registered.
 * The operation is not invoked when the gate is blocked.
 */
export function withDevelopmentWriter<T>(
  workspaceRoot: string,
  operation: () => T | PromiseLike<T>,
): Promise<T>;
