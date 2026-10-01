import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const vscodeDependencies = path.join(repositoryRoot, 'application', 'hosts', 'vscode', 'node_modules');
const buildEntry = path.join(repositoryRoot, 'scripts', 'build', 'build.mjs');
const viteConfig = path.join(repositoryRoot, 'application', 'hosts', 'vscode', 'vite.config.ts');

function write(root, relative, content) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function makeFixture(t) {
  // Windows temp can use an 8.3 spelling; compare canonical paths just as the
  // build boundary does when resolving junction ancestors.
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'pie-build-output-isolation-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repository');
  const owner = path.join(repo, 'application', 'hosts', 'vscode');
  const modules = path.join(owner, 'node_modules');
  const outputRoot = path.join(directory, 'external-output');
  const home = path.join(directory, 'home');

  write(repo, 'package.json', '{"type":"module"}\n');
  write(owner, 'package.json', '{"name":"pie-output-fixture","version":"1.0.0"}\n');
  write(owner, 'tsconfig.json', '{"compilerOptions":{}}\n');
  write(repo, 'scripts/build/build.mjs', readFileSync(buildEntry));
  write(repo, 'scripts/build/publication.mjs', `
    export async function findCompatibleInstalledExtensionDir() { throw new Error('unexpected installed-extension lookup'); }
    export async function publishRendererGeneration() { throw new Error('unexpected renderer publication'); }
  `);
  write(repo, 'scripts/build/runtime-publication.mjs', `
    export async function hasRuntimeBootstrap() { throw new Error('unexpected runtime publication'); }
    export async function installRuntimeBootstrap() { throw new Error('unexpected runtime activation'); }
    export async function publishRuntimeGeneration() { throw new Error('unexpected runtime publication'); }
    export async function resolveRuntimeGeneration() { throw new Error('unexpected runtime lookup'); }
  `);
  write(repo, 'scripts/lib/traversal-policy.mjs', `
    export function isProtectedDirectoryName(name) { return name === 'node_modules'; }
  `);
  write(repo, 'scripts/lib/package-resolution.mjs', `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    const helperDirectory = path.dirname(fileURLToPath(import.meta.url));
    const fixtureRepository = path.resolve(helperDirectory, '../..');
    const ownerRoot = path.join(fixtureRepository, 'application', 'hosts', 'vscode');
    export function resolvePackageRoots(_layout = 'planned', { repositoryRoot = fixtureRepository } = {}) {
      const root = path.resolve(repositoryRoot);
      const distributionRoot = path.join(root, 'application', 'hosts', 'vscode');
      return Object.freeze({ repositoryRoot: root, distributionRoot, dependencyOwnerRoot: distributionRoot });
    }
    export function resolveOwnerModule(specifier) {
      if (specifier !== 'vite/package.json') throw new Error('unexpected module resolution: ' + specifier);
      return path.join(ownerRoot, 'node_modules', 'vite', 'package.json');
    }
    export function resolveTypeScriptCompiler() {
      return path.join(ownerRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    }
    export function createTsconfigOverlay(baseConfigPath, options = {}) {
      if (!options.directory || !path.isAbsolute(options.directory)) {
        throw new Error('build typecheck overlay must be given an absolute output-local directory');
      }
      const directory = path.resolve(options.directory);
      mkdirSync(directory, { recursive: true });
      const configPath = path.join(directory, 'tsconfig.overlay.json');
      writeFileSync(configPath, JSON.stringify({ extends: path.resolve(baseConfigPath) }, null, 2) + '\\n');
      return Object.freeze({ configPath, directory, dispose() {} });
    }
    export function createViteAliases() { return []; }
    export function isProtectedDirectoryName(name) { return name === 'node_modules'; }
  `);

  write(owner, 'node_modules/vite/package.json', '{"name":"vite","version":"0.0.0-fixture","type":"commonjs"}\n');
  write(owner, 'node_modules/vite/bin/vite.js', `
    const fs = require('node:fs');
    const path = require('node:path');
    const outDir = process.env.PIE_BUILD_OUTPUT_DIR || path.join(process.cwd(), 'out');
    const modeAt = process.argv.indexOf('--mode');
    const nodeMode = modeAt >= 0 && process.argv[modeAt + 1] === 'node';
    fs.mkdirSync(outDir, { recursive: true });
    const record = {
      args: process.argv.slice(2),
      outputDir: path.resolve(outDir),
      envOutputDir: process.env.PIE_BUILD_OUTPUT_DIR ?? null,
      envPiRuntimeSdkPath: process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH ?? null,
      envPiRuntimeIdentity: process.env.PIE_BUILD_PI_RUNTIME_IDENTITY ?? null,
    };
    fs.writeFileSync(path.join(outDir, 'fixture-vite-' + (nodeMode ? 'node' : 'webview') + '.json'), JSON.stringify(record, null, 2));
    const buildId = '0123456789abcdefabcd';
    if (nodeMode) {
      for (const name of ['extension.js', 'backend.js', 'worker-entry.js', 'analytics-recorder-worker.js', 'analytics-query-worker.js']) {
        fs.writeFileSync(path.join(outDir, name), 'fixture');
      }
      fs.writeFileSync(path.join(outDir, 'pie-build-id.txt'), buildId + '\\n');
    } else {
      const webview = path.join(outDir, 'webview', 'panel');
      fs.mkdirSync(path.join(webview, '.vite'), { recursive: true });
      fs.writeFileSync(path.join(webview, '.vite', 'manifest.json'), '{}');
      fs.writeFileSync(path.join(webview, 'pie-build-id.txt'), buildId + '\\n');
    }
  `);
  write(owner, 'node_modules/typescript/package.json', '{"name":"typescript","version":"0.0.0-fixture","type":"commonjs"}\n');
  write(owner, 'node_modules/typescript/bin/tsc', `
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    const outputDir = process.env.PIE_BUILD_OUTPUT_DIR || path.join(process.cwd(), 'out');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'fixture-typecheck.json'), JSON.stringify({
      args,
      outputDir: path.resolve(outputDir),
      envOutputDir: process.env.PIE_BUILD_OUTPUT_DIR ?? null,
      envPiRuntimeSdkPath: process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH ?? null,
      envPiRuntimeIdentity: process.env.PIE_BUILD_PI_RUNTIME_IDENTITY ?? null,
    }, null, 2));
    const infoAt = args.indexOf('--tsBuildInfoFile');
    if (infoAt >= 0 && args[infoAt + 1]) {
      fs.mkdirSync(path.dirname(args[infoAt + 1]), { recursive: true });
      fs.writeFileSync(args[infoAt + 1], 'fixture typecheck state');
    }
  `);

  mkdirSync(modules, { recursive: true });
  mkdirSync(outputRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { directory, repo, owner, modules, outputRoot, home };
}

function runBuild(fixture, args, extraEnv = {}, timeout = 30_000) {
  return spawnSync(process.execPath, [path.join(fixture.repo, 'scripts', 'build', 'build.mjs'), ...args], {
    cwd: fixture.owner,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      ...extraEnv,
    },
  });
}

function assertBuildSucceeded(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function assertBuildRejected(result) {
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function installHomeSentinels(fixture) {
  const installed = path.join(fixture.home, '.vscode', 'extensions', 'pie.fixture-1.0.0');
  mkdirSync(installed, { recursive: true });
  writeFileSync(path.join(installed, 'preserved.txt'), 'installed sentinel');
  return installed;
}

function installSharedOutputSentinels(fixture) {
  const sharedOut = path.join(fixture.owner, 'out');
  mkdirSync(sharedOut, { recursive: true });
  writeFileSync(path.join(sharedOut, 'shared-sentinel.txt'), 'shared output sentinel');
  writeFileSync(path.join(sharedOut, 'sdk-local-path.json'), '{"sdkPath":"shared SDK pointer"}\n');
  return sharedOut;
}

test('build --output-dir isolates output, typecheck state, child environment, and publication', (t) => {
  const fixture = makeFixture(t);
  const installed = installHomeSentinels(fixture);
  const sharedOut = installSharedOutputSentinels(fixture);
  const output = path.join(fixture.outputRoot, 'isolated-build');
  assert.equal(existsSync(output), false);

  // No --no-sync is supplied: output isolation itself must disable all publication.
  const result = runBuild(fixture, ['--output-dir', output], {
    PIE_BUILD_PI_RUNTIME_SDK_PATH: path.join(fixture.directory, 'inherited-sdk'),
    PIE_BUILD_PI_RUNTIME_IDENTITY: 'inherited-runtime-identity',
  });
  assertBuildSucceeded(result);

  for (const name of ['extension.js', 'backend.js', 'worker-entry.js', 'analytics-recorder-worker.js', 'analytics-query-worker.js', 'pie-build-id.txt']) {
    assert.ok(existsSync(path.join(output, name)), `missing isolated host output ${name}`);
  }
  assert.ok(existsSync(path.join(output, 'webview', 'panel', '.vite', 'manifest.json')));
  assert.ok(existsSync(path.join(output, 'webview', 'panel', 'pie-build-id.txt')));

  const typecheckRecord = JSON.parse(readFileSync(path.join(output, 'fixture-typecheck.json'), 'utf8'));
  assert.equal(typecheckRecord.envOutputDir, output, 'typecheck child receives the output override');
  assert.equal(typecheckRecord.envPiRuntimeSdkPath, '', 'typecheck child does not inherit an unselected SDK');
  assert.equal(typecheckRecord.envPiRuntimeIdentity, '', 'typecheck child does not inherit an unselected SDK identity');
  const buildInfoAt = typecheckRecord.args.indexOf('--tsBuildInfoFile');
  assert.notEqual(buildInfoAt, -1, 'typecheck uses a private incremental-state file');
  const buildInfo = path.resolve(typecheckRecord.args[buildInfoAt + 1]);
  const typecheckDirectory = path.join(output, '.cache', 'typecheck');
  assert.equal(buildInfo, path.join(typecheckDirectory, 'extension.tsbuildinfo'));
  const projectAt = typecheckRecord.args.indexOf('--project');
  assert.notEqual(projectAt, -1);
  assert.equal(path.resolve(typecheckRecord.args[projectAt + 1]), path.join(typecheckDirectory, 'tsconfig.overlay.json'));
  assert.ok(existsSync(buildInfo));

  for (const mode of ['node', 'webview']) {
    const record = JSON.parse(readFileSync(path.join(output, `fixture-vite-${mode}.json`), 'utf8'));
    assert.equal(record.outputDir, output);
    assert.equal(record.envOutputDir, output, `${mode} Vite child receives the output override`);
    assert.equal(record.envPiRuntimeSdkPath, '', `${mode} Vite child does not inherit an unselected SDK`);
    assert.equal(record.envPiRuntimeIdentity, '', `${mode} Vite child does not inherit an unselected SDK identity`);
    assert.ok(record.args.includes('--configLoader') && record.args[record.args.indexOf('--configLoader') + 1] === 'runner', `${mode} build uses Vite's runner config loader`);
  }

  assert.equal(readFileSync(path.join(sharedOut, 'shared-sentinel.txt'), 'utf8'), 'shared output sentinel');
  assert.equal(readFileSync(path.join(sharedOut, 'sdk-local-path.json'), 'utf8'), '{"sdkPath":"shared SDK pointer"}\n');
  assert.equal(readFileSync(path.join(installed, 'preserved.txt'), 'utf8'), 'installed sentinel');
  assert.equal(existsSync(path.join(output, 'sdk-local-path.json')), false, 'isolated builds do not write SDK pointers');
  assert.deepEqual(readdirSync(sharedOut).sort(), ['sdk-local-path.json', 'shared-sentinel.txt']);
  assert.deepEqual(readdirSync(installed), ['preserved.txt']);
});

test('build clears inherited output override for the default child output path', (t) => {
  const fixture = makeFixture(t);
  const ignored = path.join(fixture.outputRoot, 'inherited-but-ignored');
  const result = runBuild(fixture, ['--skip-typecheck', '--no-sync'], {
    PIE_BUILD_OUTPUT_DIR: ignored,
    PIE_BUILD_PI_RUNTIME_SDK_PATH: path.join(fixture.directory, 'inherited-sdk'),
    PIE_BUILD_PI_RUNTIME_IDENTITY: 'inherited-runtime-identity',
  });
  assertBuildSucceeded(result);

  const defaultOut = path.join(fixture.owner, 'out');
  assert.ok(existsSync(path.join(defaultOut, 'extension.js')));
  assert.ok(existsSync(path.join(defaultOut, 'webview', 'panel', '.vite', 'manifest.json')));
  assert.equal(existsSync(ignored), false, 'the parent environment cannot redirect a default build');
  for (const mode of ['node', 'webview']) {
    const record = JSON.parse(readFileSync(path.join(defaultOut, `fixture-vite-${mode}.json`), 'utf8'));
    assert.equal(record.outputDir, defaultOut);
    assert.equal(record.envOutputDir, '', 'default Vite children receive a cleared override');
    assert.equal(record.envPiRuntimeSdkPath, '', 'default Vite children clear an inherited candidate SDK path');
    assert.equal(record.envPiRuntimeIdentity, '', 'default Vite children clear an inherited candidate identity');
    assert.equal(record.args.includes('--configLoader'), false, 'default config loading is unchanged');
  }
});

test('build accepts --output-dir=<absolute-path>', (t) => {
  const fixture = makeFixture(t);
  const output = path.join(fixture.outputRoot, 'equals-form');
  assert.equal(existsSync(output), false);
  const result = runBuild(fixture, [`--output-dir=${output}`, '--skip-typecheck']);
  assertBuildSucceeded(result);
  assert.ok(existsSync(path.join(output, 'extension.js')));
  assert.ok(existsSync(path.join(output, 'webview', 'panel', '.vite', 'manifest.json')));
});

test('build rejects unsafe, existing, or incompatible output destinations before writing', (t) => {
  const fixture = makeFixture(t);
  const installed = path.join(fixture.home, '.vscode', 'extensions');
  mkdirSync(installed, { recursive: true });
  const insiderExtensions = path.join(fixture.home, '.vscode-insiders', 'extensions');
  mkdirSync(insiderExtensions, { recursive: true });
  const outsideNodeModules = path.join(fixture.directory, 'outside', 'node_modules');
  mkdirSync(outsideNodeModules, { recursive: true });

  const junction = path.join(fixture.directory, 'repository-junction');
  symlinkSync(fixture.repo, junction, process.platform === 'win32' ? 'junction' : 'dir');

  const unsafeDestinations = [
    ['inside repository', path.join(fixture.repo, 'fresh-output')],
    ['ancestor of repository', fixture.directory],
    ['inside regular installed extensions', path.join(installed, 'fresh-output')],
    ['inside insiders installed extensions', path.join(insiderExtensions, 'fresh-output')],
    ['inside node_modules', path.join(outsideNodeModules, 'fresh-output')],
    ['through a junction ancestor into repository', path.join(junction, 'fresh-output')],
    ['relative path', 'relative-output'],
    ['missing parent', path.join(fixture.outputRoot, 'missing-parent', 'fresh-output')],
    ...(process.platform === 'win32' ? [
      ['drive-relative path', 'C:relative-output'],
      ['drive-unspecified path', '\\relative-output'],
      ['case-insensitive repository path', path.join(fixture.repo.toUpperCase(), 'fresh-output')],
    ] : []),
  ];
  for (const [description, output] of unsafeDestinations) {
    const result = runBuild(fixture, ['--output-dir', output, '--skip-typecheck']);
    assertBuildRejected(result);
    assert.equal(existsSync(path.join(fixture.repo, 'application', 'hosts', 'vscode', 'out', 'extension.js')), false, `${description} caused no repository output`);
    if (description !== 'ancestor of repository') {
      assert.equal(existsSync(output), false, `${description} was rejected before destination creation`);
    }
  }

  for (const args of [
    ['--output-dir'],
    ['--output-dir='],
    ['--output-dir', '--skip-typecheck'],
    ['--output-dir', path.join(fixture.outputRoot, 'duplicate'), '--output-dir=other'],
  ]) assertBuildRejected(runBuild(fixture, args));

  const preexisting = path.join(fixture.outputRoot, 'already-created');
  mkdirSync(preexisting);
  writeFileSync(path.join(preexisting, 'preserve.txt'), 'must survive');
  const existingResult = runBuild(fixture, ['--output-dir', preexisting, '--skip-typecheck']);
  assertBuildRejected(existingResult);
  assert.equal(readFileSync(path.join(preexisting, 'preserve.txt'), 'utf8'), 'must survive');

  for (const incompatible of ['--activate', '--watch']) {
    const output = path.join(fixture.outputRoot, `incompatible-${incompatible.slice(2)}`);
    const result = runBuild(fixture, ['--output-dir', output, incompatible, '--skip-typecheck'], {}, 15_000);
    assertBuildRejected(result);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(incompatible.slice(2), 'iu'));
    assert.equal(existsSync(output), false, `${incompatible} was rejected before output creation`);
  }
});

test('Windows drive paths are parsed as native absolute paths', (t) => {
  const fixture = makeFixture(t);
  const unique = `pie-build-output-isolation-${process.pid}-${Date.now()}`;
  const winTarget = process.platform === 'win32'
    ? path.win32.resolve(fixture.outputRoot, unique)
    : path.win32.join('C:\\\\', unique);
  assert.equal(path.win32.isAbsolute(winTarget), true);
  const slash = winTarget.replaceAll('\\', '/');
  const backslash = winTarget.replaceAll('/', '\\');

  if (process.platform !== 'win32') {
    for (const nativePath of [slash, backslash]) {
      const result = runBuild(fixture, ['--output-dir', nativePath, '--skip-typecheck']);
      assertBuildRejected(result);
    }
    return;
  }

  for (const [index, nativePath] of [slash, backslash].entries()) {
    const output = `${nativePath}-${index}`;
    const result = runBuild(fixture, ['--output-dir', output, '--skip-typecheck']);
    assertBuildSucceeded(result);
    assert.ok(existsSync(path.join(output, 'extension.js')));
    rmSync(output, { recursive: true, force: true });
  }
});

test('actual copied Vite config builds a tiny fixture into the override with runner and no Vite cache', (t) => {
  const fixture = makeFixture(t);
  const hostModules = fixture.modules;
  rmSync(path.join(hostModules, 'typescript'), { recursive: true, force: true });
  rmSync(path.join(hostModules, 'vite'), { recursive: true, force: true });
  const actualVite = path.join(vscodeDependencies, 'vite');
  const actualTailwindPostcss = path.join(vscodeDependencies, '@tailwindcss', 'postcss');
  for (const [name, source] of [['vite', actualVite], ['@tailwindcss/postcss', actualTailwindPostcss]]) {
    assert.ok(existsSync(source), `installed Vite fixture prerequisite: ${name}`);
    const link = path.join(hostModules, ...name.split('/'));
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  }

  write(fixture.owner, 'vite.config.ts', readFileSync(viteConfig, 'utf8'));
  const entries = [
    'application/hosts/vscode/activation/extension.ts',
    'application/hosts/standalone/index.ts',
    'harness/agent-processes/coordinator/index.ts',
    'harness/agent-processes/workers/worker-entry.ts',
    'analytics/recording/recorder-worker-entry.ts',
    'analytics/queries/query-worker-entry.ts',
    'harness/agent-processes/cold-browse-helper/cold-browse-helper-entry.ts',
    'harness/agent-processes/context-inventory/initial-context-estimate-worker.ts',
    'harness/agent-processes/lib/sdk-integration/test/fixtures/phase4-worker-command-extension.ts',
    'application/frontend/shell/panel.tsx',
  ];
  for (const entry of entries) write(fixture.repo, entry, 'export const fixtureEntry = 1;\n');

  const output = path.join(fixture.outputRoot, 'real-vite');
  const result = runBuild(fixture, ['--output-dir', output, '--skip-typecheck'], {}, 180_000);
  assertBuildSucceeded(result);
  for (const name of [
    'extension.js',
    'standalone.js',
    'backend.js',
    'worker-entry.js',
    'analytics-recorder-worker.js',
    'analytics-query-worker.js',
    'cold-browse-helper-entry.js',
    'initial-context-estimate-worker.js',
    'phase4-worker-command-extension.js',
  ]) {
    assert.ok(existsSync(path.join(output, name)), `actual Vite fixture omitted ${name}`);
  }
  assert.ok(existsSync(path.join(output, 'webview', 'panel', '.vite', 'manifest.json')));
  assert.equal(existsSync(path.join(fixture.owner, 'out')), false, 'real Vite config did not fall back to the package out directory');
  assert.equal(readFileSync(path.join(output, 'pie-build-id.txt'), 'utf8'), readFileSync(path.join(output, 'webview', 'panel', 'pie-build-id.txt'), 'utf8'));

  // runner mode executes the copied TypeScript config without bundling it to
  // node_modules/.vite-temp; builds do not create an optimize-deps cache.
  for (const cacheName of ['.vite-temp', '.vite', '.vite-cache']) {
    assert.equal(existsSync(path.join(hostModules, cacheName)), false, `unexpected Vite cache ${cacheName}`);
  }
  const moduleEntries = readdirSync(hostModules, { withFileTypes: true }).map((entry) => entry.name);
  assert.deepEqual(moduleEntries.sort(), ['@tailwindcss', 'vite']);
});
