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

export interface SessionManagerFenceAdmission {
  /** Acquire a short-lived admission lease immediately before persistence. */
  acquire(): () => void;
}

export interface SessionManagerFence {
  /** Permanently disable persistence mutations for the wrapped manager. */
  invalidate(): void;
  /** Whether this fence has been invalidated. */
  isInvalidated(): boolean;
  /** Number of persistence mutations currently inside the fence. */
  activeMutationCount(): number;
  /** Wait for already-admitted mutations to leave the fence. A nonzero result
   * means the bounded wait expired and the caller must fail closed. */
  waitForIdle(timeoutMs?: number): Promise<number>;
}

export interface SessionManagerFenceOptions {
  admission?: SessionManagerFenceAdmission;
}

export interface SessionManagerFenceRegistry {
  /** Add a manager fence to this host's writer set. A fence registered after
   * revocation is invalidated synchronously and can never become admissible. */
  register(fence: SessionManagerFence): () => void;
  /** Revoke admission and synchronously invalidate every registered manager. */
  revoke(): void;
  isRevoked(): boolean;
  activeMutationCount(): number;
  waitForIdle(timeoutMs?: number): Promise<number>;
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
  options: SessionManagerFenceOptions = {},
): { manager: MutableSdkSessionManager; fence: SessionManagerFence } {
  let invalidated = false;
  let activeMutations = 0;
  const idleWaiters = new Set<() => void>();

  const releaseMutation = (): void => {
    if (activeMutations === 0) return;
    activeMutations -= 1;
    if (activeMutations === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
  };

  const fence: SessionManagerFence = {
    invalidate() {
      invalidated = true;
    },
    isInvalidated() {
      return invalidated;
    },
    activeMutationCount() {
      return activeMutations;
    },
    waitForIdle(timeoutMs = 2_000) {
      const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 0;
      if (activeMutations === 0) return Promise.resolve(0);
      return new Promise<number>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          idleWaiters.delete(onIdle);
          clearTimeout(timer);
          resolve(activeMutations);
        };
        const onIdle = () => finish();
        const timer = setTimeout(finish, boundedTimeout);
        timer.unref?.();
        idleWaiters.add(onIdle);
      });
    },
  };

  const handler: ProxyHandler<SdkSessionManager> = {
    get(target, prop, receiver) {
      const revokesFence = prop === 'revokePieWriteLease';
      if (typeof prop !== 'string' || (!PERSISTENCE_MUTATION_METHODS.has(prop) && !revokesFence)) {
        return Reflect.get(target, prop, receiver);
      }

      const value = (target as unknown as Record<string, unknown>)[prop];
      if (typeof value !== 'function') {
        return value;
      }

      return (...args: unknown[]) => {
        // The patched SDK invokes this at the source-runtime replacement
        // boundary. Treat it as a local retirement signal as well as an
        // ownership-lease revocation so a stale manager cannot write after the
        // transfer starts.
        if (revokesFence) {
          fence.invalidate();
          return value.apply(target, args);
        }
        if (invalidated) {
          return MUTATION_RETURN_VALUES[prop];
        }
        let releaseAdmission: (() => void) | undefined;
        try {
          releaseAdmission = options.admission?.acquire();
          if (releaseAdmission !== undefined && typeof releaseAdmission !== 'function') {
            throw new Error('Session manager admission did not return a release function.');
          }
        } catch {
          // Admission failures are deliberately indistinguishable from a
          // revoked writer at this boundary: no persistence method is called.
          return MUTATION_RETURN_VALUES[prop];
        }
        if (invalidated) {
          releaseAdmission?.();
          return MUTATION_RETURN_VALUES[prop];
        }
        activeMutations += 1;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          try { releaseAdmission?.(); } finally { releaseMutation(); }
        };
        try {
          const result = value.apply(target, args);
          if (result && typeof (result as { then?: unknown }).then === 'function') {
            return Promise.resolve(result).finally(release);
          }
          release();
          return result;
        } catch (error) {
          release();
          throw error;
        }
      };
    },
  };

  return {
    manager: new Proxy(manager, handler) as MutableSdkSessionManager,
    fence,
  };
}

/** Host-local collection of all SessionManager fences. The collection is the
 * synchronous writer boundary used by an authenticated all-host freeze; it
 * does not pretend to fence provider requests that have already started. */
export function createSessionManagerFenceRegistry(): SessionManagerFenceRegistry {
  let revoked = false;
  const fences = new Set<SessionManagerFence>();
  return {
    register(fence) {
      if (revoked) fence.invalidate();
      else fences.add(fence);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fences.delete(fence);
      };
    },
    revoke() {
      revoked = true;
      for (const fence of fences) fence.invalidate();
    },
    isRevoked() {
      return revoked;
    },
    activeMutationCount() {
      let count = 0;
      for (const fence of fences) count += fence.activeMutationCount();
      return count;
    },
    async waitForIdle(timeoutMs = 2_000) {
      const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 0;
      const startedAt = Date.now();
      for (;;) {
        const remaining = Math.max(0, boundedTimeout - (Date.now() - startedAt));
        const current = [...fences];
        if (current.length === 0) return 0;
        await Promise.all(current.map((fence) => fence.waitForIdle(remaining)));
        const active = this.activeMutationCount();
        if (active === 0 || Date.now() - startedAt >= boundedTimeout) return active;
      }
    },
  };
}
