import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBuildIdentityPlugin, createShippedRuntimeLockPlugin } from '../../../application/hosts/vscode/vite.config.ts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const packageResolutionHelper = path.join(repositoryRoot, 'scripts', 'lib', 'package-resolution.mjs');
const traversalPolicyHelper = path.join(repositoryRoot, 'scripts', 'lib', 'traversal-policy.mjs');
const nativeOwnerHelper = path.join(repositoryRoot, 'scripts', 'lib', 'native-owner.mjs');
const BUILD_ID_SENTINEL = '__PIE_COMPILED_BUILD_ID_REPLACE__';

type EmittedAsset = { type: string; fileName?: string; source?: string | Uint8Array };

function runIdentityPlugin(plugin: ReturnType<typeof createBuildIdentityPlugin>) {
  const watched: string[] = [];
  const emitted: EmittedAsset[] = [];

  const buildStart = plugin.buildStart;
  assert.equal(typeof buildStart, 'function');
  if (typeof buildStart !== 'function') throw new Error('buildStart hook is missing');
  buildStart.call({ addWatchFile: (input: string) => watched.push(input) } as never, {} as never);

  const renderChunk = plugin.renderChunk;
  assert.equal(typeof renderChunk, 'function');
  if (typeof renderChunk !== 'function') throw new Error('renderChunk hook is missing');
  const rendered = renderChunk.call(
    {} as never,
    `const buildId = ${JSON.stringify(BUILD_ID_SENTINEL)};`,
    {} as never,
    {} as never,
    {} as never,
  );
  if (!rendered || typeof rendered === 'string' || !('code' in rendered)) {
    throw new Error('renderChunk did not return transformed code');
  }

  const generateBundle = plugin.generateBundle;
  assert.equal(typeof generateBundle, 'function');
  if (typeof generateBundle !== 'function') throw new Error('generateBundle hook is missing');
  generateBundle.call(
    { emitFile: (asset: EmittedAsset) => emitted.push(asset) } as never,
    {} as never,
    {} as never,
    false,
  );

  const identityAsset = emitted.find((asset) => asset.fileName === 'pie-build-id.txt');
  assert.equal(typeof identityAsset?.source, 'string');
  const emittedId = String(identityAsset?.source).trim();
  assert.ok(rendered.code.includes(emittedId), 'runtime sentinel and emitted identity must agree');
  return { buildId: emittedId, watched };
}

test('build identity hashes and watches package resolution for both graphs', (t) => {
  const productionNode = runIdentityPlugin(createBuildIdentityPlugin());
  const productionWebview = runIdentityPlugin(createBuildIdentityPlugin());
  assert.ok(productionNode.watched.includes(packageResolutionHelper));
  assert.ok(productionWebview.watched.includes(packageResolutionHelper));
  const runtimeDeclaration = path.join(repositoryRoot, 'application', 'hosts', 'vscode', 'runtime', 'runtime-generations.d.cts');
  assert.ok(productionNode.watched.includes(runtimeDeclaration), 'the canonical runtime declaration must be hashed and watched');
  for (const retiredRoot of [path.join(repositoryRoot, 'extension', 'src'), path.join(repositoryRoot, 'shared')]) {
    assert.equal(
      productionNode.watched.some((input) => input === retiredRoot || input.startsWith(`${retiredRoot}${path.sep}`)),
      false,
      `${retiredRoot} is a retired source root and must not be scanned`,
    );
  }
  for (const input of [
    traversalPolicyHelper,
    nativeOwnerHelper,
    path.join(repositoryRoot, 'harness', 'tools', 'warm-bash', 'index.ts'),
    path.join(repositoryRoot, 'harness', 'tools', 'computer-use', 'runtime-client.ts'),
    path.join(repositoryRoot, 'harness', 'tools', 'playwright', 'sidecar.mjs'),
    path.join(repositoryRoot, 'harness', 'model-providers', 'model-discovery', 'catalog-sync.ts'),
    path.join(repositoryRoot, 'application', 'backend', 'conversation-state', 'reducer.ts'),
    path.join(repositoryRoot, 'application', 'hosts', 'vscode', 'completion-attention.ts'),
    path.join(repositoryRoot, 'application', 'lib', 'protocol', 'messages.ts'),
    path.join(repositoryRoot, 'lib', 'build-identity.ts'),
  ]) {
    assert.ok(productionNode.watched.includes(input), `${input} must be watched by the node graph`);
    assert.ok(productionWebview.watched.includes(input), `${input} must be watched by the webview graph`);
  }
  assert.equal(productionNode.buildId, productionWebview.buildId);

  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-build-identity-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const identityRoot = path.join(fixtureRoot, 'vscode');
  const helperFixture = path.join(fixtureRoot, 'scripts', 'lib', 'package-resolution.mjs');
  const toolFixture = path.join(identityRoot, 'harness', 'tools', 'fixture-tool.ts');
  const selectorFixture = path.join(identityRoot, 'harness', 'tool-and-skill-selection', 'fixture-selector.ts');
  const modelProviderFixture = path.join(identityRoot, 'harness', 'model-providers', 'fixture-provider.ts');
  const hostFixture = path.join(identityRoot, 'application', 'hosts', 'fixture-host.ts');
  const rootLibFixture = path.join(identityRoot, 'lib', 'fixture-fact.ts');
  const runtimeFixture = path.join(identityRoot, 'runtime', 'runtime-generations.d.cts');
  mkdirSync(path.dirname(helperFixture), { recursive: true });
  mkdirSync(path.dirname(toolFixture), { recursive: true });
  mkdirSync(path.dirname(selectorFixture), { recursive: true });
  mkdirSync(path.dirname(modelProviderFixture), { recursive: true });
  mkdirSync(path.dirname(hostFixture), { recursive: true });
  mkdirSync(path.dirname(rootLibFixture), { recursive: true });
  mkdirSync(path.dirname(runtimeFixture), { recursive: true });
  writeFileSync(helperFixture, 'export const resolution = "before";\n');
  writeFileSync(toolFixture, 'export const tool = "before";\n');
  writeFileSync(selectorFixture, 'export const selector = "before";\n');
  writeFileSync(modelProviderFixture, 'export const provider = "before";\n');
  writeFileSync(hostFixture, 'export const host = "before";\n');
  writeFileSync(rootLibFixture, 'export const fact = "before";\n');
  writeFileSync(runtimeFixture, 'export interface RuntimeGenerations {}\n');

  const node = createBuildIdentityPlugin(identityRoot);
  const webview = createBuildIdentityPlugin(identityRoot);
  const beforeNode = runIdentityPlugin(node);
  const beforeWebview = runIdentityPlugin(webview);
  assert.ok(beforeNode.watched.includes(helperFixture));
  assert.ok(beforeWebview.watched.includes(helperFixture));
  assert.ok(beforeNode.watched.includes(toolFixture));
  assert.ok(beforeWebview.watched.includes(toolFixture));
  assert.ok(beforeNode.watched.includes(selectorFixture));
  assert.ok(beforeWebview.watched.includes(selectorFixture));
  assert.ok(beforeNode.watched.includes(modelProviderFixture));
  assert.ok(beforeWebview.watched.includes(modelProviderFixture));
  assert.ok(beforeNode.watched.includes(hostFixture));
  assert.ok(beforeWebview.watched.includes(hostFixture));
  assert.ok(beforeNode.watched.includes(rootLibFixture));
  assert.ok(beforeWebview.watched.includes(rootLibFixture));
  assert.ok(beforeNode.watched.includes(runtimeFixture));
  assert.ok(beforeWebview.watched.includes(runtimeFixture));
  assert.equal(beforeNode.buildId, beforeWebview.buildId);

  writeFileSync(helperFixture, 'export const resolution = "after";\n');
  const afterNode = runIdentityPlugin(node);
  const afterWebview = runIdentityPlugin(webview);
  assert.notEqual(afterNode.buildId, beforeNode.buildId);
  assert.notEqual(afterWebview.buildId, beforeWebview.buildId);
  assert.equal(afterNode.buildId, afterWebview.buildId);

  writeFileSync(toolFixture, 'export const tool = "after";\n');
  const afterToolNode = runIdentityPlugin(node);
  const afterToolWebview = runIdentityPlugin(webview);
  assert.notEqual(afterToolNode.buildId, afterNode.buildId);
  assert.notEqual(afterToolWebview.buildId, afterWebview.buildId);
  assert.equal(afterToolNode.buildId, afterToolWebview.buildId);

  writeFileSync(selectorFixture, 'export const selector = "after";\n');
  const afterSelectorNode = runIdentityPlugin(node);
  const afterSelectorWebview = runIdentityPlugin(webview);
  assert.notEqual(afterSelectorNode.buildId, afterToolNode.buildId);
  assert.notEqual(afterSelectorWebview.buildId, afterToolWebview.buildId);
  assert.equal(afterSelectorNode.buildId, afterSelectorWebview.buildId);

  writeFileSync(modelProviderFixture, 'export const provider = "after";\n');
  const afterProviderNode = runIdentityPlugin(node);
  const afterProviderWebview = runIdentityPlugin(webview);
  assert.notEqual(afterProviderNode.buildId, afterSelectorNode.buildId);
  assert.notEqual(afterProviderWebview.buildId, afterSelectorWebview.buildId);
  assert.equal(afterProviderNode.buildId, afterProviderWebview.buildId);

  writeFileSync(hostFixture, 'export const host = "after";\n');
  const afterHostNode = runIdentityPlugin(node);
  const afterHostWebview = runIdentityPlugin(webview);
  assert.notEqual(afterHostNode.buildId, afterProviderNode.buildId);
  assert.notEqual(afterHostWebview.buildId, afterProviderWebview.buildId);
  assert.equal(afterHostNode.buildId, afterHostWebview.buildId);

  writeFileSync(rootLibFixture, 'export const fact = "after";\n');
  const afterRootLibNode = runIdentityPlugin(node);
  const afterRootLibWebview = runIdentityPlugin(webview);
  assert.notEqual(afterRootLibNode.buildId, afterHostNode.buildId);
  assert.notEqual(afterRootLibWebview.buildId, afterHostWebview.buildId);
  assert.equal(afterRootLibNode.buildId, afterRootLibWebview.buildId);

  writeFileSync(runtimeFixture, 'export interface RuntimeGenerations { generation: string }\n');
  const afterRuntimeNode = runIdentityPlugin(node);
  const afterRuntimeWebview = runIdentityPlugin(webview);
  assert.notEqual(afterRuntimeNode.buildId, afterRootLibNode.buildId);
  assert.notEqual(afterRuntimeWebview.buildId, afterRootLibWebview.buildId);
  assert.equal(afterRuntimeNode.buildId, afterRuntimeWebview.buildId);
});

test('analytics implementation changes coordinate identity and watches without scanning analytics data', (t) => {
  const identityRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-analytics-identity-'));
  t.after(() => rmSync(identityRoot, { recursive: true, force: true }));
  const implementationRoots = [
    'authority', 'capture', 'contracts', 'legacy', 'projections',
    'queries', 'recording', 'storage', 'usage-accounting',
  ];
  const included = implementationRoots.map((root) => path.join(identityRoot, 'analytics', root, 'fixture.ts'));
  const excluded = [
    ...['analysis', 'runtime', 'data'].map((root) => path.join(identityRoot, 'analytics', root, 'fixture.ts')),
    ...['data', 'node_modules', 'out', '.cache', 'coverage', 'sessions', 'logs'].map(
      (root) => path.join(identityRoot, 'analytics', 'recording', root, 'fixture.ts'),
    ),
  ];
  for (const input of [...included, ...excluded]) {
    mkdirSync(path.dirname(input), { recursive: true });
    writeFileSync(input, 'export const value = "before";\n');
  }
  const node = createBuildIdentityPlugin(identityRoot);
  const webview = createBuildIdentityPlugin(identityRoot);
  let previous = runIdentityPlugin(node);
  for (const input of included) {
    assert.ok(previous.watched.includes(input), `${input} must be watched`);
    writeFileSync(input, 'export const value = "after";\n');
    const nextNode = runIdentityPlugin(node);
    const nextWebview = runIdentityPlugin(webview);
    assert.notEqual(nextNode.buildId, previous.buildId, `${input} must affect identity`);
    assert.equal(nextNode.buildId, nextWebview.buildId);
    assert.ok(nextWebview.watched.includes(input));
    previous = nextNode;
  }
  for (const input of excluded) {
    assert.ok(!previous.watched.includes(input), `${input} must not be watched`);
    writeFileSync(input, 'export const value = "ignored";\n');
    assert.equal(runIdentityPlugin(node).buildId, previous.buildId);
    assert.equal(runIdentityPlugin(webview).buildId, previous.buildId);
  }
});

test('delivery node builds emit the neutral runtime lock bytes unchanged', () => {
  const plugin = createShippedRuntimeLockPlugin();
  assert.equal(plugin.name, 'pie-shipped-runtime-lock');
  const emitted: EmittedAsset[] = [];
  const generateBundle = plugin.generateBundle;
  assert.equal(typeof generateBundle, 'function');
  if (typeof generateBundle !== 'function') throw new Error('generateBundle hook is missing');
  generateBundle.call(
    { emitFile: (asset: EmittedAsset) => emitted.push(asset) } as never,
    {} as never,
    {} as never,
    false,
  );
  const lockAsset = emitted.find((asset) => asset.fileName === 'windows-runtime-lock.cjs');
  assert.ok(lockAsset, 'the shipped runtime-lock module must be emitted into the build output');
  assert.deepEqual(
    Buffer.from(String(lockAsset?.source ?? '')),
    readFileSync(path.join(repositoryRoot, 'lib', 'windows-runtime-lock', 'windows-runtime-lock.cjs')),
    'the emitted module must be the authoritative neutral owner bytes, unchanged',
  );
});
