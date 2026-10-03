import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createOwnerRequire,
  createTsxResolution,
  resolvePackageRoots,
  resolveSdkModule,
  resolveSdkPackages,
} from '../package-resolution.mjs';
import {
  createNativeOwnerRequire,
  resolveNativeOwnerPath,
  resolveNativeOwnerRoot,
} from '../native-owner.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ownerRoot = resolvePackageRoots('current').dependencyOwnerRoot;

function selectedSdkPathFromTsxConfig() {
  const tsconfigPath = process.env.TSX_TSCONFIG_PATH;
  assert.ok(tsconfigPath, 'SDK-resolution tests require the verified wrapper TSX_TSCONFIG_PATH selection');
  const paths = JSON.parse(readFileSync(path.resolve(tsconfigPath), 'utf8')).compilerOptions?.paths;
  assert.ok(paths?.typebox?.[0], 'SDK-resolution tests require candidate TypeBox aliases');
  const entry = paths['@earendil-works/pi-coding-agent']?.[0];
  assert.ok(entry && path.isAbsolute(entry), 'wrapper config must select an absolute Pi SDK alias');
  let directory = path.dirname(realpathSync(entry));
  while (directory !== path.dirname(directory)) {
    const manifestPath = path.join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.name === '@earendil-works/pi-coding-agent') return realpathSync(directory);
    }
    directory = path.dirname(directory);
  }
  assert.fail(`Could not find the selected Pi SDK package root above ${entry}`);
}

const selectedSdkPath = selectedSdkPathFromTsxConfig();
const repoSdkOptions = { dependencyOwnerRoot: ownerRoot, sdkPath: selectedSdkPath };
const sdkPackages = resolveSdkPackages(repoSdkOptions);
const repoOwnerOptions = { repositoryRoot };

function linkDirectory(source, destination) {
  symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
}

function makeFutureRoot(t) {
  const root = path.join(os.tmpdir(), `pie-unbundled-future-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // A future checkout has source roots but no root-level dependency install.
  linkDirectory(path.join(repositoryRoot, 'scripts'), path.join(root, 'scripts'));
  linkDirectory(path.join(repositoryRoot, 'extension'), path.join(root, 'extension'));
  mkdirSync(path.join(root, 'harness', 'tools'), { recursive: true });
  mkdirSync(path.join(root, 'extensions'), { recursive: true });
  for (const id of ['computer-use', 'playwright']) {
    const extensionRoot = path.join(root, 'extensions', id);
    mkdirSync(extensionRoot, { recursive: true });
    writeFileSync(path.join(extensionRoot, 'index.ts'), readFileSync(path.join(repositoryRoot, 'extensions', id, 'index.ts')));
    writeFileSync(path.join(extensionRoot, 'package.json'), readFileSync(path.join(repositoryRoot, 'extensions', id, 'package.json')));
    linkDirectory(path.join(repositoryRoot, 'extensions', id, 'node_modules'), path.join(extensionRoot, 'node_modules'));
    linkDirectory(path.join(repositoryRoot, 'harness', 'tools', id), path.join(root, 'harness', 'tools', id));
  }
  mkdirSync(path.join(root, 'extensions', 'sdk-alias-proof'), { recursive: true });
  assert.equal(existsSync(path.join(root, 'node_modules')), false);
  return root;
}

test('native and application dependency owners resolve from an OS-temp future source root', async (t) => {
  const futureRoot = makeFutureRoot(t);
  const proofPath = path.join(futureRoot, 'harness', 'owner-proof.mjs');
  mkdirSync(path.dirname(proofPath), { recursive: true });
  writeFileSync(proofPath, `
import { requireComputerUseDependency, cuaDriverEntry } from './tools/computer-use/dependency-owner.mjs';
import { requirePlaywrightDependency } from './tools/playwright/dependency-owner.mjs';
import { createOwnerRequire } from '../scripts/lib/package-resolution.mjs';
export const resolved = {
  nut: requireComputerUseDependency.resolve('@computer-use/nut-js'),
  cuaDriverEntry: cuaDriverEntry.href,
  playwright: requirePlaywrightDependency.resolve('playwright'),
  yaml: createOwnerRequire().resolve('yaml'),
  yamlParser: createOwnerRequire()('yaml').parseDocument,
};
`);

  const { resolved } = await import(pathToFileURL(proofPath).href);
  const computerOwnerRoot = resolveNativeOwnerRoot('computer-use', repoOwnerOptions);
  const playwrightOwnerRoot = resolveNativeOwnerRoot('playwright', repoOwnerOptions);
  assert.ok(resolved.nut.startsWith(path.join(computerOwnerRoot, 'node_modules')));
  assert.equal(resolved.cuaDriverEntry, pathToFileURL(resolveNativeOwnerPath('computer-use', [
    'node_modules', '@trycua', 'cua-driver', 'dist', 'index.js',
  ], repoOwnerOptions)).href);
  assert.equal(existsSync(fileURLToPath(resolved.cuaDriverEntry)), true);
  assert.ok(resolved.playwright.startsWith(path.join(playwrightOwnerRoot, 'node_modules')));

  // catalog-sync uses the same owner-hoisted CommonJS yaml module, not a
  // source-depth-specific copy or a second parser identity.
  const yamlEntry = createOwnerRequire().resolve('yaml');
  assert.equal(resolved.yaml, yamlEntry);
  const yamlEsmNamespace = await import(pathToFileURL(yamlEntry).href);
  assert.equal(resolved.yamlParser, yamlEsmNamespace.parseDocument);
  const catalogSync = await import(pathToFileURL(path.join(
    repositoryRoot, 'harness/model-providers/model-discovery/catalog-sync.ts',
  )).href);
  const catalogResult = catalogSync.reconcileCatalogText(
    'providers:\n  github-copilot:\n    models: []\nprofileOrder: []\n',
    [],
  );
  assert.equal(catalogResult.changed, false);

  assert.equal(createNativeOwnerRequire('computer-use', repoOwnerOptions).resolve('@computer-use/nut-js'), resolved.nut);
  assert.equal(createNativeOwnerRequire('playwright', repoOwnerOptions).resolve('playwright'), resolved.playwright);
});

test('relocated runtime clients launch their colocated source sidecars over JSONL and clean them up', { timeout: 60_000 }, async () => {
  const runtimes = [
    { id: 'computer-use', expected: { state: { healthy: true } } },
    { id: 'playwright', expected: {} },
  ];
  for (const runtime of runtimes) {
    const runtimeClientPath = path.join(repositoryRoot, 'harness', 'tools', runtime.id, 'runtime-client.ts');
    const { RuntimeClient } = await import(pathToFileURL(runtimeClientPath).href);
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), `pie-${runtime.id}-sidecar-`));
    const client = new RuntimeClient(path.join(sessionDir, 'session.jsonl'));
    try {
      assert.deepEqual(await client.request('ping', {}, { timeoutMs: 15_000 }), runtime.expected);
      assert.ok(client.pid, `${runtime.id} source sidecar should be running after ping`);
    } finally {
      await client.shutdown();
      await rm(sessionDir, { recursive: true, force: true });
    }
    assert.equal(client.state, 'stopped', `${runtime.id} sidecar should stop cleanly`);
    assert.equal(client.pid, undefined);
  }
});

test('the pinned SDK loads future-root extension shims and keeps its pi-ai compat alias distinct from helper aliases', async (t) => {
  const futureRoot = makeFutureRoot(t);
  const aliasProofPath = path.join(futureRoot, 'extensions', 'sdk-alias-proof', 'index.ts');
  writeFileSync(aliasProofPath, `
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { completeSimple as rootCompleteSimple, getModel as rootGetModel } from '@earendil-works/pi-ai';
import { completeSimple as compatCompleteSimple, getModel as compatGetModel } from '@earendil-works/pi-ai/compat';
export default (pi: ExtensionAPI) => pi.registerCommand('unbundled-alias-proof', {
  description: [
    typeof rootCompleteSimple === 'function',
    rootCompleteSimple === compatCompleteSimple,
    rootGetModel === compatGetModel,
  ].join(','),
  handler: () => undefined,
});
`);

  const ownerOptions = repoSdkOptions;
  const coreEntry = resolveSdkModule('@earendil-works/pi-ai', ownerOptions);
  const compatEntry = resolveSdkModule('@earendil-works/pi-ai/compat', ownerOptions);
  const core = await import(pathToFileURL(coreEntry).href);
  const compat = await import(pathToFileURL(compatEntry).href);

  // Owner/compiler/tsx helpers preserve package export semantics: the root is
  // the core API and /compat is the wider legacy API. The SDK's actual Jiti
  // loader deliberately maps both extension spellings to compat instead.
  assert.equal(coreEntry, path.join(sdkPackages.piAi.root, 'dist', 'index.js'));
  assert.equal(compatEntry, path.join(sdkPackages.piAi.root, 'dist', 'compat.js'));
  assert.equal(typeof core.completeSimple, 'undefined');
  assert.equal(typeof compat.completeSimple, 'function');
  const helperAliases = createTsxResolution(ownerOptions).paths;
  assert.equal(helperAliases['@earendil-works/pi-ai'][0], coreEntry);
  assert.equal(helperAliases['@earendil-works/pi-ai/compat'][0], compatEntry);

  const loaderPath = path.join(sdkPackages.sdk.root, 'dist', 'core', 'extensions', 'loader.js');
  const loader = await import(pathToFileURL(loaderPath).href);
  const extensionPaths = [
    path.join(futureRoot, 'extensions/computer-use/index.ts'),
    path.join(futureRoot, 'extensions/playwright/index.ts'),
    aliasProofPath,
  ];
  const result = await loader.loadExtensions(extensionPaths, futureRoot);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.extensions.map((extension) => [...extension.tools.keys()]), [
    ['computer'], ['playwright'], [],
  ]);
  assert.equal(result.extensions[2].commands.get('unbundled-alias-proof').description, 'true,true,true');
  assert.ok(result.extensions.every((extension) => extension.resolvedPath.startsWith(futureRoot)));
  // Loading the shims only registers tools; no backend, browser, desktop, or
  // native input action is invoked by this proof.
});

test('the retained cwd-skills SDK adapter loads through the real extension loader and delegates to the moved implementation', async (t) => {
  // B3 gate for the retain record: the stable root extensions/cwd-skills/index.ts
  // entry must load through the pinned SDK's own jiti extension loader and stay
  // a thin adapter whose implementation lives at
  // harness/agent-instructions/skill-discovery/index.ts (registered exactly one
  // resources_discover hook, no second implementation).
  const loaderPath = path.join(sdkPackages.sdk.root, 'dist', 'core', 'extensions', 'loader.js');
  const loader = await import(pathToFileURL(loaderPath).href);
  const adapterPath = path.join(repositoryRoot, 'extensions', 'cwd-skills', 'index.ts');
  const result = await loader.loadExtensions([adapterPath], repositoryRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  assert.equal(extension.resolvedPath, path.resolve(adapterPath));
  assert.deepEqual([...extension.tools.keys()], []);
  // One registered hook, owned by the canonical skill-discovery implementation.
  const handlers = extension.handlers.get('resources_discover') ?? [];
  assert.equal(handlers.length, 1);
  const implementation = readFileSync(
    path.join(repositoryRoot, 'harness', 'agent-instructions', 'skill-discovery', 'index.ts'),
    'utf8',
  );
  assert.match(implementation, /resources_discover/);
  assert.equal(
    readFileSync(adapterPath, 'utf8').includes("skill-discovery/index.js"),
    true,
    'the root entry stays a thin delegating adapter',
  );
});

test('the retained Copilot discovery adapter loads once through the pinned SDK and delegates to the provider owner', async () => {
  const loaderPath = path.join(sdkPackages.sdk.root, 'dist', 'core', 'extensions', 'loader.js');
  const loader = await import(pathToFileURL(loaderPath).href);
  const adapterPath = path.join(repositoryRoot, 'extensions', 'copilot-model-discovery', 'index.ts');
  const result = await loader.loadExtensions([adapterPath], repositoryRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);

  const extension = result.extensions[0];
  assert.equal(extension.resolvedPath, path.resolve(adapterPath));
  assert.deepEqual([...extension.tools.keys()], []);
  assert.equal((extension.handlers.get('session_start') ?? []).length, 1);
  assert.equal([...extension.commands.keys()].filter((name) => name === 'copilot-sync-models').length, 1);
  const metadata = JSON.parse(readFileSync(path.join(repositoryRoot, 'extensions', 'copilot-model-discovery', 'package.json'), 'utf8'));
  assert.equal(metadata.name, 'copilot-model-discovery');
  assert.deepEqual(metadata.pi.extensions, ['./index.ts']);
  assert.equal(
    readFileSync(adapterPath, 'utf8'),
    '// Keep the stable pi SDK discovery entry here; the implementation lives under harness/.\nexport { default } from \'../../harness/model-providers/model-discovery/index.js\';\n',
  );
});
