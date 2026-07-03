import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';

import { toErrorMessage } from './error-message';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export type PieLogLevel = Extract<LogLevel, 'info' | 'warn' | 'error'>;

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

let pieLogChannel: vscode.OutputChannel | undefined;
let minLevel: LogLevel = 'info';
let devMode = false;
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

function getPieLogChannel(): vscode.OutputChannel | undefined {
  if (pieLogChannel) {
    return pieLogChannel;
  }

  try {
    // `vscode` is only available inside the extension host. Import it lazily
    // so the logger module loads safely in tests and other non-VS Code runtimes.
    const vscodeMod = require('vscode') as typeof vscode;
    const createOutputChannel = vscodeMod.window?.createOutputChannel;
    if (!createOutputChannel) {
      return undefined;
    }
    pieLogChannel = createOutputChannel('pie');
  } catch {
    // vscode not available; log output will fall back to console and file.
  }

  return pieLogChannel;
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
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) {
    return;
  }

  const ts = new Date().toISOString();
  const suffix = stringifyLogData(data);
  const line = suffix
    ? `[${ts}] [${level}] [${scope}] ${message} ${suffix}`
    : `[${ts}] [${level}] [${scope}] ${message}`;

  getPieLogChannel()?.appendLine(line);
  appendToPersistentLog(line);
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

export function showPieLogs(preserveFocus = true): void {
  getPieLogChannel()?.show(preserveFocus);
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
