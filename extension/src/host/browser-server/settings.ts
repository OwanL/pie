/**
 * Local browser-server settings (browser server plan §6.2). The effective
 * configuration source is supplied by the host composition layer so this
 * reader remains usable outside VS Code.
 */

import { BROWSER_SERVER_POLICY } from './policy';
import type { BrowserServerSettings } from './types';

/** Standalone host-storage key for the durable LAN exposure preference. */
export const BROWSER_SERVER_ALLOW_LAN_STORAGE_KEY = 'pie.browserServer.allowLan';

/** Minimal configuration reader needed for the browser-server settings. */
export interface BrowserServerSettingsReader {
  get<T>(key: string, fallback: T): T;
}

export function readBrowserServerSettings(reader: BrowserServerSettingsReader): BrowserServerSettings {
  return {
    enabled: reader.get<boolean>('enabled', true),
    port: reader.get<number>('port', BROWSER_SERVER_POLICY.defaultPort),
    requirePreferredPort: reader.get<boolean>('requirePreferredPort', false),
    allowLan: reader.get<boolean>('allowLan', false),
  };
}
