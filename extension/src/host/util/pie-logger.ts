import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';

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

let pieLogChannel: vscode.LogOutputChannel | undefined;
let pieBackendChannel: vscode.LogOutputChannel | undefined;
let minLevel: LogLevel = 'info';
let devMode = false;
/** User-facing log level options, ordered from most to least verbose. */
export const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'] as const;
let runtimeAuditLogEnabled = false;
let bootTraceEnabled = process.env.PI_BOOT_LOG === '1';

/** Initialise the logger once during extension activation. This captures the
 *  VS Code extension mode so dev-mode gating works without threading an
 *  `ExtensionContext` through every log call site. */
export function initPieLogger(options: { devMode: boolean }): void {
  devMode = options.devMode;
}

/** Override the minimum level emitted to the OutputChannel and the persistent
 *  log file. Defaults to `'info'`. */
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
  if (pieLogChannel) {
    return;
  }
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

/** Map a {@link LogLevel} to the corresponding `LogOutputChannel` severity
 *  method and emit. The channel's own `logLevel` (set via the native Output
 *  panel level dropdown) gates emission — this is intentionally decoupled from
 *  the global `minLevel` (which gates only the persistent file + console), so
 *  the user can widen a single channel's view (e.g. show Debug on `pie
 *  (backend)` only) without changing `pie.logLevel` or restarting. */
function emitToChannel(level: LogLevel, scope: string, line: string): void {
  // Backend stderr lives in its own channel so the main `pie` stream stays
  // readable; pass the raw line without a redundant scope prefix (the channel
  // name already signals the source).
  const channel = scope === 'backend-stderr' ? getPieBackendChannel() : getPieLogChannel();
  if (!channel) {
    return;
  }
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
    return data;
  }
  if (data instanceof Error) {
    return data.stack || data.message;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function rotateLogIfNeeded(): void {
  try {
    if (!fsSync.existsSync(PIE_LOG_PATH)) {
      return;
    }
    const stat = fsSync.statSync(PIE_LOG_PATH);
    if (stat.size <= MAX_LOG_BYTES) {
      return;
    }
    const backup = `${PIE_LOG_PATH}.1`;
    if (fsSync.existsSync(backup)) {
      fsSync.unlinkSync(backup);
    }
    fsSync.renameSync(PIE_LOG_PATH, backup);
  } catch {
    // Rotation failures are non-fatal; keep appending to the existing file.
  }
}

function appendToPersistentLog(line: string): void {
  try {
    fsSync.mkdirSync(PIE_LOG_DIR, { recursive: true });
    rotateLogIfNeeded();
    fsSync.appendFileSync(PIE_LOG_PATH, `${line}\n`, 'utf8');
  } catch {
    // Persistent logging must never affect extension behaviour.
  }
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
  const ts = new Date().toISOString();
  const suffix = stringifyLogData(data);
  const fullLine = suffix
    ? `[${ts}] [${level}] [${scope}] ${message} ${suffix}`
    : `[${ts}] [${level}] [${scope}] ${message}`;

  // The Output channel is a `LogOutputChannel` — it prepends its own
  // `[timestamp] [level]` prefix and colorizes by severity, so we hand it the
  // message WITHOUT our timestamp/level prefix. Emission is gated by the
  // channel's own logLevel (native dropdown), independent of `minLevel` —
  // see `emitToChannel`. Backend stderr lines are passed through raw.
  const channelLine = scope === 'backend-stderr'
    ? message
    : (suffix ? `[${scope}] ${message} ${suffix}` : `[${scope}] ${message}`);
  emitToChannel(level, scope, channelLine);

  // Persistent file + dev console are gated by the global `pie.logLevel`
  // setting (`minLevel`). The channel above may show more (when the user
  // widens its dropdown), but the durable record respects configured verbosity.
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) {
    return;
  }

  appendToPersistentLog(fullLine);
  appendToConsole(level, scope, message, data);
}

export function pieTrace(scope: string, message: string, data?: Record<string, unknown>): void {
  pieLog('trace', scope, message, data);
}

export function pieDebug(scope: string, message: string, data?: Record<string, unknown>): void {
  pieLog('debug', scope, message, data);
}

export function pieInfo(scope: string, message: string, data?: Record<string, unknown>): void {
  pieLog('info', scope, message, data);
}

export function pieWarn(scope: string, message: string, data?: Record<string, unknown>): void {
  pieLog('warn', scope, message, data);
}

export function pieError(scope: string, message: string, error?: unknown, data?: Record<string, unknown>): void {
  const details = data && typeof data === 'object'
    ? { ...data, error: toErrorMessage(error) }
    : { error: toErrorMessage(error), data };
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
