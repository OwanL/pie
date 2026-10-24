import { createHash } from 'node:crypto';
import type { WorkerJsonObject, WorkerJsonValue, WorkerSessionControlAction } from '../lib/rpc/worker-protocol.js';

export type SessionControlMutation = Extract<WorkerSessionControlAction, 'create' | 'message' | 'settings.set' | 'close' | 'cleanup' | 'note' | 'task.assign' | 'interrupt' | 'resources'>;
interface Receipt {
  action: SessionControlMutation;
  fingerprint: string;
  issuedAt: number;
  phase: string;
  status: 'pending' | 'known';
  result?: WorkerJsonValue;
  error?: string;
  outcome?: 'known' | 'unknown';
  evidenceUnavailable?: boolean;
}
const uncertain = (value: WorkerJsonValue | undefined): boolean => {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(uncertain);
  return value.status === 'unknown' || value.unknown === true
    || (typeof value.unknownCount === 'number' && value.unknownCount > 0) || Object.values(value).some(uncertain);
};

/** Coordinator-local evidence, never a retry/replay service. Missing evidence
 * cannot prove non-execution. Timestamp admission rejects evicted/pre-start
 * keys; known duplicate keys only return status. No mutation is replayed. */
export class SessionControlOperations {
  private readonly records = new Map<string, Receipt>();
  private admissionFloor: number;
  // Reserve bookkeeping space per receipt so phase/terminal metadata can grow
  // even when pending receipts occupy all available evidence capacity.
  private static readonly METADATA_RESERVE = 256;
  constructor(private readonly maxRecords = 512, private readonly maxBytes = 8 * 1024 * 1024,
    startedAt = Date.now(), private readonly now: () => number = Date.now) {
    this.admissionFloor = startedAt - 1;
  }

  private key(owner: string, requestKey: string): string { return JSON.stringify([owner, requestKey]); }
  private bytes(key: string, receipt: Receipt): number { return Buffer.byteLength(JSON.stringify([key, receipt]), 'utf8'); }
  private totalBytes(): number {
    let bytes = 0;
    for (const [key, receipt] of this.records) bytes += this.bytes(key, receipt) + SessionControlOperations.METADATA_RESERVE;
    return bytes;
  }

  begin(owner: string, requestKey: string, action: SessionControlMutation, payloadFingerprint: string): boolean {
    const key = this.key(owner, requestKey);
    const fingerprint = createHash('sha256').update(payloadFingerprint).digest('hex');
    const previous = this.records.get(key);
    if (previous) {
      if (previous.action !== action || previous.fingerprint !== fingerprint) throw new Error('requestKey is already associated with another operation.');
      return false;
    }
    if (!/^\d{13}:[0-9a-f-]{36}$/u.test(requestKey)) throw new Error('requestKey must be a timestamp-prefixed UUID.');
    const issuedAt = Number(requestKey.split(':', 1)[0]);
    if (issuedAt <= this.admissionFloor || issuedAt > this.now()) throw new Error('Stale requestKey: outside this coordinator receipt admission window. Mutation not admitted; do not replay an earlier operation.');
    const receipt: Receipt = { action, fingerprint, issuedAt, phase: 'validation', status: 'pending' };
    const required = this.bytes(key, receipt) + SessionControlOperations.METADATA_RESERVE;
    this.trim(this.maxRecords - 1, this.maxBytes - required);
    // Eviction advances the floor, including same-millisecond keys.
    if (issuedAt <= this.admissionFloor) throw new Error('Stale requestKey: outside this coordinator receipt admission window. Mutation not admitted.');
    if (this.records.size >= this.maxRecords || this.totalBytes() + required > this.maxBytes) throw new Error('Operation receipt capacity is occupied by pending operations; mutation not admitted.');
    this.records.set(key, receipt);
    return true;
  }

  phase(owner: string, requestKey: string, phase: string, result?: WorkerJsonValue): void {
    const key = this.key(owner, requestKey);
    const previous = this.records.get(key);
    if (!previous) return;
    this.update(key, { ...previous, phase: phase.slice(0, 64), ...(result !== undefined ? { result } : {}) });
  }

  finish(owner: string, requestKey: string, result?: WorkerJsonValue, error?: string, errorOutcome: 'known' | 'unknown' = 'unknown'): void {
    const key = this.key(owner, requestKey);
    const previous = this.records.get(key);
    if (!previous) return;
    const terminalizePending = (value: WorkerJsonValue): WorkerJsonValue => {
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(terminalizePending);
      return Object.fromEntries(Object.entries(value).map(([field, child]) => [field,
        field === 'status' && child === 'pending' ? errorOutcome === 'known' ? 'failed' : 'unknown' : terminalizePending(child)]));
    };
    const evidence = result ?? (error !== undefined && previous.result !== undefined
      ? terminalizePending(previous.result) : previous.result);
    this.update(key, { ...previous, status: 'known',
      ...(evidence !== undefined ? { result: evidence } : {}),
      ...(error !== undefined ? { error: error.slice(0, 1024) } : {}),
      outcome: error !== undefined ? errorOutcome : uncertain(result ?? previous.result) ? 'unknown' : 'known',
    });
  }

  private update(key: string, receipt: Receipt): void {
    const previous = this.records.get(key)!;
    const otherBytes = this.totalBytes() - this.bytes(key, previous) - SessionControlOperations.METADATA_RESERVE;
    if (this.bytes(key, receipt) > 192 * 1024
      || otherBytes + this.bytes(key, receipt) + SessionControlOperations.METADATA_RESERVE > this.maxBytes) {
      delete receipt.result;
      delete receipt.error;
      receipt.evidenceUnavailable = true;
    }
    // Bookkeeping-only updates can use the space reserved at admission. They
    // remain far below that reserve even when all receipts are pending.
    this.records.set(key, receipt);
  }

  status(owner: string, requestKey: string): WorkerJsonObject {
    const receipt = this.records.get(this.key(owner, requestKey));
    return { requestKey, operation: receipt ? {
      status: receipt.status, action: receipt.action, phase: receipt.phase,
      ...(receipt.outcome ? { outcome: receipt.outcome } : {}),
      ...(receipt.result !== undefined ? { result: receipt.result } : {}),
      ...(receipt.error ? { error: receipt.error } : {}),
      ...(receipt.evidenceUnavailable ? { evidenceUnavailable: true, reason: 'Receipt detail exceeded retained evidence capacity.' } : {}),
    } : { status: 'unavailable', reason: 'No retained evidence in this coordinator lifetime; do not repeat the mutation.' } };
  }

  private trim(targetRecords: number, targetBytes: number): void {
    for (const [key, receipt] of this.records) {
      if (this.records.size <= targetRecords && this.totalBytes() <= targetBytes) break;
      if (receipt.status === 'pending') continue;
      this.records.delete(key);
      this.admissionFloor = Math.max(this.admissionFloor, receipt.issuedAt);
    }
  }
}
