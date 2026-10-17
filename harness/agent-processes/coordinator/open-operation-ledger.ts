import * as path from 'node:path';
import type { SessionOpenedPayload } from '../lib/rpc/session-events.js';
import { BackendError } from './server-io.js';

export type OpenOperationStatus = {
  operationId: string;
  state: 'unknown' | 'pending' | 'committed' | 'failed';
  committed: boolean;
  snapshot?: SessionOpenedPayload;
  error?: { code: string; message: string };
};
type Entry = {
  intent: string;
  sessionPath: string;
  status: OpenOperationStatus;
  promise: Promise<{ ok: true; sessionPath: string }>;
  snapshotJson?: string;
};

/** Generation-local exactly-once open authority. Payload eviction never removes
 * identity/outcome tombstones. Once identity capacity is full NEW tracked opens
 * fail before mutation; legacy opens without an operationId remain unaffected. */
export class OpenOperationLedger {
  private readonly entries = new Map<string, Entry>();
  private readonly payloads = new Map<string, number>();
  private payloadBytes = 0;

  constructor(private readonly limits = { maxRecords: 512, maxBytes: 8 * 1024 * 1024 }) {
    if (!Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 1
      || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 0) {
      throw new Error('Open operation limits require positive maxRecords and nonnegative maxBytes.');
    }
  }

  has(operationId: string): boolean { return this.entries.has(operationId); }

  status(operationId: string, sessionPath: string): OpenOperationStatus {
    const entry = this.entries.get(operationId);
    if (!entry) return { operationId, state: 'unknown', committed: false };
    if (entry.sessionPath !== path.resolve(sessionPath)) {
      throw new BackendError('OPERATION_INTENT_MISMATCH', 'Open operation belongs to another session path.');
    }
    return {
      ...entry.status,
      ...(entry.status.error ? { error: { ...entry.status.error } } : {}),
      ...(entry.snapshotJson ? { snapshot: JSON.parse(entry.snapshotJson) as SessionOpenedPayload } : {}),
    };
  }

  run(options: {
    operationId: string;
    sessionPath: string;
    selectionToken?: string;
    transcript?: 'tail' | 'skip';
    execute(commit: (snapshot: SessionOpenedPayload) => void): Promise<unknown>;
  }): Promise<{ ok: true; sessionPath: string }> {
    const sessionPath = path.resolve(options.sessionPath);
    const intent = JSON.stringify([sessionPath, options.selectionToken ?? null, options.transcript ?? 'tail']);
    const existing = this.entries.get(options.operationId);
    if (existing) {
      if (existing.intent !== intent) throw new BackendError('OPERATION_INTENT_MISMATCH', 'Operation was already used for another open intent.');
      return existing.promise;
    }
    if (this.entries.size >= this.limits.maxRecords) {
      throw new BackendError('OPEN_OPERATION_CAPACITY', 'Open operation identity capacity exhausted for this backend generation.');
    }
    const entry: Entry = {
      intent, sessionPath,
      status: { operationId: options.operationId, state: 'pending', committed: false },
      promise: undefined as never,
    };
    this.entries.set(options.operationId, entry);
    // Defer execution until the entry and shared promise are both installed.
    entry.promise = Promise.resolve().then(async () => {
      const result = { ok: true as const, sessionPath: options.sessionPath };
      try {
        await options.execute(snapshot => {
          // Serialize before committing: retain an immutable transport snapshot,
          // not the object that deferred inventory/event consumers can mutate.
          const json = JSON.stringify(snapshot);
          entry.status = { operationId: options.operationId, state: 'committed', committed: true };
          const bytes = Buffer.byteLength(json, 'utf8');
          if (bytes <= this.limits.maxBytes) {
            entry.snapshotJson = json;
            this.payloads.set(options.operationId, bytes);
            this.payloadBytes += bytes;
          }
          while (this.payloadBytes > this.limits.maxBytes) {
            const oldest = this.payloads.entries().next().value!;
            this.payloads.delete(oldest[0]);
            this.payloadBytes -= oldest[1];
            delete this.entries.get(oldest[0])!.snapshotJson;
          }
        });
        if (!entry.status.committed) {
          throw new BackendError('SESSION_OPEN_FAILED', 'Open completed without a committed snapshot.');
        }
        return result;
      } catch (error) {
        if (entry.status.committed) return result;
        const failure = error instanceof BackendError ? error
          : new BackendError('SESSION_OPEN_FAILED', error instanceof Error ? error.message : String(error));
        entry.status = { operationId: options.operationId, state: 'failed', committed: false,
          error: { code: failure.code, message: failure.message } };
        throw failure;
      }
    });
    return entry.promise;
  }
}
