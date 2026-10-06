import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createOwnerRequire,
  createTsconfigOverlay,
  createTypeScriptResolution,
  createViteAliases,
  resolveOwnerModule,
  resolvePackageRoots,
  resolveSdkModule,
  resolveSdkPackages,
} from '../package-resolution.mjs';
import { runProject, runWithConcurrency } from '../../verification/run-typechecks.mjs';
import { buildTsxArgs, runGroup } from '../../verification/run-test-files.mjs';
import {
  currentRoots,
  makeFixture,
  ownerRoot,
  repoRoot,
  runNode,
  tscCli,
  tsxCli,
  viteCli,
  viteNodeEntry,
  writeTsConfig,
} from './package-resolution-fixtures.mjs';

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
const selectedSdkOptions = { dependencyOwnerRoot: ownerRoot, sdkPath: selectedSdkPath };


test('resolves current and planned package roots explicitly, and pins the explicitly selected SDK graph', () => {
  const current = resolvePackageRoots('current');
  const planned = resolvePackageRoots('planned');
  assert.equal(current.repositoryRoot, repoRoot);
  assert.equal(current.distributionRoot, path.join(repoRoot, 'application', 'hosts', 'vscode'));
  assert.equal(current.dependencyOwnerRoot, path.join(repoRoot, 'application', 'hosts', 'vscode'));
  assert.equal(planned.distributionRoot, path.join(repoRoot, 'application', 'hosts', 'vscode'));
  assert.equal(planned.dependencyOwnerRoot, path.join(repoRoot, 'application', 'hosts', 'vscode'));
  assert.throws(() => resolvePackageRoots('current', { repositoryRoot: '.' }), /absolute path/);

  const sdk = resolveSdkPackages(selectedSdkOptions);
  assert.equal(sdk.sdk.root, selectedSdkPath);
  const selectedPiAiRoots = (sdk.sdkRequire.resolve.paths('@earendil-works/pi-ai') ?? [])
    .map((modulesRoot) => path.join(modulesRoot, '@earendil-works', 'pi-ai'))
    .filter((packageRoot) => existsSync(path.join(packageRoot, 'package.json')))
    .map((packageRoot) => realpathSync(packageRoot));
  assert.ok(selectedPiAiRoots.includes(sdk.piAi.root),
    'pi-ai must resolve through the explicitly selected SDK graph, whether nested or hoisted');
  assert.equal(resolveOwnerModule('preact/jsx-runtime', { dependencyOwnerRoot: ownerRoot }),
    path.join(ownerRoot, 'node_modules', 'preact', 'jsx-runtime', 'dist', 'jsxRuntime.js'));
  assert.equal(resolveSdkModule('@earendil-works/pi-ai/compat', selectedSdkOptions),
    path.join(sdk.piAi.root, 'dist', 'compat.js'));
  assert.equal(resolveSdkModule('@mariozechner/pi-ai/providers/all', selectedSdkOptions),
    path.join(sdk.piAi.root, 'dist', 'providers', 'all.js'));
  assert.equal(createOwnerRequire({ dependencyOwnerRoot: ownerRoot }).resolve('preact'),
    path.join(ownerRoot, 'node_modules', 'preact', 'dist', 'preact.js'));
});

test('the real TypeScript compiler resolves future TSX roots, owner type roots, Pi aliases, and Preact subpaths through the integrated typecheck caller', { timeout: 120_000 }, async (t) => {
  const { sourceRoot } = makeFixture(t);
  const sourcePath = path.join(sourceRoot, 'compiler-proof.tsx');
  writeFileSync(sourcePath, `
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI as LegacyExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import type { Model as LegacyModel } from '@mariozechner/pi-ai';
import type { Text as PiTuiText } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { Type as LegacyType } from '@sinclair/typebox';
import { useState } from 'preact/hooks';
import { jsx } from 'preact/jsx-runtime';
import { createElement } from 'preact/compat';

const schema = Type.Object({ prompt: Type.String() });
const sameTypebox = Type.Object === LegacyType.Object;
const element = <section>{jsx('span', { children: 'future source root' })}</section>;
const component = () => {
  const [value] = useState('resolved');
  return createElement('div', null, value, sameTypebox ? 'same' : 'different');
};
const types: [ExtensionAPI, LegacyExtensionAPI, Model<any>, LegacyModel<any>, PiTuiText] | undefined = undefined;
void [schema, element, component, types];
`);
  const { sourceDescriptor } = await import('../../../harness/agent-processes/lib/sdk-integration/test/source-fixture.ts');
  const typeResolution = createTypeScriptResolution({ dependencyOwnerRoot: ownerRoot, sdkPath: sourceDescriptor.sdkPath });
  const piTuiRoot = path.join(sourceDescriptor.artifactDir, 'node_modules', '@earendil-works', 'pi-tui');
  assert.equal(typeResolution.paths['@earendil-works/pi-tui'][0], path.join(piTuiRoot, 'dist', 'index.d.ts'));
  const configPath = writeTsConfig(sourceRoot, typeResolution);
  // The future-root proof exercises the integrated typecheck caller (the same
  // runWithConcurrency/runProject surface scripts/verification/run-typechecks.mjs uses for
  // registry projects), including its helper-resolved compiler selection and
  // absolute-config seam — not a hand-rolled tsc spawn.
  const [result] = await runWithConcurrency([{
    id: 'package-resolution-compiler-proof',
    config: configPath,
    compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc',
  }], 1, (project, signal) => runProject(project, signal, sourceDescriptor));
  assert.equal(result.code, 0, result.output);
});

test('the real Vite bundler consumes owner aliases and SSR resolves runtime pi-tui from a future source root', { timeout: 120_000 }, async (t) => {
  const { fixtureRoot, sourceRoot } = makeFixture(t);
  const sourcePath = path.join(sourceRoot, 'bundle-proof.tsx');
  const runtimeSourcePath = path.join(sourceRoot, 'vite-runtime-proof.ts');
  writeFileSync(runtimeSourcePath, `
import { Text as PiTuiText } from '@earendil-works/pi-tui';
export const piTuiText = PiTuiText;
`);
  writeFileSync(sourcePath, `
import { h } from 'preact';
import { createElement } from 'preact/compat';
import { useState } from 'preact/hooks';
import { jsx } from 'preact/jsx-runtime';
import { jsxDEV } from 'preact/jsx-dev-runtime';
export const proof = [h, createElement, useState, jsx, jsxDEV];
`);
  const outputPath = path.join(fixtureRoot, 'vite-out');
  const configPath = path.join(fixtureRoot, 'vite.config.mjs');
  const helperUrl = pathToFileURL(fileURLToPath(new URL('../package-resolution.mjs', import.meta.url))).href;
  writeFileSync(configPath, `
import { createViteAliases } from ${JSON.stringify(helperUrl)};
export default {
  resolve: { alias: createViteAliases({ dependencyOwnerRoot: ${JSON.stringify(ownerRoot)} }) },
  build: {
    target: 'es2022',
    outDir: ${JSON.stringify(outputPath)},
    emptyOutDir: true,
    rollupOptions: { input: ${JSON.stringify(sourcePath)} },
  },
};
`);
  runNode([viteCli, 'build', sourceRoot, '--config', configPath, '--logLevel', 'error'], sourceRoot);
  const vite = await import(pathToFileURL(viteNodeEntry).href);
  const runtimeOutputPath = path.join(fixtureRoot, 'vite-runtime-out');
  await vite.build({
    configFile: false,
    root: sourceRoot,
    resolve: { alias: createViteAliases(selectedSdkOptions) },
    build: {
      target: 'node22',
      ssr: runtimeSourcePath,
      outDir: runtimeOutputPath,
      emptyOutDir: true,
    },
  });
  const runtimeEntry = path.join(runtimeOutputPath, 'vite-runtime-proof.mjs');
  const runtimeProof = await import(pathToFileURL(runtimeEntry).href);
  assert.equal(typeof runtimeProof.piTuiText, 'function');
  const outputFiles = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else outputFiles.push(fullPath);
    }
  };
  walk(outputPath);
  assert.ok(outputFiles.some((file) => file.endsWith('.js') && statSync(file).size > 0));
});

test('the integrated tsx runner resolves owner-relative overlay aliases for a future root without npx or fixture ancestry', { timeout: 120_000 }, async (t) => {
  const { sourceRoot } = makeFixture(t);
  const sourcePath = path.join(sourceRoot, 'tsx-proof.ts');
  writeFileSync(sourcePath, `
import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@earendil-works/pi-ai';
import { Type as LegacyType } from '@mariozechner/pi-ai';
import { Type as Typebox } from 'typebox';
import { Type as SinclairType } from '@sinclair/typebox';
import { Text as PiTuiText } from '@earendil-works/pi-tui';
import { useState } from 'preact/hooks';
import { jsx } from 'preact/jsx-runtime';
test('future-root tsx overlay resolves one owner identity', () => {
  assert.equal(Type.Object, LegacyType.Object);
  assert.equal(Typebox.Object, SinclairType.Object);
  assert.equal(typeof useState, 'function');
  assert.equal(typeof jsx, 'function');
  assert.equal(typeof PiTuiText, 'function');
});
`);
  // The fixture base config declares the redirection set with deliberately
  // unresolvable placeholder targets; the generated overlay re-points exactly
  // those keys to explicit owner paths (no duplicated static aliases, no new
  // redirections) while strict/include/exclude stay inherited from the base.
  const placeholder = './does-not-resolve/index.mjs';
  const baseConfigPath = writeTsConfig(sourceRoot, {
    jsx: 'react-jsx',
    jsxImportSource: 'preact',
    paths: Object.fromEntries([
      ['@earendil-works/pi-ai', [placeholder]],
      ['@mariozechner/pi-ai', [placeholder]],
      ['typebox', [placeholder]],
      ['@sinclair/typebox', [placeholder]],
      ['@earendil-works/pi-tui', [placeholder]],
      ['preact/hooks', [placeholder]],
      ['preact/jsx-runtime', [placeholder]],
    ]),
  });
  const { sourceDescriptor } = await import('../../../harness/agent-processes/lib/sdk-integration/test/source-fixture.ts');
  const overlay = createTsconfigOverlay(baseConfigPath, {
    dependencyOwnerRoot: ownerRoot, sdkPath: sourceDescriptor.sdkPath,
  });
  t.after(() => overlay.dispose());
  const overlayConfig = JSON.parse(readFileSync(overlay.configPath, 'utf8'));
  assert.equal(overlayConfig.extends, baseConfigPath);
  assert.equal(overlayConfig.compilerOptions.strict, undefined);
  assert.equal(overlayConfig.compilerOptions.include, undefined);
  const declaredAliases = Object.keys(JSON.parse(readFileSync(baseConfigPath, 'utf8')).compilerOptions.paths);
  assert.ok(declaredAliases.includes('preact/jsx-runtime'), 'every imported Preact subpath is explicitly declared');
  for (const specifier of declaredAliases) {
    const [target] = overlayConfig.compilerOptions.paths[specifier];
    assert.ok(path.isAbsolute(target), `${specifier} must have an explicit absolute owner path`);
    const expectedRoot = specifier.startsWith('preact/') ? ownerRoot : sourceDescriptor.artifactDir;
    assert.ok(target.startsWith(expectedRoot), `${specifier} must resolve under its explicit owner`);
  }

  assert.equal(existsSync(tsxCli), true);
  // Run through the integrated focused-test runner surface (buildTsxArgs +
  // runGroup), exactly the path scripts/verification/run-test-files.mjs executes.
  const group = { id: 'future-root-tsx-proof', cwd: sourceRoot, tsxBin: tsxCli, tsxConfig: overlay.configPath, files: ['tsx-proof.ts'] };
  const code = await runGroup(group, buildTsxArgs(group));
  assert.equal(code, 0);
});

test('the pinned SDK extension loader resolves both Pi spellings to one nested pi-ai identity from a future root', { timeout: 120_000 }, async (t) => {
  const { sourceRoot } = makeFixture(t);
  const extensionPath = path.join(sourceRoot, 'sdk-loader-proof.ts');
  writeFileSync(extensionPath, `
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir as currentAgentDir } from '@earendil-works/pi-coding-agent';
import { getAgentDir as legacyAgentDir } from '@mariozechner/pi-coding-agent';
import { getModel as current } from '@earendil-works/pi-ai';
import { getModel as legacy } from '@mariozechner/pi-ai';
import { getModel as currentCompat } from '@earendil-works/pi-ai/compat';
import { getModel as legacyCompat } from '@mariozechner/pi-ai/compat';
import { Type as typebox } from 'typebox';
import { Type as sinclair } from '@sinclair/typebox';

export default (pi: ExtensionAPI) => {
  const identity = [currentAgentDir === legacyAgentDir, current === legacy, current === currentCompat, current === legacyCompat, typebox.Object === sinclair.Object];
  pi.registerCommand('package-resolution-proof', {
    description: identity.map(String).join(','),
    handler: () => undefined,
  });
};
`);
  const { sdk } = resolveSdkPackages(selectedSdkOptions);
  const loaderPath = path.join(sdk.root, 'dist', 'core', 'extensions', 'loader.js');
  const loader = await import(pathToFileURL(loaderPath).href);
  const result = await loader.loadExtensions([extensionPath], sourceRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.equal(result.extensions[0].commands.get('package-resolution-proof').description, 'true,true,true,true,true');
});

test('the Vite host and browser graphs require and use the selected SDK aliases', { timeout: 120_000 }, async (t) => {
  const vite = await import(pathToFileURL(viteNodeEntry).href);
  const extensionConfigPath = path.join(currentRoots.distributionRoot, 'vite.config.ts');
  const previousSdkPath = process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH;
  t.after(() => {
    if (previousSdkPath === undefined) delete process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH;
    else process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH = previousSdkPath;
  });
  delete process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH;
  await assert.rejects(vite.resolveConfig({ configFile: extensionConfigPath }, 'build', 'node'),
    /requires PIE_BUILD_PI_RUNTIME_SDK_PATH.*explicitly selected/);
  process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH = selectedSdkPath;
  const nodeResolved = await vite.resolveConfig({ configFile: extensionConfigPath }, 'build', 'node');
  const webviewResolved = await vite.resolveConfig({ configFile: extensionConfigPath }, 'build', 'production');

  const aliases = nodeResolved.resolve.alias;
  const browserAliases = webviewResolved.resolve.alias;
  const findFor = (fromAliases, specifier) => fromAliases.find((alias) => (
    typeof alias.find === 'string' ? alias.find === specifier : alias.find.test(specifier)
  ));
  const ownerPackage = (name) => {
    // The native runner's SDK alias middleware intercepts require.resolve.
    // Independently inspect only Node's local/ancestor lookup directories,
    // taking the first exact manifest (never global or store search paths).
    for (let directory = ownerRoot; ; directory = path.dirname(directory)) {
      const manifestPath = path.join(directory, 'node_modules', name, 'package.json');
      if (path.basename(directory) !== 'node_modules' && existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        assert.equal(manifest.name, name);
        return { root: path.dirname(realpathSync(manifestPath)), manifest };
      }
      if (directory === path.dirname(directory)) break;
    }
    assert.fail(`${name} must come from the owner's local/ancestor graph, not a global fallback`);
  };
  const ws = ownerPackage('ws');
  assert.equal(findFor(aliases, 'ws').replacement, path.resolve(ws.root, ws.manifest.exports['.'].require));
  assert.equal(findFor(browserAliases, 'ws').replacement, path.resolve(ws.root, ws.manifest.exports['.'].browser),
    'the renderer retains ws package browser conditions');

  // Current and legacy SDK aliases resolve through the wrapper-selected
  // immutable candidate, never an owner-installed package.
  assert.equal(findFor(aliases, '@earendil-works/pi-coding-agent').replacement,
    path.join(selectedSdkPath, 'dist', 'index.js'));
  assert.equal(findFor(aliases, '@mariozechner/pi-coding-agent').replacement,
    path.join(selectedSdkPath, 'dist', 'index.js'));

  // Current and legacy Pi spellings rewrite into the selected nested SDK
  // graph, including wildcard subpaths.
  const selectedSdk = resolveSdkPackages(selectedSdkOptions);
  const nestedPiAi = path.join(selectedSdk.piAi.root, 'dist');
  assert.equal(findFor(aliases, '@earendil-works/pi-ai').replacement, path.join(nestedPiAi, 'index.js'));
  assert.equal(findFor(aliases, '@mariozechner/pi-ai').replacement, path.join(nestedPiAi, 'index.js'));
  const legacyProviders = findFor(aliases, '@mariozechner/pi-ai/providers/all');
  assert.ok(legacyProviders.find instanceof RegExp);
  assert.equal(legacyProviders.replacement.replace('$1', 'all'), path.join(nestedPiAi, 'providers', 'all.js'));

  // TypeBox spellings share the selected SDK identity. Ordinary packages
  // retain the owner's exact conditional entries, whether nested or hoisted.
  assert.equal(findFor(aliases, 'typebox').replacement, findFor(aliases, '@sinclair/typebox').replacement);
  assert.equal(findFor(aliases, 'typebox').replacement, resolveSdkModule('typebox', selectedSdkOptions));
  for (const name of ['preact', 'highlight.js', 'marked']) {
    const { root, manifest } = ownerPackage(name);
    const nodeEntry = manifest.exports['.'].node ?? manifest.exports['.'].require
      ?? manifest.exports['.'].import ?? manifest.exports['.'].default;
    assert.equal(findFor(aliases, name).replacement,
      path.resolve(root, typeof nodeEntry === 'string' ? nodeEntry : nodeEntry.default));
    const browserEntry = manifest.exports['.'].browser ?? manifest.exports['.'].import;
    assert.equal(findFor(browserAliases, name).replacement,
      path.resolve(root, typeof browserEntry === 'string' ? browserEntry : browserEntry.default));
  }
  const preact = ownerPackage('preact');
  assert.equal(findFor(aliases, 'preact/hooks').replacement,
    path.resolve(preact.root, preact.manifest.exports['./hooks'].require));
  assert.equal(findFor(browserAliases, 'preact/hooks').replacement,
    path.resolve(preact.root, preact.manifest.exports['./hooks'].browser));
  const tailwindcss = ownerPackage('tailwindcss');
  assert.equal(findFor(aliases, 'tailwindcss').replacement,
    path.resolve(tailwindcss.root, tailwindcss.manifest.exports['.'].style));

  // No alias redirects `vscode`, node builtins, optional native deps, or the
  // native tool sidecar owners; they keep their own resolution.
  for (const specifier of ['vscode', 'node:fs', 'bufferutil', 'utf-8-validate', 'computer-use', 'playwright']) {
    assert.equal(findFor(aliases, specifier), undefined, `${specifier} must stay unaliased`);
  }
});

test('the Node Vite host bundle contains a usable ws WebSocketServer export', { timeout: 120_000 }, async (t) => {
  const { fixtureRoot, sourceRoot } = makeFixture(t);
  const sourcePath = path.join(sourceRoot, 'node-ws-proof.ts');
  const outputPath = path.join(fixtureRoot, 'node-ws-out');
  writeFileSync(sourcePath, `
import { WebSocketServer } from 'ws';
export function createWebSocketServer() {
  return new WebSocketServer({ noServer: true });
}
`);

  const vite = await import(pathToFileURL(viteNodeEntry).href);
  const extensionConfigPath = path.join(currentRoots.distributionRoot, 'vite.config.ts');
  const previousSdkPath = process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH;
  t.after(() => {
    if (previousSdkPath === undefined) delete process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH;
    else process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH = previousSdkPath;
  });
  process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH = selectedSdkPath;
  const hostConfig = await vite.resolveConfig({ configFile: extensionConfigPath }, 'build', 'node');
  await vite.build({
    configFile: false,
    root: sourceRoot,
    resolve: { alias: hostConfig.resolve.alias },
    ssr: { noExternal: true },
    build: {
      target: 'node20',
      ssr: sourcePath,
      outDir: outputPath,
      emptyOutDir: true,
      rollupOptions: {
        external: (id) => id === 'bufferutil' || id === 'utf-8-validate',
        output: { format: 'cjs', entryFileNames: 'node-ws-proof.cjs' },
      },
    },
  });

  const builtHost = createOwnerRequire({ dependencyOwnerRoot: ownerRoot })(path.join(outputPath, 'node-ws-proof.cjs'));
  const server = builtHost.createWebSocketServer();
  assert.equal(typeof server.handleUpgrade, 'function');
  assert.equal(typeof server.shouldHandle, 'function');
});

test('the integrated run-test-files wrapper keeps current-layout tsxConfig package runs green', { timeout: 120_000 }, async (t) => {
  // Old layout stays operational: the full integrated wrapper (registry
  // classification -> generated overlay -> package-local tsx) runs a real
  // registered test that depends on the redirected nested SDK identity.
  // This fixture derives all Pi roots from the outer TSX overlay and verifies
  // the immutable artifact independently in native Node. Missing or mismatched
  // selection throws before any nested runner can acquire a fresh artifact.
  const { sourceDescriptor } = await import('../../../harness/agent-processes/lib/sdk-integration/test/source-fixture.ts');
  const result = spawnSync(process.execPath, [
    'scripts/verification/run-test-files.mjs',
    'harness/tools/subagent/test/schema.test.ts',
    '--pi-runtime', sourceDescriptor.artifactDir,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
  assert.match(result.stdout, /Summary: 1\/1 packages passed/);
});
