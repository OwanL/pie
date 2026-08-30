import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  appendPieLog,
  appendPieError,
  auditLog,
  bootLog,
  bootTraceSync,
  assertInvariant,
  initPieLogger,
  setBootTraceEnabled,
  setRuntimeAuditLogEnabled,
  setPieLogChannelsForTesting,
  setLogLevel,
  getLogLevel,
  flushPieLogger,
  getPieLogPath,
  showPieLogs,
  redactSensitive,
} from '../../../src/host/util/pie-logger';

const LIVE_PIE_LOG_PATH = path.join(os.tmpdir(), 'pie-logs', 'pie.log');
const PIE_LOG_PATH = getPieLogPath();
const BOOT_TRACE_PATH = path.join(os.tmpdir(), 'pie-boot-trace.jsonl');

interface FakeLogChannel {
  logLevel: number;
  calls: Array<{ level: string; line: string }>;
}

function fakeLogChannel(logLevel = 3): FakeLogChannel & Record<string, unknown> {
  const calls: FakeLogChannel['calls'] = [];
  return {
    name: 'test',
    logLevel,
    calls,
    trace: (line: string) => calls.push({ level: 'trace', line }),
    debug: (line: string) => calls.push({ level: 'debug', line }),
    info: (line: string) => calls.push({ level: 'info', line }),
    warn: (line: string) => calls.push({ level: 'warn', line }),
    error: (line: string) => calls.push({ level: 'error', line }),
  };
}

function resetState(): void {
  initPieLogger({ devMode: false });
  setLogLevel('info');
  setRuntimeAuditLogEnabled(false);
  setBootTraceEnabled(false);
}

async function clearLogFiles(): Promise<void> {
  await flushPieLogger();
  try {
    fs.rmSync(PIE_LOG_PATH, { force: true });
    fs.rmSync(`${PIE_LOG_PATH}.1`, { force: true });
  } catch {
    // ignore
  }
}

test('node:test logger output is isolated from the live Pie runtime log', () => {
  assert.notEqual(PIE_LOG_PATH, LIVE_PIE_LOG_PATH);
  assert.match(PIE_LOG_PATH, /pie-test-logs[\\/]process-\d+[\\/]pie\.log$/u);
});

test('appendPieLog writes to console and persistent log', async () => {
  resetState();
  await clearLogFiles();

  const originalInfo = console.info;
  const captured: unknown[][] = [];
  console.info = (...args: unknown[]) => captured.push(args);
  try {
    appendPieLog('info', 'test-scope', 'hello world', { key: 'value' });
  } finally {
    console.info = originalInfo;
  }

  assert.equal(captured.length, 1, 'console.info should fire once');
  assert.ok(
    typeof captured[0][0] === 'string' && (captured[0][0] as string).includes('[pie:test-scope] hello world'),
    'console prefix should be [pie:scope]',
  );

  await flushPieLogger();
  const logContent = fs.readFileSync(PIE_LOG_PATH, 'utf8');
  assert.ok(logContent.includes('[info] [test-scope] hello world'), 'log file should contain the message');
  assert.ok(logContent.includes('"key":"value"'), 'log file should contain the data payload');
});

test('appendPieError includes error detail', async () => {
  resetState();
  await clearLogFiles();

  const originalError = console.error;
  const captured: unknown[][] = [];
  console.error = (...args: unknown[]) => captured.push(args);
  try {
    const error = new Error('disk full');
    error.stack = 'Error: disk full\n    at save (https://example.test/run?api_key=super-secret)';
    appendPieError('test-scope', 'persist failed', error, { at: 'save' });
  } finally {
    console.error = originalError;
  }

  assert.equal(captured.length, 1);
  assert.ok(
    typeof captured[0][0] === 'string' && (captured[0][0] as string).includes('[pie:test-scope] persist failed'),
    'error message should be prefixed',
  );
  assert.ok(
    captured[0][1] && typeof captured[0][1] === 'object' && (captured[0][1] as Record<string, unknown>).error === 'disk full',
    'error detail should be captured',
  );
  const detail = captured[0][1] as Record<string, unknown>;
  assert.equal(detail.errorName, 'Error');
  assert.match(String(detail.stack), /disk full/);
  await flushPieLogger();
  const logContent = fs.readFileSync(PIE_LOG_PATH, 'utf8');
  assert.match(logContent, /"stack":"Error: disk full/);
  assert.doesNotMatch(logContent, /super-secret/);
  assert.match(logContent, /api_key=\[redacted\]/);
});

test('log level filtering blocks low-priority messages before inspecting payloads', async () => {
  resetState();
  await clearLogFiles();
  setLogLevel('warn');
  const filteredMarker = 'filtered-info-message-should-not-appear';

  const originalInfo = console.info;
  console.info = () => { /* swallow */ };
  try {
    appendPieLog('info', 'filtered-scope', filteredMarker);
    const expensivePayload = Object.defineProperty({}, 'value', {
      enumerable: true,
      get(): never { throw new Error('filtered payload was inspected'); },
    });
    assert.doesNotThrow(() => appendPieLog('debug', 'filtered-scope', 'filtered-payload', expensivePayload));
  } finally {
    console.info = originalInfo;
  }

  // Other extension test files share the process-wide log destination and run
  // concurrently, so the file itself may legitimately exist. Assert the
  // filtered record is absent instead of claiming exclusive ownership of it.
  let logContent = '';
  try {
    logContent = fs.readFileSync(PIE_LOG_PATH, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  assert.doesNotMatch(
    logContent,
    new RegExp(filteredMarker),
    'info message should not be written when minLevel is warn',
  );
});

test('Output channels filter before serialization, bound bursts, and isolate backend logs', () => {
  resetState();
  setLogLevel('error');
  const main = fakeLogChannel();
  const backend = fakeLogChannel(2);
  setPieLogChannelsForTesting(
    main as unknown as import('vscode').LogOutputChannel,
    backend as unknown as import('vscode').LogOutputChannel,
  );

  try {
    let payloadReads = 0;
    const payload = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() { payloadReads += 1; return 'diagnostic'; },
    });
    assert.doesNotThrow(() => appendPieLog('debug', 'channel-test', 'filtered', payload));
    assert.equal(payloadReads, 0, 'native Info should filter Debug before serialization');

    main.logLevel = 2;
    for (let index = 0; index < 100; index += 1) {
      appendPieLog('debug', 'channel-test', `entry-${index}`, payload);
    }
    assert.equal(main.calls.filter((call) => call.level === 'debug').length, 40);
    assert.equal(payloadReads, 40, 'rate-limited channel-only entries must not be serialized');

    appendPieLog('debug', 'backend-stderr', 'backend diagnostic');
    assert.equal(backend.calls.filter((call) => call.level === 'debug').length, 1);
    assert.equal(main.calls.some((call) => call.line.includes('backend diagnostic')), false);

    for (let index = 0; index < 3; index += 1) {
      appendPieLog('warn', 'channel-test', `warning-${index}`);
    }
    assert.equal(main.calls.filter((call) => call.level === 'warn').length, 3, 'warnings must bypass burst protection');
  } finally {
    setPieLogChannelsForTesting();
  }
});

test('persistent logging bounds a stalled burst and retains its newest diagnostic tail', async () => {
  resetState();
  await clearLogFiles();

  const originalInfo = console.info;
  console.info = () => { /* swallow the synthetic burst */ };
  try {
    const payload = 'x'.repeat(1_024);
    for (let index = 0; index < 700; index += 1) {
      appendPieLog('info', 'burst-test', `entry-${index}`, { payload });
    }
  } finally {
    console.info = originalInfo;
  }

  await flushPieLogger();
  const written = fs.readFileSync(PIE_LOG_PATH, 'utf8');
  assert.match(written, /\[pie-logger\] dropped \d+ queued log line/);
  assert.doesNotMatch(written, /\[burst-test\] entry-0\b/);
  assert.match(written, /\[burst-test\] entry-699\b/);
  assert.ok(Buffer.byteLength(written, 'utf8') < 600 * 1_024, 'bounded batch should stay close to its 512 KiB budget');
});

test('auditLog is gated by devMode and runtimeAuditLogEnabled', async () => {
  resetState();
  await clearLogFiles();

  const originalInfo = console.info;
  const captured: unknown[][] = [];
  console.info = (...args: unknown[]) => captured.push(args);
  try {
    auditLog('audit-scope', 'event.off', { x: 1 });
    setRuntimeAuditLogEnabled(true);
    auditLog('audit-scope', 'event.on', { x: 2 });
  } finally {
    console.info = originalInfo;
  }

  assert.equal(captured.length, 1, 'only the enabled audit should emit');
  assert.ok(
    typeof captured[0][0] === 'string' && (captured[0][0] as string).includes('event.on'),
    'the enabled audit event should be logged',
  );
});

test('bootLog writes to boot-trace jsonl and main log when enabled', async () => {
  resetState();
  await clearLogFiles();
  try {
    fs.rmSync(BOOT_TRACE_PATH, { force: true });
  } catch {
    // ignore
  }
  setBootTraceEnabled(true);

  const originalInfo = console.info;
  const captured: unknown[] = [];
  console.info = (...args: unknown[]) => captured.push(args);
  try {
    bootLog('boot-scope', 'boot.event', { started: true });
  } finally {
    console.info = originalInfo;
  }

  assert.equal(captured.length, 1, 'bootLog should emit to console when enabled');
  assert.ok(fs.existsSync(BOOT_TRACE_PATH), 'boot-trace jsonl should exist');
  const bootLines = fs.readFileSync(BOOT_TRACE_PATH, 'utf8').trim().split('\n');
  const last = JSON.parse(bootLines[bootLines.length - 1]);
  assert.equal(last.event, 'boot.event');
  assert.equal(last.started, true);
});

test('bootTraceSync writes only to boot-trace jsonl', async () => {
  resetState();
  await clearLogFiles();
  try {
    fs.rmSync(BOOT_TRACE_PATH, { force: true });
  } catch {
    // ignore
  }
  setBootTraceEnabled(true);

  const originalWarn = console.warn;
  const captured: unknown[] = [];
  console.warn = (...args: unknown[]) => captured.push(args);
  try {
    bootTraceSync('boot-scope', 'sync.event', { only: 'file' });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(captured.length, 0, 'bootTraceSync should not write to console');
  const bootLines = fs.readFileSync(BOOT_TRACE_PATH, 'utf8').trim().split('\n');
  const last = JSON.parse(bootLines[bootLines.length - 1]);
  assert.equal(last.event, 'sync.event');
});

test('assertInvariant throws in dev mode and logs in production', () => {
  resetState();
  initPieLogger({ devMode: false });

  const originalError = console.error;
  const captured: unknown[] = [];
  console.error = (...args: unknown[]) => captured.push(args);
  try {
    assertInvariant('inv-scope', false, 'boom', { detail: 1 });
  } finally {
    console.error = originalError;
  }
  assert.equal(captured.length, 1, 'production invariant should log an error');

  initPieLogger({ devMode: true });
  assert.throws(
    () => assertInvariant('inv-scope', false, 'boom', { detail: 1 }),
    /boom/,
    'dev mode invariant should throw',
  );
});

test('assertInvariant does not throw in production even with runtime audit logging on', () => {
  resetState();
  initPieLogger({ devMode: false });
  setRuntimeAuditLogEnabled(true);

  const originalError = console.error;
  const captured: unknown[] = [];
  console.error = (...args: unknown[]) => captured.push(args);
  try {
    assert.doesNotThrow(
      () => assertInvariant('inv-scope', false, 'boom', { detail: 1 }),
      'production invariant must not throw even when runtime audit logging is enabled',
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(captured.length, 1, 'production invariant should still log the error');
});

test('showPieLogs does not throw when vscode is unavailable', () => {
  resetState();
  // In a plain node test runner vscode is not present; this should be a no-op.
  assert.doesNotThrow(() => showPieLogs(true));
});

test('redactSensitive redacts known-sensitive keys (M2)', () => {
  const input = {
    apiKey: 'sk-secret',
    api_key: 'sk-secret2',
    authorization: 'Bearer abc',
    bearer: 'tok',
    access_token: 'tok2',
    refreshToken: 'r-tok',
    password: 'hunter2',
    secret: 's',
    credential: 'c',
    safe: 'kept',
    nested: { authToken: 'inner', ok: 1 },
    arr: [{ api_key: 'a' }, { ok: 2 }],
  };
  const out = redactSensitive(input) as Record<string, unknown>;
  assert.equal(out.apiKey, '[redacted]');
  assert.equal(out.api_key, '[redacted]');
  assert.equal(out.authorization, '[redacted]');
  assert.equal(out.bearer, '[redacted]');
  assert.equal(out.access_token, '[redacted]');
  assert.equal(out.refreshToken, '[redacted]');
  assert.equal(out.password, '[redacted]');
  assert.equal(out.secret, '[redacted]');
  assert.equal(out.credential, '[redacted]');
  assert.equal(out.safe, 'kept', 'non-sensitive fields are preserved');
  assert.equal((out.nested as Record<string, unknown>).authToken, '[redacted]', 'nested sensitive redacted');
  assert.equal((out.nested as Record<string, unknown>).ok, 1, 'nested safe preserved');
  assert.equal((out.arr as Record<string, unknown>[])[0]?.api_key, '[redacted]', 'array item redacted');
  assert.equal((out.arr as Record<string, unknown>[])[1]?.ok, 2, 'array safe preserved');
  // Original is not mutated.
  assert.equal(input.apiKey, 'sk-secret', 'input is not mutated');
});

test('redactSensitive does not over-redact incidental substrings (tokenCount stays)', () => {
  const out = redactSensitive({ tokenCount: 5, primaryKey: 'k', keyCount: 2 }) as Record<string, unknown>;
  assert.equal(out.tokenCount, 5, 'bare token substring is not redacted');
  assert.equal(out.primaryKey, 'k', 'bare key substring is not redacted');
  assert.equal(out.keyCount, 2);
});

test('redactSensitive prunes circular references', () => {
  const input: Record<string, unknown> = { safe: 1 };
  input.self = input;
  const out = redactSensitive(input) as Record<string, unknown>;
  assert.equal(out.safe, 1);
  assert.equal(out.self, '[circular]');
});

test('appendPieLog redacts sensitive keys, messages, and nested string values before writing', async () => {
  resetState();
  await clearLogFiles();
  initPieLogger({ devMode: false });
  setLogLevel('debug');
  appendPieLog('warn', 'test-redact', 'authorization=message-secret', {
    apiKey: 'key-secret',
    safe: 'Bearer nested-secret',
  });
  await flushPieLogger();
  const written = fs.readFileSync(PIE_LOG_PATH, 'utf8');
  assert.ok(!written.includes('message-secret'), 'message credentials must not reach the log file');
  assert.ok(!written.includes('key-secret'), 'sensitive keyed values must not reach the log file');
  assert.ok(!written.includes('nested-secret'), 'credentials inside safe string fields must be redacted');
  assert.ok(written.includes('[redacted]'), 'sensitive key is redacted');
});
