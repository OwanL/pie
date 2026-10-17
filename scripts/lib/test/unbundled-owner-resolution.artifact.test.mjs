import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createTsxResolution,
  resolvePackageRoots,
  resolveSdkModule,
  resolveSdkPackages,
} from '../package-resolution.mjs';
import { makeFutureRoot } from './unbundled-owner-resolution-fixtures.mjs';

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
  // the core API and /compat is the wider legacy API. The SDK Jiti loader maps
  // both extension spellings to compat for legacy extension compatibility.
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
