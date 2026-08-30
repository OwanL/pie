// Focused unit tests for scripts/lib/test-packages.mjs — the shared file→package
// classification and global test-infrastructure detection used by both
// run-test-files.mjs and run-affected-tests.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGE_DIRECTIVES,
  ALL_PACKAGE_IDS,
  classifyFileToPackage,
  isGlobalTestInfra,
  mapFilesToPackages,
} from '../lib/test-packages.mjs';

test('PACKAGE_DIRECTIVES covers the 17 run-tests.mjs package ids', () => {
  const expected = [
    'extension', 'analysis', 'scripts',
    'cwd-skills', 'safeguard', 'skill-pruner', 'subagent', 'ask-user',
    'warm-bash', 'copilot-model-discovery', 'web-access-guard', 'tool-result-pruner',
    'session-reviewer', 'deferred-triggers', 'session-changes', 'computer-use',
    'image-context-guard',
  ];
  assert.deepEqual(ALL_PACKAGE_IDS, expected);
  assert.equal(PACKAGE_DIRECTIVES.length, 17);
});

test('classifyFileToPackage maps a file under each package directory to its id', () => {
  assert.equal(classifyFileToPackage('extension/test/webview/components/app-smoke.test.ts'), 'extension');
  assert.equal(classifyFileToPackage('extension/src/backend/sdk.ts'), 'extension');
  assert.equal(classifyFileToPackage('analysis/test/pricing.test.ts'), 'analysis');
  assert.equal(classifyFileToPackage('analysis/scripts/build-db.ts'), 'analysis');
  assert.equal(classifyFileToPackage('scripts/test/run-tests.test.mjs'), 'scripts');
  assert.equal(classifyFileToPackage('extensions/subagent/test/schema.test.ts'), 'subagent');
  assert.equal(classifyFileToPackage('extensions/subagent/schema.ts'), 'subagent');
  assert.equal(classifyFileToPackage('extensions/cwd-skills/index.ts'), 'cwd-skills');
  assert.equal(classifyFileToPackage('extensions/copilot-model-discovery/test/copilot-models.test.ts'), 'copilot-model-discovery');
  assert.equal(classifyFileToPackage('extensions/session-changes/test/render.test.ts'), 'session-changes');
  assert.equal(classifyFileToPackage('extensions/deferred-triggers/test/store.test.ts'), 'deferred-triggers');
  assert.equal(classifyFileToPackage('extensions/computer-use/test/schema.test.ts'), 'computer-use');
  assert.equal(classifyFileToPackage('extensions/image-context-guard/test/projection.test.ts'), 'image-context-guard');
});

test('classifyFileToPackage does not confuse extension/ with extensions/', () => {
  // `extensions/foo` must NOT match the `extension` directive (differs at the
  // char after "extension": "/" vs "s").
  assert.equal(classifyFileToPackage('extensions/subagent/test/x.test.ts'), 'subagent');
  assert.notEqual(classifyFileToPackage('extensions/subagent/test/x.test.ts'), 'extension');
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
    '.nvmrc',
    '.node-version',
    '.githooks/pre-commit',
    '.githooks/pre-push',
  ]) {
    assert.equal(isGlobalTestInfra(p), true, `${p} should be global`);
  }
  // prefixes
  assert.equal(isGlobalTestInfra('scripts/lib/sdk-version.mjs'), true);
  assert.equal(isGlobalTestInfra('shared/pricing-core.ts'), true);
  assert.equal(isGlobalTestInfra('shared/subagent-context.ts'), true);
});

test('isGlobalTestInfra is false for per-package and unrelated paths', () => {
  // per-package config stays per-package (not global)
  assert.equal(isGlobalTestInfra('extension/package.json'), false);
  assert.equal(isGlobalTestInfra('extension/tsconfig.json'), false);
  assert.equal(isGlobalTestInfra('extensions/subagent/tsconfig.json'), false);
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
    'extensions/subagent/test/schema.test.ts',
    'analysis/test/pricing.test.ts',
    'scripts/test/pre-push-safety.test.mjs',
  ]);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, ['analysis', 'extension', 'scripts', 'subagent']);
});

test('mapFilesToPackages covers root maintenance scripts', () => {
  const plan = mapFilesToPackages([
    'scripts/run-typechecks.mjs',
    'scripts/sync-models.mjs',
    'scripts/install-dependencies.mjs',
  ]);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, ['scripts']);
});

test('mapFilesToPackages selects ALL when any global infra file changes', () => {
  const plan = mapFilesToPackages([
    'extension/test/a.test.ts',
    'scripts/run-tests.mjs',            // global => select all
    'extensions/subagent/test/schema.test.ts',
  ]);
  assert.equal(plan.selectAll, true);
});

test('mapFilesToPackages ignores unrelated files', () => {
  const plan = mapFilesToPackages([
    'README.md',
    'docs/STATE_CONTRACT.md',
    'settings.json',
  ]);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, []);
});

test('mapFilesToPackages returns empty plan for no input', () => {
  const plan = mapFilesToPackages([]);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, []);
});
