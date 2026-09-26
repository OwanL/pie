import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from '../backend-args.js';

test('parseArgs reads sdkPath and cwd and errors when sdkPath is missing', () => {
  assert.deepEqual(parseArgs(['--sdkPath', '/sdk', '--cwd', '/repo']), { sdkPath: '/sdk', cwd: '/repo', backendGeneration: 1 });
  assert.deepEqual(parseArgs(['--cwd', '/repo', '--sdkPath', '/sdk']), { sdkPath: '/sdk', cwd: '/repo', backendGeneration: 1 });
  assert.deepEqual(parseArgs(['--sdkPath', '/sdk', '--cwd', '/repo', '--hostPid', '1234']), {
    sdkPath: '/sdk', cwd: '/repo', hostPid: 1234, backendGeneration: 1,
  });
  assert.deepEqual(parseArgs(['--sdkPath', '/sdk', '--hostPid', 'not-a-pid']), { sdkPath: '/sdk', cwd: process.cwd(), backendGeneration: 1 });
  assert.throws(() => parseArgs(['--cwd', '/repo']), /Missing required --sdkPath argument/);
});
