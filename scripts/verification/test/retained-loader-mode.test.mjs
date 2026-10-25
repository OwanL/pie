import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { prepareNodeTestInvocation } from '../test-node.mjs';

test('internal retained loader preserves original entries and owner startup without compatibility preloads', () => {
  const files = [path.resolve('original.test.ts')];
  assert.throws(() => prepareNodeTestInvocation(files, { loaderMode: 'retained-esm' }), /owner-pinned/);
  assert.throws(() => prepareNodeTestInvocation(files, { loaderMode: 'unknown' }), /Unknown test loader/);
  const invocation = prepareNodeTestInvocation(files, {
    loaderMode: 'retained-esm', startupArgs: ['pinned-tsx-cli', '--tsconfig=owner-overlay'], waitForOwnership: false,
  });
  try {
    const config = JSON.parse(readFileSync(invocation.configPath, 'utf8'));
    assert.deepEqual(config.files, files);
    assert.deepEqual(config.sourceFileByEntry, {});
    assert.equal(config.waitForOwnership, false);
    const startupIndex = invocation.args.indexOf('pinned-tsx-cli');
    assert.ok(startupIndex >= 0);
    assert.deepEqual(invocation.args.slice(startupIndex, startupIndex + 2), ['pinned-tsx-cli', '--tsconfig=owner-overlay']);
    assert.equal(invocation.args.includes('--import'), false);
    assert.equal(existsSync(path.join(invocation.configRoot, 'entries')), false);
  } finally { invocation.dispose(); }
});
