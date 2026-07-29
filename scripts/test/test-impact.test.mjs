import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  extractRelativeDependencies,
  impactedTestsForChanges,
  planAffectedTests,
} from '../lib/test-impact.mjs';

test('extractRelativeDependencies recognizes imports, exports, require, and file URLs', () => {
  const dependencies = extractRelativeDependencies(`
    import './side-effect';
    import value from "../value";
    export { x } from './exported.js';
    const lazy = import('./lazy');
    const legacy = require('./legacy');
    const fixture = new URL('./fixture.json', import.meta.url);
    import 'external-package';
  `);
  assert.deepEqual(dependencies.sort(), [
    '../value', './exported.js', './fixture.json', './lazy', './legacy', './side-effect',
  ]);
});

test('impactedTestsForChanges follows transitive imports and resolves deleted modules', () => {
  const sources = new Map([
    ['extension/src/entry.ts', "export { value } from './deleted.js';"],
    ['extension/test/entry.test.ts', "import { value } from '../src/entry.js';"],
    ['extension/test/unrelated.test.ts', "import '../src/unrelated';"],
    ['extension/src/unrelated.ts', 'export const unrelated = true;'],
  ]);
  const result = impactedTestsForChanges({
    files: [...sources.keys()],
    testFiles: ['extension/test/entry.test.ts', 'extension/test/unrelated.test.ts'],
    changedFiles: ['extension/src/deleted.ts'],
    readSource: (file) => sources.get(file) ?? '',
  });
  assert.deepEqual(result, { testFiles: ['extension/test/entry.test.ts'], uncovered: [] });
});

test('impactedTestsForChanges reports source changes with no dependency edge', () => {
  const result = impactedTestsForChanges({
    files: ['extension/src/orphan.ts', 'extension/test/example.test.ts'],
    testFiles: ['extension/test/example.test.ts'],
    changedFiles: ['extension/src/orphan.ts'],
    readSource: () => '',
  });
  assert.deepEqual(result, { testFiles: [], uncovered: ['extension/src/orphan.ts'] });
});

async function withFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-test-impact-'));
  try {
    await mkdir(path.join(root, 'extension', 'src'), { recursive: true });
    await mkdir(path.join(root, 'extension', 'test', 'integration'), { recursive: true });
    await writeFile(path.join(root, 'extension', 'src', 'used.ts'), 'export const used = true;');
    await writeFile(path.join(root, 'extension', 'src', 'orphan.ts'), 'export const orphan = true;');
    await writeFile(path.join(root, 'extension', 'test', 'used.test.ts'), "import '../src/used';");
    await writeFile(path.join(root, 'extension', 'test', 'other.test.ts'), 'export {};');
    await writeFile(path.join(root, 'extension', 'test', 'integration', 'model-config-sync.test.ts'), 'export {};');
    await writeFile(path.join(root, 'extension', 'test', 'integration', 'model-profile-coverage.test.ts'), 'export {};');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('planAffectedTests selects direct dependents and falls back to the package for uncovered source', async () => {
  await withFixture(async (root) => {
    assert.deepEqual(planAffectedTests(root, ['extension/src/used.ts']).testFiles, ['extension/test/used.test.ts']);
    assert.deepEqual(planAffectedTests(root, ['extension/src/orphan.ts']).testFiles, [
      'extension/test/integration/model-config-sync.test.ts',
      'extension/test/integration/model-profile-coverage.test.ts',
      'extension/test/other.test.ts',
      'extension/test/used.test.ts',
    ]);
  });
});

test('planAffectedTests selects a package for manifest changes and full suite for global infrastructure', async () => {
  await withFixture(async (root) => {
    assert.deepEqual(planAffectedTests(root, ['extension/package.json']).testFiles, [
      'extension/test/integration/model-config-sync.test.ts',
      'extension/test/integration/model-profile-coverage.test.ts',
      'extension/test/other.test.ts',
      'extension/test/used.test.ts',
    ]);
    assert.deepEqual(planAffectedTests(root, ['models.yaml']).testFiles, [
      'extension/test/integration/model-config-sync.test.ts',
      'extension/test/integration/model-profile-coverage.test.ts',
    ]);
    assert.equal(planAffectedTests(root, ['scripts/run-tests.mjs']).mode, 'full');
  });
});
