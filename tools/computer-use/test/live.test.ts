import assert from 'node:assert/strict';
import test from 'node:test';

import { ComputerBackend } from '../src/backend.mjs';

const LIVE = process.env.PIE_RUN_INTEGRATION_TESTS === '1' && process.env.PIE_COMPUTER_USE_LIVE === '1';

test('live native backend loads and discovers the local desktop', { skip: !LIVE }, async () => {
  const backend = new ComputerBackend();
  try {
    const windows = await backend.listWindows(undefined);
    assert.ok(Array.isArray(windows));
  } finally { await backend.shutdown(); }
});
