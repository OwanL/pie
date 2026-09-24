import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createOwnerRequire,
  createTypeScriptResolution,
  createTsxResolution,
  createViteAliases,
  resolveOwnerModule,
  resolvePackageRoots,
  resolveSdkModule,
  resolveSdkPackages,
} from '../lib/package-resolution.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const currentRoots = resolvePackageRoots('current');
const ownerRoot = currentRoots.dependencyOwnerRoot;
const tsxCli = path.join(ownerRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const tscCli = path.join(ownerRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const viteCli = path.join(ownerRoot, 'node_modules', 'vite', 'bin', 'vite.js');

function makeFixture(t) {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-package-resolution-'));
  const sourceRoot = path.join(fixtureRoot, 'future-source', 'harness');
  mkdirSync(sourceRoot, { recursive: true });
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  // These source roots intentionally have no node_modules, and live outside
  // the checkout so an old extension/node_modules ancestor cannot satisfy an
  // import accidentally.
  assert.equal(sourceRoot.startsWith(repoRoot), false);
  for (const ancestor of [sourceRoot, path.dirname(sourceRoot), fixtureRoot]) {
    assert.equal(existsSync(path.join(ancestor, 'node_modules')), false, `${ancestor} unexpectedly has node_modules`);
  }
  return { fixtureRoot, sourceRoot };
}

function writeTsConfig(sourceRoot, compilerOptions) {
  const configPath = path.join(sourceRoot, 'tsconfig.json');
  writeFileSync(configPath, JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      jsx: 'react-jsx',
      types: ['node'],
      ...compilerOptions,
    },
    include: ['./**/*.ts', './**/*.tsx'],
  }, null, 2));
  return configPath;
}

function runNode(args, cwd) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result.stdout.trim();
}

test('resolves current and planned package roots explicitly, and pins the SDK nested identity', () => {
  const current = resolvePackageRoots('current');
  const planned = resolvePackageRoots('planned');
  assert.equal(current.repositoryRoot, repoRoot);
  assert.equal(current.distributionRoot, path.join(repoRoot, 'extension'));
  assert.equal(current.dependencyOwnerRoot, path.join(repoRoot, 'extension'));
  assert.equal(planned.distributionRoot, path.join(repoRoot, 'application', 'hosts', 'vscode'));
  assert.equal(planned.dependencyOwnerRoot, path.join(repoRoot, 'application', 'hosts', 'vscode'));
  assert.throws(() => resolvePackageRoots('current', { repositoryRoot: '.' }), /absolute path/);

  const sdk = resolveSdkPackages({ dependencyOwnerRoot: ownerRoot });
  assert.equal(sdk.sdk.root, path.join(ownerRoot, 'node_modules', '@earendil-works', 'pi-coding-agent'));
  assert.equal(sdk.piAi.root, path.join(sdk.sdk.root, 'node_modules', '@earendil-works', 'pi-ai'));
  assert.equal(resolveOwnerModule('preact/jsx-runtime', { dependencyOwnerRoot: ownerRoot }),
    path.join(ownerRoot, 'node_modules', 'preact', 'jsx-runtime', 'dist', 'jsxRuntime.js'));
  assert.equal(resolveSdkModule('@earendil-works/pi-ai/compat', { dependencyOwnerRoot: ownerRoot }),
    path.join(sdk.piAi.root, 'dist', 'compat.js'));
  assert.equal(resolveSdkModule('@mariozechner/pi-ai/providers/all', { dependencyOwnerRoot: ownerRoot }),
    path.join(sdk.piAi.root, 'dist', 'providers', 'all.js'));
  assert.equal(createOwnerRequire({ dependencyOwnerRoot: ownerRoot }).resolve('preact'),
    path.join(ownerRoot, 'node_modules', 'preact', 'dist', 'preact.js'));
});

function writeHoistedCompetitor(fixtureRoot, packageName) {
  const packageRoot = path.join(fixtureRoot, 'node_modules', ...packageName.split('/'));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: packageName,
    version: '0.0.0-hoisted-competitor',
    main: './index.js',
  }, null, 2));
  writeFileSync(path.join(packageRoot, 'index.js'),
    `module.exports = { marker: ${JSON.stringify(`${packageName}@0.0.0-hoisted-competitor`)} };\n`);
  return packageRoot;
}

test('resolveOwnerModule forces canonical SDK identity even when the owner hoists a competitor copy', (t) => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-package-resolution-hoisted-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const realSdk = resolveSdkPackages({ dependencyOwnerRoot: ownerRoot });

  // Isolated fake owner outside the checkout: it links the real SDK package
  // (junction/symlink, so the SDK's private nested graph stays canonical) and
  // hoists competitor copies of every identity-sensitive spelling.
  const fixtureNodeModules = path.join(fixtureRoot, 'node_modules');
  const fixtureSdkRoot = path.join(fixtureNodeModules, '@earendil-works', 'pi-coding-agent');
  mkdirSync(path.dirname(fixtureSdkRoot), { recursive: true });
  symlinkSync(realSdk.sdk.root, fixtureSdkRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const competitorNames = ['typebox', '@sinclair/typebox', '@earendil-works/pi-ai', '@mariozechner/pi-ai', 'preact'];
  const competitors = Object.fromEntries(competitorNames.map((name) => [name, writeHoistedCompetitor(fixtureRoot, name)]));
  const fixtureOptions = { dependencyOwnerRoot: fixtureRoot };

  // The competitors are genuinely owner-resolvable, so the old owner-first
  // resolution would have handed back these copies instead of SDK identity.
  const ownerRequire = createOwnerRequire(fixtureOptions);
  for (const [name, packageRoot] of Object.entries(competitors)) {
    assert.equal(ownerRequire.resolve(name), path.join(packageRoot, 'index.js'));
  }

  // Canonical SDK nested identity wins for every identity-sensitive spelling,
  // whatever spelling or hoisted copy exists in the fake owner.
  const realOwnerOptions = { dependencyOwnerRoot: ownerRoot };
  const canonicalTypebox = realpathSync(resolveSdkModule('typebox', realOwnerOptions));
  const canonicalPiAi = realpathSync(resolveSdkModule('@earendil-works/pi-ai', realOwnerOptions));
  assert.equal(realpathSync(resolveOwnerModule('typebox', fixtureOptions)), canonicalTypebox);
  assert.equal(realpathSync(resolveOwnerModule('@sinclair/typebox', fixtureOptions)), canonicalTypebox);
  assert.equal(realpathSync(resolveOwnerModule('@earendil-works/pi-ai', fixtureOptions)), canonicalPiAi);
  assert.equal(realpathSync(resolveOwnerModule('@mariozechner/pi-ai', fixtureOptions)), canonicalPiAi);
  assert.equal(realpathSync(resolveOwnerModule('@earendil-works/pi-ai/compat', fixtureOptions)),
    realpathSync(path.join(realSdk.piAi.root, 'dist', 'compat.js')));

  // No global catch-all: non-owned specifiers still resolve owner-first.
  assert.equal(resolveOwnerModule('preact', fixtureOptions), path.join(competitors.preact, 'index.js'));
});

test('the real TypeScript compiler resolves future TSX roots, owner type roots, Pi aliases, and Preact subpaths', { timeout: 120_000 }, (t) => {
  const { sourceRoot } = makeFixture(t);
  const sourcePath = path.join(sourceRoot, 'compiler-proof.tsx');
  writeFileSync(sourcePath, `
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI as LegacyExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import type { Model as LegacyModel } from '@mariozechner/pi-ai';
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
const types: [ExtensionAPI, LegacyExtensionAPI, Model<any>, LegacyModel<any>] | undefined = undefined;
void [schema, element, component, types];
`);
  const configPath = writeTsConfig(sourceRoot, createTypeScriptResolution({ dependencyOwnerRoot: ownerRoot }));
  const result = spawnSync(process.execPath, [tscCli, '--project', configPath, '--pretty', 'false'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
});

test('the real Vite bundler consumes owner aliases for Preact JSX and subpaths from a future source root', { timeout: 120_000 }, (t) => {
  const { fixtureRoot, sourceRoot } = makeFixture(t);
  const sourcePath = path.join(sourceRoot, 'bundle-proof.tsx');
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
  const helperUrl = pathToFileURL(fileURLToPath(new URL('../lib/package-resolution.mjs', import.meta.url))).href;
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

test('the repository-local tsx CLI resolves runtime aliases without npx or fixture ancestry', { timeout: 120_000 }, (t) => {
  const { sourceRoot } = makeFixture(t);
  const sourcePath = path.join(sourceRoot, 'tsx-proof.ts');
  writeFileSync(sourcePath, `
import { Type } from '@earendil-works/pi-ai';
import { Type as LegacyType } from '@mariozechner/pi-ai';
import { Type as Typebox } from 'typebox';
import { Type as SinclairType } from '@sinclair/typebox';
import { useState } from 'preact/hooks';
import { jsx } from 'preact/jsx-runtime';
console.log(JSON.stringify({
  samePiIdentity: Type.Object === LegacyType.Object,
  sameTypeboxIdentity: Typebox.Object === SinclairType.Object,
  preact: typeof useState === 'function' && typeof jsx === 'function',
}));
`);
  const configPath = writeTsConfig(sourceRoot, {
    ...createTsxResolution({ dependencyOwnerRoot: ownerRoot }),
    jsx: 'react-jsx',
    jsxImportSource: 'preact',
  });
  assert.equal(existsSync(tsxCli), true);
  const output = runNode([tsxCli, '--tsconfig', configPath, sourcePath], sourceRoot);
  assert.deepEqual(JSON.parse(output), {
    samePiIdentity: true,
    sameTypeboxIdentity: true,
    preact: true,
  });
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
  const { sdk } = resolveSdkPackages({ dependencyOwnerRoot: ownerRoot });
  const loaderPath = path.join(sdk.root, 'dist', 'core', 'extensions', 'loader.js');
  const loader = await import(pathToFileURL(loaderPath).href);
  const result = await loader.loadExtensions([extensionPath], sourceRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.equal(result.extensions[0].commands.get('package-resolution-proof').description, 'true,true,true,true,true');
});
