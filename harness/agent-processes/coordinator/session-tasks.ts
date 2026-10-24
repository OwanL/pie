import { randomUUID } from 'node:crypto';

export type SessionTaskFinishOutcome = 'completed' | 'failed' | 'blocked' | 'cancelled';
export type SessionTaskOutcome = SessionTaskFinishOutcome | 'unknown';
export type SessionTaskStatus = 'accepted' | 'running' | 'awaiting-result' | 'terminal' | 'rejected' | 'unknown';

export interface SessionTaskParticipant {
  /** Authenticated session-owner identity supplied by the coordinator. */
  owner: string;
  /** Stable, coordinator-resolved address. Titles are display metadata only. */
  address: string;
  title?: string;
}

export interface SessionTaskRecord {
  readonly taskId: string;
  readonly operationId: string;
  readonly requester: Readonly<SessionTaskParticipant>;
  readonly worker: Readonly<SessionTaskParticipant>;
  readonly revision: number;
  /** Coordinator-monotonic version for wait-after-change; assignment revision is separate. */
  readonly version: number;
  readonly status: SessionTaskStatus;
  readonly prompt: string;
  readonly outcome?: SessionTaskOutcome;
  readonly result?: string;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type SessionTaskChange =
  | { type: 'changed'; record: SessionTaskRecord }
  | { type: 'removed'; taskId: string; owners: readonly string[] };

export type SessionTaskLookup = { status: 'available'; record: SessionTaskRecord } | { status: 'unavailable' };

export interface SessionTaskRegistryOptions {
  maxActive?: number;
  maxRecords?: number;
  maxTextBytes?: number;
  maxPromptBytes?: number;
  maxResultBytes?: number;
  maxListeners?: number;
  now?: () => number;
}

export class SessionTaskError extends Error {
  constructor(readonly code: 'INVALID' | 'CAPACITY' | 'BUSY' | 'CONFLICT' | 'FORBIDDEN' | 'UNAVAILABLE', message: string) {
    super(message);
    this.name = 'SessionTaskError';
  }
}

interface AssignInput {
  requester: SessionTaskParticipant;
  worker: SessionTaskParticipant;
  prompt: string;
  operationId: string;
}

interface AmendInput {
  requester: string;
  taskId: string;
  expectedRevision: number;
  prompt: string;
  operationId: string;
}

interface FinishInput {
  worker: string;
  taskId: string;
  revision: number;
  outcome: SessionTaskFinishOutcome;
  result: string;
}

const DEFAULTS = {
  maxActive: 64,
  maxRecords: 512,
  maxTextBytes: 4 * 1024 * 1024,
  maxPromptBytes: 16 * 1024,
  maxResultBytes: 32 * 1024,
  maxListeners: 128,
};
const terminalStatuses = new Set<SessionTaskStatus>(['terminal', 'rejected']);
const validOutcomes = new Set<SessionTaskFinishOutcome>(['completed', 'failed', 'blocked', 'cancelled']);
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');
const reservedStateBytes = bytes('awaiting-result') + Math.max(...[...validOutcomes, 'unknown'].map(bytes));

/**
 * Coordinator-lifetime task evidence. This registry deliberately has no disk
 * persistence, replay, scheduling, or cross-host behavior. Missing records are
 * unavailable evidence, never proof that a task was not admitted.
 */
export class SessionTaskRegistry {
  private readonly records = new Map<string, SessionTaskRecord>();
  private readonly operationTasks = new Map<string, string>();
  private readonly workerActiveTask = new Map<string, string>();
  private readonly listeners = new Set<(change: SessionTaskChange) => void>();
  private readonly maxActive: number;
  private readonly maxRecords: number;
  private readonly maxTextBytes: number;
  private readonly maxPromptBytes: number;
  private readonly maxResultBytes: number;
  private readonly maxErrorBytes: number;
  private readonly maxListeners: number;
  private readonly now: () => number;
  private sequence = 0;

  constructor(options: SessionTaskRegistryOptions = {}) {
    this.maxActive = options.maxActive ?? DEFAULTS.maxActive;
    this.maxRecords = options.maxRecords ?? DEFAULTS.maxRecords;
    this.maxTextBytes = options.maxTextBytes ?? DEFAULTS.maxTextBytes;
    this.maxPromptBytes = options.maxPromptBytes ?? DEFAULTS.maxPromptBytes;
    this.maxResultBytes = options.maxResultBytes ?? DEFAULTS.maxResultBytes;
    if (!Number.isSafeInteger(this.maxResultBytes) || this.maxResultBytes < 1) {
      throw new SessionTaskError('INVALID', 'maxResultBytes must be a positive safe integer.');
    }
    this.maxErrorBytes = Math.min(1024, this.maxResultBytes);
    this.maxListeners = options.maxListeners ?? DEFAULTS.maxListeners;
    this.now = options.now ?? Date.now;
  }

  assign(input: AssignInput): SessionTaskRecord {
    this.validateParticipant(input.requester);
    this.validateParticipant(input.worker);
    if (!this.validString(input.operationId, 512)) throw new SessionTaskError('INVALID', 'operationId must be a bounded non-empty string.');
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || bytes(input.prompt) > this.maxPromptBytes) {
      throw new SessionTaskError('INVALID', `prompt must be non-empty and at most ${this.maxPromptBytes} UTF-8 bytes.`);
    }
    if (input.requester.owner === input.worker.owner) throw new SessionTaskError('INVALID', 'A session cannot assign a task to itself.');

    const operationKey = this.operationKey(input.worker.owner, input.operationId);
    const previousId = this.operationTasks.get(operationKey);
    if (previousId) {
      const previous = this.records.get(previousId);
      if (previous && previous.requester.owner === input.requester.owner && previous.worker.address === input.worker.address
        && previous.prompt === input.prompt) return previous;
      throw new SessionTaskError('CONFLICT', 'operationId already identifies a different task assignment.');
    }
    if (this.workerActiveTask.has(input.worker.owner)) throw new SessionTaskError('BUSY', 'Worker already has a non-terminal task.');
    if (this.activeCount() >= this.maxActive) {
      throw new SessionTaskError('CAPACITY', 'Task registry capacity is occupied; assignment was not admitted.');
    }

    const taskId = randomUUID();
    const createdAt = this.now();
    const record = this.freezeRecord({
      taskId,
      operationId: input.operationId,
      requester: this.freezeParticipant(input.requester),
      worker: this.freezeParticipant(input.worker),
      revision: 1,
      version: this.sequence + 1,
      status: 'accepted',
      prompt: input.prompt,
      createdAt,
      updatedAt: createdAt,
    });
    const victims = this.evictionsFor(record);
    if (!victims) throw new SessionTaskError('CAPACITY', 'Task registry capacity is occupied by active work or retained text; assignment was not admitted.');
    for (const victim of victims) this.removeRecord(victim);
    this.sequence++;
    this.records.set(taskId, record);
    this.operationTasks.set(operationKey, taskId);
    this.workerActiveTask.set(input.worker.owner, taskId);
    for (const victim of victims) this.publish({ type: 'removed', taskId: victim.taskId, owners: [victim.requester.owner, victim.worker.owner] });
    this.publish({ type: 'changed', record });
    return record;
  }

  amend(input: AmendInput): SessionTaskRecord {
    if (!this.validString(input.requester, 512) || !this.validString(input.taskId, 128)
      || !this.validString(input.operationId, 512)) throw new SessionTaskError('INVALID', 'Amendment requires bounded requester, taskId, and operationId.');
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || bytes(input.prompt) > this.maxPromptBytes) {
      throw new SessionTaskError('INVALID', `prompt must be non-empty and at most ${this.maxPromptBytes} UTF-8 bytes.`);
    }
    const record = this.records.get(input.taskId);
    if (!record) throw new SessionTaskError('UNAVAILABLE', 'Task is unavailable in this coordinator lifetime.');
    if (record.requester.owner !== input.requester) throw new SessionTaskError('FORBIDDEN', 'Only the original requester may amend this task.');
    if (record.revision !== input.expectedRevision) throw new SessionTaskError('CONFLICT', 'Task revision is stale.');
    if (record.status !== 'awaiting-result') throw new SessionTaskError('CONFLICT', 'A task can be amended only after its worker settles without a result.');
    const operationKey = this.operationKey(record.worker.owner, input.operationId);
    const existingId = this.operationTasks.get(operationKey);
    if (existingId) throw new SessionTaskError('CONFLICT', 'operationId already identifies a task operation.');
    const next = this.update(record, {
      operationId: input.operationId,
      revision: record.revision + 1,
      prompt: input.prompt,
      status: 'accepted',
      outcome: undefined,
      result: undefined,
      error: undefined,
    }, false);
    this.operationTasks.delete(this.operationKey(record.worker.owner, record.operationId));
    this.operationTasks.set(operationKey, record.taskId);
    this.workerActiveTask.set(record.worker.owner, record.taskId);
    this.publish({ type: 'changed', record: next });
    return next;
  }

  started(worker: string, operationId: string): SessionTaskRecord {
    const record = this.findByOperation(worker, operationId);
    if (!record) throw new SessionTaskError('UNAVAILABLE', 'No task record exists for this operation in the current coordinator lifetime.');
    if (terminalStatuses.has(record.status) || record.status === 'awaiting-result') return record;
    if (record.status === 'running') return record;
    return this.update(record, { status: 'running', error: undefined });
  }

  admissionFailed(input: { worker: string; operationId: string; status: 'rejected' | 'unknown'; error?: string }): SessionTaskRecord {
    const record = this.findByOperation(input.worker, input.operationId);
    if (!record) throw new SessionTaskError('UNAVAILABLE', 'No task record exists for this operation in the current coordinator lifetime.');
    if (record.status === 'terminal' || record.status === 'rejected') return record;
    // A late lost-ack report cannot undo correlated execution evidence. In
    // particular, preserving awaiting-result keeps deliberate amendment usable.
    if (input.status === 'unknown' && (record.status === 'running' || record.status === 'awaiting-result')) return record;
    if (input.status === 'rejected' && record.status !== 'accepted' && record.status !== 'unknown') {
      throw new SessionTaskError('CONFLICT', 'A started task cannot be changed to rejected.');
    }
    const error = input.error === undefined ? undefined : this.truncateUtf8(input.error, this.maxErrorBytes);
    if (record.status === input.status && record.error === error) return record;
    return this.update(record, { status: input.status, ...(error ? { error } : {}) });
  }

  settled(input: { worker: string; operationId: string; outcome?: 'failed' | 'cancelled'; result?: string }): SessionTaskRecord {
    const record = this.findByOperation(input.worker, input.operationId);
    if (!record) throw new SessionTaskError('UNAVAILABLE', 'No task record exists for this operation in the current coordinator lifetime.');
    if (terminalStatuses.has(record.status)) return record;
    if (record.status === 'awaiting-result' && input.outcome === undefined) return record;
    if (input.outcome === 'failed' || input.outcome === 'cancelled') {
      const result = this.truncateUtf8(input.result ?? '', this.maxResultBytes);
      const updated = this.update(record, { status: 'terminal', outcome: input.outcome, result, error: undefined });
      return updated;
    }
    return this.update(record, { status: 'awaiting-result', error: undefined });
  }

  /** Record an authoritative coordinator interruption for the worker's current
   * assignment. This is keyed by authenticated owner, not a caller-supplied ID. */
  interruptWorker(worker: string): SessionTaskRecord | undefined {
    const taskId = this.workerActiveTask.get(worker);
    const record = taskId ? this.records.get(taskId) : undefined;
    if (!record || terminalStatuses.has(record.status)) return undefined;
    return this.update(record, {
      status: 'terminal', outcome: 'cancelled', result: this.truncateUtf8('Task cancelled by an authoritative session interrupt.', this.maxResultBytes), error: undefined,
    });
  }

  finish(input: FinishInput): SessionTaskRecord {
    if (!this.validString(input.worker, 512) || !this.validString(input.taskId, 128)) throw new SessionTaskError('INVALID', 'worker and taskId must be bounded non-empty strings.');
    if (!Number.isInteger(input.revision) || input.revision < 1) throw new SessionTaskError('CONFLICT', 'Task revision is stale or unsupported.');
    if (!validOutcomes.has(input.outcome)) throw new SessionTaskError('INVALID', 'Invalid task outcome.');
    if (typeof input.result !== 'string' || !input.result.trim() || bytes(input.result) > this.maxResultBytes) {
      throw new SessionTaskError('INVALID', `result must be non-empty and at most ${this.maxResultBytes} UTF-8 bytes.`);
    }
    const record = this.records.get(input.taskId);
    if (!record) throw new SessionTaskError('UNAVAILABLE', 'Task result is unavailable in this coordinator lifetime.');
    if (record.worker.owner !== input.worker) throw new SessionTaskError('FORBIDDEN', 'Only the assigned worker may finish this task.');
    if (input.revision !== record.revision) throw new SessionTaskError('CONFLICT', 'Task revision is stale.');
    if (record.status === 'terminal') {
      if (record.outcome === input.outcome && record.result === input.result) return record;
      throw new SessionTaskError('CONFLICT', 'Task already has a different immutable finish.');
    }
    if (record.status === 'rejected') throw new SessionTaskError('CONFLICT', 'A rejected assignment cannot be finished.');
    const updated = this.update(record, { status: 'terminal', outcome: input.outcome, result: input.result, error: undefined });
    this.workerActiveTask.delete(input.worker);
    return updated;
  }

  inspect(owner: string, taskId?: string): readonly SessionTaskRecord[] {
    if (!this.validString(owner, 512)) throw new SessionTaskError('INVALID', 'owner must be a bounded non-empty string.');
    if (taskId !== undefined) {
      const record = this.records.get(taskId);
      return record && this.canRead(record, owner) ? [record] : [];
    }
    return [...this.records.values()].filter(record => this.canRead(record, owner));
  }

  lookup(owner: string, taskId: string): SessionTaskLookup {
    const record = this.inspect(owner, taskId)[0];
    return record ? { status: 'available', record } : { status: 'unavailable' };
  }

  /** A direct subscription lets the coordinator route notifications after commit. */
  subscribe(listener: (change: SessionTaskChange) => void): () => void {
    if (this.listeners.size >= this.maxListeners) throw new SessionTaskError('CAPACITY', 'Task listener capacity is occupied.');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  retireParticipant(input: { owner: string; deleted?: boolean; workerOutcome?: 'cancelled' | 'unknown' }): void {
    if (!this.validString(input.owner, 512)) throw new SessionTaskError('INVALID', 'owner must be a bounded non-empty string.');
    const owned = [...this.records.values()].filter(record => record.requester.owner === input.owner || record.worker.owner === input.owner);
    const removed: SessionTaskRecord[] = [];
    for (const record of owned) {
      if (input.deleted) {
        this.removeRecord(record);
        removed.push(record);
        continue;
      }
      if (record.worker.owner === input.owner && record.status !== 'terminal' && record.status !== 'rejected') {
        const outcome = input.workerOutcome ?? 'unknown';
        this.update(record, { status: 'terminal', outcome,
          result: outcome === 'cancelled' ? this.truncateUtf8('Worker session closed before finishing the task.', this.maxResultBytes) : '' });
      }
    }
    for (const record of removed) this.publish({ type: 'removed', taskId: record.taskId, owners: [record.requester.owner, record.worker.owner] });
  }

  private findByOperation(worker: string, operationId: string): SessionTaskRecord | undefined {
    const id = this.operationTasks.get(this.operationKey(worker, operationId));
    const record = id ? this.records.get(id) : undefined;
    return record?.operationId === operationId ? record : undefined;
  }

  private update(record: SessionTaskRecord, patch: Partial<Pick<SessionTaskRecord, 'operationId' | 'revision' | 'prompt' | 'status' | 'outcome' | 'result' | 'error'>>, notify = true): SessionTaskRecord {
    const next = this.freezeRecord({ ...record, ...patch, version: this.sequence + 1, updatedAt: this.now() });
    let total = this.totalTextBytes() - this.recordTextBytes(record) + this.recordTextBytes(next);
    const victims: SessionTaskRecord[] = [];
    if (total > this.maxTextBytes) {
      const terminal = [...this.records.values()]
        .filter(candidate => candidate.taskId !== record.taskId && terminalStatuses.has(candidate.status))
        .sort((left, right) => left.updatedAt - right.updatedAt || left.createdAt - right.createdAt);
      for (const victim of terminal) {
        if (total <= this.maxTextBytes) break;
        victims.push(victim);
        total -= this.recordTextBytes(victim);
      }
    }
    if (total > this.maxTextBytes) throw new SessionTaskError('CAPACITY', 'Task text capacity is occupied; state was not changed.');
    for (const victim of victims) this.removeRecord(victim);
    this.sequence++;
    this.records.set(record.taskId, next);
    if (terminalStatuses.has(next.status) && this.workerActiveTask.get(record.worker.owner) === record.taskId) {
      this.workerActiveTask.delete(record.worker.owner);
    }
    for (const victim of victims) this.publish({ type: 'removed', taskId: victim.taskId, owners: [victim.requester.owner, victim.worker.owner] });
    if (notify) this.publish({ type: 'changed', record: next });
    return next;
  }

  private publish(change: SessionTaskChange): void {
    for (const listener of this.listeners) {
      try { listener(change); } catch { /* Notifications cannot roll back committed task state. */ }
    }
  }

  private activeCount(): number { return [...this.records.values()].filter(record => !terminalStatuses.has(record.status)).length; }
  private canRead(record: SessionTaskRecord, owner: string): boolean { return record.requester.owner === owner || record.worker.owner === owner; }
  private operationKey(worker: string, operationId: string): string { return JSON.stringify([worker, operationId]); }
  private totalTextBytes(): number { return [...this.records.values()].reduce((total, record) => total + this.recordTextBytes(record), 0); }
  private evictionsFor(incoming: SessionTaskRecord): SessionTaskRecord[] | undefined {
    const victims: SessionTaskRecord[] = [];
    const terminal = [...this.records.values()]
      .filter(record => terminalStatuses.has(record.status))
      .sort((left, right) => left.updatedAt - right.updatedAt || left.createdAt - right.createdAt);
    let remainingRecords = this.records.size;
    let remainingBytes = this.totalTextBytes();
    for (const victim of terminal) {
      if (remainingRecords < this.maxRecords && remainingBytes + this.recordTextBytes(incoming) <= this.maxTextBytes) break;
      victims.push(victim);
      remainingRecords--;
      remainingBytes -= this.recordTextBytes(victim);
    }
    return remainingRecords < this.maxRecords && remainingBytes + this.recordTextBytes(incoming) <= this.maxTextBytes
      ? victims : undefined;
  }

  private removeRecord(record: SessionTaskRecord): void {
    this.records.delete(record.taskId);
    for (const [key, id] of this.operationTasks) if (id === record.taskId) this.operationTasks.delete(key);
    if (this.workerActiveTask.get(record.worker.owner) === record.taskId) this.workerActiveTask.delete(record.worker.owner);
  }
  /** Aggregate logical UTF-8 field bytes. Active assignments reserve their
   * maximum result and remaining error budget so lifecycle evidence can commit
   * without relying on terminal-record eviction. JSON escaping is transport
   * expansion, not retained task text. */
  private recordTextBytes(record: SessionTaskRecord): number {
    const fields = [record.taskId, record.operationId, record.requester.owner, record.requester.address,
      record.requester.title ?? '', record.worker.owner, record.worker.address, record.worker.title ?? '',
      record.status, record.outcome ?? '', record.prompt, record.result ?? '', record.error ?? ''];
    const textBytes = fields.reduce((total, field) => total + bytes(field), 0);
    if (terminalStatuses.has(record.status)) return textBytes;
    // Settlement can lengthen the non-terminal status without adding a result.
    // An admitted task must still be able to record awaiting-result when every
    // retained-text byte is occupied by active work.
    const stateAllowance = Math.max(0, reservedStateBytes - bytes(record.status) - bytes(record.outcome ?? ''));
    return textBytes + this.maxResultBytes + Math.max(0, this.maxErrorBytes - bytes(record.error ?? '')) + stateAllowance;
  }
  private validString(value: unknown, maxBytes: number): value is string { return typeof value === 'string' && !!value.trim() && bytes(value) <= maxBytes; }
  private truncateUtf8(value: string, maxBytes: number): string {
    const encoded = Buffer.from(value, 'utf8');
    if (encoded.length <= maxBytes) return value;
    let end = maxBytes;
    while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
    return encoded.subarray(0, end).toString('utf8');
  }
  private validateParticipant(participant: SessionTaskParticipant): void {
    if (!participant || !this.validString(participant.owner, 512) || !this.validString(participant.address, 1024)
      || (participant.title !== undefined && (!this.validString(participant.title, 256)))) {
      throw new SessionTaskError('INVALID', 'Task participants require bounded owner and stable address metadata.');
    }
  }
  private freezeParticipant(participant: SessionTaskParticipant): Readonly<SessionTaskParticipant> {
    return Object.freeze({ owner: participant.owner, address: participant.address, ...(participant.title ? { title: participant.title } : {}) });
  }
  private freezeRecord(record: SessionTaskRecord): SessionTaskRecord { return Object.freeze(record); }
}
