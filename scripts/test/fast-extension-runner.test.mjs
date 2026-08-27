import assert from 'node:assert/strict';
import test from 'node:test';

import path from 'node:path';

import {
  classifyExtensionTest,
  recoverBundledFailureSourceFiles,
} from '../run-fast-extension-tests.mjs';

test('classifyExtensionTest keeps child-process, Preact, DOM, and explicit isolation tests on tsx', () => {
  assert.equal(classifyExtensionTest('test/example.test.ts', "import 'node:child_process';"), 'tsx');
  assert.equal(classifyExtensionTest('test/preact.test.ts', "import { h } from 'preact';"), 'tsx');
  assert.equal(classifyExtensionTest('test/dom.test.ts', 'installDom();'), 'tsx');
  assert.equal(
    classifyExtensionTest('test/backend/runtime/extension-ui-bridge.test.ts', "import test from 'node:test';"),
    'tsx',
  );
});

test('classifyExtensionTest batches ordinary bundles and approved type-import fixtures', () => {
  assert.equal(classifyExtensionTest('test/example.test.ts', "test('pure', () => {});"), 'batch');
  assert.equal(
    classifyExtensionTest(
      'test/host/core/architecture/arch-arrival-order.test.ts',
      "const value = null as import('./types').Value;",
    ),
    'batch',
  );
});

test('classifyExtensionTest scopes hook and environment users in suites', () => {
  assert.equal(classifyExtensionTest('test/hooked.test.ts', 'beforeEach(() => {});'), 'scoped-batch');
  assert.equal(classifyExtensionTest('test/env.test.ts', 'process.env.EXAMPLE = \'1\';'), 'scoped-batch');
});

test('classifyExtensionTest keeps dynamic imports, persistent module hooks, and known DOM leaks standalone', () => {
  assert.equal(classifyExtensionTest('test/dynamic.test.ts', "await import('./fixture.js');"), 'bundle');
  assert.equal(classifyExtensionTest('test/hook.test.ts', 'Module.register(url);'), 'bundle');
  assert.equal(
    classifyExtensionTest('test/webview/composer/composer-draft.test.ts', 'globalThis.document = dom.window.document;'),
    'bundle',
  );
});

test('recoverBundledFailureSourceFiles restores source attribution for tests and batch wrappers', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const extensionRoot = path.join(repoRoot, 'extension');
  const tempDir = path.join(repoRoot, '.tmp-fast-extension-runner');
  const sourceFile = 'test/backend/sessions/cold-session-store.test.ts';
  const bundledFile = path.join(tempDir, 'test/backend/sessions/cold-session-store.test.js');
  const wrapperFile = path.join(tempDir, 'scoped-bundle-batch-1.mjs');
  const unrelatedFile = path.join(tempDir, 'scoped-bundle-batch-2.mjs');

  const recovered = recoverBundledFailureSourceFiles([
    { name: 'cold startup stays bounded', file: bundledFile },
    { name: bundledFile, file: wrapperFile },
    { name: 'unrelated infrastructure failure', file: unrelatedFile },
  ], tempDir, [sourceFile]);

  assert.equal(recovered[0].file, path.join(extensionRoot, sourceFile));
  assert.equal(recovered[1].file, path.join(extensionRoot, sourceFile));
  assert.equal(recovered[2].file, unrelatedFile);
});
