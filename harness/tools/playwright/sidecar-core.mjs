const MAX_JSONL_BYTES = 1024 * 1024;
const TASKKILL_SUCCESS = /^SUCCESS: The process with PID (\d+)(?: \(child process of PID \d+\))? has been terminated\.$/i;
const TASKKILL_ERROR_HEADER = /^ERROR: The process with PID \d+(?: \(child process of PID \d+\))? could not be terminated\.$/i;
const TASKKILL_NO_INSTANCE = /^ERROR: The process with PID (\d+)(?: \(child process of PID \d+\))? could not be terminated\. Reason: There is no running instance of the task\.$/i;
const TASKKILL_REASON = /^Reason:.+$/i;

function inspectProcess(pid) {
  try {
    process.kill(pid, 0);
    return { status: 'live' };
  } catch (error) {
    if (error?.code === 'ESRCH') return { status: 'absent' };
    return { status: 'unknown', reason: error?.code ?? error?.message ?? String(error) };
  }
}

/**
 * Preserves taskkill's exit-0 success contract across Windows locales. For
 * nonzero exits, confirm only fully recognized output and independently verify
 * that every reported target PID is gone.
 */
export function confirmTaskkillTree({ rootPid, exitCode, signal = null, stdout = '', stderr = '', truncated = false, probePid = inspectProcess }) {
  const reject = (reason) => ({ confirmed: false, reason });
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return reject('the requested root PID is invalid');
  if (signal) return reject(`taskkill was terminated by signal ${signal}`);
  if (exitCode === 0) return { confirmed: true };
  if (truncated) return reject('taskkill output was truncated');
  if (![128, 255].includes(exitCode)) return reject(`taskkill exited with unrecognized code ${String(exitCode)}`);

  const streams = [stdout, stderr].map((text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const pids = new Set();
  if (streams.every((lines) => lines.length === 0)) return reject('taskkill produced no process report');
  for (const lines of streams) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      let match = TASKKILL_SUCCESS.exec(line);
      if (!match && TASKKILL_ERROR_HEADER.test(line)) {
        const reason = lines[index + 1];
        if (!TASKKILL_REASON.test(reason ?? '')) return reject(`taskkill output contains an unrecognized diagnostic: ${line}`);
        match = TASKKILL_NO_INSTANCE.exec(`${line} ${reason}`);
        if (!match) return reject(`taskkill output contains an unrecognized diagnostic: ${line} ${reason}`);
        index += 1;
      }
      if (!match) return reject(`taskkill output contains an unrecognized diagnostic: ${line}`);
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) return reject('taskkill reported an invalid PID');
      pids.add(pid);
    }
  }
  if (!pids.has(rootPid)) return reject(`taskkill output did not report requested root PID ${rootPid}`);

  for (const pid of pids) {
    let status;
    try { status = probePid(pid); }
    catch (error) { return reject(`could not verify reported PID ${pid} is absent (${error?.code ?? error?.message ?? String(error)})`); }
    if (status?.status === 'live') return reject(`reported PID ${pid} is still live`);
    if (status?.status !== 'absent') return reject(`could not verify reported PID ${pid} is absent (${status?.reason ?? 'unknown process state'})`);
  }
  return { confirmed: true, pids: [...pids] };
}

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
