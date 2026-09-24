import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import test from 'node:test';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createOwnerRequire } from '../lib/package-resolution.mjs';

import {
  classifyExtensionTest,
  createPreserveSourceUrls,
  recoverBundledFailureSourceFiles,
  withFastRunnerTempDirs,
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

test('classifyExtensionTest isolates the transitive process-owning worker fixture test', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const relativePath = 'test/backend/worker/worker-client-transport.test.ts';
  const source = readFileSync(path.join(repoRoot, 'extension', relativePath), 'utf8');
  assert.match(source, /WorkerClient/u);
  assert.doesNotMatch(source, /node:child_process/u);
  assert.equal(classifyExtensionTest(relativePath, source), 'tsx');
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
