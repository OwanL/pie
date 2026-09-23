/** Browser-server settings defaults and explicit LAN opt-in propagation. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { readBrowserServerSettings } from '../../../src/host/browser-server/settings';

function read(values: Record<string, unknown> = {}): ReturnType<typeof readBrowserServerSettings> {
  return readBrowserServerSettings({
    get: <T>(key: string, fallback: T): T => (
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] as T : fallback
    ),
  });
}

test('browser-server LAN access defaults off and is propagated when explicitly enabled', () => {
  assert.deepEqual(read(), {
    enabled: true,
    port: 1997,
    requirePreferredPort: false,
    allowLan: false,
  });
  assert.equal(read({ allowLan: true }).allowLan, true);
  assert.equal(read({ allowLan: false }).allowLan, false);
});
