import { freemem, totalmem, availableParallelism } from 'node:os';
import type { WorkerJsonObject, WorkerSessionControlAction } from '../lib/rpc/worker-protocol.js';
import type { SessionControlSender } from '../lib/rpc/session-control-attribution.js';
import { SessionTaskRegistry, type SessionTaskParticipant, type SessionTaskRecord, type SessionTaskFinishOutcome } from './session-tasks.js';
import { normalizeSessionResourceName, SessionResourceRegistry, type SessionResourceRequest, type SessionResourceMode, type SessionResourceLeaseView, type SessionResourceResult } from './session-resources.js';
import { SessionNoteAdmission, type SessionNoteReceipt } from './session-note-admission.js';

export interface CollaborationTarget { path: string; participant: SessionTaskParticipant }
export interface CollaborationPorts {
  resolve(target: string, sourcePath: string): CollaborationTarget;
  participant(path: string): SessionTaskParticipant;
  sender(path: string): SessionControlSender;
  busy(path: string): boolean;
  assignment(source: string, target: string, prompt: string, operationId: string, task: SessionTaskRecord): Promise<WorkerJsonObject>;
  /** Undefined means cold: retain in the mailbox instead of promoting it. */
  note(target: string, payload: WorkerJsonObject): Promise<WorkerJsonObject> | undefined;
  workerMemory(): { workers: WorkerJsonObject[]; total: number; truncated: boolean };
}
interface Mail {
  owner: string;
  sourceOwner: string;
  targetPath: string;
  payload: WorkerJsonObject;
  taskId?: string;
}
interface Waiter {
  owner: string;
  id: string;
  resource?: { name: string; mode: SessionResourceMode };
  taskIds?: string[];
  afterRevision: number;
  timer: ReturnType<typeof setTimeout>;
  complete(reason: string): void;
}
const asJson = (value: unknown): WorkerJsonObject => JSON.parse(JSON.stringify(value)) as WorkerJsonObject;
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && Buffer.byteLength(value, 'utf8') <= max;
const finalState = (task: SessionTaskRecord) => ['terminal', 'rejected', 'awaiting-result', 'unknown'].includes(task.status);
function publicTask(task: SessionTaskRecord): WorkerJsonObject {
  const person = (participant: SessionTaskParticipant) => ({ address: participant.address, ...(participant.title ? { title: participant.title } : {}) });
  return asJson({ taskId: task.taskId, revision: task.revision, version: task.version, status: task.status,
    requester: person(task.requester), worker: person(task.worker),
    ...(task.outcome ? { outcome: task.outcome } : {}), ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.error ? { error: task.error } : {}), createdAt: task.createdAt, updatedAt: task.updatedAt });
}
function publicResources(result: SessionResourceResult): WorkerJsonObject {
  const lease = (record: SessionResourceLeaseView) => {
    const { owner: _privateOwner, reclaimedBy: _privateReclaimer, ownerAddress, ownerTitle, ownerDeleted, ...rest } = record;
    return { ...rest, owner: ownerDeleted ? { deleted: true } : {
      ...(ownerAddress ? { address: ownerAddress } : {}), ...(ownerTitle ? { title: ownerTitle } : {}),
    } };
  };
  if (result.action === 'status') return asJson({ ...result, resources: result.resources.map(resource => ({ ...resource, holders: resource.holders.map(lease) })) });
  if ('lease' in result) return asJson({ ...result, lease: lease(result.lease) });
  return asJson({ ...result, conflicts: result.conflicts.map(lease) });
}

/** Host-local coordination authority. Execution/identity/settings remain with
 * their existing owners; this module owns only task evidence, notes and waits. */
export class SessionCollaborationCoordinator {
  readonly tasks = new SessionTaskRegistry();
  readonly resources = new SessionResourceRegistry();
  private readonly mailboxes = new Map<string, Mail[]>();
  /** A drain dispatches from the coordinator control lane while the ordinary
   * worker command is waiting for that drain. Keep claimed mail in its inbox
   * for capacity accounting, but hide it from concurrent drains and waits. */
  private readonly inFlightMail = new WeakSet<Mail>();
  private readonly drainingOwners = new Set<string>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly participantPaths = new Map<string, string>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeResources: () => void;
  private resourceExpiryTimer?: ReturnType<typeof setTimeout>;
  private readonly noteAdmission: SessionNoteAdmission;
  private readonly drainTimeoutMs: number;
  private disposed = false;

  constructor(private readonly ports: CollaborationPorts, options: { noteAdmission?: SessionNoteAdmission; drainTimeoutMs?: number } = {}) {
    this.noteAdmission = options.noteAdmission ?? new SessionNoteAdmission();
    this.drainTimeoutMs = options.drainTimeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.drainTimeoutMs) || this.drainTimeoutMs < 1 || this.drainTimeoutMs > 20_000) {
      throw new Error('drainTimeoutMs must be an integer from 1 to 20000.');
    }
    this.unsubscribe = this.tasks.subscribe(change => {
      let notification: Mail | undefined;
      let requesterWasWaiting = false;
      if (change.type === 'changed') {
        const task = change.record;
        if (finalState(task)) {
          // The authoritative result is committed before any notification.
          // Coalesce by task identity; a status check never creates more work.
          const inbox = this.mailboxes.get(task.requester.owner) ?? [];
          const prior = inbox.findIndex(mail => mail.taskId === task.taskId && !this.inFlightMail.has(mail));
          if (prior >= 0) {
            inbox.splice(prior, 1);
            if (inbox.length === 0) this.mailboxes.delete(task.requester.owner);
          }
          const workerPath = this.participantPaths.get(task.worker.owner);
          const targetPath = this.participantPaths.get(task.requester.owner);
          requesterWasWaiting = [...this.waiters.values()].some(waiter => waiter.owner === task.requester.owner);
          if (inbox.length < 64 && workerPath) {
            const resultBytes = Buffer.from(task.result ?? '', 'utf8');
            let resultEnd = Math.min(resultBytes.length, 28 * 1024);
            while (resultEnd > 0 && (resultBytes[resultEnd] & 0xc0) === 0x80) resultEnd--;
            notification = { owner: task.requester.owner, sourceOwner: task.worker.owner,
              targetPath: targetPath ?? '', taskId: task.taskId, payload: asJson({ id: `task:${task.taskId}:${task.version}`,
                kind: 'result', task: { id: task.taskId, revision: task.revision },
                sender: this.ports.sender(workerPath),
                body: `Task ${task.taskId} is ${task.status}${task.outcome ? ` (${task.outcome})` : ''}.\n\n${resultBytes.subarray(0, resultEnd).toString('utf8')}${resultEnd < resultBytes.length ? '\n[Result notification truncated; inspect this task with session_wait timeoutMs:0.]' : ''}` }) };
            try { this.enqueue(notification); }
            catch { notification = undefined; /* Task evidence remains inspectable under mailbox pressure. */ }
          }
        }
      }
      for (const waiter of [...this.waiters.values()]) {
        if (waiter.resource) {
          if (this.hasAvailableMail(waiter.owner)) waiter.complete('mail');
          continue;
        }
        if (change.type === 'removed' && waiter.taskIds?.includes(change.taskId)) waiter.complete('unavailable');
        else if (change.type === 'changed' && (change.record.requester.owner === waiter.owner || change.record.worker.owner === waiter.owner)
          && (!waiter.taskIds || waiter.taskIds.includes(change.record.taskId))
          && finalState(change.record) && change.record.version > waiter.afterRevision) waiter.complete('changed');
      }
      if (notification?.targetPath && !requesterWasWaiting) {
        try {
          const delivery = this.ports.note(notification.targetPath, notification.payload);
          if (delivery) {
            this.removeMail(notification);
            // Notification failure never changes or replays the committed result.
            void delivery.catch(() => undefined);
          }
        } catch { /* Closed recipients retain result evidence for inspection. */ }
      }
    });
    this.unsubscribeResources = this.resources.subscribeAvailability(change => {
      for (const waiter of [...this.waiters.values()]) {
        if (waiter.resource?.name === change.name && this.resources.isCompatible(change.name, waiter.resource.mode)) waiter.complete('available');
      }
      this.scheduleResourceExpiry();
    });
  }

  static handles(action: WorkerSessionControlAction): boolean {
    return ['note', 'notes.drain', 'task.assign', 'task.finish', 'wait', 'wait.cancel', 'resources'].includes(action);
  }

  async execute(action: WorkerSessionControlAction, payload: WorkerJsonObject, sourcePath: string, requestId: string): Promise<WorkerJsonObject> {
    if (this.disposed) throw new Error('Session coordination is unavailable after shutdown.');
    const caller = this.ports.participant(sourcePath);
    this.participantPaths.set(caller.owner, sourcePath);
    const allowed: Record<string, readonly string[]> = {
      note: ['target', 'message'], 'notes.drain': [],
      'task.assign': ['target', 'prompt', 'taskId', 'revision'],
      'task.finish': ['taskId', 'revision', 'outcome', 'result'],
      wait: ['taskIds', 'timeoutMs', 'afterRevision', 'waitId'], 'wait.cancel': ['waitId'],
      resources: ['action', 'name', 'purpose', 'mode', 'leaseId', 'ttlMs', 'startWithinMs', 'reason', 'confirmStopped', 'timeoutMs', 'waitId'],
    };
    if (Object.keys(payload).some(key => !allowed[action]?.includes(key))) throw new Error(`Unexpected ${action} field.`);
    if (action === 'notes.drain') return await this.drainMail(caller.owner, sourcePath);
    if (action === 'wait.cancel') {
      if (!bounded(payload.waitId, 128)) throw new Error('wait.cancel requires a bounded waitId.');
      const waiter = this.waiters.get(payload.waitId);
      if (waiter?.owner === caller.owner) waiter.complete('cancelled');
      return { cancelled: true };
    }
    if (action === 'note') {
      if (!bounded(payload.target, 768) || !bounded(payload.message, 16 * 1024)) throw new Error('note requires target and non-empty message of at most 16 KiB UTF-8.');
      const target = this.ports.resolve(payload.target, sourcePath);
      this.participantPaths.set(target.participant.owner, target.path);
      if (target.participant.owner === caller.owner) throw new Error('Send notes to another session; use your own context directly.');
      const admission = this.noteAdmission.admit(caller.owner, target.participant.owner, payload.message);
      if (admission.status === 'rejected') return { ...admission, wake: false };
      if (admission.status === 'duplicate') return { ...asJson(admission.receipt), duplicate: true, wake: false,
        guidance: 'The same recent note was already attempted; this response preserves its delivery evidence. No second send was made.' };
      const note = asJson({ id: admission.messageId, kind: 'note', body: payload.message, sender: this.ports.sender(sourcePath) });
      const mail: Mail = { owner: target.participant.owner, sourceOwner: caller.owner, targetPath: target.path, payload: note };
      try { this.enqueue(mail); }
      catch (error) { this.noteAdmission.forget(admission.messageId); throw error; }
      const receipt = (value: WorkerJsonObject): WorkerJsonObject => {
        this.noteAdmission.commit(admission.messageId, value as unknown as Omit<SessionNoteReceipt, 'messageId'>);
        return value;
      };
      const waiting = [...this.waiters.values()].some(waiter => waiter.owner === mail.owner);
      if (waiting) {
        for (const waiter of [...this.waiters.values()]) if (waiter.owner === mail.owner) waiter.complete('mail');
        return receipt({ status: 'accepted', messageId: note.id!, delivery: 'wait', wake: false });
      }
      let delivery: Promise<WorkerJsonObject> | undefined;
      try { delivery = this.ports.note(target.path, note); }
      catch (error) {
        this.removeMail(mail);
        return receipt({ status: 'rejected', messageId: note.id!, wake: false, error: error instanceof Error ? error.message.slice(0, 1024) : 'Target no longer admits notes.' });
      }
      if (!delivery) return receipt({ status: 'accepted', messageId: note.id!, delivery: 'mailbox', wake: false, retention: 'coordinator-lifetime' });
      this.removeMail(mail);
      try {
        const result = await delivery;
        return receipt({ ...result, messageId: note.id!, wake: false });
      } catch (error) {
        return receipt({ status: 'unknown', messageId: note.id!, wake: false, error: error instanceof Error ? error.message.slice(0, 1024) : 'Note delivery acknowledgement unavailable.' });
      }
    }
    if (action === 'task.assign') {
      if (!bounded(payload.target, 768) || !bounded(payload.prompt, 16 * 1024)) throw new Error('Assignment requires a live target and a prompt of at most 16 KiB UTF-8.');
      const target = this.ports.resolve(payload.target, sourcePath);
      return this.assign(caller, target, payload.prompt, `agent-session:${requestId}`, payload.taskId, payload.revision);
    }
    if (action === 'task.finish') {
      if (!bounded(payload.taskId, 128) || !Number.isSafeInteger(payload.revision)
        || !['completed', 'failed', 'blocked', 'cancelled'].includes(String(payload.outcome)) || !bounded(payload.result, 32 * 1024)) throw new Error('Finish requires taskId, accepted revision, outcome, and a result of at most 32 KiB UTF-8.');
      const task = this.tasks.finish({ worker: caller.owner, taskId: payload.taskId, revision: payload.revision as number,
        outcome: payload.outcome as SessionTaskFinishOutcome, result: payload.result });
      return { status: 'committed', task: publicTask(task), notification: 'non-waking', retention: 'coordinator-lifetime' };
    }
    if (action === 'wait') return this.wait(caller.owner, payload);
    if (action === 'resources') {
      if (payload.action === 'wait') return this.waitResource(caller.owner, payload);
      const allowedActions = ['status', 'acquire', 'start', 'renew', 'release', 'reclaim'];
      if (!allowedActions.includes(String(payload.action))) throw new Error('Invalid resource action.');
      if (payload.timeoutMs !== undefined || payload.waitId !== undefined) throw new Error('timeoutMs and waitId are valid only for a resource wait.');
      const result = this.resources.execute({ ...payload, owner: caller.owner,
        ownerAddress: caller.address, ...(caller.title ? { ownerTitle: caller.title } : {}) } as unknown as SessionResourceRequest);
      this.scheduleResourceExpiry();
      const memory = payload.action === 'status' ? this.ports.workerMemory() : undefined;
      return { ...publicResources(result), retention: 'coordinator-lifetime', cooperative: true,
        ...(memory ? { hardware: { observedAt: Date.now(), totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), logicalCpus: availableParallelism(), coordinatorRssBytes: process.memoryUsage().rss }, workers: memory.workers, workerCount: memory.total, workersTruncated: memory.truncated } : {}) };
    }
    throw new Error(`Unsupported coordination operation: ${action}`);
  }

  async assign(requester: SessionTaskParticipant, target: CollaborationTarget, prompt: string, operationId: string, taskId?: unknown, revision?: unknown): Promise<WorkerJsonObject> {
    this.participantPaths.set(target.participant.owner, target.path);
    if (this.ports.busy(target.path)) return { status: 'rejected', reason: 'busy', message: { status: 'rejected', error: 'Worker has active or pending work. Wait or choose another session.' } };
    if ((taskId === undefined) !== (revision === undefined)) throw new Error('Resuming a task requires both taskId and current revision.');
    let task: SessionTaskRecord;
    if (taskId !== undefined) {
      if (!bounded(taskId, 128) || !Number.isSafeInteger(revision)) throw new Error('Invalid task amendment.');
      const prior = this.tasks.inspect(requester.owner, taskId)[0];
      if (!prior || prior.worker.owner !== target.participant.owner) throw new Error('Task does not belong to that requester and worker.');
      task = this.tasks.amend({ requester: requester.owner, taskId, expectedRevision: revision as number, prompt, operationId });
    } else task = this.tasks.assign({ requester, worker: target.participant, prompt, operationId });
    let message: WorkerJsonObject;
    try { message = await this.ports.assignment(requester.address, target.path, prompt, operationId, task); }
    catch (error) { message = { status: 'unknown', error: error instanceof Error ? error.message.slice(0, 1024) : String(error).slice(0, 1024) }; }
    const retained = this.tasks.inspect(requester.owner, task.taskId)[0];
    // Private deletion can purge the admitted record while the send is still
    // awaiting its acknowledgement. Do not fall back to the local pre-await
    // record: that would report a task as accepted after its evidence and
    // participant metadata have been deliberately erased. The send outcome
    // may still be ambiguous, so this response must not invite an automatic
    // replay.
    if (!retained) return {
      status: 'unknown',
      reason: 'task_record_unavailable_after_dispatch',
      message: 'The task record was removed while delivery was pending; the delivery acknowledgement cannot establish retained work.',
      guidance: 'Do not automatically repeat this assignment or create a replacement. Check the live session and task availability before deciding whether to assign new work.',
      retention: 'coordinator-lifetime',
    };
    const current = this.tasks.inspect(requester.owner, task.taskId)[0] ?? retained;
    let responseMessage = message;
    let lateRejection = false;
    if (message.status === 'rejected'
      && ['running', 'awaiting-result', 'terminal'].includes(current.status)) {
      // A generic worker/IPC failure may arrive after its correlated lifecycle
      // event. In that case the negative acknowledgement cannot prove that the
      // assignment was never admitted. Preserve the stronger task evidence
      // and expose the acknowledgement as ambiguous so callers do not retry.
      lateRejection = true;
      responseMessage = {
        ...message,
        status: 'unknown',
        reason: 'rejection_after_execution_evidence',
        error: 'The delivery acknowledgement reported rejection after correlated execution evidence was retained.',
      };
    }
    if (responseMessage.status === 'rejected' || responseMessage.status === 'unknown') this.tasks.admissionFailed({ worker: target.participant.owner, operationId, status: responseMessage.status,
      ...(typeof responseMessage.error === 'string' ? { error: responseMessage.error } : {}) });
    const latest = this.tasks.inspect(requester.owner, task.taskId)[0] ?? current;
    return {
      status: responseMessage.status === 'accepted' ? 'accepted' : responseMessage.status!,
      task: publicTask(latest),
      message: responseMessage,
      ...(responseMessage.status === 'unknown' ? {
        guidance: lateRejection
          ? 'Correlated execution evidence was retained. Inspect this task with session_wait; do not repeat the assignment automatically.'
          : 'The assignment acknowledgement is uncertain. Inspect this task with session_wait; do not repeat the assignment automatically.',
      } : {}),
      retention: 'coordinator-lifetime',
    };
  }

  observe(event: string, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const row = payload as Record<string, unknown>;
    if (typeof row.sessionPath !== 'string' || typeof row.operationId !== 'string') return;
    try {
      const owner = this.ports.participant(row.sessionPath).owner;
      // Live-pipeline workers suppress the legacy message.started event and
      // publish a correlated semantic turn boundary instead. Only the
      // explicit turn.started kind is start evidence; phases/other progress
      // must never promote an accepted task to running.
      if (event === 'message.started'
        || (event === 'live.semantic' && row.kind === 'turn.started')) {
        this.tasks.started(owner, row.operationId);
      }
      else if (event === 'preflight.failed') this.tasks.admissionFailed({ worker: owner, operationId: row.operationId, status: 'rejected', error: typeof row.error === 'string' ? row.error : 'Prompt preflight failed.' });
      else if (event === 'agent.settled') this.tasks.settled({ worker: owner, operationId: row.operationId,
        ...(row.executionOutcome === 'failed' || row.executionOutcome === 'cancelled' ? { outcome: row.executionOutcome } : {}) });
      else if (event === 'message.aborted') this.tasks.settled({ worker: owner, operationId: row.operationId, outcome: row.userInitiated === true ? 'cancelled' : 'failed', result: typeof row.reason === 'string' ? row.reason : 'Execution interrupted before a result was committed.' });
    } catch { /* Events for ordinary user/subagent work have no task record. */ }
  }

  retire(path: string, deleted = false, confirmedCancelled = false): void {
    const owner = this.ports.participant(path).owner;
    for (const waiter of [...this.waiters.values()]) if (waiter.owner === owner) waiter.complete('cancelled');
    // Purge private mail before task-removal observers can resolve peer waits.
    if (deleted) this.mailboxes.delete(owner);
    if (deleted) for (const [recipient, inbox] of this.mailboxes) {
      const kept = inbox.filter(mail => mail.sourceOwner !== owner);
      if (kept.length) this.mailboxes.set(recipient, kept); else this.mailboxes.delete(recipient);
    }
    this.tasks.retireParticipant({ owner, deleted, ...(confirmedCancelled ? { workerOutcome: 'cancelled' } : {}) });
    this.resources.retireOwner(owner, { deleted });
    this.noteAdmission.retireOwner(owner, { deleted });
    this.scheduleResourceExpiry();
    this.participantPaths.delete(owner);
  }

  /** Terminalize only task evidence after the router confirms an interrupt.
   * Mailboxes and advisory resource leases belong to the participant lifecycle
   * and must survive a task-level interrupt. */
  interruptTaskForWorker(path: string): SessionTaskRecord | undefined {
    const owner = this.ports.participant(path).owner;
    return this.tasks.interruptWorker(owner);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribeResources();
    if (this.resourceExpiryTimer) clearTimeout(this.resourceExpiryTimer);
    for (const waiter of [...this.waiters.values()]) waiter.complete('cancelled');
    this.mailboxes.clear();
  }

  private enqueue(mail: Mail): void {
    const inbox = this.mailboxes.get(mail.owner) ?? [];
    const size = Buffer.byteLength(JSON.stringify(mail), 'utf8');
    let inboxBytes = 0;
    let totalBytes = 0;
    let totalItems = 0;
    for (const [owner, retained] of this.mailboxes) for (const item of retained) {
      totalItems++;
      const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
      totalBytes += itemBytes;
      if (owner === mail.owner) inboxBytes += itemBytes;
    }
    if (inbox.length >= 64 || totalItems >= 4096 || inboxBytes + size > 256 * 1024 || totalBytes + size > 4 * 1024 * 1024) throw new Error('Mailbox capacity is occupied; note was not admitted.');
    inbox.push(mail);
    this.mailboxes.set(mail.owner, inbox);
  }
  private removeMail(mail: Mail): void {
    const inbox = this.mailboxes.get(mail.owner);
    const index = inbox?.indexOf(mail) ?? -1;
    if (index >= 0) inbox!.splice(index, 1);
    if (!inbox?.length) this.mailboxes.delete(mail.owner);
  }
  private takeMail(owner: string, results: boolean, taskIds?: readonly string[]): WorkerJsonObject[] {
    const inbox = this.mailboxes.get(owner) ?? [];
    const taken: Mail[] = [];
    let bytes = 0;
    for (const mail of inbox) {
      if (this.inFlightMail.has(mail)) continue;
      if (mail.taskId && (!results || (taskIds && !taskIds.includes(mail.taskId)))) continue;
      const size = Buffer.byteLength(JSON.stringify(mail.payload), 'utf8');
      if (taken.length && bytes + size > 64 * 1024) break;
      taken.push(mail);
      bytes += size;
    }
    const kept = inbox.filter(mail => !taken.includes(mail));
    if (kept.length) this.mailboxes.set(owner, kept); else this.mailboxes.delete(owner);
    return taken.map(mail => mail.payload);
  }

  /** Deliver retained mail through the worker's out-of-band `message.note`
   * control lane. The ordinary send is waiting for this drain; routing the
   * retained notes back through its FIFO would lose that control-lane behavior. */
  private async drainMail(owner: string, targetPath: string): Promise<WorkerJsonObject> {
    if (this.drainingOwners.has(owner)) {
      const retained = this.mailboxes.get(owner)?.length ?? 0;
      return { messages: [], attempted: 0, retained, remaining: retained, alreadyInProgress: true, issues: [] };
    }
    this.drainingOwners.add(owner);
    const batch: Mail[] = [];
    let batchBytes = 0;
    for (const mail of this.mailboxes.get(owner) ?? []) {
      if (this.inFlightMail.has(mail)) continue;
      const size = Buffer.byteLength(JSON.stringify(mail), 'utf8');
      if (batch.length >= 8 || (batch.length > 0 && batchBytes + size > 64 * 1024)) break;
      batch.push(mail);
      batchBytes += size;
    }
    // Claim the whole bounded batch before any route can await, preventing a
    // concurrent drain from overtaking the oldest pending message.
    for (const mail of batch) this.inFlightMail.add(mail);
    const issues: WorkerJsonObject[] = [];
    let attempted = 0;
    const deadline = Date.now() + this.drainTimeoutMs;
    try {
      for (const mail of batch) {
        if (!this.mailboxes.get(owner)?.includes(mail)) continue; // Retired/deleted while earlier mail was in flight.
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        let delivery: Promise<WorkerJsonObject> | undefined;
        try {
          delivery = this.ports.note(targetPath, mail.payload);
        } catch (error) {
          // The server's synchronous throw is admission validation before the
          // route starts. Keep this and the older-first suffix for a later attempt.
          issues.push(this.drainIssue(mail, 'rejected', true,
            error instanceof Error ? error.message : 'The recipient rejected note admission.'));
          break;
        }
        if (!delivery) {
          issues.push(this.drainIssue(mail, 'unavailable', true, 'The recipient worker is no longer hot; the note remains queued.'));
          break;
        }
        attempted++;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          delivery.then(
            result => ({ kind: 'result' as const, result }),
            error => ({ kind: 'error' as const, error }),
          ),
          new Promise<{ kind: 'timeout' }>(resolve => {
            timer = setTimeout(() => resolve({ kind: 'timeout' }), remainingMs);
          }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
        if (outcome.kind === 'timeout') {
          // The worker route may still settle later. Promise.race has attached
          // both handlers, and this late result must not alter committed state.
          // The route may have enqueued before losing its acknowledgement.
          // Remove it and preserve unknown evidence; never replay this write.
          this.removeMail(mail);
          this.commitNoteDelivery(mail, { status: 'unknown', outcome: 'unknown', delivery: 'acknowledgement-pending' });
          issues.push(this.drainIssue(mail, 'unknown', false,
            'The delivery acknowledgement exceeded the bounded drain deadline.'));
          break;
        }
        if (outcome.kind === 'error') {
          // The route may have enqueued before losing its acknowledgement.
          // Remove it and preserve unknown evidence; never replay this write.
          this.removeMail(mail);
          this.commitNoteDelivery(mail, { status: 'unknown', outcome: 'unknown', delivery: 'acknowledgement-pending' });
          issues.push(this.drainIssue(mail, 'unknown', false,
            outcome.error instanceof Error ? outcome.error.message : 'Delivery acknowledgement was unavailable.'));
          break;
        }
        const result = outcome.result;
        const status = result.status;
        if (status === 'accepted' || status === 'queued') {
          this.removeMail(mail);
          this.commitNoteDelivery(mail, result);
        } else if (status === 'unknown') {
          this.removeMail(mail);
          this.commitNoteDelivery(mail, result);
          issues.push(this.drainIssue(mail, 'unknown', false,
            typeof result.error === 'string' ? result.error : 'The recipient delivery outcome is unknown.'));
          break;
        } else if (status === 'rejected' || status === 'unavailable') {
          // The worker reports these before SDK enqueue, so retaining the
          // mailbox item is safe; keep the suffix ordered for a later drain.
          issues.push(this.drainIssue(mail, status, true,
            typeof result.error === 'string' ? result.error : 'The recipient did not admit this message.'));
          break;
        } else {
          // Treat unfamiliar outcomes as ambiguous rather than retrying a
          // possibly committed SDK write.
          this.removeMail(mail);
          this.commitNoteDelivery(mail, { status: 'unknown', outcome: 'unknown' });
          issues.push(this.drainIssue(mail, 'unknown', false, 'The recipient returned an unrecognized delivery outcome.'));
          break;
        }
      }
    } finally {
      for (const mail of batch) this.inFlightMail.delete(mail);
      this.drainingOwners.delete(owner);
      // A wait may have registered while every retained entry was hidden as
      // in-flight. Recheck availability after restoring visibility so it does
      // not sleep until timeout after a known failure or cold route.
      for (const waiter of [...this.waiters.values()]) {
        if (waiter.owner !== owner) continue;
        if (this.hasAvailableMail(owner, waiter.resource ? undefined : waiter.taskIds)) waiter.complete('mail');
      }
    }
    const retained = this.mailboxes.get(owner)?.length ?? 0;
    return { messages: [], attempted, retained, remaining: retained, issues };
  }

  private drainIssue(mail: Mail, status: string, retained: boolean, error: string): WorkerJsonObject {
    return { id: String(mail.payload.id ?? '').slice(0, 128), status, retained,
      error: error.slice(0, 512) };
  }

  private commitNoteDelivery(mail: Mail, receipt: WorkerJsonObject): void {
    if (mail.payload.kind !== 'note' || typeof mail.payload.id !== 'string') return;
    this.noteAdmission.commit(mail.payload.id, receipt as unknown as Omit<SessionNoteReceipt, 'messageId'>);
  }

  private hasAvailableMail(owner: string, taskIds?: readonly string[]): boolean {
    return (this.mailboxes.get(owner) ?? []).some(mail => !this.inFlightMail.has(mail)
      && (!mail.taskId || !taskIds || taskIds.includes(mail.taskId)));
  }
  private scheduleResourceExpiry(): void {
    if (this.resourceExpiryTimer) clearTimeout(this.resourceExpiryTimer);
    this.resourceExpiryTimer = undefined;
    if (this.disposed || ![...this.waiters.values()].some(waiter => waiter.resource)) return;
    const deadline = this.resources.nextReservedExpiry();
    if (deadline === undefined) return;
    this.resourceExpiryTimer = setTimeout(() => {
      this.resourceExpiryTimer = undefined;
      this.resources.sweepExpired();
      this.scheduleResourceExpiry();
    }, Math.max(1, deadline - Date.now()));
    this.resourceExpiryTimer.unref?.();
  }

  private waitResource(owner: string, payload: WorkerJsonObject): Promise<WorkerJsonObject> {
    if (Object.keys(payload).some(key => !['action', 'name', 'mode', 'timeoutMs', 'waitId'].includes(key))) throw new Error('A resource wait takes only name, mode, and timeoutMs.');
    if (!bounded(payload.waitId, 128)
      || !Number.isInteger(payload.timeoutMs) || (payload.timeoutMs as number) < 0 || (payload.timeoutMs as number) > 300_000
      || (payload.mode !== undefined && payload.mode !== 'shared' && payload.mode !== 'exclusive')) throw new Error('Resource wait requires name, waitId, valid mode, and timeoutMs from 0 to 300000.');
    const name = normalizeSessionResourceName(payload.name);
    const mode = (payload.mode ?? 'exclusive') as SessionResourceMode;
    const result = (reason: string): WorkerJsonObject => ({ reason, name, mode,
      compatible: this.resources.isCompatible(name, mode),
      ...publicResources(this.resources.execute({ action: 'status', owner, name })),
      // This is an observation, never a reservation or a place in a queue.
      action: 'wait', acquired: false, messages: reason === 'cancelled' ? [] : this.takeMail(owner, true), retention: 'coordinator-lifetime', cooperative: true });
    if (payload.timeoutMs === 0) return Promise.resolve(result('inspection'));
    if (this.resources.isCompatible(name, mode)) return Promise.resolve(result('available'));
    if (this.hasAvailableMail(owner)) return Promise.resolve(result('mail'));
    if (this.waiters.size >= 128 || [...this.waiters.values()].some(waiter => waiter.owner === owner)) throw new Error('One active wait per session is allowed; wait capacity is bounded.');
    if (this.waiters.has(payload.waitId)) throw new Error('waitId is already active.');
    return new Promise(resolve => {
      const id = payload.waitId as string;
      const complete = (reason: string) => {
        const waiter = this.waiters.get(id);
        if (!waiter) return;
        this.waiters.delete(id);
        clearTimeout(waiter.timer);
        resolve(result(reason));
        this.scheduleResourceExpiry();
      };
      const timer = setTimeout(() => complete('timeout'), payload.timeoutMs as number);
      this.waiters.set(id, { id, owner, resource: { name, mode }, afterRevision: 0, timer, complete });
      this.scheduleResourceExpiry();
    });
  }
  private wait(owner: string, payload: WorkerJsonObject): Promise<WorkerJsonObject> {
    if (!bounded(payload.waitId, 128) || !Number.isInteger(payload.timeoutMs) || (payload.timeoutMs as number) < 0 || (payload.timeoutMs as number) > 300_000) throw new Error('wait requires waitId and timeoutMs from 0 to 300000.');
    const taskIds = payload.taskIds;
    if (taskIds !== undefined && (!Array.isArray(taskIds) || !taskIds.length || taskIds.length > 16 || taskIds.some(id => !bounded(id, 128)) || new Set(taskIds).size !== taskIds.length)) throw new Error('taskIds must contain 1–16 unique bounded IDs.');
    const ids = taskIds as string[] | undefined;
    const afterRevision = payload.afterRevision ?? 0;
    if (!Number.isSafeInteger(afterRevision) || (afterRevision as number) < 0) throw new Error('afterRevision must be a non-negative record version.');
    const records = () => {
      if (ids) return ids.flatMap(id => this.tasks.inspect(owner, id));
      return this.tasks.inspect(owner).sort((left, right) => right.version - left.version).slice(0, 16);
    };
    const result = (reason: string) => {
      const tasks = records();
      const maxResultBytes = Math.min(32 * 1024, Math.floor(96 * 1024 / Math.max(1, tasks.length)));
      const projected = tasks.map(task => {
        const { result: body, ...metadata } = publicTask(task);
        if (body === undefined) return metadata;
        const bytes = Buffer.from(String(body), 'utf8');
        let end = Math.min(maxResultBytes, bytes.length);
        while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
        return { ...metadata, result: bytes.subarray(0, end).toString('utf8'), ...(end < bytes.length ? { resultTruncated: true, guidance: 'Inspect this task alone with session_wait timeoutMs:0 for its full result.' } : {}) };
      });
      const projectedTaskIds = new Set(projected.map(task => String(task.taskId)));
      const messages = (reason === 'cancelled' ? [] : this.takeMail(owner, true, ids)).map(message => {
        if (message.kind !== 'result') return message;
        const task = message.task;
        const taskId = task && typeof task === 'object' && !Array.isArray(task) && typeof task.id === 'string' ? task.id : undefined;
        if (taskId && projectedTaskIds.has(taskId)) {
          return { ...message, body: 'Task state changed; see the task evidence in this response.', taskEvidenceIncluded: true };
        }
        return {
          ...message,
          taskEvidenceIncluded: false,
          ...(taskId ? { guidance: `This task is omitted from the bounded task snapshot. Inspect it with session_wait ${JSON.stringify({ taskIds: [taskId], timeoutMs: 0 })}.` } : {}),
        };
      });
      const envelope = () => asJson({ reason, tasks: projected, messages, revision: Math.max(0, ...tasks.map(task => task.version)), retention: 'coordinator-lifetime' });
      while (Buffer.byteLength(JSON.stringify(envelope()), 'utf8') > 224 * 1024) {
        const largest = projected.filter(task => 'result' in task && typeof task.result === 'string' && task.result.length > 128)
          .sort((a, b) => ('result' in b ? String(b.result).length : 0) - ('result' in a ? String(a.result).length : 0))[0];
        if (!largest || !('result' in largest) || typeof largest.result !== 'string') break;
        let end = Math.floor(largest.result.length / 2);
        if (end > 0 && /[\uD800-\uDBFF]/u.test(largest.result[end - 1]!)) end--;
        largest.result = largest.result.slice(0, end);
        Object.assign(largest, { resultTruncated: true, guidance: 'Inspect this task alone with session_wait timeoutMs:0 for more result evidence.' });
      }
      return envelope();
    };
    const current = records();
    if (ids && current.length !== ids.length) return Promise.resolve(result('unavailable'));
    if (payload.timeoutMs === 0) return Promise.resolve(result('inspection'));
    if (this.hasAvailableMail(owner, ids)
      || (ids && current.some(task => finalState(task) && task.version > (afterRevision as number)))) return Promise.resolve(result('available'));
    if (this.waiters.size >= 128 || [...this.waiters.values()].some(waiter => waiter.owner === owner)) throw new Error('One active wait per session is allowed; wait capacity is bounded.');
    if (this.waiters.has(payload.waitId)) throw new Error('waitId is already active.');
    return new Promise(resolve => {
      const id = payload.waitId as string;
      const complete = (reason: string) => {
        const waiter = this.waiters.get(id);
        if (!waiter) return;
        this.waiters.delete(id);
        clearTimeout(waiter.timer);
        resolve(result(reason));
      };
      const timer = setTimeout(() => complete('timeout'), payload.timeoutMs as number);
      this.waiters.set(id, { id, owner, taskIds: ids, afterRevision: afterRevision as number, timer, complete });
    });
  }
}
