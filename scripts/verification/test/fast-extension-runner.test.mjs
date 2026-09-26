import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import test from 'node:test';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createOwnerRequire } from '../../lib/package-resolution.mjs';
import { createTestFileExecutionCollector, normalizeTestFileIdentity, TEST_FILE_MARKER } from '../test-reporter.mjs';

import {
  bundledSuiteMarker,
  classifyExtensionTest,
  extensionBundleOutputPath,
  createPreserveSourceUrls,
  EXTENSION_TEST_ROOTS,
  recoverBundledFailureSourceFiles,
  resolveExtensionTestPath,
  withFastRunnerTempDirs,
} from '../run-fast-extension-tests.mjs';

test('classifyExtensionTest keeps child-process, Preact, DOM, and explicit isolation tests on tsx', () => {
  assert.equal(classifyExtensionTest('test/example.test.ts', "import 'node:child_process';"), 'tsx');
  assert.equal(classifyExtensionTest('test/preact.test.ts', "import { h } from 'preact';"), 'tsx');
  assert.equal(classifyExtensionTest('test/dom.test.ts', 'installDom();'), 'tsx');
  assert.equal(classifyExtensionTest('application/hosts/test/renderer-delivery.test.ts', "test('isolated', () => {});"), 'tsx');
  assert.equal(
    classifyExtensionTest('test/backend/runtime/extension-ui-bridge.test.ts', "import test from 'node:test';"),
    'tsx',
  );
});

test('fast extension discovery includes standalone host tests under the existing extension owner', () => {
  const relativeDir = 'application/hosts/standalone/test';
  const testFile = `${relativeDir}/standalone-host-coordinator.test.ts`;
  const root = EXTENSION_TEST_ROOTS.find((candidate) => candidate.relativeDir === relativeDir);
  const repoRoot = path.resolve(import.meta.dirname, '../../..');

  assert.deepEqual(root, { relativeDir, root: repoRoot });
  assert.equal(resolveExtensionTestPath(testFile), path.join(repoRoot, testFile));
  assert.equal(classifyExtensionTest(testFile, "test('standalone host', () => {});"), 'tsx');

  const launcherRoot = EXTENSION_TEST_ROOTS.find((candidate) => candidate.relativeDir === 'application/hosts/standalone/startup/test');
  const launcherTest = 'application/hosts/standalone/startup/test/start-pie-launcher.test.mjs';
  assert.deepEqual(launcherRoot, { relativeDir: 'application/hosts/standalone/startup/test', root: repoRoot });
  assert.equal(resolveExtensionTestPath(launcherTest), path.join(repoRoot, launcherTest));
  assert.equal(classifyExtensionTest(launcherTest, "test('launcher', () => {});"), 'tsx');
  assert.equal(
    resolveExtensionTestPath('repo/test/integration/backend-runtime-prefs.test.ts'),
    path.join(repoRoot, 'test', 'integration', 'backend-runtime-prefs.test.ts'),
  );
  assert.equal(
    resolveExtensionTestPath('harness/agent-instructions/prompt-assembly/test/context-files.test.ts'),
    path.join(repoRoot, 'harness', 'agent-instructions', 'prompt-assembly', 'test', 'context-files.test.ts'),
  );
});

test('bundled suite markers preserve canonical identity for relocated application tests', () => {
  const sourceFile = 'application/frontend/test/transcript/tools/ask-user-tool-render.test.ts';
  const repoRoot = path.resolve(import.meta.dirname, '../../..');

  assert.equal(bundledSuiteMarker(sourceFile), `${TEST_FILE_MARKER}${path.join(repoRoot, sourceFile)}`);
  assert.notEqual(
    bundledSuiteMarker(sourceFile),
    `${TEST_FILE_MARKER}${path.join(repoRoot, 'extension', sourceFile)}`,
  );
});

test('bundle output paths follow the repository outbase and preserve relocated markdown accounting', () => {
  const tempDir = path.join(os.tmpdir(), 'pie-extension-fast-output-fixture');
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const markdownSourceFile = path.join(repoRoot, 'application/frontend/test/transcript/messages/markdown-rendering.test.ts');
  const markdownBundleFile = extensionBundleOutputPath(tempDir, 'application/frontend/test/transcript/messages/markdown-rendering.test.ts');
  assert.equal(markdownBundleFile,
    path.join(tempDir, 'application/frontend/test/transcript/messages/markdown-rendering.test.js'));
  const accounting = createTestFileExecutionCollector({
    expectedFiles: [markdownSourceFile],
    directFiles: { [normalizeTestFileIdentity(markdownBundleFile)]: markdownSourceFile },
    ignoredFiles: [],
    intentionalReruns: [],
  });
  accounting.observe({ type: 'test:complete', data: {
    nesting: 0,
    name: markdownBundleFile,
    file: markdownBundleFile,
  } });
  assert.equal(accounting.report().success, true, 'the relocated markdown test is accounted for once');
  assert.equal(
    extensionBundleOutputPath(tempDir, 'test/backend/runtime/rpc.test.ts'),
    path.join(tempDir, 'extension/test/backend/runtime/rpc.test.js'),
  );
  assert.equal(
    extensionBundleOutputPath(tempDir, 'repo/test/integration/backend-runtime-prefs.test.ts'),
    path.join(tempDir, 'test/integration/backend-runtime-prefs.test.js'),
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

test('classifyExtensionTest keeps dynamic imports, persistent module hooks, and JSDOM worker tests isolated', () => {
  assert.equal(classifyExtensionTest('test/dynamic.test.ts', "await import('./fixture.js');"), 'bundle');
  assert.equal(classifyExtensionTest('test/hook.test.ts', 'Module.register(url);'), 'bundle');
  assert.equal(
    classifyExtensionTest('application/frontend/test/composer/composer-draft.test.ts', 'globalThis.document = dom.window.document;'),
    'bundle',
  );
  assert.equal(
    classifyExtensionTest('application/frontend/test/transcript/messages/markdown-rendering.test.ts', "import { JSDOM } from 'jsdom';"),
    'tsx',
  );
});

test('preserve-source-urls leaves dependency and generated template strings intact but preserves source URLs', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'pie-fast-url-fixture-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'repo');
  const sourcePath = path.join(root, 'src', 'entry.ts');
  const dependencyPath = path.join(root, 'node_modules', 'vite', 'chunk.js');
  const generatedPath = path.join(root, 'dist', 'chunk.js');
  const externalPath = path.join(fixture, 'external.js');
  const publicationPath = path.join(root, 'scripts', 'build', 'publication.mjs');
  await Promise.all([sourcePath, dependencyPath, generatedPath, publicationPath].map((file) => path.dirname(file)).map(
    (dir) => mkdir(dir, { recursive: true }),
  ));
  const viteSnippet = "import { createRequire } from 'module';const require = createRequire(import.meta.url);";
  await writeFile(dependencyPath, `export const snippet = { js: \`${viteSnippet}\` }.js;`);
  await writeFile(generatedPath, `export const generated = ${JSON.stringify(viteSnippet)};`);
  await writeFile(externalPath, `export const external = ${JSON.stringify(viteSnippet)};`);
  await writeFile(publicationPath, 'export const publicationUrl = import.meta.url;');
  await writeFile(sourcePath, `import { snippet } from '../node_modules/vite/chunk.js';\nimport { generated } from '../dist/chunk.js';\nimport { external } from '../../external.js';\nimport { publicationUrl } from '../scripts/build/publication.mjs';\nexport const result = [import.meta.url, snippet, generated, external, publicationUrl];`);
  const { build } = createOwnerRequire()('esbuild');
  const output = path.join(fixture, 'output.js');
  await build({
    entryPoints: [sourcePath], outfile: output, bundle: true, format: 'cjs', platform: 'node',
    plugins: [createPreserveSourceUrls(root)], logLevel: 'silent',
  });
  const compiled = await readFile(output, 'utf8');
  assert.match(compiled, /createRequire\(import\.meta\.url\)/u);
  assert.doesNotMatch(compiled, /createRequire\(file:/u);
  const { result } = createOwnerRequire({ dependencyOwnerRoot: root })(output);
  assert.deepEqual(result, [pathToFileURL(sourcePath).href, viteSnippet, viteSnippet, viteSnippet, pathToFileURL(publicationPath).href]);
});

test('fast runner removes OS temp directories when bundle build throws', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'pie-fast-cleanup-fixture-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const { build } = createOwnerRequire()('esbuild');
  await assert.rejects(withFastRunnerTempDirs(async (tempDir) => {
    await build({ entryPoints: [path.join(fixture, 'missing.ts')], outdir: tempDir, logLevel: 'silent' });
  }, fixture), /Could not resolve/u);
  assert.deepEqual(await readdir(fixture), []);
});

test('recoverBundledFailureSourceFiles restores source attribution for tests and batch wrappers', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const extensionRoot = path.join(repoRoot, 'extension');
  const tempDir = path.join(repoRoot, '.tmp-fast-extension-runner');
  const sourceFile = 'test/backend/sessions/cold-session-store.test.ts';
  const markdownSourceFile = 'application/frontend/test/transcript/messages/markdown-rendering.test.ts';
  const bundledFile = extensionBundleOutputPath(tempDir, sourceFile);
  const markdownBundleFile = extensionBundleOutputPath(tempDir, markdownSourceFile);
  const wrapperFile = path.join(tempDir, 'scoped-bundle-batch-1.mjs');
  const unrelatedFile = path.join(tempDir, 'scoped-bundle-batch-2.mjs');

  const recovered = recoverBundledFailureSourceFiles([
    { name: 'cold startup stays bounded', file: bundledFile },
    { name: bundledFile, file: wrapperFile },
    { name: 'markdown bundle failure', file: markdownBundleFile },
    { name: 'unrelated infrastructure failure', file: unrelatedFile },
  ], tempDir, [sourceFile, markdownSourceFile]);

  assert.equal(recovered[0].file, path.join(extensionRoot, sourceFile));
  assert.equal(recovered[1].file, path.join(extensionRoot, sourceFile));
  assert.equal(recovered[2].file, path.join(repoRoot, markdownSourceFile));
  assert.equal(recovered[3].file, unrelatedFile);
});
