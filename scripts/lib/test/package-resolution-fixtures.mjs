import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnerRequire, resolvePackageRoots } from '../package-resolution.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const currentRoots = resolvePackageRoots('current');
export const ownerRoot = currentRoots.dependencyOwnerRoot;
export const tsxCli = path.join(ownerRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
export const tscCli = path.join(ownerRoot, 'node_modules', 'typescript', 'bin', 'tsc');
export const viteCli = path.join(ownerRoot, 'node_modules', 'vite', 'bin', 'vite.js');
export const viteNodeEntry = path.join(ownerRoot, 'node_modules', 'vite', 'dist', 'node', 'index.js');

// SDK-neutral fixture utilities are shared by the ordinary and artifact test files.
export function makeFixture(t) {
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

export function writeTsConfig(sourceRoot, compilerOptions) {
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

export function runNode(args, cwd) {
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

export function resolveNativeOwnerControls(options, specifiers, { helper = false } = {}) {
  // Observe native owner lookup outside the outer TSX candidate-alias hooks.
  // spawnSync starts Node without forwarding process.execArgv; retain the
  // environment so external-network denial preloads still apply.
  const helperUrl = new URL('../package-resolution.mjs', import.meta.url).href;
  return JSON.parse(runNode(['--input-type=module', '--eval', `
import { createOwnerRequire, resolveOwnerModule } from ${JSON.stringify(helperUrl)};
const options = ${JSON.stringify(options)};
const ownerRequire = createOwnerRequire(options);
console.log(JSON.stringify(${JSON.stringify(specifiers)}.map((name) => ${helper
    ? 'resolveOwnerModule(name, options)' : 'ownerRequire.resolve(name)'})));
`], options.dependencyOwnerRoot));
}

export function writeFixturePackage(modulesRoot, name, manifest = {}, files = {}) {
  const packageRoot = path.join(modulesRoot, ...name.split('/'));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name, ...manifest }, null, 2));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(packageRoot, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return packageRoot;
}

export function makeSdkCandidateGraph(fixtureRoot, { omit = [] } = {}) {
  const workspaceRoot = path.join(fixtureRoot, 'candidate-workspace');
  const sdkRoot = path.join(workspaceRoot, 'packages', 'coding-agent');
  const sdkManifest = {
    name: '@earendil-works/pi-coding-agent',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './rpc-entry': { import: './dist/rpc-entry.js' },
    },
    dependencies: {
      '@earendil-works/pi-agent-core': '*',
      '@earendil-works/pi-ai': '*',
      '@earendil-works/pi-tui': '*',
      typebox: '*',
      'candidate-runtime': '*',
      ws: '*',
      marked: '*',
      yaml: '*',
      immer: '*',
      preact: '*',
    },
  };
  mkdirSync(sdkRoot, { recursive: true });
  writeFileSync(path.join(sdkRoot, 'package.json'), JSON.stringify(sdkManifest, null, 2));

  const simpleExports = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } };
  const agentRoot = writeFixturePackage(path.join(workspaceRoot, 'node_modules'), '@earendil-works/pi-agent-core', {
    type: 'module', exports: simpleExports, dependencies: { 'candidate-transitive': '*' },
  });
  const aiRoot = writeFixturePackage(path.join(sdkRoot, 'node_modules'), '@earendil-works/pi-ai', {
    type: 'module', exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './compat': { types: './dist/compat.d.ts', import: './dist/compat.js' },
      './providers/*': { types: './dist/providers/*.d.ts', import: './dist/providers/*.js' },
    },
  });
  const tuiRoot = writeFixturePackage(path.join(workspaceRoot, 'packages', 'node_modules'), '@earendil-works/pi-tui', {
    type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
  });
  const typeboxRoot = writeFixturePackage(path.join(workspaceRoot, 'node_modules'), 'typebox', {
    type: 'module', exports: {
      '.': { types: './build/index.d.ts', import: './build/index.mjs' },
      './value': { types: './build/value/index.d.ts', import: './build/value/index.mjs' },
    },
  });
  const runtimeRoot = writeFixturePackage(path.join(workspaceRoot, 'packages'), 'candidate-runtime', {
    type: 'module', main: './index.js', dependencies: { 'candidate-transitive': '*' },
  }, {
    'index.js': "export { version as nestedVersion } from 'candidate-transitive';",
    'lib/core.js': "export const marker = 'candidate extensionless subpath';",
  });
  symlinkSync(runtimeRoot, path.join(workspaceRoot, 'node_modules', 'candidate-runtime'),
    process.platform === 'win32' ? 'junction' : 'dir');
  writeFixturePackage(path.join(runtimeRoot, 'node_modules'), 'candidate-transitive', {
    type: 'module', main: './index.js',
  }, { 'index.js': "export const version = 'nested candidate transitive';" });
  const wsRoot = writeFixturePackage(path.join(workspaceRoot, 'node_modules'), 'ws', {
    type: 'module', exports: { '.': { browser: './browser.js', import: './index.js' } },
  }, { 'browser.js': "export const marker = 'candidate ws browser';", 'index.js': "export const marker = 'candidate ws';" });
  const markedRoot = writeFixturePackage(path.join(workspaceRoot, 'node_modules'), 'marked', {
    type: 'module', exports: { '.': { browser: './browser.js', import: './index.js' } },
  }, { 'browser.js': "export const marker = 'candidate marked browser';", 'index.js': "export const marker = 'candidate marked';" });
  const yamlRoot = writeFixturePackage(path.join(sdkRoot, 'node_modules'), 'yaml', {
    type: 'module', exports: {
      '.': { types: './dist/index.d.ts', node: './dist/node.cjs', default: './dist/browser.mjs' },
      './*': { types: './dist/*.d.ts', node: './dist/*.cjs', default: './dist/*.mjs' },
    },
  }, {
    'dist/browser.mjs': "export const marker = 'candidate yaml browser';",
    'dist/node.cjs': "module.exports = { marker: 'candidate yaml node' };",
  });
  const immerRoot = writeFixturePackage(path.join(sdkRoot, 'node_modules'), 'immer', {
    type: 'module', exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.mjs' },
      './*': { types: './dist/*.d.ts', import: './dist/*.mjs' },
    },
  });
  const preactRoot = writeFixturePackage(path.join(sdkRoot, 'node_modules'), 'preact', {
    type: 'module', exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.mjs', require: './dist/index.cjs' },
      './*': { types: './dist/*.d.ts', import: './dist/*.mjs', require: './dist/*.cjs' },
    },
  });
  const transitiveRoot = writeFixturePackage(path.join(workspaceRoot, 'node_modules'), 'candidate-transitive', {
    type: 'module', main: './index.js',
  }, { 'index.js': "export const version = 'candidate root transitive';" });
  const roots = {
    '@earendil-works/pi-coding-agent': sdkRoot,
    '@earendil-works/pi-agent-core': agentRoot,
    '@earendil-works/pi-ai': aiRoot,
    '@earendil-works/pi-tui': tuiRoot,
    typebox: typeboxRoot,
    'candidate-runtime': runtimeRoot,
    'candidate-transitive': transitiveRoot,
    ws: wsRoot,
    marked: markedRoot,
    yaml: yamlRoot,
    immer: immerRoot,
    preact: preactRoot,
  };
  for (const name of omit) {
    rmSync(roots[name], { recursive: true, force: true });
  }
  return { workspaceRoot, sdkRoot, roots };
}

export function makeCandidateOwner(fixtureRoot) {
  const fakeOwnerRoot = path.join(fixtureRoot, 'candidate-owner');
  const modulesRoot = path.join(fakeOwnerRoot, 'node_modules');
  mkdirSync(modulesRoot, { recursive: true });
  for (const name of ['typescript']) {
    const target = path.join(modulesRoot, ...name.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(path.join(ownerRoot, 'node_modules', ...name.split('/')), target,
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  const dependencies = ['preact', 'owner-tool', 'candidate-runtime', 'candidate-transitive', 'ws', 'marked', 'yaml', 'immer'];
  writeFileSync(path.join(fakeOwnerRoot, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(dependencies.map((name) => [name, '*'])) }, null, 2));
  writeFixturePackage(modulesRoot, 'preact', {
    type: 'module', exports: {
      '.': { types: './dist/preact.d.ts', import: './dist/preact.mjs', require: './dist/preact.js' },
      './*': { types: './*.d.ts', import: './*.mjs', require: './*.js' },
    },
  }, { 'dist/preact.js': 'module.exports = {};', 'dist/preact.mjs': 'export {};'});
  for (const name of ['owner-tool', 'candidate-runtime', 'candidate-transitive', 'ws', 'marked', 'yaml', 'immer']) {
    writeFixturePackage(modulesRoot, name, { type: 'module', main: './index.js' }, {
      'index.js': `export const marker = 'host ${name}'; export const version = 'host ${name}';`,
    });
  }
  writeFixturePackage(modulesRoot, 'tailwindcss', {
    exports: { '.': { import: './index.js' }, './style.css': { style: './index.css' } },
  });
  for (const name of [
    '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai', '@earendil-works/pi-tui', 'typebox',
  ]) {
    writeFixturePackage(modulesRoot, name, { main: './index.js' }, { 'index.js': 'module.exports = {};' });
  }
  return fakeOwnerRoot;
}

export function writeHoistedCompetitor(fixtureRoot, packageName) {
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
