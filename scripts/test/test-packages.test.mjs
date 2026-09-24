// Focused unit tests for scripts/lib/test-packages.mjs — the shared file→package
// classification and global test-infrastructure detection used by both
// run-test-files.mjs and run-affected-tests.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGE_DIRECTIVES,
  ALL_PACKAGE_IDS,
  PACKAGE_REGISTRY,
  classifyFileToPackage,
  isGlobalTestInfra,
  isUnownedCodeSource,
  mapFilesToPackages,
  packageSourceRoots,
  packageTestRoots,
  resolvePackageEntry,
} from '../lib/test-packages.mjs';

test('PACKAGE_DIRECTIVES covers package dirs, owned dirs, and routed test roots', () => {
  const expected = [
    'extension', 'analysis', 'scripts',
    'cwd-skills', 'safeguard', 'skill-pruner', 'subagent', 'ask-user',
    'warm-bash', 'copilot-model-discovery', 'web-access-guard', 'tool-result-pruner',
    'deferred-triggers', 'session-changes', 'computer-use',
    'image-context-guard', 'playwright',
  ];
  assert.deepEqual(ALL_PACKAGE_IDS, expected);
  // 17 package dirs + 8 owned/adapter dirs + 16 nested default test roots
  // (scripts' test root equals its dir) + 2 declared analysis distributed roots.
  assert.equal(PACKAGE_DIRECTIVES.length, 43, 'routing view covers dirs, owned dirs, test roots, and declared distributed roots');
});

test('source/test root defaults keep single-root enumeration identical', () => {
  for (const entry of PACKAGE_REGISTRY) {
    if (entry.sourceRoots) continue;
    assert.deepEqual(packageSourceRoots(entry), [entry.dir, ...(entry.ownedDirs ?? [])], `${entry.id} default source roots`);
    assert.deepEqual(packageTestRoots(entry), [entry.testDir ?? `${entry.dir}/test`], `${entry.id} default test root`);
  }
  // The scripts package routes its own test root without duplication.
  const scripts = resolvePackageEntry('scripts');
  assert.deepEqual(packageSourceRoots(scripts), ['scripts/test']);
  assert.deepEqual(packageTestRoots(scripts), ['scripts/test']);
});

test('analysis declares its planned distributed roots without dropping current ones', () => {
  const analysis = resolvePackageEntry('analysis');
  // `analysis` remains the install/package owner and first-routed source root.
  assert.deepEqual(packageSourceRoots(analysis), ['analysis', 'analytics/analysis']);
  assert.deepEqual(packageTestRoots(analysis), ['analysis/test', 'analytics/analysis/test']);
  // Both generations route to the same verification id.
  assert.equal(classifyFileToPackage('analysis/test/pricing.test.ts'), 'analysis');
  assert.equal(classifyFileToPackage('analytics/analysis/test/pricing.test.ts'), 'analysis');
  assert.equal(classifyFileToPackage('analytics/analysis/scripts/build-db.ts'), 'analysis');
  assert.equal(classifyFileToPackage('analytics/analysis/README.md'), 'analysis');
  // Root integration suites and other packages' roots must not leak in.
  assert.equal(classifyFileToPackage('test/integration/example.test.ts'), null);
  assert.equal(classifyFileToPackage('analytics/other/file.ts'), null);
});

test('routed test roots classify focused test files to their verification id', () => {
  // classification only (no fs); existence is checked by groupFilesByPackage.
  for (const entry of PACKAGE_REGISTRY) {
    for (const testRoot of packageTestRoots(entry)) {
      const probe = `${testRoot}/sample.test.ts`;
      assert.equal(classifyFileToPackage(probe), entry.id, `${probe} must route to ${entry.id}`);
    }
  }
});

test('classifyFileToPackage maps a file under each package directory to its id', () => {
  assert.equal(classifyFileToPackage('extension/test/webview/components/app-smoke.test.ts'), 'extension');
  assert.equal(classifyFileToPackage('extension/src/backend/sdk.ts'), 'extension');
  assert.equal(classifyFileToPackage('analysis/test/pricing.test.ts'), 'analysis');
  assert.equal(classifyFileToPackage('analysis/scripts/build-db.ts'), 'analysis');
  assert.equal(classifyFileToPackage('scripts/test/run-tests.test.mjs'), 'scripts');
  assert.equal(classifyFileToPackage('tools/subagent/test/schema.test.ts'), 'subagent');
  assert.equal(classifyFileToPackage('extensions/subagent/index.ts'), 'subagent');
  assert.equal(classifyFileToPackage('tools/ask-user/test/loader-shim.test.ts'), 'ask-user');
  assert.equal(classifyFileToPackage('tools/ask-user/tsconfig.json'), 'ask-user');
  assert.equal(classifyFileToPackage('tools/subagent/schema.ts'), 'subagent');
  assert.equal(classifyFileToPackage('tools/request-capability/index.ts'), 'skill-pruner');
  assert.equal(classifyFileToPackage('extensions/cwd-skills/index.ts'), 'cwd-skills');
  assert.equal(classifyFileToPackage('extensions/copilot-model-discovery/test/copilot-models.test.ts'), 'copilot-model-discovery');
  assert.equal(classifyFileToPackage('tools/session-changes/test/render.test.ts'), 'session-changes');
  assert.equal(classifyFileToPackage('tools/deferred-triggers/test/store.test.ts'), 'deferred-triggers');
  assert.equal(classifyFileToPackage('tools/computer-use/test/schema.test.ts'), 'computer-use');
  assert.equal(classifyFileToPackage('tools/warm-bash/test/classifier.test.ts'), 'warm-bash');
  assert.equal(classifyFileToPackage('tools/playwright/test/schema.test.ts'), 'playwright');
  assert.equal(classifyFileToPackage('extensions/image-context-guard/test/projection.test.ts'), 'image-context-guard');
});

test('every migrated discovery adapter remains assigned to its tool tests', () => {
  for (const id of ['ask-user', 'subagent', 'warm-bash', 'deferred-triggers', 'session-changes', 'computer-use', 'playwright']) {
    const shim = `extensions/${id}/index.ts`;
    assert.equal(classifyFileToPackage(shim), id);
    const plan = mapFilesToPackages([shim]);
    assert.ok(plan.selectAll || plan.packageIds.includes(id), `${shim} must not silently skip its tests`);
  }
});

test('classifyFileToPackage distinguishes extension, tool, and legacy adapter paths', () => {
  assert.equal(classifyFileToPackage('tools/subagent/test/x.test.ts'), 'subagent');
  assert.notEqual(classifyFileToPackage('tools/subagent/test/x.test.ts'), 'extension');
  assert.equal(classifyFileToPackage('tools/ask-user/test/x.test.ts'), 'ask-user');
  assert.notEqual(classifyFileToPackage('tools/ask-user/test/x.test.ts'), 'extension');
});

test('classifyFileToPackage returns null for non-package paths', () => {
  assert.equal(classifyFileToPackage('README.md'), null);
  assert.equal(classifyFileToPackage('docs/STATE_CONTRACT.md'), null);
  assert.equal(classifyFileToPackage('settings.json'), null);
  assert.equal(classifyFileToPackage('models.yaml'), null);
  assert.equal(classifyFileToPackage('scripts/run-tests.mjs'), null);
  assert.equal(classifyFileToPackage('shared/pricing-core.ts'), null);
  assert.equal(classifyFileToPackage(''), null);
  assert.equal(classifyFileToPackage(/** @type {unknown} */ (undefined)), null);
});

test('isGlobalTestInfra recognises the test tooling and root config', () => {
  // exact paths
  for (const p of [
    'scripts/run-tests.mjs',
    'scripts/run-test-files.mjs',
    'scripts/run-affected-tests.mjs',
    'scripts/run-fast-extension-tests.mjs',
    'scripts/run-fast-batched-tests.mjs',
    'scripts/test-reporter.mjs',
    'package.json',
    'package-lock.json',
    '.node-version',
    'tools/index.ts',
    'tools/backend.ts',
    'tools/tsconfig.json',
  ]) {
    assert.equal(isGlobalTestInfra(p), true, `${p} should be global`);
  }
  // prefixes
  assert.equal(isGlobalTestInfra('scripts/lib/sdk-version.mjs'), true);
  assert.equal(isGlobalTestInfra('shared/pricing-core.ts'), true);
  assert.equal(isGlobalTestInfra('shared/subagent-context.ts'), true);
  assert.equal(isGlobalTestInfra('extensions/ask-user/index.ts'), true);
  assert.equal(isGlobalTestInfra('tools/session-control/index.ts'), true);
});

test('isGlobalTestInfra is false for per-package and unrelated paths', () => {
  // per-package config stays per-package (not global)
  assert.equal(isGlobalTestInfra('extension/package.json'), false);
  assert.equal(isGlobalTestInfra('extension/tsconfig.json'), false);
  assert.equal(isGlobalTestInfra('tools/subagent/tsconfig.json'), false);
  assert.equal(isGlobalTestInfra('extensions/subagent/index.ts'), false);
  assert.equal(isGlobalTestInfra('tools/request-capability/index.ts'), false);
  assert.equal(isGlobalTestInfra('analysis/package-lock.json'), false);
  assert.equal(isGlobalTestInfra('scripts/test/run-test-files.test.mjs'), false);
  // unrelated
  assert.equal(isGlobalTestInfra('README.md'), false);
  assert.equal(isGlobalTestInfra('docs/x.md'), false);
  assert.equal(isGlobalTestInfra('settings.json'), false);
  assert.equal(isGlobalTestInfra('extension/test/foo.test.ts'), false);
});

test('mapFilesToPackages maps package files and de-duplicates ids', () => {
  const plan = mapFilesToPackages([
    'extension/test/a.test.ts',
    'extension/src/backend/sdk.ts',     // same package, different file
    'tools/subagent/test/schema.test.ts',
    'tools/ask-user/test/loader-shim.test.ts',
    'analysis/test/pricing.test.ts',
    'scripts/test/git-environment.test.mjs',
  ]);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, ['analysis', 'ask-user', 'extension', 'scripts', 'subagent']);
  assert.deepEqual(plan.unowned, []);
});

test('mapFilesToPackages assigns moved and externally owned sources to their test packages', () => {
  const plan = mapFilesToPackages([
    'extensions/subagent/index.ts',
    'tools/request-capability/index.ts',
  ]);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, ['skill-pruner', 'subagent']);
  assert.deepEqual(plan.unowned, []);
});

test('mapFilesToPackages covers root maintenance scripts', () => {
  const plan = mapFilesToPackages([
    'scripts/run-typechecks.mjs',
    'scripts/sync-models.mjs',
    'scripts/install-dependencies.mjs',
  ]);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, ['scripts']);
  assert.deepEqual(plan.unowned, []);
});

test('mapFilesToPackages selects ALL when any global infra file changes', () => {
  const plan = mapFilesToPackages([
    'extension/test/a.test.ts',
    'scripts/run-tests.mjs',            // global => select all
    'tools/subagent/test/schema.test.ts',
  ]);
  assert.equal(plan.selectAll, true);
  assert.deepEqual(plan.unowned, []);
});

test('mapFilesToPackages broadens unknown-ownership code files instead of selecting zero tests', () => {
  // A code file under no registered root (created, moved, or a future
  // distributed root that was never declared) must broaden, never select zero.
  for (const file of [
    'harness/session-storage/transcripts/slice.ts',
    'application/backend/session-actions/cleanup.ts',
    'new-root/nested/module.test.ts',
    'stray.ts',
  ]) {
    assert.equal(isUnownedCodeSource(file), true, file);
    const plan = mapFilesToPackages([file]);
    assert.equal(plan.selectAll, true, `${file} must broaden verification`);
    assert.deepEqual(plan.packageIds, [], `${file} must not be silently attributed`);
    assert.deepEqual(plan.unowned, [file]);
  }
  // Broadening dominates even alongside owned changes; ids stay de-duplicated.
  const mixed = mapFilesToPackages(['extension/test/a.test.ts', 'harness/unknown.ts', 'harness/other.ts']);
  assert.equal(mixed.selectAll, true);
  assert.deepEqual(mixed.packageIds, ['extension']);
  assert.deepEqual(mixed.unowned, ['harness/unknown.ts', 'harness/other.ts']);
  // Unknown ownership broadens even when every other change is unowned.
  const only = mapFilesToPackages(['harness/session-storage/store.ts']);
  assert.equal(only.selectAll, true);
  assert.deepEqual(only.packageIds, []);
});

test('isUnownedCodeSource ignores non-code, global-infra, and owned maintenance scripts', () => {
  assert.equal(isUnownedCodeSource('README.md'), false);
  assert.equal(isUnownedCodeSource('docs/STATE_CONTRACT.md'), false);
  assert.equal(isUnownedCodeSource('settings.json'), false);
  assert.equal(isUnownedCodeSource('models.yaml'), false);
  assert.equal(isUnownedCodeSource(''), false);
  assert.equal(isUnownedCodeSource(undefined), false);
  // global infra and scripts-package files are owned, not unknown
  assert.equal(isUnownedCodeSource('scripts/lib/test-packages.mjs'), false);
  assert.equal(isUnownedCodeSource('scripts/run-typechecks.mjs'), false);
  assert.equal(isUnownedCodeSource('shared/pricing-core.ts'), false);
  assert.equal(isUnownedCodeSource('extension/src/backend/sdk.ts'), false);
});

test('mapFilesToPackages ignores unrelated files', () => {
  const plan = mapFilesToPackages([
    'README.md',
    'docs/STATE_CONTRACT.md',
    'settings.json',
  ]);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, []);
  assert.deepEqual(plan.unowned, []);
});

test('mapFilesToPackages returns empty plan for no input', () => {
  const plan = mapFilesToPackages([]);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, []);
  assert.deepEqual(plan.unowned, []);
});
