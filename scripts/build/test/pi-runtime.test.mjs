import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireDevelopmentReader, withDevelopmentWriter } from '../../../lib/development-runtime/lifetime.mjs';
import {
  assertPiWorkspaceBuildStamp,
  assertPrivateOutput,
  buildChildEnvironment,
  buildPiRuntime,
  computePiRuntimeInputFingerprint,
  materializeDeployedNodeModules,
  resolveNativeModifierHelper,
  run,
} from '../pi-runtime.mjs';

const piNames = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-tui',
  '@earendil-works/pi-coding-agent',
];
function createFingerprintFixture(t, lockVersions = piNames.map((_, index) => `link:harness/pi/packages/${['ai', 'agent', 'tui', 'coding-agent'][index]}`)) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-pi-runtime-fingerprint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (relative, contents) => {
    const file = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
    return file;
  };
  write('harness/pi/package-lock.json', '{"name":"pi-source","lockfileVersion":3}\n');
  write('harness/pi/package.json', '{"name":"pi-source","private":true}\n');
  write('harness/pi/packages/coding-agent/src/index.ts', 'export const value = 1;\n');
  write('harness/pi-runtime/package.json', '{"name":"runtime-owner","version":"1"}\n');
  write('harness/pi-runtime/package-lock.json', '{"name":"runtime-owner","lockfileVersion":3}\n');
  write('package.json', JSON.stringify({ name: 'pi-config', private: true, packageManager: 'pnpm@10.34.4', dependencies: Object.fromEntries(piNames.map(name => [name, 'workspace:*'])) }));
  write('pnpm-lock.yaml', `lockfileVersion: '9.0'\nsettings:\n  injectWorkspacePackages: true\nimporters:\n  .:\n    dependencies:\n${piNames.map((name, index) => `      '${name}':\n        specifier: workspace:*\n        version: ${lockVersions[index]}\n`).join('')}`);
  write('pnpm-workspace.yaml', `packages:\n  - '.'\n  - harness/pi/packages/ai\n  - harness/pi/packages/agent\n  - harness/pi/packages/tui\n  - harness/pi/packages/coding-agent\ninjectWorkspacePackages: true\n`);
  write('.prototools', 'node = "24.16.0"\npnpm = "10.34.4"\n');
  write('.npmrc', 'ignore-scripts=true\nauto-install-peers=false\nnode-linker=hoisted\n');
  // Private fixture inventory only: exercise source reads without invoking Git.
  const tracked = ['harness/pi/package-lock.json', 'harness/pi/packages/coding-agent/src/index.ts'];
  const inventory = () => {
    const names = [...tracked];
    const visit = relative => {
      for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const name = `${relative}/${entry.name}`;
        if (entry.isDirectory()) visit(name);
        else names.push(name); // Links are passed to ordinary-file validation.
      }
    };
    visit('harness/pi');
    return [...new Set(names)].join('\0');
  };
  return { root, write, computePiRuntimeInputFingerprint: options => computePiRuntimeInputFingerprint(options, { inventory: inventory(), workspaceRepositoryRoot: root }) };
}

test('buildPiRuntime rejects retired npm refresh before creating output or acquiring a reader', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-retired-refresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'artifact');
  await assert.rejects(buildPiRuntime({ output, refreshLock: true }), /npm --refresh-lock route is retired/);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../pi-runtime.mjs', import.meta.url)), '--output', output, '--refresh-lock'], { encoding: 'utf8' });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /npm --refresh-lock route is retired/);
  assert.throws(() => lstatSync(output), { code: 'ENOENT' });
});

test('production role packing preserves ordered compilation, smoke, stability and full verification checkpoints', () => {
  const source = readFileSync(new URL('../pi-runtime.mjs', import.meta.url), 'utf8');
  const builder = source.slice(source.indexOf('export async function buildPiRuntime'), source.indexOf('\nif (process.argv[1]'));
  const checkpoints = [
    'assertPrivateOutput(output)',
    'acquireDevelopmentReader(SOURCE)',
    'const inputEvidence = await capturePiRuntimeInputs()',
    'const compilation = await assertPiWorkspaceBuildStamp',
    'await materializeDeployedNodeModules',
    'fingerprintCompiledPiOutputs(SOURCE, { runtimeRoot: runtime }) === compilation.compiledSha256',
    "packPiRuntime({ runtimeDir: runtime, toolingDir: path.join(output, 'pi-tooling')",
    'fingerprintCompiledPiOutputs(SOURCE, { runtimeRoot: packed.tooling.artifactDir }) === compilation.compiledSha256',
    'await smoke(runtime, work, env)',
    'await assertPiWorkspaceBuildStamp({ inputFingerprint: fingerprintPiRuntimeInputs(inputEvidence) })',
    'const afterDeploy = await capturePiRuntimeInputs()',
    'fingerprintPiRuntimeInputs(inputEvidence) === fingerprintPiRuntimeInputs(afterDeploy)',
    'const verified = await verifyPiRuntimeArtifact(runtime)',
    'const tooling = await verifyPiRuntimeToolingArtifact(runtime)',
    "await writeFile(path.join(output, 'build-evidence.json')",
    'return verified;',
    'await reader.release({ teardownConfirmed })',
  ];
  let previous = -1;
  for (const checkpoint of checkpoints) {
    const current = builder.indexOf(checkpoint, previous + 1);
    assert.ok(current > previous, `missing/out-of-order checkpoint: ${checkpoint}`);
    previous = current;
  }
  assert.match(builder, /provenance: \{ upstreamVersion: piSourceVersion, upstreamCommit: UPSTREAM,[\s\S]*sourceTreeSha256: inputEvidence\.sourceTreeSha256, lockSha256: inputEvidence\.lockSha256, target: inputEvidence\.target/);
  assert.match(builder, /toolingIdentity: tooling\.identity, rolePacking: packed\.evidence/);
  assert.match(builder, /compiledSha256: compilation\.compiledSha256/);
  assert.doesNotMatch(builder, /writePiRuntimeManifest|refresh-lock.*install/);
});

test('buildPiRuntime rejects an existing private output before acquiring a workspace reader', async t => {
  const output = mkdtempSync(path.join(os.tmpdir(), 'pie-pi-runtime-existing-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  await assert.rejects(buildPiRuntime({ output }), /Output already exists/);
  assert.deepEqual(readdirSync(output), []);
});

test('resolveNativeModifierHelper requires the current Windows/macOS target helper', (t) => {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'pie-pi-runtime-native-'));
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  const addHelper = (platform, arch, filename) => {
    const helper = path.join(runtime, 'node_modules', '@earendil-works', 'pi-tui', 'native', platform,
      'prebuilds', `${platform}-${arch}`, filename);
    mkdirSync(path.dirname(helper), { recursive: true });
    writeFileSync(helper, 'fixture helper; never loaded as native code');
    return helper;
  };

  assert.throws(() => resolveNativeModifierHelper(runtime, 'win32', 'x64'), /Required native modifier helper missing for win32-x64/);
  const windowsX64 = addHelper('win32', 'x64', 'win32-console-mode.node');
  assert.equal(resolveNativeModifierHelper(runtime, 'win32', 'x64'), windowsX64,
    'Windows x64 retains its source runtime helper path and filename');
  const darwinArm64 = addHelper('darwin', 'arm64', 'darwin-modifiers.node');
  assert.equal(resolveNativeModifierHelper(runtime, 'darwin', 'arm64'), darwinArm64,
    'macOS selects only the matching platform/architecture helper');
  assert.throws(() => resolveNativeModifierHelper(runtime, 'win32', 'ia32'), /Unsupported native modifier helper target: win32-ia32/);
  assert.throws(() => resolveNativeModifierHelper(runtime, 'freebsd', 'x64'), /Unsupported native modifier helper platform: freebsd/);
});

test('materializeDeployedNodeModules breaks pnpm store hardlinks and keeps complete Pi package payloads', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-pi-runtime-deploy-copy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deployed = path.join(root, 'deploy', 'node_modules');
  const artifact = path.join(root, 'artifact', 'node_modules');
  const license = path.join(root, 'pi-LICENSE');
  const shared = path.join(root, 'shared-file.js');
  mkdirSync(deployed, { recursive: true });
  writeFileSync(license, 'MIT License fixture\n');
  writeFileSync(shared, 'export const shared = true;\n');
  mkdirSync(path.join(deployed, '.pnpm'), { recursive: true });
  mkdirSync(path.join(deployed, '.bin'), { recursive: true });
  writeFileSync(path.join(deployed, '.pnpm', 'lock.yaml'), 'private layout metadata\n');
  writeFileSync(path.join(deployed, '.modules.yaml'), 'private layout metadata\n');
  writeFileSync(path.join(deployed, '.bin', 'pi'), 'generated executable shim\n');
  for (const name of piNames) {
    const packageRoot = path.join(deployed, name);
    mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name, version: '0.80.6' }));
    writeFileSync(path.join(packageRoot, 'dist', 'index.js'), 'export {};\n');
  }
  mkdirSync(path.join(deployed, piNames[0], 'node_modules', '.bin'), { recursive: true });
  writeFileSync(path.join(deployed, piNames[0], 'node_modules', '.bin', 'nested-shim'), 'generated nested shim\n');
  const hardlinkedSource = path.join(deployed, piNames[0], 'dist', 'linked.js');
  linkSync(shared, hardlinkedSource);
  mkdirSync(path.dirname(artifact), { recursive: true });

  await materializeDeployedNodeModules(deployed, artifact, license);

  assert.equal(lstatSync(hardlinkedSource).nlink, 2, 'fixture must exercise a shared source hardlink');
  const copied = path.join(artifact, piNames[0], 'dist', 'linked.js');
  assert.equal(lstatSync(copied).nlink, 1, 'materialized bytes must not remain linked to pnpm store/source');
  for (const name of piNames) {
    assert.equal(readFileSync(path.join(artifact, name, 'LICENSE'), 'utf8'), 'MIT License fixture\n');
  }
  assert.throws(() => lstatSync(path.join(artifact, '.pnpm')));
  assert.throws(() => lstatSync(path.join(artifact, '.bin')));
  assert.throws(() => lstatSync(path.join(artifact, '.modules.yaml')));
  assert.throws(() => lstatSync(path.join(artifact, piNames[0], 'node_modules', '.bin')));
});

test('materializeDeployedNodeModules refuses pnpm symlink layouts rather than leaking links', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-pi-runtime-deploy-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deployed = path.join(root, 'deploy', 'node_modules');
  const artifact = path.join(root, 'artifact', 'node_modules');
  const license = path.join(root, 'pi-LICENSE');
  const target = path.join(root, 'outside');
  mkdirSync(deployed, { recursive: true });
  mkdirSync(target);
  writeFileSync(license, 'MIT License fixture\n');
  symlinkSync(target, path.join(deployed, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  mkdirSync(path.dirname(artifact), { recursive: true });
  await assert.rejects(materializeDeployedNodeModules(deployed, artifact, license), /Refusing pnpm deployment symlink/);
});

test('computePiRuntimeInputFingerprint tracks live source, shared lock, toolchain, and Node target inputs', async (t) => {
  const { root, write, computePiRuntimeInputFingerprint } = createFingerprintFixture(t);
  const options = { repositoryRoot: root };
  const initial = await computePiRuntimeInputFingerprint(options);
  assert.equal(await computePiRuntimeInputFingerprint(options), initial, 'identical inputs have a stable fingerprint');

  const sourceFile = path.join(root, 'harness/pi/packages/coding-agent/src/index.ts');
  write('harness/pi/packages/coding-agent/src/index.ts', 'export const value = 2;\n');
  assert.notEqual(await computePiRuntimeInputFingerprint(options), initial, 'tracked source edits change the fingerprint');
  write('harness/pi/packages/coding-agent/src/index.ts', 'export const value = 1;\n');
  assert.equal(await computePiRuntimeInputFingerprint(options), initial);

  write('harness/pi/packages/coding-agent/src/new-source.ts', 'export {};\n');
  const withAddedSource = await computePiRuntimeInputFingerprint(options);
  assert.notEqual(withAddedSource, initial, 'nonignored untracked source is included');
  unlinkSync(path.join(root, 'harness/pi/packages/coding-agent/src/new-source.ts'));
  assert.equal(await computePiRuntimeInputFingerprint(options), initial, 'removing added source restores the original inventory');

  unlinkSync(sourceFile);
  assert.notEqual(await computePiRuntimeInputFingerprint(options), initial, 'tracked source deletion changes the current inventory');
  write('harness/pi/packages/coding-agent/src/index.ts', 'export const value = 1;\n');
  assert.equal(await computePiRuntimeInputFingerprint(options), initial);

  write('harness/pi/package-lock.json', '{"name":"pi-source","lockfileVersion":3,"changed":true}\n');
  assert.equal(await computePiRuntimeInputFingerprint(options), initial, 'obsolete Pi npm lock is excluded from source inputs');
  write('harness/pi/package-lock.json', '{"name":"pi-source","lockfileVersion":3}\n');
  write('harness/pi-runtime/package.json', '{"name":"runtime-owner","version":"2"}\n');
  assert.equal(await computePiRuntimeInputFingerprint(options), initial, 'obsolete runtime owner manifest is ignored');
  write('harness/pi-runtime/package.json', '{"name":"runtime-owner","version":"1"}\n');
  write('harness/pi-runtime/package-lock.json', '{"name":"runtime-owner","lockfileVersion":3,"changed":true}\n');
  assert.equal(await computePiRuntimeInputFingerprint(options), initial, 'obsolete runtime npm lock is ignored');
  write('harness/pi-runtime/package-lock.json', '{"name":"runtime-owner","lockfileVersion":3}\n');
  for (const relative of ['harness/pi/package-lock.json', 'harness/pi-runtime/package.json', 'harness/pi-runtime/package-lock.json']) {
    unlinkSync(path.join(root, relative));
  }
  assert.equal(await computePiRuntimeInputFingerprint(options), initial, 'production fingerprints do not require retained npm metadata');

  for (const name of ['package.json', 'package-lock.json']) {
    const exampleMetadata = write(`harness/pi/packages/coding-agent/examples/extensions/${name}`, '{"private":true}\n');
    assert.notEqual(await computePiRuntimeInputFingerprint(options), initial, 'examples metadata remains source evidence');
    unlinkSync(exampleMetadata);
  }

  const target = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
  for (const changed of [
    { ...target, platform: target.platform === 'win32' ? 'linux' : 'win32' },
    { ...target, arch: `${target.arch}-other` },
    { ...target, nodeAbi: `${target.nodeAbi}0` },
  ]) {
    assert.notEqual(await computePiRuntimeInputFingerprint({ ...options, target: changed }), initial, 'platform, architecture, and Node ABI are bound');
  }
  assert.notEqual(await computePiRuntimeInputFingerprint({ ...options, nodeVersion: 'v0.0.0' }), initial, 'Node version is bound separately from its ABI');

  for (const relative of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.prototools', '.npmrc']) {
    const original = readFileSync(path.join(root, relative), 'utf8');
    write(relative, `${original}\n# fingerprint fixture change\n`);
    assert.notEqual(await computePiRuntimeInputFingerprint(options), initial, `${relative} changes are fingerprinted`);
    write(relative, original);
  }
  const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  rootManifest.dependencies['@earendil-works/pi-ai'] = '^0.80.6';
  write('package.json', JSON.stringify(rootManifest));
  await assert.rejects(computePiRuntimeInputFingerprint(options), /Root production dependencies must include/);
});

test('computePiRuntimeInputFingerprint accepts pnpm injected local resolutions while rejecting nonlocal locks', async (t) => {
  // Root importer emitted by pnpm 10 with injectWorkspacePackages: true.
  const versions = [
    'file:harness/pi/packages/ai(ws@8.22.0)(zod@4.6.5)',
    'file:harness/pi/packages/agent(ws@8.22.0)(zod@4.6.5)',
    'file:harness/pi/packages/tui',
    'file:harness/pi/packages/coding-agent(ws@8.22.0)(zod@4.6.5)',
  ];
  const { root, write, computePiRuntimeInputFingerprint } = createFingerprintFixture(t, versions);
  const options = { repositoryRoot: root };
  const lock = readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  const initial = await computePiRuntimeInputFingerprint(options);
  assert.equal(await computePiRuntimeInputFingerprint(options), initial);
  write('pnpm-lock.yaml', lock.replaceAll('ws@8.22.0', 'ws@8.22.1'));
  assert.notEqual(await computePiRuntimeInputFingerprint(options), initial, 'peer suffix bytes remain identity inputs');

  for (const version of versions) {
    const localPath = version.split('(')[0].slice('file:'.length);
    for (const invalid of ['0.80.6', '0.80.6(ws@8.22.0)', `file:${localPath}-other(ws@8.22.0)`,
      `file:${localPath}/other`, `link:${localPath}-other`, `file:../${localPath}`, `file:${localPath}(ws@8.22.0)garbage`]) {
      write('pnpm-lock.yaml', lock.replace(version, invalid));
      await assert.rejects(computePiRuntimeInputFingerprint(options), /Main pnpm lock must resolve/, invalid);
    }
  }
  write('pnpm-lock.yaml', lock.replace('specifier: workspace:*', 'specifier: ^0.80.6'));
  await assert.rejects(computePiRuntimeInputFingerprint(options), /Main pnpm lock must resolve/);
  write('pnpm-lock.yaml', lock);
  assert.equal(await computePiRuntimeInputFingerprint(options), initial);
});

test('assertPiWorkspaceBuildStamp requires matching schema, inputs, compiled bytes, and Node evidence', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-pi-workspace-stamp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'harness', 'pi');
  const inputFingerprint = 'a'.repeat(64);
  await assert.rejects(assertPiWorkspaceBuildStamp({ workspaceRoot, inputFingerprint }), /Missing Pi workspace build evidence/);

  const stampPath = path.join(workspaceRoot, '.cache', 'build.json');
  mkdirSync(path.dirname(stampPath), { recursive: true });
  for (const directory of ['tui', 'ai', 'agent', 'coding-agent']) {
    const output = path.join(workspaceRoot, 'packages', directory, 'dist');
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, 'index.js'), 'export const current = true;');
  }
  const { fingerprintCompiledPiOutputs } = await import('../../../lib/development-runtime/compiled-output.mjs');
  const compiledSha256 = await fingerprintCompiledPiOutputs(workspaceRoot);
  writeFileSync(stampPath, JSON.stringify({ schema: 1, inputFingerprint, compiledSha256, node: process.version }));
  assert.deepEqual(await assertPiWorkspaceBuildStamp({ workspaceRoot, inputFingerprint }), {
    schema: 1, inputFingerprint, compiledSha256, node: process.version,
  });
  const emittedFile = path.join(workspaceRoot, 'packages/ai/dist/index.js');
  writeFileSync(emittedFile, 'export const current = false;');
  await assert.rejects(assertPiWorkspaceBuildStamp({ workspaceRoot, inputFingerprint }), /compiled bytes differ from build evidence/);
  writeFileSync(emittedFile, 'export const current = true;');
  await assert.rejects(assertPiWorkspaceBuildStamp({ workspaceRoot, inputFingerprint: 'b'.repeat(64) }), /does not match current source\/lock\/toolchain inputs/);
  await assert.rejects(assertPiWorkspaceBuildStamp({ workspaceRoot, inputFingerprint, nodeVersion: 'v0.0.0' }), /current Node is v0\.0\.0/);
  writeFileSync(stampPath, JSON.stringify({ schema: 2, inputFingerprint, node: process.version }));
  await assert.rejects(assertPiWorkspaceBuildStamp({ workspaceRoot, inputFingerprint }), /Unsupported Pi workspace build evidence schema/);
});

test('development reader blocks Pi workspace compilation until confirmed teardown', async (t) => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-pi-runtime-reader-'));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  const reader = await acquireDevelopmentReader(workspaceRoot);
  await reader.release({ teardownConfirmed: false });
  await assert.rejects(withDevelopmentWriter(workspaceRoot, async () => {}), /writer denied[\s\S]*reader/u);
  await reader.release({ teardownConfirmed: true });
  await withDevelopmentWriter(workspaceRoot, async () => {});
});

test('run waits for child close and drains forwarded output before teardown', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-pi-runtime-close-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let forwarded = '';
  const originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout');
  Object.defineProperty(process, 'stdout', {
    configurable: true,
    value: new Writable({ write(chunk, _encoding, callback) {
      forwarded += chunk.toString();
      setTimeout(callback, 120);
    } }),
  });
  const started = Date.now();
  try {
    await run('fixture', [], root, {}, 'close/drain fixture', {
      spawn: () => {
        setImmediate(() => {
          child.emit('exit', 0, null); // exit precedes the remaining stdio and close acknowledgement.
          child.stdout.end('late stdout marker');
          child.stderr.end();
          child.emit('close', 0, null);
        });
        return child;
      },
      watchChildProcess: () => ({ timedOut: false, aborted: false, settle: async () => ({ gone: true }) }),
    });
  } finally {
    Object.defineProperty(process, 'stdout', originalStdout);
  }
  assert.ok(Date.now() - started >= 100, 'the helper must wait for the writable output drain');
  assert.match(forwarded, /late stdout marker/u);
});

test('run marks unknown owned-process teardown for conservative reader retention', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-pi-runtime-uncertain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  await assert.rejects(run('fixture', [], root, {}, 'uncertain teardown fixture', {
    spawn: () => {
      setImmediate(() => {
        child.emit('exit', 0, null);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0, null);
      });
      return child;
    },
    watchChildProcess: () => ({ timedOut: false, aborted: false, settle: async () => ({ gone: false, survivors: [1234] }) }),
  }), error => error.teardownUnconfirmed === true);
});

test('computePiRuntimeInputFingerprint rejects generated and linked Pi source entries', async (t) => {
  const { root, write, computePiRuntimeInputFingerprint } = createFingerprintFixture(t);
  const options = { repositoryRoot: root };
  const generated = write('harness/pi/packages/coding-agent/dist/generated.js', 'export {};\n');
  await assert.rejects(computePiRuntimeInputFingerprint(options), /Generated source inventory entry/);
  unlinkSync(generated);
  rmSync(path.dirname(generated), { recursive: true, force: true });

  const target = path.join(root, 'linked-source-target');
  mkdirSync(target);
  write('linked-source-target/index.ts', 'export const linked = true;\n');
  const sourceDirectory = path.join(root, 'harness/pi/packages/coding-agent/src');
  unlinkSync(path.join(sourceDirectory, 'index.ts'));
  rmSync(sourceDirectory, { recursive: true, force: true });
  symlinkSync(target, sourceDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(computePiRuntimeInputFingerprint(options), /Not an ordinary source file/);
});

test('assertPrivateOutput rejects protected locations, existing outputs, and symlink ancestors', (t) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'pie-pi-runtime-private-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  // Match per-file isolation: an otherwise-protected HOME is itself beneath OS temp.
  const home = path.join(fixture, 'home');
  mkdirSync(home);
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    assert.equal(path.resolve(os.homedir()), path.resolve(home), 'fixture home must be used by the path guard');
    const repositoryRoot = path.join(fixture, 'repository');
    mkdirSync(path.join(repositoryRoot, 'data'), { recursive: true });
    mkdirSync(path.join(repositoryRoot, 'settings'), { recursive: true });
    const safeOutput = path.join(fixture, 'private-runtime');
    assert.doesNotThrow(() => assertPrivateOutput(safeOutput, repositoryRoot),
      'a fresh OS-temp output outside HOME remains allowed');

    for (const protectedPath of [
      repositoryRoot,
      path.join(repositoryRoot, 'data', 'runtime'),
      path.join(repositoryRoot, 'settings', 'runtime'),
      path.parse(repositoryRoot).root,
      home,
      path.join(home, 'Documents', `pie-runtime-test-${process.pid}`),
      path.join(home, '.pi', 'agent', 'data', `pie-runtime-test-${process.pid}`),
      path.join(home, '.pi', 'agent', 'settings.json'),
      path.join(home, '.vscode', 'extensions', `pie-runtime-test-${process.pid}`),
    ]) {
      assert.throws(
        () => assertPrivateOutput(protectedPath, repositoryRoot),
        `must reject protected output path ${protectedPath}`,
      );
    }

    const existingOutput = path.join(fixture, 'already-exists');
    mkdirSync(existingOutput);
    assert.throws(() => assertPrivateOutput(existingOutput, repositoryRoot));

    const symlinkTarget = path.join(fixture, 'symlink-target');
    const symlinkAncestor = path.join(fixture, 'symlinked-output');
    mkdirSync(symlinkTarget);
    symlinkSync(symlinkTarget, symlinkAncestor, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertPrivateOutput(path.join(symlinkAncestor, 'runtime'), repositoryRoot));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
});

test('buildChildEnvironment isolates private state and excludes inherited credentials and runtime overrides', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'pie-pi-runtime-env-'));
  try {
    const privateRoot = path.join(fixture, 'private');
    const parentEnv = {
      PATH: `${fixture}${path.delimiter}system-bin`,
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      TEMP: path.join(fixture, 'parent-temp'),
      TMP: path.join(fixture, 'parent-tmp'),
      LANG: 'C.UTF-8',
      HTTP_PROXY: 'http://proxy.fixture:8080',
      HTTPS_PROXY: 'http://secure-proxy.fixture:8443',
      NO_PROXY: 'localhost,127.0.0.1',
      SSL_CERT_FILE: path.join(fixture, 'ca.pem'),
      NODE_EXTRA_CA_CERTS: path.join(fixture, 'extra-ca.pem'),
      GITHUB_TOKEN: 'do-not-inherit-token',
      AWS_ACCESS_KEY_ID: 'do-not-inherit-key',
      NPM_TOKEN: 'do-not-inherit-npm-token',
      CUSTOM_PARENT_VARIABLE: 'must-not-be-inherited',
      PI_CODING_AGENT_DIR: path.join(fixture, 'old-agent-dir'),
      PI_SESSION_DIR: path.join(fixture, 'old-sessions'),
      PIE_DATA_DIR: path.join(fixture, 'old-data'),
      PIE_SETTINGS_PATH: path.join(fixture, 'old-settings.json'),
      NODE_OPTIONS: '--require=parent-hook.cjs',
      npm_config_registry: 'https://registry.fixture.invalid',
      NPM_CONFIG_USERCONFIG: path.join(fixture, 'parent.npmrc'),
      npm_config_cache: path.join(fixture, 'parent-npm-cache'),
      npm_config_prefix: path.join(fixture, 'parent-npm-prefix'),
      npm_config_fund: 'false',
    };
    const childEnv = buildChildEnvironment(parentEnv, privateRoot);
    const findKey = (key) => Object.keys(childEnv).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    const findValue = (key) => childEnv[findKey(key)];

    assert.equal(findValue('PATH'), parentEnv.PATH);
    assert.equal(findValue('LANG'), parentEnv.LANG);
    assert.equal(findKey('CUSTOM_PARENT_VARIABLE'), undefined);
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
      assert.equal(findValue(key), parentEnv[key], `${key} should be retained`);
    }
    if (process.platform === 'win32') {
      for (const key of ['SystemRoot', 'ComSpec']) assert.equal(findValue(key), parentEnv[key]);
    }
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'npm_config_cache']) {
      const value = findValue(key);
      assert.equal(typeof value, 'string', `${key} must be set privately`);
      const relative = path.relative(privateRoot, path.resolve(value));
      assert.ok(relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)),
        `${key} must resolve inside the private root: ${value}`);
    }
    for (const key of Object.keys(childEnv)) {
      assert.doesNotMatch(key, /^(?:GITHUB_TOKEN|AWS_ACCESS_KEY_ID|NPM_TOKEN|NODE_OPTIONS|npm_config_(?!cache$)|PI(?:_|$)|PIE(?:_|$))/iu,
        `sensitive inherited variable leaked: ${key}`);
    }
    for (const key of Object.keys(parentEnv)) {
      if (/^(?:GITHUB_TOKEN|AWS_ACCESS_KEY_ID|NPM_TOKEN|PI(?:_|$)|PIE(?:_|$)|NODE_OPTIONS|npm_config_(?!cache$))/iu.test(key)) {
        assert.equal(findKey(key), undefined, `${key} must not be inherited`);
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
