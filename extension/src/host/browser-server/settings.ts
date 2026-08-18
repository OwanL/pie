/**
 * Local browser-server settings (browser server plan §6.2): read
 * `pie.browserServer.*` VS Code configuration. The server re-reads on every
 * start and normalizes defensively (`BrowserServer.readSettings`), so this
 * helper passes raw values through.
 */

import * as vscode from 'vscode';

import { BROWSER_SERVER_POLICY } from './policy';
import type { BrowserServerSettings } from './types';

export function readBrowserServerSettings(): BrowserServerSettings {
  const config = vscode.workspace.getConfiguration('pie.browserServer');
  return {
    enabled: config.get<boolean>('enabled', true),
    port: config.get<number>('port', BROWSER_SERVER_POLICY.defaultPort),
    requirePreferredPort: config.get<boolean>('requirePreferredPort', false),
  };
}
