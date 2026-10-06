// Focused unit tests for scripts/lib/test-packages.mjs — the shared file→package
// classification and global test-infrastructure detection used by both
// run-test-files.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGE_DIRECTIVES,
  ALL_PACKAGE_IDS,
  PACKAGE_REGISTRY,
  classifyFileToPackage,
  packageSdkIndependentTestFiles,
  packageSourceRoots,
  packageTestFiles,
  packageTestRoots,
  SDK_INDEPENDENT_TEST_FILES,
  isSdkIndependentTestFile,
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
  assert.equal(PACKAGE_DIRECTIVES.length, 209, 'routing view covers dirs, owned dirs, test roots, and explicit test files');
  for (const file of [
    'application/lib/composer/local-message-id.ts',
    'application/lib/session-tabs/tab-behavior.ts',
    'application/lib/transcript/message-parts.ts',
    'application/lib/platform-contracts/platform.ts',
    'application/lib/renderer-delivery/renderer-view-state.ts',
    'application/lib/test/renderer-delivery/renderer-view-state.test.ts',
    'application/lib/test/source-boundaries.test.ts',
  ]) assert.equal(classifyFileToPackage(file), 'extension', `${file} retains its compatibility owner`);
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

test('SDK-independent focused tests are an exact file allowlist owned by extension and scripts', () => {
  const expected = [
    'application/hosts/test/asset-manifests/bootstrap.test.ts',
    'application/hosts/test/asset-manifests/runtime-generations.test.ts',
    'application/hosts/test/asset-manifests/runtime-scan-concurrency.test.ts',
    'application/hosts/test/asset-manifests/runtime-copy-concurrency.test.ts',
  ];
  const scriptsExpected = [
    'scripts/lib/test/package-resolution.test.mjs',
    'scripts/lib/test/unbundled-owner-resolution.test.mjs',
    'scripts/install/test/source-pi-cli.test.mjs',
  ];
  assert.deepEqual(SDK_INDEPENDENT_TEST_FILES, [...expected, ...scriptsExpected]);
  assert.deepEqual(packageSdkIndependentTestFiles(resolvePackageEntry('extension')), expected);
  assert.deepEqual(packageSdkIndependentTestFiles(resolvePackageEntry('scripts')), scriptsExpected);
  assert.deepEqual(PACKAGE_REGISTRY.filter((entry) => packageSdkIndependentTestFiles(entry).length > 0).map((entry) => entry.id), ['extension', 'scripts']);
  for (const file of [...expected, ...scriptsExpected]) assert.equal(isSdkIndependentTestFile(file), true, file);
  for (const file of [
    'application/hosts/test/asset-manifests/other.test.ts',
    'application/hosts/other/asset-manifests/bootstrap.test.ts',
    'scripts/lib/test/other.test.mjs',
    'scripts/install/test/source-pi-cli.artifact.test.mjs',
  ]) assert.equal(isSdkIndependentTestFile(file), false, file);
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
  assert.equal(classifyFileToPackage('test/integration/dynamic-tool-activation.artifact.test.ts'), 'skill-pruner');
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
  assert.equal(classifyFileToPackage('test/integration/real-sdk-image-persistence.artifact.test.ts'), 'session-storage-transcripts');
  assert.equal(classifyFileToPackage('test/integration/sdk-terminal-durability.artifact.test.ts'), 'session-storage-transcripts');
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
  assert.equal(classifyFileToPackage('test/integration/dynamic-tool-activation.artifact.test.ts'), 'skill-pruner');
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

test('retired fast batching has no registry metadata and preserves source scopes', () => {
  for (const entry of PACKAGE_REGISTRY) {
    assert.equal(Object.hasOwn(entry, 'fastBatch'), false, `${entry.id} has no retired batch plan`);
  }
  for (const file of [
    'scripts/verification/run-fast-extension-tests.mjs',
    'scripts/verification/run-fast-batched-tests.mjs',
    'scripts/verification/update-extension-test-costs.mjs',
    'scripts/verification/test-costs-reporter.mjs',
    'scripts/verification/extension-test-costs.json',
  ]) {
    assert.equal(classifyFileToPackage(file), 'scripts', 'retirement preserves the scripts source scope');
  }
});
