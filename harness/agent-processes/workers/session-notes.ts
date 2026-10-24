import type { WorkerJsonObject } from '../lib/rpc/worker-protocol.js';
import { isSessionControlSender, type SessionControlSender } from '../lib/rpc/session-control-attribution.js';
import type { SessionContext } from '../coordinator/server-types.js';
import type { SdkSessionEvent } from '../lib/sdk-integration/sdk.js';

export const SESSION_NOTE_CUSTOM_TYPE = 'pie.session-note';
export const SESSION_NOTE_MAX_BYTES = 16 * 1024;
export const SESSION_RESULT_MAX_BYTES = 32 * 1024;
export const SESSION_NOTE_MAX_PENDING = 32;
export const SESSION_NOTE_MAX_PENDING_BYTES = 256 * 1024;

interface PendingSessionNotes {
  readonly byId: Map<string, number>;
  bytes: number;
}

const pendingBySession = new WeakMap<object, PendingSessionNotes>();
const queueEditGates = new WeakMap<object, symbol>();

function pendingFor(context: SessionContext): PendingSessionNotes {
  const session = context.session as object;
  let pending = pendingBySession.get(session);
  if (!pending) {
    pending = { byId: new Map(), bytes: 0 };
    pendingBySession.set(session, pending);
  }
  return pending;
}

/** Forget queue charges only after a host has confirmed SDK queue clearing. */
export function clearSessionNoteQueue(context: SessionContext): void {
  const pending = pendingBySession.get(context.session as object);
  if (!pending) return;
  pending.byId.clear();
  pending.bytes = 0;
}

/** Atomically reserve the brief SDK queue-edit window when no note is queued. */
export function beginSessionQueueEdit(context: SessionContext): (() => void) | undefined {
  const session = context.session as object;
  if (queueEditGates.has(session) || (pendingBySession.get(session)?.byId.size ?? 0) > 0) return undefined;
  const token = Symbol('session-note-queue-edit');
  queueEditGates.set(session, token);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (queueEditGates.get(session) === token) queueEditGates.delete(session);
  };
}

/** SDK confirmation that this exact custom message crossed into the stream. */
export function observeSessionNoteEvent(context: SessionContext, event: SdkSessionEvent): void {
  if (event.type !== 'message_start') return;
  const message = event.message as (typeof event.message & {
    customType?: unknown;
    details?: unknown;
  }) | undefined;
  if (message?.role !== 'custom' || message.customType !== SESSION_NOTE_CUSTOM_TYPE
    || typeof message.details !== 'object' || message.details === null || Array.isArray(message.details)) return;
  const id = (message.details as Record<string, unknown>).id;
  if (typeof id !== 'string') return;
  const pending = pendingBySession.get(context.session as object);
  const bytes = pending?.byId.get(id);
  if (bytes === undefined || !pending) return;
  pending.byId.delete(id);
  pending.bytes = Math.max(0, pending.bytes - bytes);
}

interface SessionNoteTask {
  id: string;
  revision?: number;
}

interface SessionNotePayload {
  id: string;
  body: string;
  kind: 'note' | 'result';
  sender: SessionControlSender;
  task?: SessionNoteTask;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePayload(value: unknown): SessionNotePayload | undefined {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !['id', 'body', 'kind', 'sender', 'task'].includes(key))) return undefined;
  if (typeof value.id !== 'string' || !value.id.trim() || Buffer.byteLength(value.id, 'utf8') > 256
    || typeof value.body !== 'string'
    || (value.kind !== 'note' && value.kind !== 'result')
    || !isSessionControlSender(value.sender)
    || value.sender.message?.expectReply !== false) return undefined;
  const bodyLimit = value.kind === 'note' ? SESSION_NOTE_MAX_BYTES : SESSION_RESULT_MAX_BYTES;
  if (!value.body.trim() || Buffer.byteLength(value.body, 'utf8') > bodyLimit) return undefined;

  let task: SessionNoteTask | undefined;
  if (value.task !== undefined) {
    if (!isRecord(value.task)
      || Object.keys(value.task).some((key) => !['id', 'revision'].includes(key))
      || typeof value.task.id !== 'string' || !value.task.id.trim()
      || Buffer.byteLength(value.task.id, 'utf8') > 256
      || (value.task.revision !== undefined
        && (!Number.isSafeInteger(value.task.revision) || (value.task.revision as number) < 1))) return undefined;
    task = {
      id: value.task.id,
      ...(value.task.revision !== undefined ? { revision: value.task.revision as number } : {}),
    };
  }

  return {
    id: value.id,
    body: value.body,
    kind: value.kind,
    sender: value.sender,
    ...(task ? { task } : {}),
  };
}

function senderLabel(sender: SessionControlSender): string {
  return sender.title ?? `session ${sender.identity.sessionId}`;
}

function modelContent(payload: SessionNotePayload): string {
  const lines = [
    `[Pie cross-session ${payload.kind}]`,
    `From: ${senderLabel(payload.sender)}`,
    `Reply address: ${payload.sender.address ?? payload.sender.replyReference}`,
    'No acknowledgement is requested.',
  ];
  if (payload.kind === 'note') lines.push('This is context only; it does not assign work.');
  if (payload.task) {
    lines.push(`Task: ${payload.task.id}${payload.task.revision !== undefined ? ` (revision ${payload.task.revision})` : ''}`);
  }
  lines.push('', payload.body);
  return lines.join('\n');
}

/** Deliver a coordinator-authenticated note/result into this worker's SDK
 *  message stream. Idle delivery is durable context only; running delivery is
 *  queued for the next safe SDK boundary. Neither path starts a new turn. */
export async function deliverSessionNote(context: SessionContext, value: unknown): Promise<WorkerJsonObject> {
  const payload = parsePayload(value);
  if (!payload) return { status: 'rejected', error: 'Invalid session note payload.' };
  if (queueEditGates.has(context.session as object)) {
    return {
      status: 'rejected',
      outcome: 'recipient_queue_edit',
      error: 'A queued-message edit is in progress; this note was not queued. Retry the note after the edit finishes.',
    };
  }
  const sendCustomMessage = context.session.sendCustomMessage;
  if (!sendCustomMessage) {
    return { status: 'unavailable', error: 'The active SDK does not support custom session-note delivery.' };
  }

  const streaming = context.session.isStreaming;
  const details = {
    id: payload.id,
    kind: payload.kind,
    sender: payload.sender,
    ...(payload.task ? { task: payload.task } : {}),
    displayBody: payload.body,
  };

  const message = {
    customType: SESSION_NOTE_CUSTOM_TYPE,
    content: modelContent(payload),
    display: true,
    details,
  };
  const encodedBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
  let pending: PendingSessionNotes | undefined;
  if (streaming) {
    pending = pendingFor(context);
    if (pending.byId.has(payload.id)) {
      return { status: 'rejected', outcome: 'backpressure', error: 'A session note with this ID is already pending.' };
    }
    if (pending.byId.size >= SESSION_NOTE_MAX_PENDING
      || encodedBytes > SESSION_NOTE_MAX_PENDING_BYTES - pending.bytes) {
      return { status: 'rejected', outcome: 'backpressure', error: 'The session-note SDK queue is at its pending capacity.' };
    }
    pending.byId.set(payload.id, encodedBytes);
    pending.bytes += encodedBytes;
  }

  try {
    await sendCustomMessage.call(context.session, message, {
      triggerTurn: false,
      ...(streaming ? { deliverAs: 'steer' as const } : {}),
    });
  } catch (error) {
    // The SDK may have queued the message before rejecting. Keep its charge
    // until its exact consumption event or a confirmed clearQueue.
    return {
      status: 'unknown',
      outcome: 'unknown',
      error: error instanceof Error ? error.message.slice(0, 2_048) : String(error).slice(0, 2_048),
    };
  }

  return {
    status: streaming ? 'queued' : 'accepted',
    delivery: streaming ? 'queued' : 'appended',
    id: payload.id,
    kind: payload.kind,
    ...(payload.task ? { task: payload.task } : {}),
  } as unknown as WorkerJsonObject;
}
