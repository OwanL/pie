import * as vscode from 'vscode';

import {
  getPieLogPath,
  setPieLoggerOutputAdapter,
  type LogLevel,
} from '../../../../lib/structured-logging/pie-logger.js';

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};
const CHANNEL_WINDOW_MS = 1_000;
const MAX_CHANNEL_LINES_PER_WINDOW = 40;

interface ChannelRateState {
  windowStartedAt: number;
  emitted: number;
  suppressed: number;
  summaryTimer?: ReturnType<typeof setTimeout>;
}

let pieLogChannel: vscode.LogOutputChannel | undefined;
let pieBackendChannel: vscode.LogOutputChannel | undefined;
let logChannelsInitialized = false;
let channelRateStates = new WeakMap<object, ChannelRateState>();

/** Create the VS Code channels lazily, keeping module evaluation safe until a
 *  log is actually emitted. The backend channel isolates its chatty stderr. */
function ensureLogChannels(): void {
  if (logChannelsInitialized) return;
  logChannelsInitialized = true;
  try {
    const createOutputChannel = vscode.window?.createOutputChannel;
    if (!createOutputChannel) return;
    pieLogChannel = createOutputChannel('pie', { log: true });
    pieBackendChannel = createOutputChannel('pie (backend)', { log: true });
  } catch {
    // If the host surface is unavailable, core logging still reaches file/console.
  }
}

function channelForScope(scope: string): vscode.LogOutputChannel | undefined {
  ensureLogChannels();
  return scope === 'backend-stderr' ? pieBackendChannel : pieLogChannel;
}

/** Honor VS Code's native per-channel level dropdown independently from
 *  `pie.logLevel`. VS Code levels are Off=0, Trace=1 … Error=5. */
function channelAccepts(channel: vscode.LogOutputChannel, level: LogLevel): boolean {
  const configured = Number(channel.logLevel);
  if (configured === 0) return false;
  if (configured === 1) return true;
  if (configured >= 2 && configured <= 5) return LEVEL_RANK[level] >= configured * 10;
  return true;
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

/** Bound low-severity bursts on the workbench thread; warnings and errors are
 *  never rate-limited. Every accepted entry remains eligible for file logging. */
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

function emitToChannel(channel: vscode.LogOutputChannel, level: LogLevel, line: string): void {
  switch (level) {
    case 'trace': channel.trace(line); break;
    case 'debug': channel.debug(line); break;
    case 'info': channel.info(line); break;
    case 'warn': channel.warn(line); break;
    case 'error': channel.error(line); break;
  }
}

/** @internal Test seam for deterministic OutputChannel policy checks. */
export function setPieLogChannelsForTesting(
  main?: vscode.LogOutputChannel,
  backend?: vscode.LogOutputChannel,
): void {
  pieLogChannel = main;
  pieBackendChannel = backend;
  logChannelsInitialized = true;
  channelRateStates = new WeakMap<object, ChannelRateState>();
}

setPieLoggerOutputAdapter({
  accepts(level, scope) {
    const channel = channelForScope(scope);
    return channel !== undefined
      && channelAccepts(channel, level)
      && channelRateLimitAllows(channel, level);
  },
  emit(level, scope, line) {
    const channel = channelForScope(scope);
    if (channel) emitToChannel(channel, level, line);
  },
});

/** Reveal the main diagnostics channel and point at the durable log location. */
export function showPieLogs(preserveFocus = true): void {
  const channel = channelForScope('main');
  if (!channel) return;
  channel.appendLine(`[pie] persistent log file: ${getPieLogPath()}`);
  channel.show(preserveFocus);
}
