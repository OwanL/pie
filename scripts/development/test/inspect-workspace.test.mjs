import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireDevelopmentReader } from '../../../lib/development-runtime/lifetime.mjs';

const cli = fileURLToPath(new URL('../inspect-workspace.mjs', import.meta.url));
test('inspection never creates state and does not acquire a coordination lock', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-inspect-gate-'));
  try {
    const missing = spawnSync(process.execPath, [cli, root], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.deepEqual(await fs.readdir(root), []);
    const reader = await acquireDevelopmentReader(root, { metadata: { operation: 'inspection-test' } });
    const lock = path.join(root, '.cache/development-runtime/coordination.lock');
    await fs.writeFile(lock, 'malformed');
    const result = spawnSync(process.execPath, [cli, root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.readers[0].record.metadata.operation, 'inspection-test');
    assert.match(snapshot.problems[0].reason, /not valid JSON/);
    assert.equal(await fs.readFile(lock, 'utf8'), 'malformed');
    await fs.unlink(lock);
    await reader.release({ teardownConfirmed: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
