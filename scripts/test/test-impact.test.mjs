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
import {
  isProtectedDirectoryName,
  parseProtectedDirectoryNames,
  PROTECTED_DIRECTORY_NAMES,
} from '../lib/traversal-policy.mjs';

test('plain-Node root walkers consume every canonical protected-directory entry', () => {
  assert.ok(PROTECTED_DIRECTORY_NAMES.length > 20);
  for (const name of ['node_modules', '.git', 'build', 'data', 'sessions', 'logs', 'coverage']) {
    assert.equal(isProtectedDirectoryName(name), true, name);
  }
  assert.equal(isProtectedDirectoryName('.pie-sdk-fixture'), true);
  assert.equal(isProtectedDirectoryName('fixture.egg-info'), true);
  assert.equal(isProtectedDirectoryName('src'), false);
  assert.deepEqual(parseProtectedDirectoryNames(`
    export const PROTECTED_DIRECTORIES = [
      { dir: 'single-quoted', className: 'caches' },
      { dir: "double-quoted", className: "logs" },
    ];
  `), ['single-quoted', 'double-quoted']);
  assert.throws(() => parseProtectedDirectoryNames(`
    export const PROTECTED_DIRECTORIES = [
      { dir: 'parsed', className: 'caches' },
      buildEntry('silently-dropped'),
    ];
  `), /unsupported or unparsed entry/);
});

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
    await mkdir(path.join(root, 'scripts', 'test'), { recursive: true });
    await writeFile(path.join(root, 'extension', 'src', 'used.ts'), 'export const used = true;');
    await writeFile(path.join(root, 'extension', 'src', 'orphan.ts'), 'export const orphan = true;');
    await writeFile(path.join(root, 'extension', 'test', 'used.test.ts'), "import '../src/used';");
    await writeFile(path.join(root, 'extension', 'test', 'other.test.ts'), 'export {};');
    await writeFile(path.join(root, 'extension', 'test', 'integration', 'model-config-sync.test.ts'), 'export {};');
    await writeFile(path.join(root, 'extension', 'test', 'integration', 'model-profile-coverage.test.ts'), 'export {};');
    await writeFile(path.join(root, 'scripts', 'test', 'install-batch.test.mjs'), 'export {};');
    for (const protectedDir of ['data', 'build', '.pie-sdk-fixture']) {
      await mkdir(path.join(root, 'extension', protectedDir), { recursive: true });
      await writeFile(path.join(root, 'extension', protectedDir, `${protectedDir}.test.ts`), 'export {};');
    }
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

test('planAffectedTests routes deleted sources to their package without silent zero', async () => {
  await withFixture(async (root) => {
    // The file no longer exists on disk (git reports deletions by path), but
    // its owning package must still be selected.
    const plan = planAffectedTests(root, ['extension/src/deleted-in-worktree.ts']);
    assert.equal(plan.mode, 'files');
    assert.deepEqual(plan.testFiles, [
      'extension/test/integration/model-config-sync.test.ts',
      'extension/test/integration/model-profile-coverage.test.ts',
      'extension/test/other.test.ts',
      'extension/test/used.test.ts',
    ]);
    assert.ok(plan.reasons.some((reason) => reason.includes('deleted-in-worktree.ts')));
  });
});

test('planAffectedTests merges rename old/new paths and never duplicates selections', async () => {
  await withFixture(async (root) => {
    // A rename reaches the runner as both the old and the new path; the old
    // path no longer exists on disk while the new one is untracked.
    const plan = planAffectedTests(root, ['extension/src/used.ts', 'extension/src/renamed.ts']);
    assert.equal(plan.mode, 'files');
    assert.deepEqual(plan.testFiles, [
      'extension/test/integration/model-config-sync.test.ts',
      'extension/test/integration/model-profile-coverage.test.ts',
      'extension/test/other.test.ts',
      'extension/test/used.test.ts',
    ]);
  });
});

test('planAffectedTests broadens to the full suite for unknown-ownership code files', async () => {
  await withFixture(async (root) => {
    // A code file under a not-yet-registered root must broaden, never select zero.
    const unowned = planAffectedTests(root, ['harness/session-storage/new-store.ts']);
    assert.equal(unowned.mode, 'full');
    assert.deepEqual(unowned.testFiles, []);
    assert.ok(unowned.reasons.some((reason) => reason.includes('harness/session-storage/new-store.ts')));

    // Broadening dominates even alongside owned changes.
    const mixed = planAffectedTests(root, ['extension/src/used.ts', 'application/backend/new-action.ts']);
    assert.equal(mixed.mode, 'full');

    // Non-code unknown paths keep the narrow behavior.
    assert.deepEqual(planAffectedTests(root, ['docs/new-note.md']), { mode: 'none', testFiles: [], reasons: [] });
  });
});

test('planAffectedTests selects a package for manifest changes and full suite for global infrastructure', async () => {
  await withFixture(async (root) => {
    assert.deepEqual(planAffectedTests(root, ['application/hosts/vscode/package.json']).testFiles, [
      'extension/test/integration/model-config-sync.test.ts',
      'extension/test/integration/model-profile-coverage.test.ts',
      'extension/test/other.test.ts',
      'extension/test/used.test.ts',
    ]);
    assert.deepEqual(planAffectedTests(root, ['models.yaml']).testFiles, [
      'extension/test/integration/model-config-sync.test.ts',
      'extension/test/integration/model-profile-coverage.test.ts',
    ]);
    assert.deepEqual(planAffectedTests(root, ['install.bat']).testFiles, [
      'scripts/test/install-batch.test.mjs',
    ]);
    assert.deepEqual(planAffectedTests(root, ['.gitattributes']).testFiles, [
      'scripts/test/install-batch.test.mjs',
    ]);
    assert.equal(planAffectedTests(root, ['scripts/run-tests.mjs']).mode, 'full');
  });
});
