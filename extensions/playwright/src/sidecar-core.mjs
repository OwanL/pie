const MAX_JSONL_BYTES = 1024 * 1024;

export class SidecarJsonlDecoder {
  constructor() { this.buffer = Buffer.alloc(0); this.discardingOversizedRecord = false; this.errors = []; }
  takeErrors() { const errors = this.errors; this.errors = []; return errors; }
  push(chunk) {
    let incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.discardingOversizedRecord) {
      const newline = incoming.indexOf(0x0a);
      if (newline < 0) return [];
      this.discardingOversizedRecord = false;
      incoming = incoming.subarray(newline + 1);
    }
    this.buffer = Buffer.concat([this.buffer, incoming]);
    const lines = [];
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > MAX_JSONL_BYTES) {
          this.buffer = Buffer.alloc(0);
          this.discardingOversizedRecord = true;
          this.errors.push(coded('OVERSIZED_JSONL', `JSONL record exceeds ${MAX_JSONL_BYTES} bytes.`));
        }
        return lines;
      }
      if (newline > MAX_JSONL_BYTES) {
        this.buffer = this.buffer.subarray(newline + 1);
        this.errors.push(coded('OVERSIZED_JSONL', `JSONL record exceeds ${MAX_JSONL_BYTES} bytes.`));
        continue;
      }
      const raw = this.buffer.subarray(0, newline).toString('utf8').trim(); this.buffer = this.buffer.subarray(newline + 1);
      if (!raw) continue;
      try { lines.push(JSON.parse(raw)); }
      catch { this.errors.push(coded('MALFORMED_JSONL', 'Malformed JSONL request.')); }
    }
  }
}
function coded(code, message, retryable = false) { const error = new Error(message); error.code = code; error.retryable = retryable; return error; }
export function encodeSidecarRecord(record) {
  const raw = JSON.stringify(record); if (Buffer.byteLength(raw) > MAX_JSONL_BYTES) throw coded('OVERSIZED_RESPONSE', 'Sidecar response exceeds 1 MiB.'); return `${raw}\n`;
}

export class SidecarCore {
  constructor(backend, writeRecord) { this.backend = backend; this.writeRecord = writeRecord; this.active = new Map(); this.seen = new Set(); this.queue = Promise.resolve(); this.shuttingDown = false; }
  write(record) {
    try { this.writeRecord(record); }
    catch (error) { this.writeRecord({ v: 1, kind: 'response', id: record.id ?? 'protocol', ok: false, error: { code: error.code ?? 'SIDECAR_PROTOCOL_ERROR', message: error.message } }); }
  }
  protocolError(error) { this.write({ v: 1, kind: 'protocol_error', error: { code: error.code ?? 'MALFORMED_JSONL', message: error.message } }); }
  accept(record) {
    if (!record || typeof record !== 'object' || record.v !== 1 || typeof record.kind !== 'string') { this.protocolError(coded('MALFORMED_REQUEST', 'Request record must have v:1 and a kind.')); return; }
    if (record.kind === 'cancel') {
      if (typeof record.id !== 'string') { this.protocolError(coded('MALFORMED_CANCEL', 'Cancel requires a request id.')); return; }
      const controller = this.active.get(record.id);
      if (!controller) { this.write({ v: 1, kind: 'response', id: record.id, ok: false, error: { code: 'STALE_REQUEST', message: `No active request ${record.id} to cancel.` } }); return; }
      controller.abort(); return;
    }
    if (record.kind === 'shutdown') { void this.shutdown(); return; }
    if (record.kind !== 'request' || typeof record.id !== 'string' || !record.id || typeof record.method !== 'string' || !record.params || typeof record.params !== 'object') {
      this.protocolError(coded('MALFORMED_REQUEST', 'Request requires id, method, and object params.')); return;
    }
    if (this.seen.has(record.id) || this.active.has(record.id)) { this.write({ v: 1, kind: 'response', id: record.id, ok: false, error: { code: 'DUPLICATE_REQUEST', message: `Duplicate request id ${record.id}.` } }); return; }
    this.seen.add(record.id); if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value);
    const controller = new AbortController(); this.active.set(record.id, controller);
    const run = async () => {
      try {
        if (this.shuttingDown) throw coded('RUNTIME_REOPEN_REQUIRED', 'Sidecar is shutting down.');
        if (controller.signal.aborted) throw coded('CANCELLED', 'Playwright request was cancelled.');
        const result = await this.backend.handle(record.method, record.params, controller.signal);
        const aborted = controller.signal.aborted;
        this.write({ v: 1, kind: 'response', id: record.id, ok: !aborted, ...(aborted
          ? { error: { code: 'CANCELLED', message: 'Playwright request was cancelled.' } }
          : { result }) });
      } catch (error) {
        const aborted = controller.signal.aborted;
        this.write({ v: 1, kind: 'response', id: record.id, ok: false, error: {
          code: aborted ? 'CANCELLED' : (error.code ?? 'REQUEST_FAILED'),
          message: aborted ? 'Playwright request was cancelled.' : (error.message ?? String(error)),
          retryable: aborted ? false : error.retryable === true,
        } });
      } finally { this.active.delete(record.id); }
    };
    if (record.method === 'ping') void run();
    else this.queue = this.queue.then(run, run);
  }
  async shutdown() {
    if (this.shuttingDown) return; this.shuttingDown = true;
    for (const controller of this.active.values()) controller.abort();
    await this.queue.catch(() => {}); await this.backend.shutdown();
  }
}
