import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('the pinned embedded Pi runtime discovers the extension and serializes provider-compatible discriminators', { skip: process.env.PLAYWRIGHT_COVERAGE_RUN === '1' }, () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(testDir, '..', '..', '..');
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--import', 'tsx', path.join(testDir, 'fixtures', 'host-runtime-loader.ts'), repoRoot], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim()) as {
    errors: unknown[]; found: boolean; serializedLength: number; hasConst: boolean;
    actionEnum: string[]; inputKinds: Array<{ type: string; enumLength: number }>;
  };
  assert.deepEqual(result.errors, []);
  assert.equal(result.found, true, 'playwright tool was not registered by the embedded Pi loader');
  assert.ok(result.serializedLength > 1000);
  assert.equal(result.hasConst, false, 'string discriminators must use StringEnum rather than Type.Literal');
  assert.deepEqual(result.actionEnum, ['open', 'observe', 'act', 'run_code', 'close']);
  assert.ok(result.inputKinds.length > 0);
  for (const kind of result.inputKinds) {
    assert.equal(kind.type, 'string');
    assert.equal(kind.enumLength, 1);
  }
});
