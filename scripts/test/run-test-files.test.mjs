// Focused unit tests for scripts/run-test-files.mjs — the pure classification,
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
const expectedRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fwd = (p) => p.replace(/\\/g, '/');

test('inferRepoRoot resolves to the pie repo root', () => {
  assert.equal(fwd(inferRepoRoot()), fwd(expectedRepoRoot));
  assert.ok(fs.existsSync(path.join(repoRoot, 'package.json')));
});

test('resolveLocalTsx finds the package-local tsx cli for each cwd', () => {
  // extension and analysis ship their own tsx; extensions/* use the root one.
  assert.match(fwd(resolveLocalTsx(path.join(repoRoot, 'extension'))), /extension\/node_modules\/tsx\/dist\/cli\.mjs$/);
  assert.match(fwd(resolveLocalTsx(path.join(repoRoot, 'analysis'))), /analysis\/node_modules\/tsx\/dist\/cli\.mjs$/);
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

  const abs = normalizeRepoRelative(repoRoot, path.join(repoRoot, 'analysis', 'test', 'pricing.test.ts'));
  assert.equal(abs.repoRel, 'analysis/test/pricing.test.ts');
});

test('normalizeRepoRelative rejects paths outside the repo', () => {
  assert.throws(() => normalizeRepoRelative(repoRoot, '../outside-file.ts'), /outside the repo/);
});

test('classifyTestFile classifies extension files (cwd=extension/, no tsxConfig)', () => {
  const d = classifyTestFile(repoRoot, 'extension/test/webview/components/app-smoke.test.ts');
  assert.equal(d.id, 'extension');
  assert.equal(fwd(d.cwd), fwd(path.join(repoRoot, 'extension')));
  assert.equal(d.tsxConfig, undefined);
  assert.equal(d.repoRel, 'extension/test/webview/components/app-smoke.test.ts');
  assert.equal(d.relativeFilePath, 'test/webview/components/app-smoke.test.ts');
  assert.match(fwd(d.tsxBin), /extension\/node_modules\/tsx\/dist\/cli\.mjs$/);
});

test('classifyTestFile classifies analysis files (cwd=analysis/)', () => {
  const d = classifyTestFile(repoRoot, 'analysis/test/pricing.test.ts');
  assert.equal(d.id, 'analysis');
  assert.equal(fwd(d.cwd), fwd(path.join(repoRoot, 'analysis')));
  assert.equal(d.relativeFilePath, 'test/pricing.test.ts');
  assert.match(fwd(d.tsxBin), /analysis\/node_modules\/tsx\/dist\/cli\.mjs$/);
});

test('classifyTestFile keeps script tests repo-rooted like the scripts package gate', () => {
  const d = classifyTestFile(repoRoot, 'scripts/test/run-test-files.test.mjs');
  assert.equal(d.id, 'scripts');
  assert.equal(fwd(d.cwd), fwd(repoRoot));
  assert.equal(d.relativeFilePath, 'scripts/test/run-test-files.test.mjs');
  assert.match(fwd(d.tsxBin), /(^|\/)node_modules\/tsx\/dist\/cli\.mjs$/);
});

test('classifyTestFile classifies extensions/* files (cwd=repoRoot) and sets the subagent --tsconfig', () => {
  const d = classifyTestFile(repoRoot, 'extensions/subagent/test/agents.test.ts');
  assert.equal(d.id, 'subagent');
  assert.equal(fwd(d.cwd), fwd(repoRoot));
  assert.equal(d.tsxConfig, 'extensions/subagent/tsconfig.json');
  assert.equal(d.relativeFilePath, 'extensions/subagent/test/agents.test.ts');
  // extensions/* resolve the root tsx
  assert.match(fwd(d.tsxBin), /(^|\/)node_modules\/tsx\/dist\/cli\.mjs$/);
  assert.doesNotMatch(fwd(d.tsxBin), /extensions\/subagent/);
});

test('classifyTestFile applies package-specific tsconfig and leaves ordinary extensions unconfigured', () => {
  const playwright = classifyTestFile(repoRoot, 'extensions/playwright/test/schema.test.ts');
  assert.equal(playwright.id, 'playwright');
  assert.equal(playwright.tsxConfig, 'extensions/playwright/tsconfig.runtime.json');
  const ordinary = classifyTestFile(repoRoot, 'extensions/cwd-skills/test/cwd-skills-extension.test.ts');
  assert.equal(ordinary.id, 'cwd-skills');
  assert.equal(ordinary.tsxConfig, undefined);
});

test('classifyTestFile throws for unclassifiable paths', () => {
  for (const bad of ['README.md', 'docs/x.md', 'scripts/run-tests.mjs', 'settings.json']) {
    assert.throws(() => classifyTestFile(repoRoot, bad), /Cannot classify/);
  }
});

test('groupFilesByPackage groups real files by package (sorted) and sets subagent tsxConfig', () => {
  const groups = groupFilesByPackage(repoRoot, [
    'extension/test/webview/components/app-smoke.test.ts',
    'extensions/subagent/test/agents.test.ts',
    'analysis/test/pricing.test.ts',
  ]);
  assert.deepEqual(groups.map((g) => g.id), ['analysis', 'extension', 'subagent']);
  const subagent = groups.find((g) => g.id === 'subagent');
  assert.equal(subagent.tsxConfig, 'extensions/subagent/tsconfig.json');
  assert.deepEqual(subagent.files, ['extensions/subagent/test/agents.test.ts']);
  const ext = groups.find((g) => g.id === 'extension');
  assert.equal(ext.tsxConfig, undefined);
  assert.deepEqual(ext.files, ['test/webview/components/app-smoke.test.ts']);
});

test('groupFilesByPackage retains repo-relative script paths for execution', () => {
  const groups = groupFilesByPackage(repoRoot, ['scripts/test/run-test-files.test.mjs']);
  assert.deepEqual(groups, [{
    id: 'scripts',
    cwd: repoRoot,
    tsxConfig: undefined,
    tsxBin: resolveLocalTsx(repoRoot),
    files: ['scripts/test/run-test-files.test.mjs'],
  }]);
  assert.deepEqual(buildTsxArgs(groups[0]), [
    '--test',
    '--test-force-exit',
    'scripts/test/run-test-files.test.mjs',
  ]);
});

test('groupFilesByPackage groups script tests under the scripts package', () => {
  const groups = groupFilesByPackage(repoRoot, [
    'scripts/test/run-test-files.test.mjs',
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'scripts');
});

test('groupFilesByPackage de-duplicates repeated files', () => {
  const groups = groupFilesByPackage(repoRoot, [
    'extension/test/webview/components/app-smoke.test.ts',
    'extension/test/webview/components/app-smoke.test.ts',
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
      tsxConfig: 'extensions/subagent/tsconfig.json',
      files: ['extensions/subagent/test/a.test.ts', 'extensions/subagent/test/b.test.ts'],
    }),
    [
      '--test',
      '--test-force-exit',
      '--tsconfig=extensions/subagent/tsconfig.json',
      'extensions/subagent/test/a.test.ts',
      'extensions/subagent/test/b.test.ts',
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
