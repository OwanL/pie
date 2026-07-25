import { StringDecoder } from 'node:string_decoder';
import { MAX_JSONL_BYTES } from './types.js';

export class JsonlProtocolError extends Error {
  constructor(readonly code: 'MALFORMED_JSONL' | 'OVERSIZED_JSONL', message: string) { super(message); }
}

export class JsonlDecoder {
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  push(chunk: Buffer | string): unknown[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const records: unknown[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) {
        if (Buffer.byteLength(this.buffer) > MAX_JSONL_BYTES) throw new JsonlProtocolError('OVERSIZED_JSONL', `JSONL record exceeds ${MAX_JSONL_BYTES} bytes.`);
        return records;
      }
      const line = this.buffer.slice(0, newline).trim();
      if (Buffer.byteLength(line) > MAX_JSONL_BYTES) throw new JsonlProtocolError('OVERSIZED_JSONL', `JSONL record exceeds ${MAX_JSONL_BYTES} bytes.`);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try { records.push(JSON.parse(line)); }
      catch { throw new JsonlProtocolError('MALFORMED_JSONL', 'Malformed JSONL received from computer sidecar.'); }
    }
  }
}

export function encodeJsonl(record: unknown): string {
  const line = JSON.stringify(record);
  if (Buffer.byteLength(line) > MAX_JSONL_BYTES) throw new JsonlProtocolError('OVERSIZED_JSONL', `JSONL record exceeds ${MAX_JSONL_BYTES} bytes.`);
  return `${line}\n`;
}
