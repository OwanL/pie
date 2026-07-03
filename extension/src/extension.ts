import * as vscode from 'vscode';

import { BackendClient } from './host/backend/client';
import { PieExtension } from './host/extension-host';
import { bootTraceSync } from './host/util/audit';
import { initPieLogger } from './host/util/pie-logger';

let extensionInstance: PieExtension | null = null;

export function activate(context: vscode.ExtensionContext): void {
  initPieLogger({ devMode: context.extensionMode === 1 });
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
