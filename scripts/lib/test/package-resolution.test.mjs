import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createOwnerRequire,
  createTsconfigOverlay,
  createTypeScriptResolution,
  createTsxResolution,
  createViteAliases,
  resolveOwnerModule,
  resolveTypeScriptCompiler,
  resolveSdkModule,
  resolveSdkPackages,
} from '../package-resolution.mjs';
import { buildTsxArgs, runGroup } from '../../verification/run-test-files.mjs';
import {
  makeFixture,
  ownerRoot,
  resolveNativeOwnerControls,
  runNode,
  tscCli,
  tsxCli,
  viteNodeEntry,
  writeFixturePackage,
  writeHoistedCompetitor,
  writeTsConfig,
  makeCandidateOwner,
  makeSdkCandidateGraph,
} from './package-resolution-fixtures.mjs';

test('SDK identities require explicit selection while ordinary owner resolution remains available', () => {
  const ownerOnly = { dependencyOwnerRoot: ownerRoot };
  assert.throws(() => resolveSdkPackages(ownerOnly), /sdkPath is required/);
  assert.throws(() => resolveOwnerModule('@earendil-works/pi-ai', ownerOnly), /sdkPath is required/);
  assert.throws(() => resolveOwnerModule('typebox', ownerOnly), /sdkPath is required/);
  assert.equal(resolveOwnerModule('preact/jsx-runtime', ownerOnly),
    path.join(ownerRoot, 'node_modules', 'preact', 'jsx-runtime', 'dist', 'jsxRuntime.js'));

  for (const paths of [
    createTypeScriptResolution(ownerOnly).paths,
    createTsxResolution(ownerOnly).paths,
  ]) {
    assert.equal(paths['@earendil-works/pi-coding-agent'], undefined);
    assert.equal(paths['@mariozechner/pi-ai'], undefined);
    assert.equal(paths.typebox, undefined);
    assert.ok(paths.preact, 'owner Preact alias remains available without an SDK selection');
  }
  const aliases = createViteAliases(ownerOnly);
  const findAlias = (name) => aliases.find(({ find }) => find === name);
  assert.equal(findAlias('@earendil-works/pi-coding-agent'), undefined);
  assert.equal(findAlias('@mariozechner/pi-ai'), undefined);
  assert.equal(findAlias('typebox'), undefined);
  assert.ok(findAlias('preact'), 'owner Preact alias remains available without an SDK selection');
});

test('owner aliases resolve root-hoisted manifests without a host-local Preact install', (t) => {
  const { fixtureRoot } = makeFixture(t);
  const hostRoot = path.join(fixtureRoot, 'application', 'hosts', 'vscode');
  mkdirSync(hostRoot, { recursive: true });
  writeFileSync(path.join(hostRoot, 'package.json'), JSON.stringify({ dependencies: {
    preact: '*', tailwindcss: '*', 'config-only': '*', '@fixture/tool': '*',
  } }));
  const modules = path.join(fixtureRoot, 'node_modules');
  const preactRoot = writeFixturePackage(modules, 'preact', {
    types: './types/index.d.ts',
    typesVersions: { '*': { hooks: ['./types/hooks.d.ts'] } },
    exports: {
      '.': { import: './dist/preact.mjs', require: './dist/preact.cjs' },
      './hooks': { import: './hooks/hooks.mjs', require: './hooks/hooks.cjs' },
    },
  }, { 'dist/preact.cjs': 'module.exports = {};\n' });
  const tailwindRoot = writeFixturePackage(modules, 'tailwindcss', {
    main: './index.js', exports: { '.': { style: './index.css', require: './index.js' } },
  });
  writeFixturePackage(modules, 'config-only');
  const toolRoot = writeFixturePackage(modules, '@fixture/tool', {
    exports: { './feature': './feature.js' },
  });
  // Compiler selection stays owner-relative even when ordinary packages hoist.
  writeFixturePackage(modules, 'typescript', { main: './index.js' }, { 'bin/tsc': '' });
  const compilerRoot = writeFixturePackage(path.join(hostRoot, 'node_modules'), 'typescript',
    { main: './index.js' }, { 'bin/tsc': '' });
  const options = { dependencyOwnerRoot: hostRoot };
  assert.equal(existsSync(path.join(hostRoot, 'node_modules', 'preact')), false);
  assert.equal(resolveNativeOwnerControls(options, ['preact'], { helper: true })[0],
    path.join(preactRoot, 'dist', 'preact.cjs'));
  const types = createTypeScriptResolution(options);
  assert.deepEqual(types.paths.preact, [path.join(preactRoot, 'types', 'index.d.ts')]);
  assert.deepEqual(types.paths['preact/hooks'], [path.join(preactRoot, 'types', 'hooks.d.ts')]);
  assert.deepEqual(types.typeRoots, [path.join(hostRoot, 'node_modules', '@types')]);
  assert.equal(types.baseUrl, hostRoot);
  assert.equal(resolveTypeScriptCompiler(options), path.join(compilerRoot, 'bin', 'tsc'));
  const runtime = createTsxResolution(options);
  assert.deepEqual(runtime.paths.preact, [path.join(preactRoot, 'dist', 'preact.cjs')]);
  assert.deepEqual(runtime.paths['preact/hooks'], [path.join(preactRoot, 'hooks', 'hooks.cjs')]);
  const aliases = createViteAliases(options);
  const target = (name) => aliases.find(({ find }) => find === name)?.replacement;
  assert.equal(target('preact'), path.join(preactRoot, 'dist', 'preact.mjs'));
  assert.equal(target('tailwindcss'), path.join(tailwindRoot, 'index.css'));
  assert.equal(target('@fixture/tool/feature'), path.join(toolRoot, 'feature.js'));
  assert.equal(target('config-only'), undefined);
  assert.throws(() => resolveOwnerModule('typebox', options), /sdkPath is required/);
});

test('owner type roots resolve root-hoisted vscode declarations without a private host install', (t) => {
  const { fixtureRoot, sourceRoot } = makeFixture(t);
  const hostRoot = path.join(fixtureRoot, 'application', 'hosts', 'vscode');
  const modules = path.join(hostRoot, 'node_modules');
  mkdirSync(modules, { recursive: true });
  writeFileSync(path.join(hostRoot, 'package.json'), JSON.stringify({ dependencies: { 'fixture-untyped': '*' }, devDependencies: { '@types/vscode': '*' } }));
  for (const name of ['preact', 'typescript']) {
    symlinkSync(path.join(ownerRoot, 'node_modules', name), path.join(modules, name),
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  const hoistedTypes = path.join(fixtureRoot, 'node_modules', '@types');
  writeFixturePackage(path.join(fixtureRoot, 'node_modules'), '@types/vscode', { types: './index.d.ts' }, {
    'index.d.ts': 'declare module "vscode" { export interface ExtensionContext { hoisted: true } }\n',
  });
  writeFixturePackage(path.join(fixtureRoot, 'node_modules'), 'fixture-untyped', { main: './index.js' }, {
    'index.js': 'module.exports = { marker: "hoisted" };\n',
  });
  const untypedDeclarations = writeFixturePackage(path.join(fixtureRoot, 'node_modules'), '@types/fixture-untyped', { types: './index.d.ts' }, {
    'index.d.ts': 'export const marker: "hoisted";\n',
  });
  const customTypes = path.join(sourceRoot, 'custom-types');
  writeFixturePackage(customTypes, 'local-global', { types: './index.d.ts' }, {
    'index.d.ts': 'declare const localGlobal: string;\n',
  });
  writeFileSync(path.join(sourceRoot, 'proof.ts'), 'import type { ExtensionContext } from "vscode";\ndeclare const context: ExtensionContext;\nconst hoisted: true = context.hoisted; void [hoisted, localGlobal];\n');
  const inherited = path.join(sourceRoot, 'inherited.json');
  writeFileSync(inherited, JSON.stringify({ compilerOptions: {
    types: ['vscode', 'local-global'], typeRoots: ['./custom-types'],
  } }));
  const base = writeTsConfig(sourceRoot, {});
  const config = JSON.parse(readFileSync(base, 'utf8'));
  delete config.compilerOptions.types;
  config.extends = './inherited.json';
  writeFileSync(base, JSON.stringify(config));
  const options = { dependencyOwnerRoot: hostRoot, includeOwnerDependencies: true, typescript: true };
  assert.equal(existsSync(path.join(modules, '@types')), false);
  assert.deepEqual(createTypeScriptResolution(options).typeRoots, [hoistedTypes]);
  const overlay = createTsconfigOverlay(base, options);
  t.after(() => overlay.dispose());
  const generated = JSON.parse(readFileSync(overlay.configPath, 'utf8')).compilerOptions;
  assert.deepEqual(generated.typeRoots, [customTypes, hoistedTypes]);
  assert.equal(generated.types, undefined, 'inherited requested types are not suppressed or replaced');
  assert.deepEqual(generated.paths['fixture-untyped'], [path.join(untypedDeclarations, 'index.d.ts')],
    'owner declaration aliases use the same hoisted owner search paths');
  runNode([resolveTypeScriptCompiler(options), '--project', overlay.configPath, '--pretty', 'false'], sourceRoot);

  // The owner's nearer version remains authoritative over a hoisted competitor.
  writeFixturePackage(modules, '@types/vscode', { types: './index.d.ts' }, {
    'index.d.ts': 'declare module "vscode" { export interface ExtensionContext { privateOwner: true } }\n',
  });
  writeFileSync(path.join(sourceRoot, 'proof.ts'), 'import type { ExtensionContext } from "vscode";\ndeclare const context: ExtensionContext;\nconst privateOwner: true = context.privateOwner; void [privateOwner, localGlobal];\n');
  const privateOverlay = createTsconfigOverlay(base, options);
  t.after(() => privateOverlay.dispose());
  assert.deepEqual(JSON.parse(readFileSync(privateOverlay.configPath, 'utf8')).compilerOptions.typeRoots,
    [customTypes, path.join(modules, '@types'), hoistedTypes]);
  runNode([resolveTypeScriptCompiler(options), '--project', privateOverlay.configPath, '--pretty', 'false'], sourceRoot);
});

test('inherited explicit package types resolve through bounded hoisted owner module paths', (t) => {
  const { fixtureRoot, sourceRoot } = makeFixture(t);
  const hostRoot = path.join(fixtureRoot, 'application', 'hosts', 'vscode');
  const modules = path.join(fixtureRoot, 'node_modules');
  mkdirSync(hostRoot, { recursive: true });
  mkdirSync(modules, { recursive: true });
  writeFileSync(path.join(hostRoot, 'package.json'), '{}');
  for (const name of ['preact', 'typescript', 'vite']) {
    symlinkSync(path.join(ownerRoot, 'node_modules', name), path.join(modules, name),
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  writeFixturePackage(modules, 'configured-types', { types: './index.d.ts' }, {
    'index.d.ts': 'declare const configuredGlobal: "hoisted";\n',
  });
  writeFileSync(path.join(sourceRoot, 'proof.ts'), 'const marker: "hoisted" = configuredGlobal; void [marker, import.meta.env.MODE];\n');
  writeFileSync(path.join(sourceRoot, 'inherited.json'), JSON.stringify({ compilerOptions: {
    types: ['vite/client', 'configured-types'],
  } }));
  const base = writeTsConfig(sourceRoot, {});
  const config = JSON.parse(readFileSync(base, 'utf8'));
  delete config.compilerOptions.types;
  config.extends = './inherited.json';
  writeFileSync(base, JSON.stringify(config));
  const options = { dependencyOwnerRoot: hostRoot, includeOwnerDependencies: true, typescript: true };
  const overlay = createTsconfigOverlay(base, options);
  t.after(() => overlay.dispose());
  const generated = JSON.parse(readFileSync(overlay.configPath, 'utf8')).compilerOptions;
  assert.equal(existsSync(path.join(hostRoot, 'node_modules')), false);
  assert.ok(generated.typeRoots.includes(modules), 'package types include hoisted modules, not just @types');
  const boundedRoots = new Set();
  for (let directory = hostRoot; ; directory = path.dirname(directory)) {
    boundedRoots.add(path.join(directory, 'node_modules'));
    if (path.dirname(directory) === directory) break;
  }
  assert.ok(generated.typeRoots.every((root) => boundedRoots.has(root) || boundedRoots.has(path.dirname(root))),
    'no global Node module search paths enter the overlay');
  assert.equal(generated.types, undefined);
  runNode([resolveTypeScriptCompiler(options), '--project', overlay.configPath, '--pretty', 'false'], sourceRoot);
});

test('root-hoisted highlight language imports retain bundled ambient declaration semantics', (t) => {
  const { fixtureRoot, sourceRoot } = makeFixture(t);
  const hostRoot = path.join(fixtureRoot, 'application', 'hosts', 'vscode');
  const modules = path.join(fixtureRoot, 'node_modules');
  mkdirSync(hostRoot, { recursive: true });
  mkdirSync(modules, { recursive: true });
  writeFileSync(path.join(hostRoot, 'package.json'), JSON.stringify({ dependencies: { 'highlight.js': '*' } }));
  for (const name of ['preact', 'typescript', 'highlight.js']) {
    symlinkSync(path.join(ownerRoot, 'node_modules', name), path.join(modules, name),
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  const options = { dependencyOwnerRoot: hostRoot, includeOwnerDependencies: true, typescript: true };
  const base = writeTsConfig(sourceRoot, { types: [] });
  const explicitFile = path.join(fixtureRoot, 'explicit.d.ts');
  writeFileSync(explicitFile, 'declare const explicitGlobal: true;\n');
  writeFileSync(path.join(sourceRoot, 'inherited.json'), JSON.stringify({ files: [explicitFile] }));
  const baseConfig = JSON.parse(readFileSync(base, 'utf8'));
  baseConfig.extends = './inherited.json';
  writeFileSync(base, JSON.stringify(baseConfig));
  writeFileSync(path.join(sourceRoot, 'proof.ts'), `
import hljs from 'highlight.js';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
const language = javascript(hljs);
const name: string | undefined = language.name;
void [name, typescript, explicitGlobal];
// @ts-expect-error bundled declarations do not accept a numeric highlighter
javascript(123);
// @ts-expect-error language names are not numbers (and must not become any)
const invalid: number = language.name;
`);
  const overlay = createTsconfigOverlay(base, options);
  t.after(() => overlay.dispose());
  const generated = JSON.parse(readFileSync(overlay.configPath, 'utf8'));
  assert.equal(generated.compilerOptions.paths['highlight.js/lib/languages/*'], undefined,
    'a JS wildcard alias must not swallow bundled ambient declarations');
  assert.ok(generated.files.includes(path.join(realpathSync(path.join(modules, 'highlight.js')), 'types', 'index.d.ts')));
  assert.ok(generated.files.map((file) => path.normalize(file)).includes(explicitFile), 'inherited explicit files are preserved');
  assert.equal(generated.include, undefined, 'inherited include globs are not flattened');
  assert.equal(existsSync(path.join(hostRoot, 'node_modules')), false);
  runNode([resolveTypeScriptCompiler(options), '--project', overlay.configPath, '--pretty', 'false'], sourceRoot);

  delete baseConfig.include;
  delete baseConfig.extends;
  writeFileSync(base, JSON.stringify(baseConfig));
  writeFileSync(path.join(sourceRoot, 'proof.ts'), 'const invalid: number = "must still check implicit source roots";\n');
  const implicitOverlay = createTsconfigOverlay(base, options);
  t.after(() => implicitOverlay.dispose());
  assert.deepEqual(JSON.parse(readFileSync(implicitOverlay.configPath, 'utf8')).include, [`${sourceRoot.split(path.sep).join('/')}/**/*`]);
  const result = spawnSync(process.execPath, [resolveTypeScriptCompiler(options), '--project', implicitOverlay.configPath, '--pretty', 'false'], {
    cwd: sourceRoot, encoding: 'utf8', timeout: 120_000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /proof.ts.*TS2322/);
});

test('explicit sdkPath resolves its nested and hoisted candidate graph for all Pi aliases and exports', (t) => {
  const { fixtureRoot } = makeFixture(t);
  const candidate = makeSdkCandidateGraph(fixtureRoot);
  const fakeOwner = makeCandidateOwner(fixtureRoot);
  const viteOwnerManifestPath = path.join(fakeOwner, 'package.json');
  const viteOwnerManifest = JSON.parse(readFileSync(viteOwnerManifestPath, 'utf8'));
  delete viteOwnerManifest.dependencies['candidate-runtime'];
  delete viteOwnerManifest.dependencies['candidate-transitive'];
  writeFileSync(viteOwnerManifestPath, JSON.stringify(viteOwnerManifest, null, 2));
  const options = { sdkPath: candidate.sdkRoot, dependencyOwnerRoot: fakeOwner };
  const resolved = resolveSdkPackages(options);

  const sdkLink = path.join(fixtureRoot, 'selected-sdk-link');
  symlinkSync(candidate.sdkRoot, sdkLink, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedResolution = resolveSdkPackages({ ...options, sdkPath: sdkLink });
  assert.equal(linkedResolution.sdk.root, realpathSync(candidate.sdkRoot),
    'explicit SDK selection is canonical even when selected through a junction');
  assert.equal(linkedResolution.piAi.root, candidate.roots['@earendil-works/pi-ai']);
  assert.equal(resolved.sdk.root, candidate.sdkRoot);
  assert.equal(resolved.packages['@earendil-works/pi-agent-core'].root, candidate.roots['@earendil-works/pi-agent-core']);
  assert.equal(resolved.piAi.root, candidate.roots['@earendil-works/pi-ai']);
  assert.equal(resolved.packages['@earendil-works/pi-tui'].root, candidate.roots['@earendil-works/pi-tui']);
  assert.equal(resolved.packages.typebox.root, candidate.roots.typebox);
  assert.equal(resolveNativeOwnerControls({ dependencyOwnerRoot: fakeOwner }, ['@earendil-works/pi-ai'])[0],
    path.join(fakeOwner, 'node_modules', '@earendil-works', 'pi-ai', 'index.js'));
  assert.notEqual(resolved.piAi.root, path.join(fakeOwner, 'node_modules', '@earendil-works', 'pi-ai'));

  for (const [canonical, legacy] of [
    ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'],
    ['@earendil-works/pi-agent-core', '@mariozechner/pi-agent-core'],
    ['@earendil-works/pi-ai', '@mariozechner/pi-ai'],
    ['@earendil-works/pi-tui', '@mariozechner/pi-tui'],
  ]) {
    assert.equal(resolveSdkModule(canonical, options), resolveSdkModule(legacy, options), `${canonical} and ${legacy}`);
    assert.ok(resolveSdkModule(canonical, options).startsWith(candidate.sdkRoot)
      || Object.values(candidate.roots).some((root) => resolveSdkModule(canonical, options).startsWith(root)));
  }
  assert.equal(resolveSdkModule('@earendil-works/pi-ai/compat', options),
    path.join(candidate.roots['@earendil-works/pi-ai'], 'dist', 'compat.js'));
  assert.equal(resolveSdkModule('@mariozechner/pi-ai/compat', options),
    path.join(candidate.roots['@earendil-works/pi-ai'], 'dist', 'compat.js'));
  assert.equal(resolveSdkModule('@mariozechner/pi-ai/providers/all', options),
    path.join(candidate.roots['@earendil-works/pi-ai'], 'dist', 'providers', 'all.js'));

  const tsxPaths = createTsxResolution(options).paths;
  const typePaths = createTypeScriptResolution(options).paths;
  for (const name of [
    '@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent',
    '@earendil-works/pi-agent-core', '@mariozechner/pi-agent-core',
    '@earendil-works/pi-ai', '@mariozechner/pi-ai',
    '@earendil-works/pi-tui', '@mariozechner/pi-tui',
  ]) {
    const root = name.endsWith('/pi-coding-agent')
      ? candidate.sdkRoot
      : name.endsWith('/pi-agent-core') ? candidate.roots['@earendil-works/pi-agent-core']
        : name.endsWith('/pi-ai') ? candidate.roots['@earendil-works/pi-ai']
          : candidate.roots['@earendil-works/pi-tui'];
    assert.ok(tsxPaths[name][0].startsWith(root), `${name} runtime alias uses the candidate`);
    assert.ok(typePaths[name][0].startsWith(root), `${name} type alias uses the candidate`);
  }
  assert.equal(tsxPaths['@earendil-works/pi-ai/compat'][0],
    path.join(candidate.roots['@earendil-works/pi-ai'], 'dist', 'compat.js'));
  assert.equal(tsxPaths['@mariozechner/pi-ai/compat'][0], tsxPaths['@earendil-works/pi-ai/compat'][0]);
  assert.equal(typePaths['@earendil-works/pi-ai/compat'][0],
    path.join(candidate.roots['@earendil-works/pi-ai'], 'dist', 'compat.d.ts'));
  assert.equal(typePaths['@mariozechner/pi-ai/compat'][0], typePaths['@earendil-works/pi-ai/compat'][0]);
  assert.ok(tsxPaths.typebox[0].startsWith(candidate.roots.typebox));
  assert.equal(tsxPaths['@sinclair/typebox'][0], tsxPaths.typebox[0]);
  assert.ok(typePaths['typebox/value'][0].startsWith(candidate.roots.typebox));
  assert.equal(resolveNativeOwnerControls(options, ['preact'], { helper: true })[0],
    path.join(fakeOwner, 'node_modules', 'preact', 'dist', 'preact.js'));

  const viteAliases = createViteAliases(options);
  const findAlias = (specifier) => viteAliases.find(({ find }) => (
    typeof find === 'string' ? find === specifier : find.test(specifier)
  ));
  for (const name of [
    '@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent',
    '@earendil-works/pi-agent-core', '@mariozechner/pi-agent-core',
    '@earendil-works/pi-ai', '@mariozechner/pi-ai',
    '@earendil-works/pi-tui', '@mariozechner/pi-tui',
  ]) {
    const root = name.endsWith('/pi-coding-agent') ? candidate.sdkRoot
      : name.endsWith('/pi-agent-core') ? candidate.roots['@earendil-works/pi-agent-core']
        : name.endsWith('/pi-ai') ? candidate.roots['@earendil-works/pi-ai']
          : candidate.roots['@earendil-works/pi-tui'];
    assert.ok(findAlias(name).replacement.startsWith(root), `${name} Vite alias uses the candidate`);
  }
  assert.equal(findAlias('@earendil-works/pi-ai/compat').replacement,
    path.join(candidate.roots['@earendil-works/pi-ai'], 'dist', 'compat.js'));
  assert.equal(findAlias('@mariozechner/pi-ai/compat').replacement,
    findAlias('@earendil-works/pi-ai/compat').replacement);
  const runtimeAlias = findAlias('candidate-runtime');
  assert.ok(runtimeAlias.replacement.startsWith(candidate.roots['candidate-runtime']),
    'undeclared candidate dependencies resolve from the SDK graph');
  assert.equal(typeof runtimeAlias.customResolver, 'function', 'candidate runtime alias is importer-aware');
  for (const name of ['ws', 'marked']) {
    const alias = findAlias(name);
    assert.equal(alias.replacement, path.join(fakeOwner, 'node_modules', name, 'index.js'),
      `${name} imports from Pie source retain the dependency owner`);
    assert.equal(typeof alias.customResolver, 'function', `${name} SDK imports retain native artifact resolution`);
  }
});

test('Vite redirects Pie source imports across repository roots and preserves workspace dependency resolution', { timeout: 120_000 }, async (t) => {
  const { fixtureRoot } = makeFixture(t);
  t.after(() => {
    delete globalThis.__candidateViteBrowserProof;
    delete globalThis.__candidateViteFrontendProof;
    delete globalThis.__candidateViteSubagentProof;
  });
  const candidate = makeSdkCandidateGraph(fixtureRoot);
  const fakeOwner = makeCandidateOwner(fixtureRoot);
  const ownerManifestPath = path.join(fakeOwner, 'package.json');
  const ownerManifest = JSON.parse(readFileSync(ownerManifestPath, 'utf8'));
  delete ownerManifest.dependencies['candidate-runtime'];
  delete ownerManifest.dependencies['candidate-transitive'];
  writeFileSync(ownerManifestPath, JSON.stringify(ownerManifest, null, 2));
  const applicationRoot = path.join(fixtureRoot, 'application');
  const browserSource = path.join(applicationRoot, 'hosts', 'browser', 'http', 'browser-server.ts');
  const frontendSource = path.join(applicationRoot, 'frontend', 'lib', 'components', 'selection-copy.ts');
  const subagentSource = path.join(fixtureRoot, 'harness', 'tools', 'subagent', 'subagent-profiles.ts');
  mkdirSync(path.dirname(browserSource), { recursive: true });
  mkdirSync(path.dirname(frontendSource), { recursive: true });
  mkdirSync(path.dirname(subagentSource), { recursive: true });
  writeFileSync(path.join(candidate.roots['candidate-runtime'], 'index.js'), `
import { marker as nestedWsMarker } from 'ws';
export { version as nestedVersion } from 'candidate-transitive';
export { nestedWsMarker };
`);
  writeFileSync(browserSource, `
import { marker as wsMarker } from 'ws';
import { version as appVersion } from 'candidate-transitive';
import { nestedVersion, nestedWsMarker } from 'candidate-runtime';
import { marker as extensionlessMarker } from 'candidate-runtime/lib/core';
import { marker as yamlMarker } from 'yaml';
globalThis.__candidateViteBrowserProof = [wsMarker, appVersion, nestedVersion, nestedWsMarker, extensionlessMarker, yamlMarker];
`);
  writeFileSync(frontendSource, `
import { marker as markedMarker } from 'marked';
globalThis.__candidateViteFrontendProof = markedMarker;
`);
  writeFileSync(subagentSource, `
import { version as harnessVersion } from 'candidate-transitive';
import { marker as yamlMarker } from 'yaml';
globalThis.__candidateViteSubagentProof = [harnessVersion, yamlMarker];
`);
  const outputRoot = path.join(fixtureRoot, 'vite-candidate-out');
  const vite = await import(pathToFileURL(viteNodeEntry).href);
  const resolutionOptions = {
    dependencyOwnerRoot: fakeOwner,
    repositoryRoot: fixtureRoot,
    sdkPath: candidate.sdkRoot,
  };
  const aliases = createViteAliases(resolutionOptions);
  const wsAlias = aliases.find(({ find }) => (
    typeof find === 'string' ? find === 'ws' : find.test('ws')
  ));
  const wsAliasCalls = [];
  const resolveWsAlias = wsAlias.customResolver;
  wsAlias.customResolver = async function (source, importer, resolveOptions) {
    const resolutions = [];
    const context = new Proxy(this, {
      get(target, key, receiver) {
        if (key === 'resolve') return (...args) => {
          resolutions.push(args[0]);
          return Reflect.apply(target.resolve, target, args);
        };
        return Reflect.get(target, key, receiver);
      },
    });
    const result = await resolveWsAlias.call(context, source, importer, resolveOptions);
    wsAliasCalls.push({ source, importer, resolutions });
    return result;
  };
  const buildResult = await vite.build({
    configFile: false,
    root: fixtureRoot,
    resolve: { alias: aliases },
    build: {
      target: 'es2022',
      outDir: outputRoot,
      emptyOutDir: true,
      rollupOptions: { input: { browserServer: browserSource, selectionCopy: frontendSource, subagentProfiles: subagentSource } },
    },
  });
  const output = Array.isArray(buildResult) ? buildResult[0] : buildResult;
  const browserFile = output.output.find((item) => item.name === 'browserServer' && item.isEntry).fileName;
  const frontendFile = output.output.find((item) => item.name === 'selectionCopy' && item.isEntry).fileName;
  const subagentFile = output.output.find((item) => item.name === 'subagentProfiles' && item.isEntry).fileName;
  await import(pathToFileURL(path.join(outputRoot, browserFile)).href);
  await import(pathToFileURL(path.join(outputRoot, frontendFile)).href);
  await import(pathToFileURL(path.join(outputRoot, subagentFile)).href);
  const runtimeWsCall = wsAliasCalls.find(({ importer }) => importer
    && importer.toLowerCase().includes('/candidate-workspace/packages/candidate-runtime/index.js'));
  assert.ok(runtimeWsCall, `candidate runtime's ws import must pass through its importer-aware owner alias: ${JSON.stringify(wsAliasCalls)}`);
  assert.ok(runtimeWsCall.resolutions.some((target) => (
    target.replace(/[\\/]/gu, '/').toLowerCase().includes('/candidate-workspace/node_modules/ws/browser.js')
  )), `candidate runtime ws must resolve from the selected artifact, not the owner: ${JSON.stringify(runtimeWsCall)}`);
  assert.deepEqual(globalThis.__candidateViteBrowserProof, [
    'host ws', 'candidate root transitive', 'nested candidate transitive', 'candidate ws browser',
    'candidate extensionless subpath', 'host yaml',
  ]);
  assert.equal(globalThis.__candidateViteFrontendProof, 'host marked');
  assert.deepEqual(globalThis.__candidateViteSubagentProof, ['candidate root transitive', 'host yaml']);

  const runtimeAlias = aliases.find(({ find }) => (
    typeof find === 'string' ? find === 'candidate-runtime/missing' : find.test('candidate-runtime/missing')
  ));
  const missingTarget = path.join(candidate.roots['candidate-runtime'], 'missing');
  const missingImporter = path.join(applicationRoot, 'frontend', 'missing-import.ts');
  const resolveCalls = [];
  await assert.rejects(runtimeAlias.customResolver.call({
    async resolve(...args) {
      resolveCalls.push(args);
      return null;
    },
  }, missingTarget, missingImporter),
  /Candidate SDK package candidate-runtime could not resolve Pie-source import candidate-runtime\/missing/);
  assert.deepEqual(resolveCalls, [[missingTarget, missingImporter, { skipSelf: true }]]);
});

test('candidate overlays add SDK and TypeBox aliases across inherited paths without aliasing candidate dependencies to the host', (t) => {
  const { fixtureRoot } = makeFixture(t);
  const candidate = makeSdkCandidateGraph(fixtureRoot);
  const fakeOwner = makeCandidateOwner(fixtureRoot);
  const configRoot = path.join(fixtureRoot, 'configs');
  const configChild = path.join(configRoot, 'child');
  mkdirSync(configChild, { recursive: true });
  const inheritedConfig = path.join(configRoot, 'tsconfig.shared.json');
  const baseConfig = path.join(configChild, 'tsconfig.json');
  writeFileSync(inheritedConfig, JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: {
        'local-inherited-alias': ['./local.js'],
        '@mariozechner/pi-ai/compat': ['./old-sdk-placeholder.js'],
        yaml: ['./host-yaml.d.ts'],
        'yaml/browser': ['./host-yaml-browser.d.ts'],
        'yaml/browser/*': ['./host-yaml/browser/*.d.ts'],
        'yaml/*': ['./host-yaml/*.d.ts'],
        immer: ['./host-immer.d.ts'],
        'immer/*': ['./host-immer/*.d.ts'],
        preact: ['./host-preact.d.ts'],
        'preact/*': ['./host-preact/*.d.ts'],
        'preact/hooks': ['./host-preact-hooks.d.ts'],
      },
    },
  }, null, 2));
  writeFileSync(baseConfig, JSON.stringify({ extends: '../tsconfig.shared.json' }, null, 2));

  const overlay = createTsconfigOverlay(baseConfig, {
    dependencyOwnerRoot: fakeOwner,
    sdkPath: candidate.sdkRoot,
    includeOwnerDependencies: true,
    typescript: true,
  });
  t.after(() => overlay.dispose());
  const paths = JSON.parse(readFileSync(overlay.configPath, 'utf8')).compilerOptions.paths;
  assert.deepEqual(paths['local-inherited-alias'], [path.join(configRoot, 'local.js')]);
  assert.equal(paths['@mariozechner/pi-ai/compat'][0],
    path.join(candidate.roots['@earendil-works/pi-ai'], 'dist', 'compat.d.ts'));
  assert.deepEqual(paths.yaml, [path.join(candidate.roots.yaml, 'dist', 'index.d.ts')]);
  assert.deepEqual(paths['yaml/browser'], [path.join(candidate.roots.yaml, 'dist', 'browser.d.ts')]);
  assert.deepEqual(paths['yaml/browser/*'], [path.join(candidate.roots.yaml, 'dist', 'browser', '*.d.ts')]);
  assert.deepEqual(paths['yaml/*'], [path.join(candidate.roots.yaml, 'dist', '*.d.ts')]);
  assert.deepEqual(paths.immer, [path.join(candidate.roots.immer, 'dist', 'index.d.ts')]);
  assert.deepEqual(paths['immer/*'], [path.join(candidate.roots.immer, 'dist', '*.d.ts')]);
  assert.deepEqual(paths.preact, [path.join(candidate.roots.preact, 'dist', 'index.d.ts')],
    'candidate runtime Preact wins the inherited and owner Preact alias');
  assert.deepEqual(paths['preact/*'], [path.join(candidate.roots.preact, 'dist', '*.d.ts')]);
  assert.deepEqual(paths['preact/hooks'], [path.join(candidate.roots.preact, 'dist', 'hooks.d.ts')]);

  for (const name of [
    '@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent',
    '@earendil-works/pi-agent-core', '@mariozechner/pi-agent-core',
    '@earendil-works/pi-ai', '@mariozechner/pi-ai',
    '@earendil-works/pi-tui', '@mariozechner/pi-tui', 'typebox', '@sinclair/typebox',
  ]) {
    assert.ok(paths[name]?.[0], `candidate overlay includes ${name} even though the base does not declare it`);
    const root = name.includes('pi-coding-agent') ? candidate.sdkRoot
      : name.includes('pi-agent-core') ? candidate.roots['@earendil-works/pi-agent-core']
        : name.includes('pi-ai') ? candidate.roots['@earendil-works/pi-ai']
          : name.includes('pi-tui') ? candidate.roots['@earendil-works/pi-tui'] : candidate.roots.typebox;
    assert.ok(paths[name][0].startsWith(root), `${name} points into the candidate graph`);
  }
  assert.equal(paths['candidate-runtime'], undefined,
    'compiler declaration resolution is unchanged by executable import aliases');
  assert.equal(paths['candidate-transitive'], undefined,
    'multiple transitive roots must not be flattened by direct owner aliases');
  assert.equal(paths.ws, undefined, 'compiler keeps declaration/@types lookup rather than a JS-only alias');
  assert.ok(paths['owner-tool'][0].startsWith(path.join(fakeOwner, 'node_modules', 'owner-tool')));
  assert.ok(paths.preact[0].startsWith(candidate.roots.preact), 'candidate Preact is not split from the SDK graph');
});

test('direct owner imports missing from the candidate graph never retain the installed copy', (t) => {
  const { fixtureRoot, sourceRoot } = makeFixture(t);
  const candidate = makeSdkCandidateGraph(fixtureRoot);
  const fakeOwner = makeCandidateOwner(fixtureRoot);
  rmSync(candidate.roots.ws, { recursive: true, force: true });
  assert.throws(() => createTsconfigOverlay(writeTsConfig(sourceRoot, {}), {
    dependencyOwnerRoot: fakeOwner,
    sdkPath: candidate.sdkRoot,
    includeOwnerDependencies: true,
  }), /Candidate SDK graph.*cannot resolve Pie-source import ws/);
});

test('explicit sdkPath fails on invalid or incomplete candidate graphs instead of falling back to the owner', (t) => {
  const { fixtureRoot } = makeFixture(t);
  const fakeOwner = makeCandidateOwner(fixtureRoot);
  assert.throws(() => resolveSdkPackages({ sdkPath: 'relative/candidate', dependencyOwnerRoot: fakeOwner }), /sdkPath must be an absolute path/);
  assert.throws(() => resolveSdkPackages({ sdkPath: path.join(fixtureRoot, 'missing'), dependencyOwnerRoot: fakeOwner }),
    /Expected @earendil-works\/pi-coding-agent package manifest/);

  const incomplete = makeSdkCandidateGraph(fixtureRoot, { omit: ['@earendil-works/pi-ai'] });
  assert.throws(() => resolveSdkPackages({ sdkPath: incomplete.sdkRoot, dependencyOwnerRoot: fakeOwner }),
    /Candidate SDK graph.*cannot resolve @earendil-works\/pi-ai/);
});

test('candidate Pi package owners must resolve one coherent TypeBox instance', (t) => {
  const { fixtureRoot } = makeFixture(t);
  const candidate = makeSdkCandidateGraph(fixtureRoot);
  const nestedTypebox = writeFixturePackage(path.join(candidate.roots['@earendil-works/pi-ai'], 'node_modules'), 'typebox', {
    main: './index.js',
  }, { 'index.js': 'module.exports = {};' });
  assert.ok(existsSync(path.join(nestedTypebox, 'package.json')));

  assert.throws(() => resolveSdkPackages({ sdkPath: candidate.sdkRoot }),
    /Incoherent SDK TypeBox resolution: @earendil-works\/pi-ai resolves typebox at .* but @earendil-works\/pi-coding-agent resolves it at/);
});

test('candidate Pi owners reject declared dependencies resolved to divergent nested package roots', (t) => {
  const { fixtureRoot } = makeFixture(t);
  const candidate = makeSdkCandidateGraph(fixtureRoot);
  const agentManifestPath = path.join(candidate.roots['@earendil-works/pi-agent-core'], 'package.json');
  const agentManifest = JSON.parse(readFileSync(agentManifestPath, 'utf8'));
  agentManifest.dependencies['@earendil-works/pi-ai'] = '*';
  writeFileSync(agentManifestPath, JSON.stringify(agentManifest, null, 2));
  const competingPiAi = writeFixturePackage(
    path.join(candidate.roots['@earendil-works/pi-agent-core'], 'node_modules'),
    '@earendil-works/pi-ai',
    { main: './index.js' },
    { 'index.js': 'module.exports = {};' },
  );

  assert.throws(() => resolveSdkPackages({ sdkPath: candidate.sdkRoot }),
    (error) => error.message.includes('Incoherent SDK Pi package resolution: @earendil-works/pi-agent-core resolves @earendil-works/pi-ai')
      && error.message.includes(realpathSync(competingPiAi))
      && error.message.includes(realpathSync(candidate.roots['@earendil-works/pi-ai'])));
});

test('candidate overlays leave unaliased nested dependencies native and reject ambiguous exposed dependencies', (t) => {
  const { fixtureRoot, sourceRoot } = makeFixture(t);
  const candidate = makeSdkCandidateGraph(fixtureRoot);
  const fakeOwner = makeCandidateOwner(fixtureRoot);
  const sdkManifestPath = path.join(candidate.sdkRoot, 'package.json');
  const sdkManifest = JSON.parse(readFileSync(sdkManifestPath, 'utf8'));
  sdkManifest.dependencies['proper-lockfile'] = '*';
  sdkManifest.dependencies.harness = '*';
  writeFileSync(sdkManifestPath, JSON.stringify(sdkManifest, null, 2));

  const properLockfile = writeFixturePackage(path.join(candidate.sdkRoot, 'node_modules'), 'proper-lockfile', {
    dependencies: { retry: '*' },
  });
  writeFixturePackage(path.join(properLockfile, 'node_modules'), 'retry', {
    version: '1.0.0', main: './index.js',
  }, { 'index.js': 'module.exports = { version: 1 };' });
  const harness = writeFixturePackage(path.join(candidate.sdkRoot, 'node_modules'), 'harness', {
    dependencies: { pi: '*' },
  });
  const pi = writeFixturePackage(path.join(harness, 'node_modules'), 'pi', {
    dependencies: { retry: '*' },
  });
  writeFixturePackage(path.join(pi, 'node_modules'), 'retry', {
    version: '2.0.0', main: './index.js',
  }, { 'index.js': 'module.exports = { version: 2 };' });

  const baseConfig = writeTsConfig(sourceRoot, {});
  const overlay = createTsconfigOverlay(baseConfig, {
    dependencyOwnerRoot: fakeOwner,
    sdkPath: candidate.sdkRoot,
    includeOwnerDependencies: true,
  });
  t.after(() => overlay.dispose());
  const paths = JSON.parse(readFileSync(overlay.configPath, 'utf8')).compilerOptions.paths;
  assert.equal(paths.retry, undefined, 'unaliased nested retry versions remain resolvable by candidate package ancestry');
  assert.equal(paths['candidate-transitive'], undefined,
    'multiple transitive roots remain native instead of being flattened');
  assert.deepEqual(paths.ws, [path.join(candidate.roots.ws, 'index.js')]);
  assert.deepEqual(paths.yaml, [path.join(candidate.roots.yaml, 'dist', 'node.cjs')],
    'Node runtime overlays prefer the node export over the browser-oriented default');
  assert.deepEqual(paths['candidate-runtime'], [path.join(candidate.roots['candidate-runtime'], 'index.js')]);

  const entry = path.join(sourceRoot, 'candidate-imports.ts');
  writeFileSync(entry, [
    "import { marker } from 'ws';",
    "import { marker as yamlMarker } from 'yaml';",
    "import { nestedVersion } from 'candidate-runtime';",
    'console.log(JSON.stringify([marker, nestedVersion, yamlMarker]));',
  ].join('\n'));
  assert.deepEqual(JSON.parse(runNode([tsxCli, '--tsconfig', overlay.configPath, entry], sourceRoot)),
    ['candidate ws', 'nested candidate transitive', 'candidate yaml node'],
    'ordinary Pie imports use the artifact while package issuers retain their nested versions');

  const retryAliasConfig = writeTsConfig(sourceRoot, { paths: { retry: ['./host-retry.js'] } });
  const overlayDirectories = () => new Set(readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('pie-tsx-overlay-')));
  const beforeFailure = overlayDirectories();
  assert.throws(() => createTsconfigOverlay(retryAliasConfig, {
    dependencyOwnerRoot: fakeOwner,
    sdkPath: candidate.sdkRoot,
    includeOwnerDependencies: true,
  }), (error) => error.message.includes('Ambiguous candidate SDK runtime dependency retry:')
    && error.message.includes('proper-lockfile')
    && error.message.includes(`${path.join('harness', 'node_modules', 'pi')}`));
  assert.deepEqual(overlayDirectories(), beforeFailure, 'failed overlay generation removes its owned temporary directory');
});

test('resolveOwnerModule forces canonical SDK identity even when the owner hoists a competitor copy', (t) => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-package-resolution-hoisted-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const candidate = makeSdkCandidateGraph(fixtureRoot);
  // Native realpath identity assertions need actual fixture entry files.
  for (const [root, entry] of [
    [candidate.roots.typebox, 'build/index.mjs'],
    [candidate.roots['@earendil-works/pi-ai'], 'dist/index.js'],
    [candidate.roots['@earendil-works/pi-ai'], 'dist/compat.js'],
  ]) {
    const entryPath = path.join(root, entry);
    mkdirSync(path.dirname(entryPath), { recursive: true });
    writeFileSync(entryPath, 'export {};\n');
  }

  // Isolated fake owner links the synthetic SDK graph, preserving its nested
  // canonical identity, and hoists competitors of each sensitive spelling.
  const fixtureNodeModules = path.join(fixtureRoot, 'node_modules');
  const fixtureSdkRoot = path.join(fixtureNodeModules, '@earendil-works', 'pi-coding-agent');
  mkdirSync(path.dirname(fixtureSdkRoot), { recursive: true });
  symlinkSync(candidate.sdkRoot, fixtureSdkRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const competitorNames = ['typebox', '@sinclair/typebox', '@earendil-works/pi-ai', '@mariozechner/pi-ai', 'preact'];
  const competitors = Object.fromEntries(competitorNames.map((name) => [name, writeHoistedCompetitor(fixtureRoot, name)]));
  const fixtureOptions = { dependencyOwnerRoot: fixtureRoot, sdkPath: candidate.sdkRoot };

  // The competitors are genuinely owner-resolvable, so the old owner-first
  // resolution would have handed back these copies instead of SDK identity.
  const nativeControls = resolveNativeOwnerControls(fixtureOptions, competitorNames);
  for (const [index, name] of competitorNames.entries()) {
    assert.equal(nativeControls[index], path.join(competitors[name], 'index.js'));
  }

  // Canonical SDK nested identity wins for every identity-sensitive spelling,
  // whatever spelling or hoisted copy exists in the fake owner.
  const candidateOptions = { sdkPath: candidate.sdkRoot, dependencyOwnerRoot: fixtureRoot };
  const canonicalTypebox = realpathSync(path.join(candidate.roots.typebox, 'build/index.mjs'));
  const canonicalPiAi = realpathSync(path.join(candidate.roots['@earendil-works/pi-ai'], 'dist/index.js'));
  assert.equal(realpathSync(resolveSdkModule('typebox', candidateOptions)), canonicalTypebox);
  assert.equal(realpathSync(resolveSdkModule('@earendil-works/pi-ai', candidateOptions)), canonicalPiAi);
  assert.equal(realpathSync(resolveOwnerModule('typebox', fixtureOptions)), canonicalTypebox);
  assert.equal(realpathSync(resolveOwnerModule('@sinclair/typebox', fixtureOptions)), canonicalTypebox);
  assert.equal(realpathSync(resolveOwnerModule('@earendil-works/pi-ai', fixtureOptions)), canonicalPiAi);
  assert.equal(realpathSync(resolveOwnerModule('@mariozechner/pi-ai', fixtureOptions)), canonicalPiAi);
  assert.equal(realpathSync(resolveOwnerModule('@earendil-works/pi-ai/compat', fixtureOptions)),
    realpathSync(path.join(candidate.roots['@earendil-works/pi-ai'], 'dist', 'compat.js')));

  // No global catch-all: non-owned specifiers still resolve owner-first.
  assert.equal(resolveNativeOwnerControls(fixtureOptions, ['preact'], { helper: true })[0],
    path.join(competitors.preact, 'index.js'));
});

test('detached source and a Preact-consuming dependency share the owner require graph', { timeout: 120_000 }, async (t) => {
  const { fixtureRoot, sourceRoot } = makeFixture(t);
  const fakeOwner = path.join(fixtureRoot, 'owner');
  const modules = path.join(fakeOwner, 'node_modules');
  mkdirSync(modules, { recursive: true });
  for (const name of ['preact', 'preact-render-to-string', 'typescript']) {
    const target = path.join(modules, ...name.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(path.join(ownerRoot, 'node_modules', ...name.split('/')), target,
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  const library = path.join(modules, '@testing-library', 'preact');
  mkdirSync(library, { recursive: true });
  writeFileSync(path.join(library, 'package.json'), JSON.stringify({
    name: '@testing-library/preact',
    exports: { './hooks': { import: './hooks.mjs', require: './hooks.cjs' } },
  }));
  writeFileSync(path.join(library, 'hooks.cjs'), `
const preact = require('preact');
const hooks = require('preact/hooks');
module.exports = { ownerOptions: preact.options, useState: hooks.useState };
`);
  writeFileSync(path.join(library, 'hooks.mjs'), "throw new Error('dual-package ESM branch split the Preact hooks identity');\n");
  writeFileSync(path.join(fakeOwner, 'package.json'), JSON.stringify({ dependencies: {
    preact: '*', 'preact-render-to-string': '*', '@testing-library/preact': '*',
  } }));
  const base = writeTsConfig(sourceRoot, { types: [] });
  const sourcePath = path.join(sourceRoot, 'preact-owner-proof.tsx');
  // DOM support comes from the new owner, not an old extension install or
  // a node_modules ancestor of the detached source.
  const domEntry = createOwnerRequire({ dependencyOwnerRoot: ownerRoot }).resolve('happy-dom');
  writeFileSync(sourcePath, `
import test from 'node:test';
import { Window } from ${JSON.stringify(pathToFileURL(domEntry).href)};
const window = new Window();
globalThis.document = window.document;
import assert from 'node:assert/strict';
import { h, options, render } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import renderToString from 'preact-render-to-string';
import { ownerOptions, useState as libraryUseState } from '@testing-library/preact/hooks';
test('dependency and detached component use the same Preact singleton', () => {
  assert.equal(ownerOptions, options);
  assert.equal(libraryUseState, useState);
  const element = document.createElement('div');
  function Component() { const [value] = libraryUseState('shared'); return h('span', null, value); }
  act(() => render(h(Component, {}), element));
  assert.equal(element.textContent, 'shared');
  assert.equal(renderToString(h(Component, {})), '<span>shared</span>');
});
`);
  const overlay = createTsconfigOverlay(base, { dependencyOwnerRoot: fakeOwner, includeOwnerDependencies: true });
  t.after(() => overlay.dispose());
  const paths = JSON.parse(readFileSync(overlay.configPath, 'utf8')).compilerOptions.paths;
  const fakeRequire = createOwnerRequire({ dependencyOwnerRoot: fakeOwner });
  for (const specifier of ['preact', 'preact/hooks', 'preact/test-utils', 'preact-render-to-string', '@testing-library/preact/hooks']) {
    assert.equal(realpathSync(paths[specifier][0]), realpathSync(fakeRequire.resolve(specifier)), `${specifier} uses the require export`);
  }
  assert.equal(existsSync(path.join(sourceRoot, 'node_modules')), false);
  const group = { id: 'detached-preact-proof', cwd: sourceRoot, tsxBin: tsxCli, tsxConfig: overlay.configPath, files: [path.basename(sourcePath)] };
  assert.equal(await runGroup(group, buildTsxArgs(group)), 0);
});

test('createTsconfigOverlay preserves the base redirection set and inherits compiler options', (t) => {
  const { sourceRoot } = makeFixture(t);
  const placeholder = './does-not-resolve/index.mjs';
  const baseConfigPath = writeTsConfig(sourceRoot, {
    paths: {
      '@mariozechner/pi-ai': [placeholder],
      '@earendil-works/pi-coding-agent': [placeholder],
      'typebox/value': [placeholder],
      'custom-tool-alias': [placeholder],
      'preact/hooks': [placeholder],
    },
  });
  const overlay = createTsconfigOverlay(baseConfigPath, { dependencyOwnerRoot: ownerRoot });
  t.after(() => overlay.dispose());
  const parsed = JSON.parse(readFileSync(overlay.configPath, 'utf8'));

  // Base config semantics are inherited, never duplicated or weakened.
  assert.equal(parsed.extends, baseConfigPath);
  assert.equal(parsed.compilerOptions.strict, undefined);
  assert.equal(parsed.compilerOptions.include, undefined);
  assert.equal(parsed.compilerOptions.exclude, undefined);

  // Without an explicit SDK selection, SDK aliases are kept at their declared
  // base targets rather than redirected to the owner's installed Pi graph.
  const paths = parsed.compilerOptions.paths;
  assert.equal(Object.keys(paths).length, 5, 'overlay must not add aliases the base does not declare');
  for (const name of ['@mariozechner/pi-ai', '@earendil-works/pi-coding-agent', 'typebox/value']) {
    assert.deepEqual(paths[name], [path.resolve(sourceRoot, placeholder)], `${name} keeps its declared base target`);
  }
  assert.ok(paths['preact/hooks'][0].startsWith(path.join(ownerRoot, 'node_modules', 'preact')),
    'the existing Preact helper alias still resolves through the owner');

  // Specifiers outside the helper's model keep their base target semantics;
  // no-baseUrl paths are anchored to the declaring config, not the temp overlay.
  assert.deepEqual(paths['custom-tool-alias'], [path.resolve(sourceRoot, placeholder)]);

  // Dispose removes the private temp directory and its config.
  const overlayDirectory = overlay.directory;
  overlay.dispose();
  assert.equal(existsSync(overlayDirectory), false);
});

test('createTsconfigOverlay preserves no-baseUrl relative paths through inherited configs', { timeout: 120_000 }, (t) => {
  const { sourceRoot } = makeFixture(t);
  const configDirectory = path.join(sourceRoot, 'configs');
  const customModule = path.join(sourceRoot, 'local', 'custom.ts');
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(path.dirname(customModule), { recursive: true });
  writeFileSync(customModule, 'export const marker: string = \'resolved from declaring config\';\n');
  writeFileSync(path.join(sourceRoot, 'overlay-input.ts'), "import { marker } from 'custom-tool-alias';\nvoid marker;\n");

  const sharedConfigPath = path.join(sourceRoot, 'tsconfig.shared.json');
  writeFileSync(sharedConfigPath, JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
  }, null, 2));
  const baseConfigPath = path.join(configDirectory, 'tsconfig.json');
  writeFileSync(baseConfigPath, JSON.stringify({
    extends: '../tsconfig.shared.json',
    compilerOptions: {
      paths: {
        'custom-tool-alias': ['../local/custom.ts'],
        '@mariozechner/pi-ai': ['./unused-placeholder.ts'],
      },
    },
    include: ['../overlay-input.ts'],
  }, null, 2));

  const overlay = createTsconfigOverlay(baseConfigPath, { dependencyOwnerRoot: ownerRoot });
  t.after(() => overlay.dispose());
  const parsed = JSON.parse(readFileSync(overlay.configPath, 'utf8'));
  assert.equal(parsed.extends, baseConfigPath);
  assert.equal(parsed.compilerOptions.baseUrl, undefined, 'overlay must not introduce baseUrl semantics');
  assert.deepEqual(parsed.compilerOptions.paths['custom-tool-alias'], [customModule]);
  assert.deepEqual(Object.keys(parsed.compilerOptions.paths).sort(), ['@mariozechner/pi-ai', 'custom-tool-alias']);

  const result = spawnSync(process.execPath, [tscCli, '--project', overlay.configPath, '--pretty', 'false'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
});

test('owner dependency overlay resolves entry-less globals from a future root without changing inherited aliases or native owners', { timeout: 120_000 }, (t) => {
  const { sourceRoot } = makeFixture(t);
  const configDirectory = path.join(sourceRoot, 'configs');
  mkdirSync(configDirectory, { recursive: true });
  const baseConfigPath = writeTsConfig(sourceRoot, {});
  const inheritedPath = path.join(configDirectory, 'inherited.json');
  writeFileSync(inheritedPath, JSON.stringify({
    extends: baseConfigPath,
    compilerOptions: { types: [], paths: { 'local-alias': ['../local.ts'] } },
  }));
  const localPath = path.join(sourceRoot, 'local.ts');
  writeFileSync(localPath, 'export const local: string = "ok";\n');
  writeFileSync(path.join(sourceRoot, 'proof.ts'), "import globals from 'globals';\nimport { local } from 'local-alias';\nvoid [globals, local];\n");
  const overlay = createTsconfigOverlay(inheritedPath, { dependencyOwnerRoot: ownerRoot, includeOwnerDependencies: true, typescript: true });
  t.after(() => overlay.dispose());
  const generated = JSON.parse(readFileSync(overlay.configPath, 'utf8'));
  const paths = generated.compilerOptions.paths;
  assert.equal(generated.compilerOptions.types, undefined, 'inherited types: [] must stay explicit');
  assert.deepEqual(generated.compilerOptions.typeRoots, createTypeScriptResolution({ dependencyOwnerRoot: ownerRoot }).typeRoots,
    'do not expose all package types when vite/client is not requested');
  assert.equal(paths.globals[0], path.join(ownerRoot, 'node_modules', 'globals', 'index.d.ts'));
  assert.deepEqual(paths['local-alias'], [localPath]);
  for (const name of ['computer-use', 'playwright', 'vscode', 'node:fs']) {
    assert.equal(paths[name], undefined, `${name} belongs to its native owner`);
  }
  runNode([tscCli, '--project', overlay.configPath, '--pretty', 'false'], sourceRoot);
});

test('owner dependency overlays resolve base-aliased packages for dynamic imports from relocated source', { timeout: 120_000 }, async (t) => {
  const { sourceRoot } = makeFixture(t);
  const sourcePath = path.join(sourceRoot, 'dynamic-owner-import.test.ts');
  writeFileSync(sourcePath, `
import assert from 'node:assert/strict';
import test from 'node:test';
test('dynamic package import resolves through the dependency owner', async () => {
  const { produce } = await import('immer');
  assert.equal(produce({ value: 0 }, draft => { draft.value = 1; }).value, 1);
});
`);
  const overlay = createTsconfigOverlay(path.join(ownerRoot, 'tsconfig.json'), {
    dependencyOwnerRoot: ownerRoot,
    includeOwnerDependencies: true,
  });
  t.after(() => overlay.dispose());
  const paths = JSON.parse(readFileSync(overlay.configPath, 'utf8')).compilerOptions.paths;
  assert.equal(paths.immer[0], path.join(ownerRoot, 'node_modules', 'immer', 'dist', 'immer.mjs'));

  const group = {
    id: 'owner-dynamic-import-proof',
    cwd: sourceRoot,
    tsxBin: tsxCli,
    tsxConfig: overlay.configPath,
    files: [path.basename(sourcePath)],
  };
  assert.equal(await runGroup(group, buildTsxArgs(group)), 0);
});

test('owner dependency overlay resolves inherited node, vscode, and vite/client types for detached source', { timeout: 120_000 }, (t) => {
  const { sourceRoot } = makeFixture(t);
  const extraTypes = path.join(sourceRoot, 'extra-types');
  mkdirSync(path.join(extraTypes, 'local-global'), { recursive: true });
  writeFileSync(path.join(extraTypes, 'local-global', 'index.d.ts'), 'declare const localGlobal: string;\n');
  writeFileSync(path.join(sourceRoot, 'proof.ts'), `
import type { ExtensionContext } from 'vscode';
import type { ReadStream } from 'node:fs';
import { WebSocket } from 'ws';
import { encode } from 'gpt-tokenizer/encoding/cl100k_base';
import { Window } from 'happy-dom';
declare const context: ExtensionContext;
declare const stream: ReadStream;
void [context, stream, import.meta.env.MODE, localGlobal, WebSocket, encode, Window];
`);
  const inherited = path.join(sourceRoot, 'inherited.json');
  writeFileSync(inherited, JSON.stringify({
    compilerOptions: { typeRoots: ['./extra-types'], types: ['local-global', 'node', 'vscode', 'vite/client'] },
  }));
  const configPath = path.join(sourceRoot, 'tsconfig.json');
  writeFileSync(configPath, JSON.stringify({
    extends: './inherited.json',
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true, strict: true, skipLibCheck: true },
    include: ['./proof.ts'],
  }));
  const overlay = createTsconfigOverlay(configPath, { dependencyOwnerRoot: ownerRoot, includeOwnerDependencies: true, typescript: true });
  t.after(() => overlay.dispose());
  const generated = JSON.parse(readFileSync(overlay.configPath, 'utf8'));
  assert.equal(generated.compilerOptions.types, undefined, 'do not replace inherited explicit types');
  assert.ok(generated.compilerOptions.typeRoots.includes(extraTypes), 'preserve inherited type roots');
  assert.ok(generated.compilerOptions.typeRoots.includes(path.join(ownerRoot, 'node_modules', '@types')));
  assert.ok(generated.compilerOptions.typeRoots.includes(path.join(ownerRoot, 'node_modules')), 'vite/client is a package subpath');
  assert.equal(generated.compilerOptions.paths.ws[0], path.join(ownerRoot, 'node_modules', '@types', 'ws', 'index.d.ts'));
  assert.equal(generated.compilerOptions.paths['gpt-tokenizer/*'][0], path.join(ownerRoot, 'node_modules', 'gpt-tokenizer', 'esm', '*.d.ts'));
  runNode([tscCli, '--project', overlay.configPath, '--pretty', 'false'], sourceRoot);
});

test('owner dependency overlay validates installed manifests but does not invent roots for config-only or subpath-only packages', (t) => {
  const { fixtureRoot, sourceRoot } = makeFixture(t);
  const fakeOwner = path.join(fixtureRoot, 'owner');
  const modules = path.join(fakeOwner, 'node_modules');
  mkdirSync(modules, { recursive: true });
  for (const name of ['preact', 'typescript']) {
    const from = path.join(ownerRoot, 'node_modules', ...name.split('/'));
    const to = path.join(modules, ...name.split('/'));
    mkdirSync(path.dirname(to), { recursive: true });
    symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const packageAt = (name, manifest) => {
    const directory = path.join(modules, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, ...manifest }));
    return directory;
  };
  packageAt('config-only', {});
  const subpath = packageAt('subpath-only', { main: './missing.js', exports: { './feature': './feature.js' } });
  writeFileSync(path.join(subpath, 'feature.js'), 'module.exports = 1;\n');
  const ownerManifest = path.join(fakeOwner, 'package.json');
  writeFileSync(ownerManifest, JSON.stringify({ dependencies: { 'config-only': '1', 'subpath-only': '1' } }));
  const base = writeTsConfig(sourceRoot, {});
  const makeOverlay = () => createTsconfigOverlay(base, { dependencyOwnerRoot: fakeOwner, includeOwnerDependencies: true });
  const overlay = makeOverlay();
  t.after(() => overlay.dispose());
  const paths = JSON.parse(readFileSync(overlay.configPath, 'utf8')).compilerOptions.paths;
  assert.equal(paths['config-only'], undefined);
  assert.equal(paths['subpath-only'], undefined);
  assert.deepEqual(paths['subpath-only/feature'], [path.join(subpath, 'feature.js')]);
  writeFileSync(ownerManifest, JSON.stringify({ dependencies: { missing: '1' } }));
  assert.throws(makeOverlay, /Dependency owner graph.*cannot resolve missing through its Node module search paths/);
});

test('TypeScript overlays preserve default base-config type ancestry without owner dependency aliases', (t) => {
  const { fixtureRoot, sourceRoot } = makeFixture(t);
  const candidate = makeSdkCandidateGraph(fixtureRoot);
  const typeRoot = path.join(fixtureRoot, 'node_modules', '@types');
  writeFixturePackage(typeRoot, 'fixture-global', { types: './index.d.ts' }, {
    'index.d.ts': 'declare const fixtureGlobal: string;\n',
  });
  writeFileSync(path.join(sourceRoot, 'proof.ts'), 'const proof: string = fixtureGlobal; void proof;\n');
  const inheritedPath = path.join(sourceRoot, 'inherited.json');
  writeFileSync(inheritedPath, JSON.stringify({ compilerOptions: { types: ['fixture-global'] } }));
  const baseConfigPath = writeTsConfig(sourceRoot, {});
  const baseConfig = JSON.parse(readFileSync(baseConfigPath, 'utf8'));
  delete baseConfig.compilerOptions.types;
  baseConfig.extends = './inherited.json';
  writeFileSync(baseConfigPath, JSON.stringify(baseConfig));
  const options = { typescript: true, sdkPath: candidate.sdkRoot, dependencyOwnerRoot: ownerRoot };
  const overlay = createTsconfigOverlay(baseConfigPath, options);
  t.after(() => overlay.dispose());
  const generated = JSON.parse(readFileSync(overlay.configPath, 'utf8')).compilerOptions;
  assert.ok(generated.typeRoots.includes(typeRoot), 'base ancestry survives relocation to OS temp');
  assert.equal(generated.typeRoots.includes(path.join(ownerRoot, 'node_modules', '@types')), false,
    'includeOwnerDependencies:false does not substitute an unrelated owner');
  assert.equal(generated.types, undefined, 'inherited explicit types remain unchanged');
  assert.equal(generated.paths['candidate-transitive'], undefined, 'nested graphs are not flattened');
  runNode([tscCli, '--project', overlay.configPath, '--pretty', 'false'], sourceRoot);

  writeFileSync(inheritedPath, JSON.stringify({ compilerOptions: {
    types: ['fixture-global'], typeRoots: [typeRoot],
  } }));
  const explicitOverlay = createTsconfigOverlay(baseConfigPath, options);
  t.after(() => explicitOverlay.dispose());
  assert.equal(JSON.parse(readFileSync(explicitOverlay.configPath, 'utf8')).compilerOptions.typeRoots, undefined,
    'explicit inherited typeRoots are not overridden');
  runNode([tscCli, '--project', explicitOverlay.configPath, '--pretty', 'false'], sourceRoot);
});

test('tsconfig overlays accept JSONC comments and trailing commas without changing own or inherited paths', (t) => {
  const { sourceRoot } = makeFixture(t);
  const parentConfig = path.join(sourceRoot, 'shared.json');
  const childRoot = path.join(sourceRoot, 'child');
  mkdirSync(childRoot);
  const baseConfig = path.join(childRoot, 'tsconfig.json');
  writeFileSync(parentConfig, `{
    // Inherited aliases stay anchored to the declaring config.
    "compilerOptions": {
      "paths": { "inherited-local": ["./parent.ts",], },
      "typeRoots": ["./custom-types",],
    },
  }`);
  writeFileSync(baseConfig, `{
    /* No own paths: ordinary runtime overlays remain passthrough. */
    "extends": "../shared.json",
    "compilerOptions": { "strict": true, },
  }`);
  const options = { dependencyOwnerRoot: ownerRoot };
  const runtimeOverlay = createTsconfigOverlay(baseConfig, options);
  const inheritedOverlay = createTsconfigOverlay(baseConfig, { ...options, typescript: true, includeOwnerDependencies: true });
  t.after(() => runtimeOverlay.dispose());
  t.after(() => inheritedOverlay.dispose());
  assert.equal(JSON.parse(readFileSync(runtimeOverlay.configPath, 'utf8')).compilerOptions, undefined);
  const inherited = JSON.parse(readFileSync(inheritedOverlay.configPath, 'utf8')).compilerOptions;
  assert.deepEqual(inherited.paths['inherited-local'], [path.join(sourceRoot, 'parent.ts')]);
  assert.ok(inherited.typeRoots.includes(path.join(sourceRoot, 'custom-types')));

  writeFileSync(baseConfig, `{
    "extends": "../shared.json",
    "compilerOptions": {
      // An own paths object replaces rather than merges inherited aliases.
      "paths": { "own-local": ["./child.ts",], },
    },
  }`);
  const ownOverlay = createTsconfigOverlay(baseConfig, options);
  t.after(() => ownOverlay.dispose());
  const own = JSON.parse(readFileSync(ownOverlay.configPath, 'utf8')).compilerOptions.paths;
  assert.deepEqual(own['own-local'], [path.join(childRoot, 'child.ts')]);
  assert.equal(own['inherited-local'], undefined);
});

test('tsconfig overlays reject malformed JSONC with a config-specific parser error', (t) => {
  const { sourceRoot } = makeFixture(t);
  const baseConfig = path.join(sourceRoot, 'tsconfig.json');
  writeFileSync(baseConfig, `{
    // Comments are valid, but a missing property separator is not.
    "compilerOptions": { "strict": true "noEmit": true, },
  }`);
  for (const typescript of [false, true]) {
    assert.throws(() => createTsconfigOverlay(baseConfig, { dependencyOwnerRoot: ownerRoot, typescript }),
      (error) => error.message.includes(`Invalid tsconfig at ${baseConfig}:`)
        && error.message.includes("',' expected."));
  }
});

test('createTsconfigOverlay passes through base configs without their own paths', (t) => {
  const { sourceRoot } = makeFixture(t);
  const baseConfigPath = writeTsConfig(sourceRoot, {});
  const overlay = createTsconfigOverlay(baseConfigPath, { dependencyOwnerRoot: ownerRoot });
  t.after(() => overlay.dispose());
  const parsed = JSON.parse(readFileSync(overlay.configPath, 'utf8'));
  assert.equal(parsed.extends, baseConfigPath);
  assert.equal(parsed.compilerOptions, undefined);
  assert.throws(() => createTsconfigOverlay(path.join(sourceRoot, 'missing.json')), /Base tsconfig for overlay does not exist/);
});
