// Focused unit tests for scripts/verification/run-test-files.mjs — the pure classification,
// grouping, arg-building, and tsx-resolution helpers (main() spawns tsx and is
// exercised separately by hand).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inferRepoRoot,
  resolveLocalTsx,
  normalizeRepoRelative,
  classifyTestFile,
  groupFilesByPackage,
  buildTsxArgs,
  parseArgs,
} from '../run-test-files.mjs';

const repoRoot = inferRepoRoot();
const expectedRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fwd = (p) => p.replace(/\\/g, '/');

test('inferRepoRoot resolves to the pie repo root', () => {
  assert.equal(fwd(inferRepoRoot()), fwd(expectedRepoRoot));
  assert.ok(fs.existsSync(path.join(repoRoot, 'package.json')));
});

test('resolveLocalTsx finds the package-local tsx cli for each cwd', () => {
  // The host owns extension test dependencies; analytics/analysis ships its own tsx, extensions/* use root.
  assert.match(fwd(resolveLocalTsx(path.join(repoRoot, 'application', 'hosts', 'vscode'))), /application\/hosts\/vscode\/node_modules\/tsx\/dist\/cli\.mjs$/);
  assert.match(fwd(resolveLocalTsx(path.join(repoRoot, 'analytics/analysis'))), /analytics\/analysis\/node_modules\/tsx\/dist\/cli\.mjs$/);
  assert.match(fwd(resolveLocalTsx(repoRoot)), /(^|\/)node_modules\/tsx\/dist\/cli\.mjs$/);
});

test('resolveLocalTsx walks up to find root tsx from nested repo dirs', () => {
  // docs/ is not a package cwd, but walking up reaches the repo-root tsx.
  assert.match(fwd(resolveLocalTsx(path.join(repoRoot, 'docs'))), /(^|\/)node_modules\/tsx\/dist\/cli\.mjs$/);
});

test('resolveLocalTsx throws when no tsx exists above the start dir', () => {
  // The OS temp dir is outside the repo and has no node_modules/tsx above it.
  const tsxLess = path.join(os.tmpdir(), 'pie-resolve-tsx-throw-test');
  assert.throws(() => resolveLocalTsx(tsxLess), /Could not find a local tsx/);
});

test('normalizeRepoRelative converts absolute and relative inputs to repo-relative forward slashes', () => {
  const rel = normalizeRepoRelative(repoRoot, 'extension/test/webview/components/app-smoke.test.ts');
  assert.equal(rel.repoRel, 'extension/test/webview/components/app-smoke.test.ts');
  assert.ok(path.isAbsolute(rel.abs));

  const abs = normalizeRepoRelative(repoRoot, path.join(repoRoot, 'analytics/analysis', 'test', 'pricing.test.ts'));
  assert.equal(abs.repoRel, 'analytics/analysis/test/pricing.test.ts');
});

test('normalizeRepoRelative rejects paths outside the repo', () => {
  assert.throws(() => normalizeRepoRelative(repoRoot, '../outside-file.ts'), /outside the repo/);
});

test('classifyTestFile uses the registered root tsx for extension files with cross-owner ESM imports', () => {
  const d = classifyTestFile(repoRoot, 'application/frontend/test/components/app-smoke.test.ts');
  assert.equal(d.id, 'extension');
  assert.equal(fwd(d.cwd), fwd(path.join(repoRoot, 'extension')));
  assert.equal(d.tsxConfig, 'application/hosts/vscode/tsconfig.json');
  assert.equal(d.includeOwnerDependencies, true);
  assert.equal(d.repoRel, 'application/frontend/test/components/app-smoke.test.ts');
  assert.equal(d.relativeFilePath, '../application/frontend/test/components/app-smoke.test.ts');
  assert.match(fwd(d.tsxBin), /(^|\/)node_modules\/tsx\/dist\/cli\.mjs$/);
  const promptTest = classifyTestFile(repoRoot, 'harness/agent-instructions/prompt-assembly/test/backend-system-prompts.test.ts');
  assert.equal(promptTest.id, 'extension');
  assert.match(fwd(promptTest.tsxBin), /(^|\/)node_modules\/tsx\/dist\/cli\.mjs$/);
});

test('classifyTestFile routes application host composition tests through analytics owner dependencies', () => {
  const d = classifyTestFile(repoRoot, 'application/backend/test/composition/host-runtime.test.ts');
  assert.equal(d.id, 'analytics-runtime');
  assert.equal(d.includeOwnerDependencies, true);
  assert.equal(d.tsxConfig, 'application/hosts/vscode/tsconfig.json');
});

test('classifyTestFile classifies the retained analytics workspace (cwd=analytics/analysis/)', () => {
  const d = classifyTestFile(repoRoot, 'analytics/analysis/test/pricing.test.ts');
  assert.equal(d.id, 'analysis');
  assert.equal(fwd(d.cwd), fwd(path.join(repoRoot, 'analytics/analysis')));
  assert.equal(d.relativeFilePath, 'test/pricing.test.ts');
  assert.match(fwd(d.tsxBin), /analytics\/analysis\/node_modules\/tsx\/dist\/cli\.mjs$/);
});

test('classifyTestFile keeps script tests repo-rooted like the scripts package gate', () => {
  const d = classifyTestFile(repoRoot, 'scripts/verification/test/run-test-files.test.mjs');
  assert.equal(d.id, 'scripts');
  assert.equal(fwd(d.cwd), fwd(repoRoot));
  assert.equal(d.relativeFilePath, 'scripts/verification/test/run-test-files.test.mjs');
  assert.match(fwd(d.tsxBin), /(^|\/)node_modules\/tsx\/dist\/cli\.mjs$/);
});

test('classifyTestFile routes both subagent owner and agent-discovery tests with the owner tsconfig', () => {
  const d = classifyTestFile(repoRoot, 'harness/tools/subagent/test/schema.test.ts');
  assert.equal(d.id, 'subagent');
  assert.equal(fwd(d.cwd), fwd(repoRoot));
  assert.equal(d.tsxConfig, 'harness/tools/subagent/tsconfig.json');
  assert.equal(d.relativeFilePath, 'harness/tools/subagent/test/schema.test.ts');
  const discovery = classifyTestFile(repoRoot, 'harness/agent-instructions/agent-discovery/test/agents.test.ts');
  assert.equal(discovery.id, 'subagent');
  assert.equal(discovery.tsxConfig, 'harness/tools/subagent/tsconfig.json');
  assert.equal(discovery.relativeFilePath, 'harness/agent-instructions/agent-discovery/test/agents.test.ts');
  // harness/* packages resolve the root tsx
  assert.match(fwd(d.tsxBin), /(^|\/)node_modules\/tsx\/dist\/cli\.mjs$/);
  assert.doesNotMatch(fwd(d.tsxBin), /harness\/tools\/subagent/);
});

test('classifyTestFile routes selector owner and root integration tests to skill-pruner', () => {
  const selector = classifyTestFile(repoRoot, 'harness/tool-and-skill-selection/prepass/test/llm-scorer.test.ts');
  assert.equal(selector.id, 'skill-pruner');
  assert.equal(selector.tsxConfig, undefined);
  assert.equal(selector.relativeFilePath, 'harness/tool-and-skill-selection/prepass/test/llm-scorer.test.ts');
  const integration = classifyTestFile(repoRoot, 'test/integration/dynamic-tool-activation.test.ts');
  assert.equal(integration.id, 'skill-pruner');
  assert.equal(integration.tsxConfig, undefined);
  assert.equal(integration.relativeFilePath, 'test/integration/dynamic-tool-activation.test.ts');
  const retained = classifyTestFile(repoRoot, 'extensions/skill-pruner/test/copilot-headers.test.ts');
  assert.equal(retained.id, 'skill-pruner');
});

test('classifyTestFile applies package-specific tsconfig and leaves ordinary extensions unconfigured', () => {
  const playwright = classifyTestFile(repoRoot, 'harness/tools/playwright/test/schema.test.ts');
  assert.equal(playwright.id, 'playwright');
  assert.equal(playwright.tsxConfig, 'harness/tools/playwright/tsconfig.runtime.json');
  const computerUse = classifyTestFile(repoRoot, 'harness/tools/computer-use/test/protocol.test.ts');
  assert.equal(computerUse.id, 'computer-use');
  assert.equal(computerUse.tsxConfig, 'harness/tools/computer-use/tsconfig.runtime.json');
  const ordinary = classifyTestFile(repoRoot, 'harness/agent-instructions/skill-discovery/test/cwd-skills-extension.test.ts');
  assert.equal(ordinary.id, 'cwd-skills');
  assert.equal(ordinary.tsxConfig, undefined);
});

test('classifyTestFile throws for unclassifiable paths', () => {
  for (const bad of ['README.md', 'docs/x.md', 'other-root/run-tests.mjs', 'settings.json']) {
    assert.throws(() => classifyTestFile(repoRoot, bad), /Cannot classify/);
  }
});

test('groupFilesByPackage groups real files by package (sorted) and sets subagent tsxConfig', () => {
  const groups = groupFilesByPackage(repoRoot, [
    'application/frontend/test/components/app-smoke.test.ts',
    'application/backend/test/composition/host-runtime.test.ts',
    'harness/tool-and-skill-selection/test/integration.test.ts',
    'test/integration/dynamic-tool-activation.test.ts',
    'harness/tools/subagent/test/schema.test.ts',
    'harness/agent-instructions/agent-discovery/test/agents.test.ts',
    'analytics/analysis/test/pricing.test.ts',
  ]);
  assert.deepEqual(groups.map((g) => g.id), ['analysis', 'analytics-runtime', 'extension', 'skill-pruner', 'subagent']);
  const analytics = groups.find((g) => g.id === 'analytics-runtime');
  assert.equal(analytics.includeOwnerDependencies, true);
  assert.equal(analytics.tsxConfig, 'application/hosts/vscode/tsconfig.json');
  assert.deepEqual(analytics.files, ['application/backend/test/composition/host-runtime.test.ts']);
  const selector = groups.find((g) => g.id === 'skill-pruner');
  assert.equal(selector.tsxConfig, undefined);
  assert.deepEqual(selector.files, [
    'harness/tool-and-skill-selection/test/integration.test.ts',
    'test/integration/dynamic-tool-activation.test.ts',
  ]);
  const subagent = groups.find((g) => g.id === 'subagent');
  assert.equal(subagent.tsxConfig, 'harness/tools/subagent/tsconfig.json');
  assert.deepEqual(subagent.files, [
    'harness/tools/subagent/test/schema.test.ts',
    'harness/agent-instructions/agent-discovery/test/agents.test.ts',
  ]);
  const ext = groups.find((g) => g.id === 'extension');
  assert.equal(ext.tsxConfig, 'application/hosts/vscode/tsconfig.json');
  assert.equal(ext.includeOwnerDependencies, true);
  assert.deepEqual(ext.files, ['../application/frontend/test/components/app-smoke.test.ts']);
});

test('groupFilesByPackage retains repo-relative script paths for execution', () => {
  const groups = groupFilesByPackage(repoRoot, ['scripts/verification/test/run-test-files.test.mjs']);
  assert.deepEqual(groups, [{
    id: 'scripts',
    cwd: repoRoot,
    tsxConfig: undefined,
    tsxBin: resolveLocalTsx(repoRoot),
    files: ['scripts/verification/test/run-test-files.test.mjs'],
  }]);
  assert.deepEqual(buildTsxArgs(groups[0]), [
    '--test',
    '--test-force-exit',
    'scripts/verification/test/run-test-files.test.mjs',
  ]);
});

test('groupFilesByPackage groups script tests under the scripts package', () => {
  const groups = groupFilesByPackage(repoRoot, [
    'scripts/verification/test/run-test-files.test.mjs',
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'scripts');
});

test('groupFilesByPackage de-duplicates repeated files', () => {
  const groups = groupFilesByPackage(repoRoot, [
    'application/frontend/test/components/app-smoke.test.ts',
    'application/frontend/test/components/app-smoke.test.ts',
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].files.length, 1);
});

test('groupFilesByPackage throws on a missing file', () => {
  assert.throws(
    () => groupFilesByPackage(repoRoot, ['extension/test/does-not-exist.test.ts']),
    /Test file not found/,
  );
});

test('groupFilesByPackage collects all classification errors before throwing', () => {
  assert.throws(
    () => groupFilesByPackage(repoRoot, ['README.md', 'docs/x.md']),
    /Cannot classify[\s\S]*Cannot classify/,
  );
});

test('buildTsxArgs is fast/no-coverage and prefixes --tsconfig before files', () => {
  assert.deepEqual(
    buildTsxArgs({ files: ['test/a.test.ts'] }),
    ['--test', '--test-force-exit', 'test/a.test.ts'],
  );
  assert.deepEqual(
    buildTsxArgs({
      tsxConfig: 'harness/tools/subagent/tsconfig.json',
      files: ['harness/tools/subagent/test/a.test.ts', 'harness/tools/subagent/test/b.test.ts'],
    }),
    [
      '--test',
      '--test-force-exit',
      '--tsconfig=harness/tools/subagent/tsconfig.json',
      'harness/tools/subagent/test/a.test.ts',
      'harness/tools/subagent/test/b.test.ts',
    ],
  );
  // no coverage flags ever
  assert.equal(buildTsxArgs({ files: ['x.test.ts'] }).some((a) => a.includes('coverage')), false);
  // no serialization flag => node:test parallelizes (fast)
  assert.equal(buildTsxArgs({ files: ['x.test.ts'] }).includes('--test-concurrency=1'), false);
});

test('parseArgs collects positional files and respects -- / --help', () => {
  assert.deepEqual(parseArgs(['a.test.ts', 'b.test.ts']), { files: ['a.test.ts', 'b.test.ts'], help: false });
  assert.deepEqual(parseArgs(['--help']), { files: [], help: true });
  assert.deepEqual(parseArgs(['-h']), { files: [], help: true });
  assert.deepEqual(parseArgs(['a.test.ts', '--', '--help', 'b.test.ts']), {
    files: ['a.test.ts', '--help', 'b.test.ts'],
    help: false,
  });
});
