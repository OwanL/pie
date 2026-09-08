import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawnCliSync } from '../lib/subprocess.mjs';

test('spawnCliSync runs the current Node executable when its path contains spaces', () => {
  const result = spawnCliSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ok');
});
