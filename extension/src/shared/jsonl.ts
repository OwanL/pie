import type { Readable } from 'node:stream';

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Shared JSONL record limit. This is a per-record transport safety bound, not
 * a session-size limit. Keep enough headroom for long-running session
 * snapshots and base64-encoded images while still bounding malformed peers. */
export const JSONL_MAX_LINE_BYTES = 128 * 1024 * 1024;
export const JSONL_OVERFLOW_PREVIEW_BYTES = 256;

export interface JsonlLineReaderOptions {
  /** Maximum UTF-8 bytes before LF. Defaults to JSONL_MAX_LINE_BYTES. */
  maxLineBytes?: number;
  /** Called once for each discarded overlong line. Preview is bounded. */
  onOverflow?: (diagnostic: { maxLineBytes: number; preview: string }) => void;
}

export function attachJsonlLineReader(
  stream: Readable,
  onLine: (line: string) => void,
  options: JsonlLineReaderOptions = {},
): () => void {
  const maxLineBytes = options.maxLineBytes ?? JSONL_MAX_LINE_BYTES;
  // A single geometrically-grown allocation bounds both retained bytes and
  // object overhead, even when a peer sends a line one byte per data event.
  let storage = Buffer.allocUnsafe(Math.min(maxLineBytes, 4096));
  let byteLength = 0;
  let discarding = false;

  const ensureCapacity = (required: number) => {
    if (required <= storage.length) return;
    const next = Buffer.allocUnsafe(Math.min(maxLineBytes, Math.max(required, storage.length * 2, 1)));
    storage.copy(next, 0, 0, byteLength);
    storage = next;
  };
  const reset = () => { byteLength = 0; };
  const emit = () => {
    const decoded = storage.toString('utf8', 0, byteLength);
    reset();
    onLine(decoded.endsWith('\r') ? decoded.slice(0, -1) : decoded);
  };
  const overflow = () => {
    const previewLength = Math.min(byteLength, JSONL_OVERFLOW_PREVIEW_BYTES);
    options.onOverflow?.({ maxLineBytes, preview: storage.toString('utf8', 0, previewLength) });
    reset();
    discarding = true;
  };
  const retain = (part: Buffer) => {
    if (part.length === 0) return;
    const remaining = maxLineBytes - byteLength;
    const retained = Math.min(part.length, remaining);
    if (retained > 0) {
      ensureCapacity(byteLength + retained);
      part.copy(storage, byteLength, 0, retained);
      byteLength += retained;
    }
    if (retained < part.length) overflow();
  };

  const onData = (chunk: string | Buffer) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    let start = 0;
    for (let i = 0; i < data.length; i += 1) {
      if (data[i] !== 0x0a) continue;
      if (!discarding) {
        retain(data.subarray(start, i));
        if (!discarding) emit();
      }
      discarding = false;
      start = i + 1;
    }
    if (!discarding && start < data.length) retain(data.subarray(start));
  };

  const onEnd = () => {
    if (!discarding && byteLength > 0) emit();
    reset();
  };

  stream.on('data', onData);
  stream.on('end', onEnd);
  return () => {
    stream.off('data', onData);
    stream.off('end', onEnd);
  };
}
