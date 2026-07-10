import * as vscode from 'vscode';

import { BackendClient } from './host/backend/client';
import { PieExtension } from './host/extension-host';
import { bootTraceSync } from './host/util/audit';
import { toErrorMessage } from './host/util/error-message';
import { appendPieError, initPieLogger, parseLogLevel, pieLog, setLogLevel } from './host/util/pie-logger';
import { reapTempLogs } from './host/util/temp-log-reaper';

let extensionInstance: PieExtension | null = null;
let processErrorHandlersRegistered = false;

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
    process.on('unhandledRejection', (reason) => {
      appendPieError('process', 'unhandledRejection', reason);
    });
    process.on('uncaughtException', (err) => {
      appendPieError('process', 'uncaughtException', err);
      void vscode.window.showErrorMessage('pie: uncaught exception: ' + toErrorMessage(err));
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
  await extension?.shutdown();
}
