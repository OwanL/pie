import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';

import { redactSensitiveText } from '../../shared/sensitive-redaction';
import { toErrorMessage } from './error-message';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export type PieLogLevel = Extract<LogLevel, 'debug' | 'info' | 'warn' | 'error'>;

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const BOOT_TRACE_PATH = path.join(os.tmpdir(), 'pie-boot-trace.jsonl');
const PIE_LOG_DIR = path.join(os.tmpdir(), 'pie-logs');
const PIE_LOG_PATH = path.join(PIE_LOG_DIR, 'pie.log');
/** Simple 1-deep rotation: once the active log exceeds 5 MiB it is moved to
 *  `pie.log.1`. Keeping the limit small avoids unbounded growth in long-lived
 *  sessions. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Keep diagnostic writes bounded even if the filesystem stalls. The newest
 * entries are retained because they are normally the most useful during a
 * failure; the durable stream records how many older entries were dropped. */
const MAX_PENDING_LOG_BYTES = 512 * 1024;
const PERSISTENT_FLUSH_DELAY_MS = 100;
/** VS Code renders a selected OutputChannel on the shared workbench thread.
 * Bound low-severity bursts so verbose diagnostics cannot make the whole
 * workbench janky. Warnings and errors are never rate-limited. */
const CHANNEL_WINDOW_MS = 1_000;
const MAX_CHANNEL_LINES_PER_WINDOW = 40;

interface PendingLogLine {
  line: string;
  bytes: number;
}

interface ChannelRateState {
  windowStartedAt: number;
  emitted: number;
  suppressed: number;
  summaryTimer?: ReturnType<typeof setTimeout>;
}

let pieLogChannel: vscode.LogOutputChannel | undefined;
let pieBackendChannel: vscode.LogOutputChannel | undefined;
let logChannelsInitialized = false;
let minLevel: LogLevel = 'info';
let devMode = false;
/** User-facing log level options, ordered from most to least verbose. */
export const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'] as const;
let runtimeAuditLogEnabled = false;
let bootTraceEnabled = process.env.PI_BOOT_LOG === '1';
let pendingLogLines: PendingLogLine[] = [];
let pendingLogBytes = 0;
let droppedPendingLogLines = 0;
let persistentFlushTimer: ReturnType<typeof setTimeout> | undefined;
let persistentFlushPromise: Promise<void> | undefined;
let channelRateStates = new WeakMap<object, ChannelRateState>();

/** Initialise the logger once during extension activation. This captures the
 *  VS Code extension mode so dev-mode gating works without threading an
 *  `ExtensionContext` through every log call site. */
export function initPieLogger(options: { devMode: boolean }): void {
  devMode = options.devMode;
}

/** Override the minimum level written to the persistent file and extension-host
 * console. Output channels additionally use their native level dropdown. */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function getLogLevel(): LogLevel {
  return minLevel;
}

/** Parse a level name from configuration into a `LogLevel`, falling back to
 *  `fallback` when the value is missing or unrecognised. Keeps activation
 *  resilient to hand-edited settings without throwing. */
export function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  if (value && (LOG_LEVELS as readonly string[]).includes(value)) {
    return value as LogLevel;
  }
  return fallback;
}

/** Enable or disable boot tracing at runtime. */
export function setBootTraceEnabled(enabled: boolean): void {
  bootTraceEnabled = enabled;
}

/** Whether boot tracing is currently active. Callers can use this to avoid
 *  computing expensive log payloads (e.g. a full ViewState projection) when
 *  tracing is off — `bootLog` itself short-circuits, but only after the caller
 *  has already built the payload object. */
export function isBootLogEnabled(): boolean {
  return bootTraceEnabled;
}

/** Runtime audit logging — off by default. When true, audit events are emitted
 *  to the extension host console even in production/installed mode. Dev mode
 *  (`extensionMode === 1`) always emits regardless of this flag. */
export function setRuntimeAuditLogEnabled(enabled: boolean): void {
  runtimeAuditLogEnabled = enabled;
}

/** Whether runtime audit logging is currently active. */
export function isRuntimeAuditLogEnabled(): boolean {
  return runtimeAuditLogEnabled;
}

function isAuditEnabled(): boolean {
  return devMode || runtimeAuditLogEnabled;
}

/** Create both Output channels on first use. Both are backed by VS Code's
 *  {@link vscode.LogOutputChannel} (created via `{ log: true }`) so the native
 *  severity colors and per-channel level dropdown (Clear / Trace / Debug /
 *  Info / Warning / Error) work. The `pie (backend)` channel keeps the chatty
 *  backend stderr stream out of the main `pie` channel so the main log stays
 *  readable. */
function ensureLogChannels(): void {
  if (logChannelsInitialized) return;
  logChannelsInitialized = true;
  try {
    // `vscode` is only available inside the extension host. Import it lazily
    // so the logger module loads safely in tests and other non-VS Code runtimes.
    const vscodeMod = require('vscode') as typeof vscode;
    const createOutputChannel = vscodeMod.window?.createOutputChannel;
    if (!createOutputChannel) {
      return;
    }
    pieLogChannel = createOutputChannel('pie', { log: true });
    pieBackendChannel = createOutputChannel('pie (backend)', { log: true });
  } catch {
    // vscode not available; log output will fall back to console and file.
  }
}

function getPieLogChannel(): vscode.LogOutputChannel | undefined {
  ensureLogChannels();
  return pieLogChannel;
}

function getPieBackendChannel(): vscode.LogOutputChannel | undefined {
  ensureLogChannels();
  return pieBackendChannel;
}

/** @internal Test seam for deterministic OutputChannel behavior without the
 * VS Code runtime. Production initializes channels lazily via
 * `ensureLogChannels`. */
export function setPieLogChannelsForTesting(
  main?: vscode.LogOutputChannel,
  backend?: vscode.LogOutputChannel,
): void {
  pieLogChannel = main;
  pieBackendChannel = backend;
  logChannelsInitialized = true;
  channelRateStates = new WeakMap<object, ChannelRateState>();
}

/** Whether the channel's native level dropdown accepts this entry. Checking
 * before redaction/serialization avoids paying for diagnostics VS Code will
 * discard. VS Code LogLevel values are Off=0, Trace=1 … Error=5. */
function channelAccepts(channel: vscode.LogOutputChannel, level: LogLevel): boolean {
  const configured = Number(channel.logLevel);
  if (configured === 0) return false;
  if (configured === 1) return true;
  if (configured >= 2 && configured <= 5) {
    return LEVEL_RANK[level] >= configured * 10;
  }
  // Preserve output if a future VS Code version adds an unknown level.
  return true;
}

function channelForScope(scope: string): vscode.LogOutputChannel | undefined {
  return scope === 'backend-stderr' ? getPieBackendChannel() : getPieLogChannel();
}

function emitSuppressedChannelSummary(channel: vscode.LogOutputChannel, state: ChannelRateState): void {
  if (state.suppressed === 0) return;
  channel.warn(`[pie-logger] suppressed ${state.suppressed} low-severity Output entries to keep VS Code responsive`);
  state.suppressed = 0;
}

function scheduleChannelSummary(channel: vscode.LogOutputChannel, state: ChannelRateState): void {
  if (state.summaryTimer !== undefined) return;
  const remaining = Math.max(0, CHANNEL_WINDOW_MS - (Date.now() - state.windowStartedAt));
  state.summaryTimer = setTimeout(() => {
    state.summaryTimer = undefined;
    emitSuppressedChannelSummary(channel, state);
    state.windowStartedAt = Date.now();
    state.emitted = 0;
  }, remaining);
  state.summaryTimer.unref?.();
}

/** Protect the workbench renderer from low-severity bursts while keeping every
 * accepted entry eligible for the persistent diagnostic file. */
function channelRateLimitAllows(channel: vscode.LogOutputChannel, level: LogLevel): boolean {
  if (LEVEL_RANK[level] >= LEVEL_RANK.warn) return true;
  const now = Date.now();
  let state = channelRateStates.get(channel);
  if (!state) {
    state = { windowStartedAt: now, emitted: 0, suppressed: 0 };
    channelRateStates.set(channel, state);
  } else if (now - state.windowStartedAt >= CHANNEL_WINDOW_MS) {
    if (state.summaryTimer !== undefined) clearTimeout(state.summaryTimer);
    state.summaryTimer = undefined;
    emitSuppressedChannelSummary(channel, state);
    state.windowStartedAt = now;
    state.emitted = 0;
  }
  if (state.emitted >= MAX_CHANNEL_LINES_PER_WINDOW) {
    state.suppressed += 1;
    scheduleChannelSummary(channel, state);
    return false;
  }
  state.emitted += 1;
  return true;
}

/** Map a {@link LogLevel} to the corresponding `LogOutputChannel` severity
 * method and emit. The channel's own `logLevel` is intentionally independent
 * from `pie.logLevel`, while burst protection keeps a selected channel cheap. */
function emitToChannel(channel: vscode.LogOutputChannel, level: LogLevel, line: string): void {
  switch (level) {
    case 'trace': channel.trace(line); break;
    case 'debug': channel.debug(line); break;
    case 'info': channel.info(line); break;
    case 'warn': channel.warn(line); break;
    case 'error': channel.error(line); break;
  }
}

function stringifyLogData(data: unknown): string {
  if (data === undefined) {
    return '';
  }
  if (typeof data === 'string') {
    return redactSensitiveText(data);
  }
  if (data instanceof Error) {
    return redactSensitiveText(data.stack || data.message);
  }
  try {
    return JSON.stringify(redactSensitive(data));
  } catch {
    return String(data);
  }
}

// M2 redaction: known-sensitive keys are redacted before log data is serialized
// so credentials never reach the pie OutputChannel / pie.log. Only error-
// mapping.ts redacted before (req-NN). Conservative compound patterns avoid
// over-redacting incidental substrings (e.g. bare 'token' would catch 'tokenCount';
// 'access_token' / 'auth_token' / 'api_key' are precise enough).
const SENSITIVE_KEY_PATTERN = /(api[_-]?key|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|password|passwd|secret|credential)/i;

/** Deep-clone `data` with values of sensitive keys replaced by `'[redacted]'`.
 *  Non-mutating; circular references are pruned to `'[circular]'`. Exported so
 *  callers can opt into explicit redaction before passing data to `appendPieLog`
 *  (e.g. for pre-formatted payloads). Applied automatically in {@link stringifyLogData}. */
export function redactSensitive(data: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof data === 'string') return redactSensitiveText(data);
  if (data === null || typeof data !== 'object') return data;
  if (seen.has(data as object)) return '[circular]';
  seen.add(data as object);
  if (Array.isArray(data)) {
    return data.map((item) => redactSensitive(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : redactSensitive(value, seen);
  }
  return out;
}

async function rotateLogIfNeeded(): Promise<void> {
  try {
    const stat = await fsSync.promises.stat(PIE_LOG_PATH);
    if (stat.size <= MAX_LOG_BYTES) return;
    const backup = `${PIE_LOG_PATH}.1`;
    await fsSync.promises.rm(backup, { force: true });
    await fsSync.promises.rename(PIE_LOG_PATH, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Rotation failures are non-fatal; keep appending to the active file.
    }
  }
}

async function appendPersistentBatch(lines: string[], dropped: number): Promise<void> {
  try {
    await fsSync.promises.mkdir(PIE_LOG_DIR, { recursive: true });
    await rotateLogIfNeeded();
    const records = dropped > 0
      ? [`[${new Date().toISOString()}] [warn] [pie-logger] dropped ${dropped} queued log line(s) because persistent logging fell behind`, ...lines]
      : lines;
    if (records.length > 0) {
      await fsSync.promises.appendFile(PIE_LOG_PATH, `${records.join('\n')}\n`, 'utf8');
    }
  } catch {
    // Persistent logging must never affect extension behaviour.
  }
}

async function drainPersistentLogQueue(): Promise<void> {
  while (pendingLogLines.length > 0 || droppedPendingLogLines > 0) {
    const batch = pendingLogLines;
    const dropped = droppedPendingLogLines;
    pendingLogLines = [];
    pendingLogBytes = 0;
    droppedPendingLogLines = 0;
    await appendPersistentBatch(batch.map((entry) => entry.line), dropped);
  }
}

function startPersistentFlush(): Promise<void> {
  if (persistentFlushTimer !== undefined) {
    clearTimeout(persistentFlushTimer);
    persistentFlushTimer = undefined;
  }
  if (!persistentFlushPromise) {
    persistentFlushPromise = drainPersistentLogQueue().finally(() => {
      persistentFlushPromise = undefined;
      if (pendingLogLines.length > 0 || droppedPendingLogLines > 0) schedulePersistentFlush();
    });
  }
  return persistentFlushPromise;
}

function schedulePersistentFlush(): void {
  if (persistentFlushTimer !== undefined || persistentFlushPromise !== undefined) return;
  persistentFlushTimer = setTimeout(() => {
    persistentFlushTimer = undefined;
    void startPersistentFlush();
  }, PERSISTENT_FLUSH_DELAY_MS);
  persistentFlushTimer.unref?.();
}

function appendToPersistentLog(line: string): void {
  const bytes = Buffer.byteLength(line, 'utf8') + 1;
  if (bytes > MAX_PENDING_LOG_BYTES) {
    droppedPendingLogLines += 1;
    schedulePersistentFlush();
    return;
  }
  while (pendingLogLines.length > 0 && pendingLogBytes + bytes > MAX_PENDING_LOG_BYTES) {
    const dropped = pendingLogLines.shift()!;
    pendingLogBytes -= dropped.bytes;
    droppedPendingLogLines += 1;
  }
  pendingLogLines.push({ line, bytes });
  pendingLogBytes += bytes;
  schedulePersistentFlush();
}

/** Flush all persistent entries accepted before this call. Used during orderly
 * extension shutdown and by tests; normal logging remains fire-and-forget. */
export async function flushPieLogger(): Promise<void> {
  await startPersistentFlush();
}

function appendToConsole(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>): void {
  const formatted = `[pie:${scope}] ${message}`;
  const args = data === undefined ? [formatted] : [formatted, data];
  switch (level) {
    case 'error':
      console.error(...args);
      break;
    case 'warn':
      console.warn(...args);
      break;
    case 'info':
      console.info(...args);
      break;
    case 'debug':
    case 'trace':
      console.debug(...args);
      break;
  }
}

/** Core log entry point. Writes to the `pie` OutputChannel, a persistent log
 *  file, and the dev console (with appropriate gating). */
export function pieLog(
  level: LogLevel,
  scope: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  const persistentEligible = LEVEL_RANK[level] >= LEVEL_RANK[minLevel];
  const channel = channelForScope(scope);
  const channelConfigured = channel !== undefined && channelAccepts(channel, level);
  // Apply burst protection before redacting or serializing channel-only data.
  // Persistent-eligible entries still pay formatting cost because the durable
  // file deliberately retains the complete accepted stream.
  const channelEligible = channelConfigured && channelRateLimitAllows(channel, level);
  if (!persistentEligible && !channelEligible) return;

  const ts = new Date().toISOString();
  const safeMessage = redactSensitiveText(message);
  const suffix = stringifyLogData(data);
  const fullLine = suffix
    ? `[${ts}] [${level}] [${scope}] ${safeMessage} ${suffix}`
    : `[${ts}] [${level}] [${scope}] ${safeMessage}`;

  // The Output channel is a `LogOutputChannel` — it prepends its own
  // `[timestamp] [level]` prefix and colorizes by severity, so we hand it the
  // message WITHOUT our timestamp/level prefix. Emission is gated by the
  // channel's own logLevel (native dropdown), independent of `minLevel` —
  // see `emitToChannel`. Backend stderr lines are passed through raw.
  const channelLine = scope === 'backend-stderr'
    ? safeMessage
    : (suffix ? `[${scope}] ${safeMessage} ${suffix}` : `[${scope}] ${safeMessage}`);
  if (channelEligible) emitToChannel(channel, level, channelLine);

  // Persistent file + dev console are gated by the global `pie.logLevel`
  // setting (`minLevel`). The channel above may show more (when the user
  // widens its dropdown), but the durable record respects configured verbosity.
  if (!persistentEligible) return;

  appendToPersistentLog(fullLine);
  appendToConsole(level, scope, safeMessage, data === undefined ? undefined : (redactSensitive(data) as Record<string, unknown>));
}

export function pieDebug(scope: string, message: string, data?: Record<string, unknown>): void {
  pieLog('debug', scope, message, data);
}

export function pieWarn(scope: string, message: string, data?: Record<string, unknown>): void {
  pieLog('warn', scope, message, data);
}

function errorDiagnostic(error: unknown): Record<string, unknown> {
  const diagnostic: Record<string, unknown> = { error: redactSensitiveText(toErrorMessage(error)) };
  if (!(error instanceof Error)) return diagnostic;

  diagnostic.errorName = error.name;
  // The message alone is rarely enough for asynchronous failures such as
  // "Canceled" or "Channel has been closed". Preserve the originating stack
  // in the durable log while keeping the short `error` field for grouping.
  if (error.stack) diagnostic.stack = redactSensitiveText(error.stack).slice(0, 32 * 1024);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== undefined) diagnostic.cause = redactSensitiveText(toErrorMessage(cause));
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') diagnostic.errorCode = code;
  return diagnostic;
}

export function pieError(scope: string, message: string, error?: unknown, data?: Record<string, unknown>): void {
  const details = data && typeof data === 'object'
    ? { ...data, ...errorDiagnostic(error) }
    : { data, ...errorDiagnostic(error) };
  pieLog('error', scope, message, details);
}

/** Backward-compatible alias used by existing extension-host call sites. */
export function appendPieLog(level: PieLogLevel, scope: string, message: string, data?: unknown): void {
  pieLog(level, scope, message, data as Record<string, unknown> | undefined);
}

/** Backward-compatible alias for error logging with an exception object. */
export function appendPieError(scope: string, message: string, error: unknown, data?: unknown): void {
  pieError(scope, message, error, data as Record<string, unknown> | undefined);
}

/** Absolute path of the persistent pie log file (`pie.log` in the OS temp
 *  dir, rotated to `pie.log.1` once it exceeds 5 MiB). Survives extension
 *  reloads, unlike the in-memory OutputChannel buffer. */
export function getPieLogPath(): string {
  return PIE_LOG_PATH;
}

/** Directory containing the persistent pie log file. */
export function getPieLogDir(): string {
  return PIE_LOG_DIR;
}

export function showPieLogs(preserveFocus = true): void {
  const channel = getPieLogChannel();
  if (channel) {
    // Surface the persistent log file path so the user knows where the
    // surviving history lives — the OutputChannel buffer is lost on reload.
    channel.appendLine(`[pie] persistent log file: ${PIE_LOG_PATH}`);
    channel.show(preserveFocus);
  }
}

function appendBootTraceSync(record: Record<string, unknown>): void {
  if (!bootTraceEnabled) {
    return;
  }
  try {
    fsSync.mkdirSync(path.dirname(BOOT_TRACE_PATH), { recursive: true });
    fsSync.appendFileSync(BOOT_TRACE_PATH, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Ignore trace write failures; tracing must never affect extension behaviour.
  }
}

/** Audit events are emitted at `info` level but only when the user has opted in
 *  via `runtimeAuditLog` or is running in dev mode. */
export function auditLog(scope: string, event: string, payload: Record<string, unknown> = {}): void {
  if (!isAuditEnabled()) {
    return;
  }
  pieLog('info', scope, event, payload);
}

/** Boot-lifecycle logging. Off by default; enable with `PI_BOOT_LOG=1` or
 *  `setBootTraceEnabled(true)`. Records are written to both the main pie log
 *  and the dedicated boot-trace JSONL file. */
export function bootLog(scope: string, event: string, payload: Record<string, unknown> = {}): void {
  if (!bootTraceEnabled) {
    return;
  }
  const record = {
    ts: new Date().toISOString(),
    pid: process.pid,
    scope,
    event,
    ...payload,
  };
  appendBootTraceSync(record);
  pieLog('info', scope, event, payload);
}

/** Very low-level boot tracing (e.g. per-request backend RPC). Writes only to the
 *  dedicated boot-trace JSONL file to avoid flooding the OutputChannel. */
export function bootTraceSync(scope: string, event: string, payload: Record<string, unknown> = {}): void {
  if (!bootTraceEnabled) {
    return;
  }
  appendBootTraceSync({
    ts: new Date().toISOString(),
    pid: process.pid,
    scope,
    event,
    ...payload,
  });
}

/** Development-only invariant guard. In dev mode it logs an error and throws so
 *  the defect is caught immediately. In production it only logs the error. */
export function assertInvariant(
  scope: string,
  condition: boolean,
  message: string,
  payload: Record<string, unknown> = {},
): void {
  if (condition) {
    return;
  }

  pieLog('error', scope, 'invariant', { message, ...payload });

  // Throw only in dev mode so defects surface immediately during development.
  // In production (even with runtime audit logging on) we only log — turning
  // on the diagnostics toggle must never make a recoverable invariant fatal.
  if (devMode) {
    throw new Error(`[pie:${scope}] ${message}`);
  }
}
