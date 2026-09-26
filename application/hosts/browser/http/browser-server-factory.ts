import { BrowserServer } from './browser-server.js';
import type { BrowserServerOptions } from '../types.js';
import type { BrowserServerService } from '../../lib/platform-contracts/browser-server-seam.js';

/** Construct the concrete browser server behind the host-owned factory seam. */
export function createBrowserServer(options: BrowserServerOptions): BrowserServerService {
  return new BrowserServer(options);
}
