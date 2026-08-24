import * as vscode from 'vscode';

import { BackendClient } from './host/backend/client';
import { PieExtension } from './host/extension-host';
import { bootTraceSync } from './host/util/audit';
import { toErrorMessage } from './host/util/error-message';
import { appendPieError, flushPieLogger, initPieLogger, parseLogLevel, pieLog, setLogLevel } from './host/util/pie-logger';
import { reapTempLogs } from './host/util/temp-log-reaper';

let extensionInstance: PieExtension | null = null;
let processErrorHandlersRegistered = false;

/** Normalize a filesystem path for case- and separator-insensitive comparison
 *  (Windows stacks use backslashes; pie's extensionPath may differ in case). */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** True if the error's stack trace contains a frame inside pie's own extension
 *  directory. The extension host runs every extension in one Node.js process,
 *  so a global `uncaughtException` handler catches other extensions' crashes
 *  too (e.g. Copilot). This lets us distinguish pie's own crashes from foreign
 *  ones so we don't mislabel them as "pie: uncaught exception". When the stack
 *  is missing/ambiguous we conservatively return true so pie's own crashes are
 *  still surfaced. */
function originatesFromPie(err: unknown, piePath: string): boolean {
  if (!piePath) return true;
  const stack = err instanceof Error ? err.stack : undefined;
  if (!stack) return true;
  return normalizePath(stack).includes(piePath);
}

export function activate(context: vscode.ExtensionContext): void {
  initPieLogger({ devMode: context.extensionMode === 1 });
  // Apply the user-configured log verbosity. The level can also be changed
  // live via the `pie.setLogLevel` command, which keeps this setting in sync.
  const configuredLevel = vscode.workspace
    .getConfiguration('pie')
    .get<string>('logLevel', 'info');
  setLogLevel(parseLogLevel(configuredLevel, 'info'));

  // Reap orphaned pi tool-output temp logs (pi-bash-*.log / pi-output-*.log)
  // that the SDK writes on truncation but never cleans up. Best-effort,
  // fire-and-forget — never blocks activation.
  const retention = vscode.workspace
    .getConfiguration('pie')
    .get<{ maxAgeDays?: number; maxTotalSizeMb?: number }>('tempLogRetention');
  void reapTempLogs({
    maxAgeDays: retention?.maxAgeDays,
    maxTotalSizeMb: retention?.maxTotalSizeMb,
  }).then((r) => {
    if (r.deleted > 0) {
      pieLog('info', 'temp-log-reaper', `Reaped ${r.deleted} temp log(s)`, {
        scanned: r.scanned,
        freedKb: Math.round(r.freedBytes / 1024),
      });
    }
  }).catch(() => {
    // Best-effort cleanup — never surface a reaper failure to the user.
  });

  bootTraceSync('extension', 'activate.enter', {
    extensionMode: context.extensionMode,
  });
  const extension = new PieExtension(context, new BackendClient());
  extensionInstance = extension;
  extension.register();
  context.subscriptions.push(extension);

  if (!processErrorHandlersRegistered) {
    processErrorHandlersRegistered = true;
    // Capture pie's own extension path once so the global uncaughtException
    // handler can tell pie's own crashes apart from those thrown by *other*
    // extensions sharing the extension-host process. Without this, pie
    // misattributes foreign crashes (e.g. Copilot's) as "pie: uncaught
    // exception". Foreign exceptions are still logged for diagnostics but
    // left to VS Code's native extension-host error handling, which attributes
    // them correctly.
    const piePath = normalizePath(context.extensionPath);
    process.on('unhandledRejection', (reason) => {
      appendPieError('process', 'unhandledRejection', reason);
      void flushPieLogger();
    });
    process.on('uncaughtException', (err) => {
      appendPieError('process', 'uncaughtException', err);
      void flushPieLogger();
      if (originatesFromPie(err, piePath)) {
        void vscode.window.showErrorMessage('pie: uncaught exception: ' + toErrorMessage(err));
      }
    });
  }

  void extension.start().catch((err) => {
    appendPieError('extension', 'start() failed', err);
    void vscode.window.showErrorMessage('pie failed to start: ' + toErrorMessage(err));
  });
}

export async function deactivate(): Promise<void> {
  bootTraceSync('extension', 'deactivate.enter');
  const extension = extensionInstance;
  extensionInstance = null;
  try {
    await extension?.shutdown();
  } finally {
    await flushPieLogger();
  }
}
