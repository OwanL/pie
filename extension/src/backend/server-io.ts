import type { Writable } from 'node:stream';
import { JSONL_MAX_LINE_BYTES, serializeJsonLine } from '../shared/jsonl';
import type { ErrorPayload, EventEnvelope, ResponseEnvelope } from '../shared/protocol';
import { SessionSnapshotTooLargeError } from '../shared/transcript-window';
import {
  compactJsonPatchOperations,
  DEFAULT_JSON_PATCH_LIMITS,
  type JsonStructuralPatchOperation,
} from '../shared/json-structural-patch';
import { isBackendLivePipelineTraceEnabled, recordBackendLivePipelineTrace } from './live-pipeline-trace-runtime';

interface QueuedLine {
  line: string;
  bytes: number;
  progressKey?: string;
  /** Sequenced semantic records must never be dropped or reordered. */
  sequencedSemantic: boolean;
  /** RPC acknowledgements are independent control traffic. They must not sit
   * behind an arbitrarily large backlog of already-queued stream events. */
  response: boolean;
  queuedAt: number;
  trace?: WriterTraceMetadata;
  semanticProgress?: SemanticProgressMetadata;
}

interface SemanticProgressMetadata {
  key: string;
  baseSeq: number;
  seq: number;
  baseProgressRevision: number;
  progressRevision: number;
  envelope: Record<string, unknown>;
  payload: Record<string, unknown>;
  update: { kind: 'snapshot'; preview: unknown; operations?: JsonStructuralPatchOperation[] }
    | { kind: 'patch'; operations: JsonStructuralPatchOperation[] };
}

interface WriterTraceMetadata {
  identifiers: { session?: string; request?: string; turn?: string; attempt?: string; message?: string; tool?: string };
  eventKind: 'text' | 'reasoning' | 'tool_draft' | 'tool_start' | 'tool_progress' | 'tool_terminal' | 'turn_start' | 'turn_terminal' | 'control' | 'checkpoint' | 'snapshot' | 'render';
  eventSeq?: number;
}

export interface OrderedJsonlWriterOptions {
  /** Application-owned bytes waiting behind the active stream write. */
  maxQueuedBytes?: number;
  /** Capacity reserved exclusively for correlated RPC responses. */
  maxQueuedResponseBytes?: number;
  /** Production treats critical overflow/write failure as fatal. */
  onFatal?: (error: Error) => void;
}

/** Serializes writes while bounding application-owned backlog. Legacy
 * unsequenced progress for the same session/tool is coalesced. Sequenced live
 * semantic records remain strict FIFO and fail closed rather than creating an
 * artificial sequence gap. RPC
 * responses use a priority lane (FIFO within that lane), so control-plane
 * acknowledgements cannot be head-of-line blocked by queued stream events.
 * The active stream write is never preempted and event/event order is retained. */
const MAX_TERMINAL_TOOL_KEYS = 2_048;

export class OrderedJsonlWriter {
  private readonly queue: QueuedLine[] = [];
  private readonly maxQueuedBytes: number;
  private readonly maxQueuedResponseBytes: number;
  private readonly onFatal: (error: Error) => void;
  private queuedBytes = 0;
  private queuedResponseBytes = 0;
  private writing = false;
  private failed = false;
  private readonly terminalToolKeys = new Set<string>();
  private readonly terminalToolKeyOrder: string[] = [];

  constructor(private readonly stream: Writable, options: OrderedJsonlWriterOptions = {}) {
    this.maxQueuedBytes = options.maxQueuedBytes ?? 2 * JSONL_MAX_LINE_BYTES;
    this.maxQueuedResponseBytes = options.maxQueuedResponseBytes ?? JSONL_MAX_LINE_BYTES;
    this.onFatal = options.onFatal ?? ((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      process.nextTick(() => process.exit(1));
    });
  }

  write(value: unknown): void {
    if (this.failed) throw new Error('JSONL writer is unavailable after a fatal error.');
    let line = serializeJsonLine(value);
    let entry: QueuedLine = {
      line,
      bytes: Buffer.byteLength(line),
      progressKey: progressKey(value),
      sequencedSemantic: isSequencedSemanticEnvelope(value),
      response: isResponseEnvelope(value),
      queuedAt: performance.now(),
      trace: isBackendLivePipelineTraceEnabled() ? writerTraceMetadata(value) : undefined,
      semanticProgress: semanticProgressMetadata(value),
    };
    if (entry.bytes > JSONL_MAX_LINE_BYTES) {
      if (entry.progressKey && !entry.sequencedSemantic) return;
      if (entry.response) {
        const responseId = (value as { id: string }).id;
        line = serializeJsonLine(responseError(
          responseId,
          'RESPONSE_TOO_LARGE',
          `Backend response exceeded the JSONL record limit (${entry.bytes} > ${JSONL_MAX_LINE_BYTES} bytes).`,
        ));
        entry = {
          line,
          bytes: Buffer.byteLength(line),
          sequencedSemantic: false,
          response: true,
          queuedAt: performance.now(),
          trace: isBackendLivePipelineTraceEnabled() ? writerTraceMetadata(value) : undefined,
        };
      } else {
        this.fail(`Fatal JSONL stdout record overflow (${entry.bytes} > ${JSONL_MAX_LINE_BYTES} bytes).`);
      }
    }

    const terminalKey = terminalToolKey(value);
    if (entry.progressKey && !entry.sequencedSemantic && this.terminalToolKeys.has(entry.progressKey)) return;

    if (this.writing && entry.semanticProgress) {
      const previousEventIndex = this.findLastQueuedEventIndex();
      const previous = previousEventIndex >= 0 ? this.queue[previousEventIndex] : undefined;
      if (previous?.semanticProgress
        && previous.semanticProgress.key === entry.semanticProgress.key
        && previous.semanticProgress.seq === entry.semanticProgress.baseSeq
        && previous.semanticProgress.progressRevision === entry.semanticProgress.baseProgressRevision) {
        const combined = combineSemanticProgress(previous.semanticProgress, entry.semanticProgress);
        const combinedLine = serializeJsonLine(combined.envelope);
        const combinedBytes = Buffer.byteLength(combinedLine);
        const replacementBytes = this.queuedBytes - previous.bytes + combinedBytes;
        const replacementEventBytes = replacementBytes - this.queuedResponseBytes;
        const combinedOperations = combined.update.operations?.length ?? 0;
        if (combinedOperations <= DEFAULT_JSON_PATCH_LIMITS.maxOperations
          && combinedBytes <= JSONL_MAX_LINE_BYTES
          && replacementEventBytes <= this.maxQueuedBytes) {
          const replacement: QueuedLine = {
            ...entry,
            line: combinedLine,
            bytes: combinedBytes,
            semanticProgress: combined,
            queuedAt: previous.queuedAt,
          };
          this.queue[previousEventIndex] = replacement;
          this.queuedBytes = replacementBytes;
          this.traceQueued(replacement);
          return;
        }
        // The latest patch can safely replace an unwriteable contiguous range:
        // its base revision will no longer match at the host, which triggers the
        // checkpoint RPC. This bounds backlog without dropping a lifecycle
        // record or pretending the patch was applicable.
        const latestReplacementBytes = this.queuedBytes - previous.bytes + entry.bytes;
        const latestEventBytes = latestReplacementBytes - this.queuedResponseBytes;
        if (entry.bytes <= JSONL_MAX_LINE_BYTES && latestEventBytes <= this.maxQueuedBytes) {
          this.queue[previousEventIndex] = entry;
          this.queuedBytes = latestReplacementBytes;
          this.traceQueued(entry);
          return;
        }
      }
    }

    if (this.writing && entry.progressKey && !entry.sequencedSemantic) {
      const staleIndex = this.queue.findIndex((queued) => queued.progressKey === entry.progressKey);
      if (staleIndex >= 0) {
        const stale = this.queue[staleIndex]!;
        const staleSeq = stale.trace?.eventSeq;
        const nextSeq = entry.trace?.eventSeq;
        if (staleSeq !== undefined && nextSeq !== undefined && nextSeq <= staleSeq) return;
        const replacementBytes = this.queuedBytes - stale.bytes + entry.bytes;
        const replacementEventBytes = replacementBytes - this.queuedResponseBytes;
        if (replacementEventBytes > this.maxQueuedBytes) return;
        // Replace at the original position: moving fresh progress to the tail
        // could place it after a terminal/response event already queued.
        this.queue[staleIndex] = entry;
        this.queuedBytes = replacementBytes;
        this.traceQueued(entry);
        return;
      }
    }

    if (terminalKey) {
      const staleIndex = this.queue.findIndex((queued) => queued.progressKey === terminalKey);
      if (staleIndex >= 0 && !this.queue[staleIndex]?.sequencedSemantic) {
        const [stale] = this.queue.splice(staleIndex, 1);
        if (stale) {
          this.queuedBytes -= stale.bytes;
          if (stale.response) this.queuedResponseBytes -= stale.bytes;
        }
      }
    }

    if (this.writing) {
      const eventBytes = this.queuedBytes - this.queuedResponseBytes;
      if (entry.response && this.queuedResponseBytes + entry.bytes > this.maxQueuedResponseBytes) {
        this.fail(
          `Fatal JSONL stdout response queue overflow (${this.queuedResponseBytes + entry.bytes} > ${this.maxQueuedResponseBytes} bytes).`,
        );
      }
      if (!entry.response && eventBytes + entry.bytes > this.maxQueuedBytes) {
        if (entry.progressKey && !entry.sequencedSemantic) return;
        this.fail(
          `Fatal JSONL stdout event queue overflow (${eventBytes + entry.bytes} > ${this.maxQueuedBytes} bytes).`,
        );
      }
    }

    if (terminalKey) this.rememberTerminalToolKey(terminalKey);
    this.queue.push(entry);
    this.queuedBytes += entry.bytes;
    if (entry.response) this.queuedResponseBytes += entry.bytes;
    this.traceQueued(entry);
    this.pump();
  }

  getDebugState(): { terminalToolKeys: number; queueDepth: number; queuedBytes: number } {
    return { terminalToolKeys: this.terminalToolKeys.size, queueDepth: this.queue.length, queuedBytes: this.queuedBytes };
  }

  private findLastQueuedEventIndex(): number {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (!this.queue[index]?.response) return index;
    }
    return -1;
  }

  private rememberTerminalToolKey(key: string): void {
    if (this.terminalToolKeys.has(key)) return;
    this.terminalToolKeys.add(key);
    this.terminalToolKeyOrder.push(key);
    while (this.terminalToolKeyOrder.length > MAX_TERMINAL_TOOL_KEYS) {
      const expired = this.terminalToolKeyOrder.shift();
      if (expired) this.terminalToolKeys.delete(expired);
    }
  }

  private fail(message: string): never {
    const error = new Error(message);
    this.failed = true;
    this.onFatal(error);
    throw error;
  }

  private pump(): void {
    if (this.writing || this.failed) return;
    // Preserve FIFO inside both classes, but drain responses before events.
    // Responses are correlation-id addressed and the host already supports
    // backend events arriving on either side of their acknowledgement. Events
    // themselves remain strictly ordered, preserving transcript causality.
    const responseIndex = this.queue.findIndex((queued) => queued.response);
    const entry = responseIndex >= 0
      ? this.queue.splice(responseIndex, 1)[0]
      : this.queue.shift();
    if (!entry) return;
    this.queuedBytes -= entry.bytes;
    if (entry.response) this.queuedResponseBytes -= entry.bytes;
    this.writing = true;
    this.stream.write(entry.line, (error?: Error | null) => {
      this.writing = false;
      this.traceSettled(entry, !!error);
      if (error) {
        this.failed = true;
        this.onFatal(new Error(`Fatal JSONL stdout write failure: ${error.message}`));
        return;
      }
      this.pump();
    });
  }

  private traceQueued(entry: QueuedLine): void {
    if (!entry.trace) return;
    recordBackendLivePipelineTrace({
      stage: 'backend.writer.queued',
      kind: 'start',
      identifiers: entry.trace.identifiers,
      eventKind: entry.trace.eventKind,
      eventSeq: entry.trace.eventSeq,
      queueDepth: this.queue.length,
      queueBytes: this.queuedBytes,
    });
  }

  private traceSettled(entry: QueuedLine, failed: boolean): void {
    if (!entry.trace) return;
    recordBackendLivePipelineTrace({
      stage: 'backend.writer.settled',
      kind: failed ? 'failure' : 'success',
      identifiers: entry.trace.identifiers,
      eventKind: entry.trace.eventKind,
      eventSeq: entry.trace.eventSeq,
      durationMs: Math.max(0, performance.now() - entry.queuedAt),
      queueDepth: this.queue.length,
      queueBytes: this.queuedBytes,
      reasonCode: failed ? 'writer_failure' : undefined,
    });
  }
}

function writerTraceMetadata(value: unknown): WriterTraceMetadata {
  const envelope = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const payload = envelope.payload && typeof envelope.payload === 'object'
    ? envelope.payload as Record<string, unknown>
    : {};
  const event = typeof envelope.event === 'string' ? envelope.event : '';
  return {
    identifiers: {
      ...(typeof payload.sessionPath === 'string' ? { session: payload.sessionPath } : {}),
      ...(typeof payload.requestId === 'string' ? { request: payload.requestId } : typeof envelope.id === 'string' ? { request: envelope.id } : {}),
      ...(typeof payload.turnId === 'string' ? { turn: payload.turnId } : {}),
      ...(typeof payload.attemptId === 'string' ? { attempt: payload.attemptId } : {}),
      ...(typeof payload.messageId === 'string' ? { message: payload.messageId } : {}),
      ...(typeof payload.toolCallId === 'string' ? { tool: payload.toolCallId } : {}),
    },
    eventKind: event === 'live.semantic' ? writerSemanticEventKind(payload.kind) : writerEventKind(event),
    eventSeq: typeof payload.seq === 'number' && Number.isSafeInteger(payload.seq) && payload.seq >= 0
      ? payload.seq
      : undefined,
  };
}

function writerSemanticEventKind(kind: unknown): WriterTraceMetadata['eventKind'] {
  if (kind === 'turn.text') return 'text';
  if (kind === 'turn.reasoning') return 'reasoning';
  if (kind === 'turn.toolDraft') return 'tool_draft';
  if (kind === 'tool.started') return 'tool_start';
  if (kind === 'tool.progress') return 'tool_progress';
  if (kind === 'tool.terminal') return 'tool_terminal';
  if (kind === 'turn.started') return 'turn_start';
  if (kind === 'turn.terminal') return 'turn_terminal';
  return 'control';
}

function writerEventKind(event: string): WriterTraceMetadata['eventKind'] {
  if (event === 'message.delta') return 'text';
  if (event === 'message.thinking') return 'reasoning';
  if (event === 'message.toolCallDelta') return 'tool_draft';
  if (event === 'tool.started') return 'tool_start';
  if (event === 'tool.progress') return 'tool_progress';
  if (event === 'tool.finished') return 'tool_terminal';
  if (event === 'message.started') return 'turn_start';
  if (event === 'message.finished' || event === 'message.aborted') return 'turn_terminal';
  if (event.includes('checkpoint')) return 'checkpoint';
  return 'control';
}

function isResponseEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as { id?: unknown; ok?: unknown; event?: unknown };
  return typeof envelope.id === 'string'
    && typeof envelope.ok === 'boolean'
    && envelope.event === undefined;
}

function toolKey(value: unknown, expectedEvent: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const envelope = value as { event?: unknown; payload?: unknown };
  if (envelope.event !== expectedEvent || !envelope.payload || typeof envelope.payload !== 'object') return undefined;
  const payload = envelope.payload as { sessionPath?: unknown; toolCallId?: unknown };
  return typeof payload.sessionPath === 'string' && typeof payload.toolCallId === 'string'
    ? `${payload.sessionPath}\u0000${payload.toolCallId}`
    : undefined;
}

function semanticToolKey(value: unknown, expectedKind: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const envelope = value as { event?: unknown; payload?: unknown };
  if (envelope.event !== 'live.semantic' || !envelope.payload || typeof envelope.payload !== 'object') return undefined;
  const payload = envelope.payload as { kind?: unknown; sessionPath?: unknown; turnId?: unknown; attemptId?: unknown; executionId?: unknown };
  return payload.kind === expectedKind
    && typeof payload.sessionPath === 'string'
    && typeof payload.turnId === 'string'
    && typeof payload.attemptId === 'string'
    && typeof payload.executionId === 'string'
      ? `${payload.sessionPath}\u0000${payload.turnId}\u0000${payload.attemptId}\u0000${payload.executionId}`
      : undefined;
}

function semanticProgressMetadata(value: unknown): SemanticProgressMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const envelope = value as Record<string, unknown>;
  if (envelope.event !== 'live.semantic' || !envelope.payload || typeof envelope.payload !== 'object') return undefined;
  const payload = envelope.payload as Record<string, unknown>;
  if (payload.kind !== 'tool.progress'
    || typeof payload.sessionPath !== 'string'
    || typeof payload.turnId !== 'string'
    || typeof payload.attemptId !== 'string'
    || typeof payload.executionId !== 'string'
    || !Number.isSafeInteger(payload.baseSeq)
    || !Number.isSafeInteger(payload.seq)
    || !Number.isSafeInteger(payload.baseProgressRevision)
    || !Number.isSafeInteger(payload.progressRevision)
    || !payload.update || typeof payload.update !== 'object') return undefined;
  const update = payload.update as SemanticProgressMetadata['update'];
  if ((update.kind !== 'snapshot' && update.kind !== 'patch')
    || (update.kind === 'patch' && !Array.isArray(update.operations))
    || (update.kind === 'snapshot' && update.operations !== undefined && !Array.isArray(update.operations))) return undefined;
  return {
    key: `${payload.sessionPath}\u0000${payload.turnId}\u0000${payload.attemptId}\u0000${payload.executionId}`,
    baseSeq: payload.baseSeq as number,
    seq: payload.seq as number,
    baseProgressRevision: payload.baseProgressRevision as number,
    progressRevision: payload.progressRevision as number,
    envelope,
    payload,
    update,
  };
}

function combineSemanticProgress(
  previous: SemanticProgressMetadata,
  next: SemanticProgressMetadata,
): SemanticProgressMetadata {
  let update: SemanticProgressMetadata['update'];
  if (next.update.kind === 'snapshot') {
    update = next.update;
  } else if (previous.update.kind === 'snapshot') {
    update = {
      kind: 'snapshot',
      preview: previous.update.preview,
      operations: compactJsonPatchOperations([
        ...(previous.update.operations ?? []),
        ...next.update.operations,
      ]),
    };
  } else {
    update = {
      kind: 'patch',
      operations: compactJsonPatchOperations([
        ...previous.update.operations,
        ...next.update.operations,
      ]),
    };
  }
  const payload: Record<string, unknown> = {
    ...next.payload,
    baseSeq: previous.baseSeq,
    baseProgressRevision: previous.baseProgressRevision,
    update,
  };
  const envelope = { ...next.envelope, payload };
  return {
    ...next,
    baseSeq: previous.baseSeq,
    baseProgressRevision: previous.baseProgressRevision,
    envelope,
    payload,
    update,
  };
}

function isSequencedSemanticEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as { event?: unknown; payload?: unknown };
  if (envelope.event !== 'live.semantic' || !envelope.payload || typeof envelope.payload !== 'object') return false;
  return Number.isSafeInteger((envelope.payload as { seq?: unknown }).seq);
}

function progressKey(value: unknown): string | undefined {
  return semanticToolKey(value, 'tool.progress') ?? toolKey(value, 'tool.progress');
}

function terminalToolKey(value: unknown): string | undefined {
  return semanticToolKey(value, 'tool.terminal') ?? toolKey(value, 'tool.finished');
}

const stdoutWriter = new OrderedJsonlWriter(process.stdout);

export function writeStdout(value: EventEnvelope | ResponseEnvelope): void {
  stdoutWriter.write(value);
}

export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * A typed backend error carrying a stable `code` (uppercase SNAKE_CASE) so the
 * client can distinguish failure modes (invalid-params, streaming-busy,
 * model-unavailable, ...) instead of them all collapsing to `BACKEND_ERROR`.
 * Handlers that still throw plain `Error` keep working — `extractRequestError`
 * falls back to `BACKEND_ERROR` for them (backward-compatible).
 */
export class BackendError extends Error {
  readonly code: string;
  readonly data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export function extractRequestError(error: unknown): ErrorPayload & { data?: unknown } {
  if (error instanceof SessionSnapshotTooLargeError) {
    return { code: error.code, message: error.message, data: error.data };
  }
  if (error instanceof BackendError) {
    const payload: ErrorPayload & { data?: unknown } = { code: error.code, message: error.message };
    if (error.data !== undefined) payload.data = error.data;
    return payload;
  }
  if (error instanceof Error) return { code: 'BACKEND_ERROR', message: error.message };
  return { code: 'BACKEND_ERROR', message: String(error) };
}

export function responseOk(id: string, result?: unknown): ResponseEnvelope {
  return { id, ok: true, result };
}

export function responseError(id: string, code: string, message: string, data?: unknown): ResponseEnvelope {
  return { id, ok: false, error: { code, message, data } };
}
