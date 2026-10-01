import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyPiRuntimeArtifact, writePiRuntimeManifest } from '../../lib/pi-runtime-artifact.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const installedModules = path.join(repositoryRoot, 'application', 'hosts', 'vscode', 'node_modules');
const artifactPackages = [
  '@earendil-works/pi-tui',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-coding-agent',
];
const sdkAssets = [
  'dist/cli.js',
  'dist/rpc-entry.js',
  'dist/modes/interactive/theme/dark.json',
  'dist/modes/interactive/theme/light.json',
  'dist/modes/interactive/theme/theme-schema.json',
  'dist/modes/interactive/assets/clankolas.png',
  'dist/core/export-html/template.html',
  'dist/core/export-html/template.css',
  'dist/core/export-html/template.js',
  'dist/core/export-html/vendor/marked.min.js',
  'dist/core/export-html/vendor/highlight.min.js',
];

function write(root, relative, content) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function makeArtifact(root) {
  for (const name of artifactPackages) {
    const packageRoot = path.join(root, 'node_modules', ...name.split('/'));
    const isSdk = name === '@earendil-works/pi-coding-agent';
    write(root, `node_modules/${name}/package.json`, JSON.stringify({
      name,
      version: '0.80.6',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
          require: './dist/index.js',
        },
      },
    }, null, 2) + '\n');
    write(root, `node_modules/${name}/LICENSE`, 'MIT License\nCopyright (c) 2025 Mario Zechner\n');
    write(root, `node_modules/${name}/dist/index.js`, isSdk
      ? "export function candidateOnly() { return 'candidate-sdk'; }\nexport const candidateBuildMarker = 'verified-candidate-sdk-graph';\n"
      : `export const fixturePackage = ${JSON.stringify(name)};\n`);
    write(root, `node_modules/${name}/dist/index.d.ts`, isSdk
      ? "export declare function candidateOnly(): 'candidate-sdk';\nexport declare const candidateBuildMarker: 'verified-candidate-sdk-graph';\n"
      : 'export declare const fixturePackage: string;\n');
    if (isSdk) {
      for (const asset of sdkAssets) write(root, `node_modules/${name}/${asset}`, `fixture asset: ${asset}\n`);
      write(root, `node_modules/${name}/dist/custom/assets/fixture.bin`, Buffer.from([0, 1, 2, 255]));
      write(root, `node_modules/${name}/THIRD-PARTY-NOTICES.txt`, 'Fixture third-party notice; preserve verbatim.\n');
    }
    assert.ok(existsSync(packageRoot));
  }

  write(root, 'node_modules/typebox/package.json', JSON.stringify({
    name: 'typebox', version: '1.0.0', type: 'module',
    types: './index.d.ts', main: './index.js',
    exports: { '.': { types: './index.d.ts', import: './index.js', require: './index.js' } },
  }, null, 2) + '\n');
  write(root, 'node_modules/typebox/index.js', 'export {};\n');
  write(root, 'node_modules/typebox/index.d.ts', 'export {};\n');
}

function makeBuildFixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pie-build-artifact-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repository');
  const owner = path.join(repo, 'application', 'hosts', 'vscode');
  const modules = path.join(owner, 'node_modules');
  const artifactDir = path.join(directory, 'input', 'pi-runtime');
  const outputs = path.join(directory, 'outputs');
  mkdirSync(outputs, { recursive: true });

  write(repo, 'package.json', '{"type":"module"}\n');
  write(owner, 'package.json', JSON.stringify({
    name: 'pie-build-artifact-fixture',
    version: '1.0.0',
    dependencies: {
      '@tailwindcss/postcss': '0.0.0-fixture',
      preact: '0.0.0-fixture',
      tailwindcss: '0.0.0-fixture',
      typescript: '0.0.0-fixture',
      vite: '0.0.0-fixture',
    },
  }, null, 2) + '\n');
  write(owner, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      module: 'preserve',
      moduleResolution: 'bundler',
      target: 'ES2021',
      types: ['node'],
    },
    include: ['../../../source.ts'],
  }, null, 2) + '\n');
  write(repo, 'source.ts', "import { candidateOnly } from '@earendil-works/pi-coding-agent';\nconst selected: 'candidate-sdk' = candidateOnly();\nexport { selected };\n");
  write(repo, 'scripts/build/build.mjs', readFileSync(path.join(repositoryRoot, 'scripts/build/build.mjs')));
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
  for (const helper of ['package-resolution.mjs', 'pi-runtime-artifact.mjs', 'traversal-policy.mjs']) {
    write(repo, `scripts/lib/${helper}`, readFileSync(path.join(repositoryRoot, 'scripts/lib', helper)));
  }
  write(repo, 'lib/pi-runtime/artifact.mjs', readFileSync(path.join(repositoryRoot, 'lib/pi-runtime/artifact.mjs')));
  write(repo, 'application/hosts/vscode/vite.config.ts', readFileSync(path.join(repositoryRoot, 'application/hosts/vscode/vite.config.ts')));
  write(repo, 'harness/tools/execution-safety/traversal-policy.ts', readFileSync(path.join(repositoryRoot, 'harness/tools/execution-safety/traversal-policy.ts')));

  const links = [
    'typescript', 'preact', 'vite', 'tailwindcss', '@tailwindcss/postcss', '@types/node',
  ];
  for (const name of links) {
    const source = path.join(installedModules, ...name.split('/'));
    assert.ok(existsSync(source), `fixture prerequisite: ${name}`);
    const link = path.join(modules, ...name.split('/'));
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  }

  const viteInputs = [
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
  for (const input of viteInputs) {
    write(repo, input, input.endsWith('activation/extension.ts')
      ? "import { candidateBuildMarker } from '@earendil-works/pi-coding-agent';\nexport const fixtureEntry = candidateBuildMarker;\n"
      : input.endsWith('panel.tsx')
        ? "import { candidateBuildMarker } from '@earendil-works/pi-coding-agent';\nglobalThis.candidateFixtureMarker = candidateBuildMarker;\n"
        : 'export const fixtureEntry = 1;\n');
  }
  makeArtifact(artifactDir);
  return { directory, repo, owner, modules, artifactDir, outputs };
}

function runBuild(fixture, args, timeout = 180_000) {
  return spawnSync(process.execPath, [path.join(fixture.repo, 'scripts', 'build', 'build.mjs'), ...args], {
    cwd: fixture.owner,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, HOME: fixture.directory, USERPROFILE: fixture.directory },
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

function filesBelow(root, relative = '') {
  const entries = readdirSync(path.join(root, relative), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(root, child);
    const info = lstatSync(absolute);
    assert.equal(info.isSymbolicLink(), false, `artifact contains symlink ${child}`);
    if (info.isDirectory()) return filesBelow(root, child);
    assert.equal(info.isFile(), true, `artifact contains non-file entry ${child}`);
    return [child];
  }).sort();
}

function assertSameTree(left, right) {
  const leftFiles = filesBelow(left);
  const rightFiles = filesBelow(right);
  assert.deepEqual(rightFiles, leftFiles, 'every source artifact file is copied and no extra file is introduced');
  for (const relative of leftFiles) {
    assert.deepEqual(readFileSync(path.join(right, relative)), readFileSync(path.join(left, relative)), relative);
  }
}

test('source-bound isolated build selects candidate graph and materializes a complete verified artifact', async (t) => {
  const fixture = makeBuildFixture(t);
  const artifact = await writePiRuntimeManifest(fixture.artifactDir, {
    upstreamVersion: '0.80.6',
    upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b',
    sourceTreeSha256: 'a'.repeat(64),
    lockSha256: 'b'.repeat(64),
    target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
  });
  const output = path.join(fixture.outputs, 'candidate-build');
  const result = runBuild(fixture, ['--output-dir', output, '--pi-runtime', fixture.artifactDir]);
  assertBuildSucceeded(result);
  assert.match(result.stdout, /Running TypeScript check/);
  assert.match(result.stdout, /Coordinated host\/webview identity/);

  const overlay = JSON.parse(readFileSync(path.join(output, '.cache', 'typecheck', 'tsconfig.overlay.json'), 'utf8'));
  assert.equal(
    path.resolve(overlay.compilerOptions.paths['@earendil-works/pi-coding-agent'][0]),
    path.join(artifact.sdkPath, 'dist', 'index.d.ts'),
    'TypeScript resolves the explicit candidate SDK graph, not the installed owner copy',
  );
  const bundledHost = readFileSync(path.join(output, 'extension.js'), 'utf8');
  assert.match(bundledHost, /verified-candidate-sdk-graph/, 'the actual Vite config bundles the selected candidate SDK alias');
  const rendererRoot = path.join(output, 'webview', 'panel');
  const rendererManifest = JSON.parse(readFileSync(path.join(rendererRoot, '.vite', 'manifest.json'), 'utf8'));
  const rendererEntry = Object.values(rendererManifest).find((entry) => entry.isEntry);
  assert.ok(rendererEntry, 'renderer build emits its selected entry');
  assert.match(readFileSync(path.join(rendererRoot, rendererEntry.file), 'utf8'), /verified-candidate-sdk-graph/, 'browser aliases also select the candidate SDK');
  for (const name of artifactPackages) {
    assert.equal(path.resolve(overlay.compilerOptions.paths[name][0]), path.join(artifact.artifactDir, 'node_modules', ...name.split('/'), 'dist', 'index.d.ts'));
  }
  for (const name of ['typebox', '@sinclair/typebox']) {
    assert.equal(path.resolve(overlay.compilerOptions.paths[name][0]), path.join(artifact.artifactDir, 'node_modules', 'typebox', 'index.d.ts'));
  }

  assert.equal(existsSync(path.join(output, 'sdk-local-path.json')), false, 'D1 does not wire startup SDK selection');
  assert.equal(existsSync(path.join(fixture.owner, 'out')), false, 'source-bound build leaves shared output untouched');
  const copiedArtifact = path.join(output, 'pi-runtime');
  assertSameTree(fixture.artifactDir, copiedArtifact);
  assert.ok(existsSync(path.join(copiedArtifact, 'node_modules/@earendil-works/pi-coding-agent/dist/custom/assets/fixture.bin')));
  assert.match(readFileSync(path.join(copiedArtifact, 'node_modules/@earendil-works/pi-coding-agent/LICENSE'), 'utf8'), /Copyright \(c\) 2025 Mario Zechner/u);
  assert.match(readFileSync(path.join(copiedArtifact, 'node_modules/@earendil-works/pi-coding-agent/THIRD-PARTY-NOTICES.txt'), 'utf8'), /preserve verbatim/u);
  const copied = await verifyPiRuntimeArtifact(copiedArtifact);
  assert.equal(copied.identity, artifact.identity, 'the complete copied artifact re-verifies to the source identity');
});

test('Pi runtime option requires isolated output and invalid artifacts fail before any writes', async (t) => {
  const fixture = makeBuildFixture(t);
  const valid = await writePiRuntimeManifest(fixture.artifactDir, {
    upstreamVersion: '0.80.6',
    upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b',
    sourceTreeSha256: 'c'.repeat(64),
    lockSha256: 'd'.repeat(64),
    target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
  });
  const sharedOutput = path.join(fixture.owner, 'out');
  write(sharedOutput, 'shared-sentinel.txt', 'must remain untouched\n');

  const withoutOutput = runBuild(fixture, ['--pi-runtime', fixture.artifactDir, '--skip-typecheck']);
  assertBuildRejected(withoutOutput);
  assert.match(`${withoutOutput.stdout}\n${withoutOutput.stderr}`, /requires a safe --output-dir/u);
  assert.equal(readFileSync(path.join(sharedOutput, 'shared-sentinel.txt'), 'utf8'), 'must remain untouched\n');

  const wrongTargetDir = path.join(fixture.directory, 'wrong-target', 'pi-runtime');
  makeArtifact(wrongTargetDir);
  await writePiRuntimeManifest(wrongTargetDir, {
    upstreamVersion: '0.80.6',
    upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b',
    sourceTreeSha256: 'e'.repeat(64),
    lockSha256: 'f'.repeat(64),
    target: {
      platform: process.platform === 'win32' ? 'linux' : 'win32',
      arch: process.arch,
      nodeAbi: process.versions.modules,
    },
  });

  const cases = [
    ['missing', path.join(fixture.directory, 'does-not-exist', 'pi-runtime')],
    ['tampered', fixture.artifactDir],
    ['wrong-target', wrongTargetDir],
  ];
  write(fixture.artifactDir, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js', 'export const changedAfterManifest = true;\n');
  for (const [name, artifactPath] of cases) {
    const output = path.join(fixture.outputs, `${name}-rejected`);
    const rejected = runBuild(fixture, ['--output-dir', output, '--pi-runtime', artifactPath, '--skip-typecheck']);
    assertBuildRejected(rejected);
    assert.equal(existsSync(output), false, `${name} artifact rejected before isolated output creation`);
    assert.equal(existsSync(path.join(fixture.owner, 'node_modules', '.cache')), false, `${name} artifact caused no dependency-cache writes`);
    assert.equal(readFileSync(path.join(sharedOutput, 'shared-sentinel.txt'), 'utf8'), 'must remain untouched\n');
  }
  assert.ok(valid.identity, 'the baseline fixture artifact was valid before its deliberate tamper');
  assert.deepEqual(readdirSync(sharedOutput), ['shared-sentinel.txt']);
});
