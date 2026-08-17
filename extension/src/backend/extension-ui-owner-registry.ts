/**
 * Coordinator-owned pending ExtensionUI owner registry.
 *
 * The coordinator records exactly one pending owner before it forwards a
 * worker's `extension_ui.request` to the host. A host `extension_ui.response`
 * is routed to a worker only when it matches the exact recorded owner tuple
 * (root session + worker generation + uiRequestId + optional subagentCallId /
 * toolCallId). The first accepted worker settlement clears the owner;
 * duplicate, mismatched, timed-out, cancelled, stale-generation, and
 * crashed-worker responses therefore receive a correlated typed stale/
 * unavailable result and never invoke an extension callback.
 *
 * The registry is bounded: per-session and total pending caps fail closed
 * (the coordinator refuses to forward a request it cannot later settle
 * exactly once). `notify` dialogs are fire-and-forget and are never recorded.
 */
export interface ExtensionUiPendingOwner {
  sessionPath: string;
  workerId: string;
  workerGeneration: number;
  uiRequestId: string;
  subagentCallId?: string;
  toolCallId?: string;
  method: 'confirm' | 'select' | 'input';
  /** Dialog timeout from the request payload; the webview auto-cancels at it. */
  timeoutMs?: number;
  recordedAt: number;
}

export interface ExtensionUiOwnerIdentity {
  sessionPath: string;
  workerId: string;
  workerGeneration: number;
  uiRequestId: string;
  subagentCallId?: string;
  toolCallId?: string;
}

export const EXTENSION_UI_PENDING_PER_SESSION_LIMIT = 64 as const;
export const EXTENSION_UI_PENDING_TOTAL_LIMIT = 512 as const;
/** Grace beyond the dialog timeout before the registry treats the owner as
 * expired. The webview auto-cancels at `timeout`, so a response arriving
 * after expiry is stale regardless of transport delay. */
const EXTENSION_UI_EXPIRY_GRACE_MS = 5_000;

function ownerKey(owner: Pick<ExtensionUiOwnerIdentity, 'sessionPath' | 'workerId' | 'workerGeneration' | 'uiRequestId' | 'subagentCallId' | 'toolCallId'>): string {
  return [
    owner.sessionPath,
    owner.workerId,
    String(owner.workerGeneration),
    owner.uiRequestId,
    owner.subagentCallId ?? '',
    owner.toolCallId ?? '',
  ].join('\u0000');
}

export class ExtensionUiOwnerRegistry {
  private readonly pending = new Map<string, ExtensionUiPendingOwner>();
  private readonly bySession = new Map<string, number>();

  /** Record the exact owner BEFORE the public request is forwarded. Throws
   * when the registry is at capacity or an exact duplicate already exists;
   * callers must fail closed rather than forward an unownable request. */
  record(owner: ExtensionUiOwnerIdentity): void {
    const key = ownerKey(owner);
    if (this.pending.has(key)) {
      throw new Error(`Extension UI request ${owner.uiRequestId} is already owned.`);
    }
    if (this.pending.size >= EXTENSION_UI_PENDING_TOTAL_LIMIT) {
      throw new Error(`Extension UI pending owner registry is at its ${EXTENSION_UI_PENDING_TOTAL_LIMIT}-request total limit.`);
    }
    const sessionCount = this.bySession.get(owner.sessionPath) ?? 0;
    if (sessionCount >= EXTENSION_UI_PENDING_PER_SESSION_LIMIT) {
      throw new Error(`Extension UI pending owner registry is at its ${EXTENSION_UI_PENDING_PER_SESSION_LIMIT}-request per-session limit.`);
    }
    this.pending.set(key, {
      sessionPath: owner.sessionPath,
      workerId: owner.workerId,
      workerGeneration: owner.workerGeneration,
      uiRequestId: owner.uiRequestId,
      subagentCallId: owner.subagentCallId,
      toolCallId: owner.toolCallId,
      method: 'confirm',
      recordedAt: Date.now(),
    });
    this.bySession.set(owner.sessionPath, sessionCount + 1);
  }

  /** Optional dialog metadata attached after record by the forwarding path. */
  attachMetadata(uiRequestId: string, metadata: { method?: 'confirm' | 'select' | 'input'; timeoutMs?: number }): void {
    for (const entry of this.pending.values()) {
      if (entry.uiRequestId !== uiRequestId) continue;
      if (metadata.method !== undefined) entry.method = metadata.method;
      if (metadata.timeoutMs !== undefined && Number.isSafeInteger(metadata.timeoutMs) && metadata.timeoutMs > 0) {
        entry.timeoutMs = metadata.timeoutMs;
      }
      return;
    }
  }

  /**
   * Resolve the single pending owner for a host response on the current
   * worker generation. Returns undefined (typed stale/unavailable) when no
   * exact owner exists: duplicate (already settled), mismatched worker
   * generation, expired, cancelled locally by the worker, or the owning
   * worker crashed/retired (owners are cleared on worker death).
   */
  resolve(sessionPath: string, uiRequestId: string, owner: { workerId: string; workerGeneration: number }): ExtensionUiPendingOwner | undefined {
    const now = Date.now();
    for (const [key, entry] of [...this.pending]) {
      if (entry.sessionPath !== sessionPath || entry.uiRequestId !== uiRequestId) continue;
      if (entry.workerId !== owner.workerId || entry.workerGeneration !== owner.workerGeneration) {
        // The response targets a different live generation than the owner's.
        this.remove(key, entry);
        return undefined;
      }
      const expiresAt = entry.timeoutMs !== undefined ? entry.recordedAt + entry.timeoutMs + EXTENSION_UI_EXPIRY_GRACE_MS : undefined;
      if (expiresAt !== undefined && now > expiresAt) {
        this.remove(key, entry);
        return undefined;
      }
      return entry;
    }
    return undefined;
  }

  /**
   * Remove the owner after the owning worker's settlement (accepted or
   * definitively rejected). Idempotent; a late duplicate finds no owner.
   */
  settle(sessionPath: string, uiRequestId: string): void {
    for (const [key, entry] of [...this.pending]) {
      if (entry.sessionPath !== sessionPath || entry.uiRequestId !== uiRequestId) continue;
      this.remove(key, entry);
      return;
    }
  }

  /** Release every owner held by one worker generation (crash/kill/retire). */
  clearWorker(workerId: string, workerGeneration: number): void {
    for (const [key, entry] of [...this.pending]) {
      if (entry.workerId !== workerId || entry.workerGeneration !== workerGeneration) continue;
      this.remove(key, entry);
    }
  }

  /** Bounded snapshot for diagnostics and tests. */
  inspect(): Array<{ sessionPath: string; workerId: string; workerGeneration: number; uiRequestId: string; method: string; recordedAt: number; timeoutMs?: number }> {
    return [...this.pending.values()].map((entry) => ({
      sessionPath: entry.sessionPath,
      workerId: entry.workerId,
      workerGeneration: entry.workerGeneration,
      uiRequestId: entry.uiRequestId,
      method: entry.method,
      recordedAt: entry.recordedAt,
      ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
    }));
  }

  get size(): number {
    return this.pending.size;
  }

  private remove(key: string, entry: ExtensionUiPendingOwner): void {
    this.pending.delete(key);
    const remaining = (this.bySession.get(entry.sessionPath) ?? 1) - 1;
    if (remaining <= 0) this.bySession.delete(entry.sessionPath);
    else this.bySession.set(entry.sessionPath, remaining);
  }
}
