import type { SdkSessionManager } from './sdk';

/**
 * Sentinel entry id returned by fenced appendXXX methods. It is intentionally
 * not a valid UUID so a leaked id stands out in logs; backend listeners for a
 * retired runtime ignore these events anyway.
 */
export const FENCED_ENTRY_ID = '__pie:fenced__';

/**
 * The SDK SessionManager surface that generates persisted session entries.
 * This is the mutation boundary the backend fences for retired runtimes.
 */
export interface MutableSdkSessionManager extends SdkSessionManager {
  [key: string]: unknown;
  newSession(options?: unknown): string | undefined;
  setSessionFile(sessionFile: string): void;
  _rewriteFile(): void;
  _persist(entry: unknown): void;
  _appendEntry(entry: unknown): void;
  appendMessage(message: unknown): string;
  appendThinkingLevelChange(thinkingLevel: string): string;
  appendModelChange(provider: string, modelId: string): string;
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): string;
  appendCustomEntry(customType: string, data?: unknown): string;
  appendSessionInfo(name: string): string;
  appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: unknown,
    display: boolean,
    details?: T,
  ): string;
  appendLabelChange(targetId: string, label: string | undefined): string;
  branch(branchFromId: string): void;
  resetLeaf(): void;
  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): string;
  createBranchedSession(leafId: string): string | undefined;
}

export interface SessionManagerFence {
  /** Permanently disable persistence mutations for the wrapped manager. */
  invalidate(): void;
  /** Whether this fence has been invalidated. */
  isInvalidated(): boolean;
}

/**
 * Mutation methods on the SDK SessionManager that generate or modify persisted
 * session state. Read APIs are intentionally omitted.
 */
const PERSISTENCE_MUTATION_METHODS = new Set([
  // lifecycle / file switching
  'newSession',
  'setSessionFile',
  // private persistence helpers
  '_rewriteFile',
  '_persist',
  '_appendEntry',
  // public append methods
  'appendMessage',
  'appendThinkingLevelChange',
  'appendModelChange',
  'appendCompaction',
  'appendCustomEntry',
  'appendSessionInfo',
  'appendCustomMessageEntry',
  'appendLabelChange',
  // branching / leaf manipulation
  'branch',
  'resetLeaf',
  'branchWithSummary',
  'createBranchedSession',
]);

/**
 * Return value used when a fenced mutation method is called after invalidation.
 * Methods that normally return an entry id get the sentinel; everything else
 * is treated as a no-op (undefined).
 */
const MUTATION_RETURN_VALUES: Record<string, unknown> = {
  appendMessage: FENCED_ENTRY_ID,
  appendThinkingLevelChange: FENCED_ENTRY_ID,
  appendModelChange: FENCED_ENTRY_ID,
  appendCompaction: FENCED_ENTRY_ID,
  appendCustomEntry: FENCED_ENTRY_ID,
  appendSessionInfo: FENCED_ENTRY_ID,
  appendCustomMessageEntry: FENCED_ENTRY_ID,
  appendLabelChange: FENCED_ENTRY_ID,
  branchWithSummary: FENCED_ENTRY_ID,
};

/**
 * Wrap a SessionManager so that persistence-generation mutations can be
 * disabled synchronously when the owning runtime is retired, replaced, or shut
 * down. Read APIs and unrelated properties pass through unchanged. The fence
 * is bounded: it does not revoke access to the object, it only no-ops the
 * mutation boundary. External side effects that have already been issued (e.g.
 * an in-flight provider request) are explicitly NOT fenced.
 */
export function createSessionManagerFence(
  manager: SdkSessionManager,
): { manager: MutableSdkSessionManager; fence: SessionManagerFence } {
  let invalidated = false;

  const fence: SessionManagerFence = {
    invalidate() {
      invalidated = true;
    },
    isInvalidated() {
      return invalidated;
    },
  };

  const handler: ProxyHandler<SdkSessionManager> = {
    get(target, prop, receiver) {
      if (typeof prop !== 'string' || !PERSISTENCE_MUTATION_METHODS.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }

      const value = (target as unknown as Record<string, unknown>)[prop];
      if (typeof value !== 'function') {
        return value;
      }

      return (...args: unknown[]) => {
        if (invalidated) {
          return MUTATION_RETURN_VALUES[prop];
        }
        return value.apply(target, args);
      };
    },
  };

  return {
    manager: new Proxy(manager, handler) as MutableSdkSessionManager,
    fence,
  };
}
