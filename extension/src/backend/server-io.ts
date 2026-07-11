import type { Writable } from 'node:stream';
import { JSONL_MAX_LINE_BYTES, serializeJsonLine } from '../shared/jsonl';
import type { ErrorPayload, EventEnvelope, ResponseEnvelope } from '../shared/protocol';

interface QueuedLine {
  line: string;
  bytes: number;
  progressKey?: string;
}

export interface OrderedJsonlWriterOptions {
  /** Application-owned bytes waiting behind the active stream write. */
  maxQueuedBytes?: number;
  /** Production treats critical overflow/write failure as fatal. */
  onFatal?: (error: Error) => void;
}

/** Serializes writes while bounding application-owned backlog. Queued progress
 * for the same session/tool is stale by definition and is coalesced;
 * responses and terminal events are never dropped. */
export class OrderedJsonlWriter {
  private readonly queue: QueuedLine[] = [];
  private readonly maxQueuedBytes: number;
  private readonly onFatal: (error: Error) => void;
  private queuedBytes = 0;
  private writing = false;
  private failed = false;
  private readonly terminalToolKeys = new Set<string>();

  constructor(private readonly stream: Writable, options: OrderedJsonlWriterOptions = {}) {
    this.maxQueuedBytes = options.maxQueuedBytes ?? 2 * JSONL_MAX_LINE_BYTES;
    this.onFatal = options.onFatal ?? ((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      process.nextTick(() => process.exit(1));
    });
  }

  write(value: unknown): void {
    if (this.failed) throw new Error('JSONL writer is unavailable after a fatal error.');
    const line = serializeJsonLine(value);
    const entry: QueuedLine = {
      line,
      bytes: Buffer.byteLength(line),
      progressKey: progressKey(value),
    };
    if (entry.bytes > JSONL_MAX_LINE_BYTES) {
      if (entry.progressKey) return;
      this.fail(`Fatal JSONL stdout record overflow (${entry.bytes} > ${JSONL_MAX_LINE_BYTES} bytes).`);
    }

    const terminalKey = terminalToolKey(value);
    if (entry.progressKey && this.terminalToolKeys.has(entry.progressKey)) return;

    if (this.writing && entry.progressKey) {
      const staleIndex = this.queue.findIndex((queued) => queued.progressKey === entry.progressKey);
      if (staleIndex >= 0) {
        const stale = this.queue[staleIndex]!;
        const replacementBytes = this.queuedBytes - stale.bytes + entry.bytes;
        if (replacementBytes > this.maxQueuedBytes) return;
        // Replace at the original position: moving fresh progress to the tail
        // could place it after a terminal/response event already queued.
        this.queue[staleIndex] = entry;
        this.queuedBytes = replacementBytes;
        return;
      }
    }

    if (this.writing && this.queuedBytes + entry.bytes > this.maxQueuedBytes) {
      if (entry.progressKey) return;
      this.fail(
        `Fatal JSONL stdout queue overflow (${this.queuedBytes + entry.bytes} > ${this.maxQueuedBytes} bytes).`,
      );
    }

    if (terminalKey) this.terminalToolKeys.add(terminalKey);
    this.queue.push(entry);
    this.queuedBytes += entry.bytes;
    this.pump();
  }

  private fail(message: string): never {
    const error = new Error(message);
    this.failed = true;
    this.onFatal(error);
    throw error;
  }

  private pump(): void {
    if (this.writing || this.failed) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.queuedBytes -= entry.bytes;
    this.writing = true;
    this.stream.write(entry.line, (error?: Error | null) => {
      this.writing = false;
      if (error) {
        this.failed = true;
        this.onFatal(new Error(`Fatal JSONL stdout write failure: ${error.message}`));
        return;
      }
      this.pump();
    });
  }
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

function progressKey(value: unknown): string | undefined {
  return toolKey(value, 'tool.progress');
}

function terminalToolKey(value: unknown): string | undefined {
  return toolKey(value, 'tool.finished');
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
