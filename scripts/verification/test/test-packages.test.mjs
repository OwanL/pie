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
  packageTestFiles,
  packageTestRoots,
  resolvePackageEntry,
} from '../../lib/test-packages.mjs';

test('PACKAGE_DIRECTIVES covers package dirs, owned and retired source dirs, and routed test roots', () => {
  const expected = [
    'extension', 'analysis', 'scripts', 'lib',
    'cwd-skills', 'safeguard', 'skill-pruner', 'model-provider-authentication', 'model-provider-concurrency', 'model-provider-pricing', 'model-provider-traffic-observation', 'agent-processes-coordinator', 'session-control', 'tool-catalog', 'subagent', 'ask-user',
    'warm-bash', 'copilot-model-discovery', 'web-access-guard', 'tool-result-pruner',
    'deferred-triggers', 'session-changes', 'computer-use',
    'model-provider-request-validation', 'playwright',
    'session-storage-transcripts', 'session-storage-settings', 'agent-processes-context-inventory', 'agent-processes-process-lifecycle', 'agent-processes-rpc', 'agent-processes-workers',
    'agent-processes-sdk-integration', 'model-provider-catalog', 'session-storage-lifecycle', 'session-storage-catalog',
    'session-storage-ownership', 'session-storage-metadata', 'analytics-runtime', 'conversation-state', 'session-actions', 'agent-connection', 'deferred-triggers-backend', 'application-settings', 'file-changes', 'transcript-delivery', 'application-validation', 'cold-browse-helper',
  ];
  assert.deepEqual(ALL_PACKAGE_IDS, expected);
  // The classification view covers package/source owners, nested/distributed
  // test roots, retired source identities, and exact root-integration files.
  assert.equal(PACKAGE_DIRECTIVES.length, 203, 'routing view covers dirs, owned dirs, test roots, and explicit test files');
});

test('source/test root defaults keep single-root enumeration identical', () => {
  for (const entry of PACKAGE_REGISTRY) {
    if (entry.sourceRoots) continue;
    assert.deepEqual(packageSourceRoots(entry), [entry.dir, ...(entry.ownedDirs ?? []), ...(entry.retiredSourceDirs ?? [])], `${entry.id} default source roots`);
    assert.deepEqual(packageTestRoots(entry), [entry.testDir ?? `${entry.dir}/test`, ...(entry.testRoots ?? [])], `${entry.id} test roots`);
  }
  // The scripts package routes grouped sources and all its test roots once.
  const scripts = resolvePackageEntry('scripts');
  assert.deepEqual(packageSourceRoots(scripts), ['scripts']);
  assert.deepEqual(packageTestRoots(scripts), ['scripts/test', ...scripts.testRoots]);
});

test('analysis owns the relocated workspace and keeps the retired source path routable', () => {
  const analysis = resolvePackageEntry('analysis');
  assert.deepEqual(packageSourceRoots(analysis), ['analytics/analysis', 'analysis']);
  assert.deepEqual(packageTestRoots(analysis), ['analytics/analysis/test']);
  // The retired path still routes changed/deleted files to the same verification id.
  assert.equal(classifyFileToPackage('analysis/test/pricing.test.ts'), 'analysis');
  assert.equal(classifyFileToPackage('analytics/analysis/test/pricing.test.ts'), 'analysis');
  assert.equal(classifyFileToPackage('analytics/analysis/scripts/build-db.ts'), 'analysis');
  assert.equal(classifyFileToPackage('analytics/analysis/README.md'), 'analysis');
  // Shared root integration suites route by exact file to their distinct owners.
  assert.equal(classifyFileToPackage('test/integration/dynamic-tool-activation.test.ts'), 'skill-pruner');
  assert.equal(classifyFileToPackage('test/integration/tool-catalog.test.ts'), 'tool-catalog');
  assert.equal(classifyFileToPackage('test/integration/backend-model-profiles.test.ts'), 'model-provider-catalog');
  assert.equal(classifyFileToPackage('test/integration/backend-cold-session-browse.test.ts'), 'session-storage-transcripts');
  assert.equal(classifyFileToPackage('test/integration/backend-session-directory.test.ts'), 'session-storage-catalog');
  assert.equal(classifyFileToPackage('test/integration/session-runtime-crash-matrix.test.ts'), 'session-storage-ownership');
  assert.equal(classifyFileToPackage('test/integration/example.test.ts'), null);
  assert.equal(classifyFileToPackage('analytics/other/file.ts'), null);
});

test('B3 authored-resource relocations route to their verification owners', () => {
  // The prompt-assembly root is verified with the extension package; agent
  // discovery routes with the subagent tool; skill discovery with cwd-skills.
  assert.equal(classifyFileToPackage('harness/agent-instructions/prompt-assembly/system-prompts.ts'), 'extension');
  assert.equal(classifyFileToPackage('harness/agent-instructions/prompt-assembly/pie-harness-prompt.ts'), 'extension');
  assert.equal(classifyFileToPackage('harness/agent-instructions/agent-discovery/agents.ts'), 'subagent');
  assert.equal(classifyFileToPackage('harness/agent-instructions/skill-discovery/index.ts'), 'cwd-skills');
  assert.equal(classifyFileToPackage('harness/agent-instructions/skill-discovery/test/cwd-skills-extension.test.ts'), 'cwd-skills');
  // The stable root discovery adapter keeps its package identity.
  assert.equal(classifyFileToPackage('extensions/cwd-skills/index.ts'), 'cwd-skills');
});

test('routed test roots classify focused test files to their verification id', () => {
  // classification only (no fs); existence is checked by groupFilesByPackage.
  for (const entry of PACKAGE_REGISTRY) {
    for (const testRoot of packageTestRoots(entry)) {
      const probe = `${testRoot}/sample.test.ts`;
      assert.equal(classifyFileToPackage(probe), entry.id, `${probe} must route to ${entry.id}`);
    }
    for (const testFile of packageTestFiles(entry)) {
      assert.equal(classifyFileToPackage(testFile), entry.id, `${testFile} must route to ${entry.id}`);
    }
  }
});

test('B5 settings test targets route to their implementation owners', () => {
  assert.equal(classifyFileToPackage('application/lib/protocol/test/tool-result-pruning-settings-merge.test.ts'), 'extension');
  assert.equal(classifyFileToPackage('application/lib/protocol/test/pruning-settings-merge.test.ts'), 'extension');
  assert.equal(classifyFileToPackage('application/lib/protocol/test/settings-subagent-buckets.test.ts'), 'extension');
  assert.equal(classifyFileToPackage('application/lib/validation/test/session-titles-protocol.test.ts'), 'application-validation');
  assert.equal(classifyFileToPackage('test/integration/history-compaction-settings.test.ts'), 'session-storage-settings');
});

test('classifyFileToPackage maps a file under each package directory to its id', () => {
  assert.equal(classifyFileToPackage('extension/test/webview/components/app-smoke.test.ts'), 'extension');
  assert.equal(classifyFileToPackage('extension/src/backend/sdk.ts'), 'extension');
  assert.equal(classifyFileToPackage('application/lib/protocol/thinking-level.ts'), 'extension');
  assert.equal(classifyFileToPackage('application/frontend/composer/image-constraints.ts'), 'extension');
  assert.equal(classifyFileToPackage('application/frontend/composer/test/local-message-id.test.ts'), 'extension');
  assert.equal(classifyFileToPackage('application/hosts/standalone/startup/test/start-pie-launcher.test.mjs'), 'extension');
  assert.equal(classifyFileToPackage('application/backend/agent-connection/test/request-tracker.test.ts'), 'agent-connection');
  assert.equal(classifyFileToPackage('application/backend/analytics-views/test/token-rate.test.ts'), 'analytics-runtime');
  assert.equal(classifyFileToPackage('application/backend/settings/test/settings-json-update.test.ts'), 'application-settings');
  assert.equal(classifyFileToPackage('test/integration/browser/ui-smoke.pw.ts'), 'extension');
  assert.equal(classifyFileToPackage('test/integration/large-detail.e2e.ts'), 'extension');
  assert.equal(classifyFileToPackage('harness/agent-processes/lib/rpc/test/worker-client-args.test.ts'), 'agent-processes-rpc');
  assert.equal(classifyFileToPackage('test/integration/backend-expected-cancellation-log.test.ts'), 'agent-processes-coordinator');
  assert.equal(classifyFileToPackage('test/integration/real-sdk-image-persistence.test.ts'), 'session-storage-transcripts');
  assert.equal(classifyFileToPackage('test/integration/sdk-terminal-durability.test.ts'), 'session-storage-transcripts');
  assert.equal(classifyFileToPackage('analytics/analysis/test/pricing.test.ts'), 'analysis');
  assert.equal(classifyFileToPackage('analytics/analysis/scripts/build-db.ts'), 'analysis');
  assert.equal(classifyFileToPackage('scripts/verification/test/run-tests.test.mjs'), 'scripts');
  assert.equal(classifyFileToPackage('harness/tools/subagent/test/schema.test.ts'), 'subagent');
  assert.equal(classifyFileToPackage('tools/subagent/test/schema.test.ts'), 'subagent');
  assert.equal(classifyFileToPackage('extensions/subagent/index.ts'), 'subagent');
  assert.equal(classifyFileToPackage('harness/tools/ask-user/test/loader-shim.test.ts'), 'ask-user');
  assert.equal(classifyFileToPackage('harness/tools/ask-user/tsconfig.json'), 'ask-user');
  assert.equal(classifyFileToPackage('tools/ask-user/test/loader-shim.test.ts'), 'ask-user');
  assert.equal(classifyFileToPackage('tools/subagent/schema.ts'), 'subagent');
  assert.equal(classifyFileToPackage('tools/request-capability/index.ts'), 'skill-pruner');
  assert.equal(classifyFileToPackage('harness/tools/request-capability/index.ts'), 'skill-pruner');
  assert.equal(classifyFileToPackage('harness/tools/session-control/index.ts'), 'session-control');
  assert.equal(classifyFileToPackage('harness/tools/catalog/index.ts'), 'tool-catalog');
  assert.equal(classifyFileToPackage('harness/model-providers/authentication/copilot-headers.ts'), 'model-provider-authentication');
  assert.equal(classifyFileToPackage('harness/model-providers/authentication/test/copilot-headers.test.ts'), 'model-provider-authentication');
  assert.equal(classifyFileToPackage('harness/model-providers/concurrency/test/provider-gate.test.ts'), 'model-provider-concurrency');
  assert.equal(classifyFileToPackage('harness/model-providers/pricing/test/pricing.test.ts'), 'model-provider-pricing');
  assert.equal(classifyFileToPackage('harness/model-providers/traffic-observation/test/provider-incident.test.ts'), 'model-provider-traffic-observation');
  assert.equal(classifyFileToPackage('harness/model-providers/request-validation/test/model-input-kinds.test.ts'), 'model-provider-request-validation');
  assert.equal(classifyFileToPackage('harness/model-providers/retry-and-failover/subagent-provider-policy.ts'), 'agent-processes-coordinator');
  assert.equal(classifyFileToPackage('harness/agent-processes/coordinator/test/subagent-provider-policy.test.ts'), 'agent-processes-coordinator');
  assert.equal(classifyFileToPackage('harness/tools/package-integrations/web-access/index.ts'), 'web-access-guard');
  assert.equal(classifyFileToPackage('extensions/web-access-guard/index.ts'), 'web-access-guard');
  assert.equal(classifyFileToPackage('harness/tool-and-skill-selection/lifecycle/register.ts'), 'skill-pruner');
  assert.equal(classifyFileToPackage('harness/tool-and-skill-selection/state/pruned-skills.ts'), 'skill-pruner');
  assert.equal(classifyFileToPackage('extensions/skill-pruner/index.ts'), 'skill-pruner');
  assert.equal(classifyFileToPackage('test/integration/dynamic-tool-activation.test.ts'), 'skill-pruner');
  assert.equal(classifyFileToPackage('extensions/cwd-skills/index.ts'), 'cwd-skills');
  assert.equal(classifyFileToPackage('extensions/copilot-model-discovery/index.ts'), 'copilot-model-discovery');
  assert.equal(classifyFileToPackage('harness/model-providers/model-discovery/copilot-models.ts'), 'copilot-model-discovery');
  assert.equal(classifyFileToPackage('harness/model-providers/model-discovery/test/copilot-models.test.ts'), 'copilot-model-discovery');
  assert.equal(classifyFileToPackage('tools/session-changes/test/render.test.ts'), 'session-changes');
  assert.equal(classifyFileToPackage('harness/tools/session-changes/test/render.test.ts'), 'session-changes');
  assert.equal(classifyFileToPackage('tools/deferred-triggers/test/store.test.ts'), 'deferred-triggers');
  assert.equal(classifyFileToPackage('harness/tools/deferred-triggers/test/store.test.ts'), 'deferred-triggers');
  assert.equal(classifyFileToPackage('harness/tools/result-processing/test/rules.test.ts'), 'tool-result-pruner');
  assert.equal(classifyFileToPackage('extensions/tool-result-pruner/index.ts'), 'tool-result-pruner');
  assert.equal(classifyFileToPackage('harness/tools/execution-safety/test/safeguard-extension.test.ts'), 'safeguard');
  assert.equal(classifyFileToPackage('extensions/safeguard/index.ts'), 'safeguard');
  assert.equal(classifyFileToPackage('harness/tools/execution-safety/traversal-policy.ts'), 'safeguard');
  assert.equal(classifyFileToPackage('harness/tools/computer-use/test/schema.test.ts'), 'computer-use');
  assert.equal(classifyFileToPackage('tools/computer-use/test/schema.test.ts'), 'computer-use');
  assert.equal(classifyFileToPackage('harness/tools/warm-bash/test/classifier.test.ts'), 'warm-bash');
  assert.equal(classifyFileToPackage('tools/warm-bash/test/classifier.test.ts'), 'warm-bash');
  assert.equal(classifyFileToPackage('harness/tools/playwright/test/schema.test.ts'), 'playwright');
  assert.equal(classifyFileToPackage('tools/playwright/test/schema.test.ts'), 'playwright');
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
  assert.equal(classifyFileToPackage('harness/tools/ask-user/test/x.test.ts'), 'ask-user');
  assert.notEqual(classifyFileToPackage('harness/tools/ask-user/test/x.test.ts'), 'extension');
});

test('classifyFileToPackage returns null for non-package paths', () => {
  assert.equal(classifyFileToPackage('README.md'), null);
  assert.equal(classifyFileToPackage('docs/contracts/STATE_CONTRACT.md'), null);
  assert.equal(classifyFileToPackage('settings.json'), null);
  assert.equal(classifyFileToPackage('models.yaml'), null);
  assert.equal(classifyFileToPackage('scripts/verification/run-tests.mjs'), 'scripts');
  assert.equal(classifyFileToPackage('shared/pricing-core.ts'), null);
  assert.equal(classifyFileToPackage(''), null);
  assert.equal(classifyFileToPackage(/** @type {unknown} */ (undefined)), null);
});

test('isGlobalTestInfra recognises the test tooling and root config', () => {
  // exact paths
  for (const p of [
    'scripts/verification/run-tests.mjs',
    'scripts/verification/run-test-files.mjs',
    'scripts/verification/run-affected-tests.mjs',
    'scripts/verification/run-fast-extension-tests.mjs',
    'scripts/verification/run-fast-batched-tests.mjs',
    'scripts/verification/test-reporter.mjs',
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
  assert.equal(isGlobalTestInfra('application/hosts/vscode/package.json'), false);
  assert.equal(isGlobalTestInfra('extension/src/backend/tsconfig.json'), false);
  assert.equal(isGlobalTestInfra('tools/subagent/tsconfig.json'), false);
  assert.equal(isGlobalTestInfra('extensions/subagent/index.ts'), false);
  assert.equal(isGlobalTestInfra('tools/request-capability/index.ts'), false);
  assert.equal(isGlobalTestInfra('analysis/package-lock.json'), false);
  assert.equal(isGlobalTestInfra('analytics/analysis/package-lock.json'), false);
  assert.equal(isGlobalTestInfra('scripts/verification/test/run-test-files.test.mjs'), false);
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
    'harness/tools/subagent/test/schema.test.ts',
    'harness/tools/ask-user/test/loader-shim.test.ts',
    'analytics/analysis/test/pricing.test.ts',
    'scripts/verification/test/run-tests.test.mjs',
  ]);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, ['analysis', 'ask-user', 'extension', 'scripts', 'subagent']);
  assert.deepEqual(plan.unowned, []);
});

test('mapFilesToPackages assigns moved and externally owned sources to their test packages', () => {
  const plan = mapFilesToPackages([
    'extensions/subagent/index.ts',
    'tools/request-capability/index.ts',
    'harness/tools/session-control/index.ts',
    'test/integration/tool-catalog.test.ts',
  ]);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, ['session-control', 'skill-pruner', 'subagent', 'tool-catalog']);
  assert.deepEqual(plan.unowned, []);
});

test('mapFilesToPackages covers root maintenance scripts', () => {
  const plan = mapFilesToPackages([
    'scripts/verification/run-typechecks.mjs',
    'scripts/model-config/sync-models.mjs',
    'scripts/install/install-dependencies.mjs',
  ]);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, ['scripts']);
  assert.deepEqual(plan.unowned, []);
});

test('mapFilesToPackages selects ALL when any global infra file changes', () => {
  const plan = mapFilesToPackages([
    'extension/test/a.test.ts',
    'scripts/verification/run-tests.mjs', // global => select all
    'harness/tools/subagent/test/schema.test.ts',
  ]);
  assert.equal(plan.selectAll, true);
  assert.deepEqual(plan.unowned, []);
});

test('mapFilesToPackages broadens unknown-ownership code files instead of selecting zero tests', () => {
  // A code file under no registered root (created, moved, or a future
  // distributed root that was never declared) must broaden, never select zero.
  for (const file of [
    'harness/some-new-owner/slice.ts',
    'application/backend/future-owner/slice.ts',
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
  assert.equal(isUnownedCodeSource('docs/contracts/STATE_CONTRACT.md'), false);
  assert.equal(isUnownedCodeSource('settings.json'), false);
  assert.equal(isUnownedCodeSource('models.yaml'), false);
  assert.equal(isUnownedCodeSource(''), false);
  assert.equal(isUnownedCodeSource(undefined), false);
  // global infra and scripts-package files are owned, not unknown
  assert.equal(isUnownedCodeSource('scripts/lib/test-packages.mjs'), false);
  assert.equal(isUnownedCodeSource('scripts/verification/run-typechecks.mjs'), false);
  assert.equal(isUnownedCodeSource('shared/pricing-core.ts'), false);
  assert.equal(isUnownedCodeSource('extension/src/backend/sdk.ts'), false);
});

test('mapFilesToPackages ignores unrelated files', () => {
  const plan = mapFilesToPackages([
    'README.md',
    'docs/contracts/STATE_CONTRACT.md',
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
