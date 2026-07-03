import * as vscode from 'vscode';

import { BackendClient } from './host/backend/client';
import { PieExtension } from './host/extension-host';
import { bootTraceSync } from './host/util/audit';
import { initPieLogger, parseLogLevel, setLogLevel } from './host/util/pie-logger';

let extensionInstance: PieExtension | null = null;

export function activate(context: vscode.ExtensionContext): void {
  initPieLogger({ devMode: context.extensionMode === 1 });
  // Apply the user-configured log verbosity. The level can also be changed
  // live via the `pie.setLogLevel` command, which keeps this setting in sync.
  const configuredLevel = vscode.workspace
    .getConfiguration('pie')
    .get<string>('logLevel', 'info');
  setLogLevel(parseLogLevel(configuredLevel, 'info'));
  bootTraceSync('extension', 'activate.enter', {
    extensionMode: context.extensionMode,
  });
  const extension = new PieExtension(context, new BackendClient());
  extensionInstance = extension;
  extension.register();
  context.subscriptions.push(extension);
  void extension.start();
}

export async function deactivate(): Promise<void> {
  bootTraceSync('extension', 'deactivate.enter');
  const extension = extensionInstance;
  extensionInstance = null;
  await extension?.shutdown();
}
