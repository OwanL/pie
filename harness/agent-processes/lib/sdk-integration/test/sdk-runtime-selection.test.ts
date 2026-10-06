import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { PI_RUNTIME_PACKAGES, PI_RUNTIME_SDK_RELATIVE_PATH, verifyPiRuntimeArtifact } from '../../../../../lib/pi-runtime/artifact.mjs';
import { writePiRuntimeManifest } from '../../../../../scripts/lib/pi-runtime-artifact.mjs';
import { fingerprintCompiledPiOutputs } from '../../../../../lib/development-runtime/compiled-output.mjs';
import {
  assertSdkRuntimeAgreement,
  currentBackendTarget,
  parseSdkRuntimeSelection,
  sdkRuntimeLoadMode,
  sdkRuntimeSdkPath,
  validateSdkRuntimeSelectionShape,
  verifySdkRuntimeSelection,
  verifyWorkspaceDevelopmentSdkRoot,
  WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV,
  type SdkRuntimeSelection,
} from '../sdk-runtime-selection';
import { loadSdk, loadSdkInternalModule, type SdkLoadMode } from '../sdk';
import { createSyntheticSourceTestSdkRuntime } from '../../../test/fixtures/sdk-runtime-selection';

async function fixture(t: TestContext, target = currentBackendTarget()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-runtime-selection-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  async function put(relative: string, content = 'export {};\n') {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  for (const name of PI_RUNTIME_PACKAGES) {
    await put(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '0.80.6' }));
    await put(`node_modules/${name}/dist/index.js`);
    await put(`node_modules/${name}/LICENSE`, 'fixture license');
  }
  for (const file of ['dist/cli.js', 'dist/rpc-entry.js', 'dist/modes/interactive/theme/dark.json', 'dist/modes/interactive/theme/light.json', 'dist/modes/interactive/theme/theme-schema.json', 'dist/modes/interactive/assets/clankolas.png', 'dist/core/export-html/template.html', 'dist/core/export-html/template.css', 'dist/core/export-html/template.js', 'dist/core/export-html/vendor/marked.min.js', 'dist/core/export-html/vendor/highlight.min.js']) await put(`${PI_RUNTIME_SDK_RELATIVE_PATH}/${file}`);
  await writePiRuntimeManifest(root, { upstreamVersion: '0.80.6', upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b', sourceTreeSha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64), target });
  const verified = await verifyPiRuntimeArtifact(root, { target });
  const descriptor = { schemaVersion: 1 as const, artifactDir: verified.artifactDir, sdkPath: await realpath(verified.sdkPath), cliPath: await realpath(path.join(verified.sdkPath, 'dist/cli.js')), identity: verified.identity, manifest: verified.manifest };
  return {
    root,
    descriptor,
    selection: { kind: 'source-artifact', descriptor } as Extract<SdkRuntimeSelection, { kind: 'source-artifact' }>,
  };
}

test('closed selection rejects missing, legacy, mixed and unknown identity routes', () => {
  // Shape-only descriptor. Never use this selection for artifact verification or loading.
  const selection = createSyntheticSourceTestSdkRuntime(path.join(os.tmpdir(), 'pie-shape-only-sdk'));
  for (const value of [undefined, {}, { descriptor: selection.descriptor }, { ...selection, kind: 'unknown' }, { ...selection, patchIdentity: {} }, { kind: 'legacy-patched', descriptor: selection.descriptor }, { kind: 'legacy-patched', patchIdentity: {} }, { ...selection, backendTarget: currentBackendTarget() }]) assert.throws(() => parseSdkRuntimeSelection(value));
  assert.equal(parseSdkRuntimeSelection(selection), selection);
  assert.equal(sdkRuntimeSdkPath(selection), selection.descriptor.sdkPath);
  for (const surface of ['cold', 'full'] as const) {
    const mode = surface === 'cold' ? sdkRuntimeLoadMode(selection, 'cold') : sdkRuntimeLoadMode(selection, 'full');
    assert.deepEqual(mode, { mode: 'source-artifact', descriptor: selection.descriptor,
      backendTarget: currentBackendTarget(), surface });
  }
});

async function workspaceDevelopmentFixture(t: TestContext) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'pie-pi-workspace-sdk-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    name: 'pi-monorepo', private: true, workspaces: ['packages/*'],
  }));
  await mkdir(path.join(workspaceRoot, 'node_modules', 'typebox', 'build'), { recursive: true });
  await writeFile(path.join(workspaceRoot, 'node_modules', 'typebox', 'package.json'), JSON.stringify({
    name: 'typebox', version: '1.1.38', type: 'module',
    exports: { '.': { import: './build/index.mjs', default: './build/index.mjs' } },
  }));
  await writeFile(path.join(workspaceRoot, 'node_modules', 'typebox', 'build', 'index.mjs'), 'export {}\n');

  const packageRoots: Record<string, string> = {};
  for (const [name, directory] of [
    ['@earendil-works/pi-tui', 'tui'],
    ['@earendil-works/pi-ai', 'ai'],
    ['@earendil-works/pi-agent-core', 'agent'],
    ['@earendil-works/pi-coding-agent', 'coding-agent'],
  ]) {
    const packageRoot = path.join(workspaceRoot, 'packages', directory);
    packageRoots[name] = packageRoot;
    await mkdir(path.join(packageRoot, 'dist', 'core'), { recursive: true });
    const dependencies = ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-tui'].includes(name)
      ? name === '@earendil-works/pi-agent-core'
        ? { '@earendil-works/pi-ai': '^0.80.6', typebox: '1.1.38' }
        : name === '@earendil-works/pi-ai' ? { typebox: '1.1.38' } : {}
      : {
          '@earendil-works/pi-agent-core': '^0.80.6',
          '@earendil-works/pi-ai': '^0.80.6',
          '@earendil-works/pi-tui': '^0.80.6',
          typebox: '1.1.38',
        };
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name, version: '0.80.6', type: 'module', main: './dist/index.js', dependencies,
    }));
    await writeFile(path.join(packageRoot, 'dist', 'index.js'), 'export {}\n');
    await writeFile(path.join(packageRoot, 'dist', 'index.d.ts'), 'export {}\n');
    if (name === '@earendil-works/pi-coding-agent') {
      for (const file of ['config.js', 'core/auth-storage.js', 'core/model-registry.js', 'core/session-manager.js']) {
        const target = path.join(packageRoot, 'dist', file);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, 'export {}\n');
      }
    }
  }

  for (const [ownerName, dependencies] of Object.entries({
    '@earendil-works/pi-agent-core': ['@earendil-works/pi-ai'],
    '@earendil-works/pi-coding-agent': [
      '@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-tui',
    ],
  })) {
    const ownerRoot = packageRoots[ownerName];
    for (const dependency of dependencies) {
      const alias = path.join(ownerRoot, 'node_modules', ...dependency.split('/'));
      await mkdir(path.dirname(alias), { recursive: true });
      await symlink(packageRoots[dependency], alias, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }

  const stampRoot = path.join(workspaceRoot, '.cache');
  await mkdir(stampRoot, { recursive: true });
  await writeFile(path.join(stampRoot, 'build.json'), JSON.stringify({
    schema: 1,
    inputFingerprint: 'a'.repeat(64),
    compiledSha256: await fingerprintCompiledPiOutputs(workspaceRoot),
    node: process.version,
  }));

  return {
    workspaceRoot,
    sdkPath: packageRoots['@earendil-works/pi-coding-agent'],
    packageRoots,
    selection: { kind: 'workspace-development', workspaceRoot } as const,
  };
}

test('workspace-development route is an explicit, provenance-free selection and has an independent opt-in', async t => {
  const fixture = await workspaceDevelopmentFixture(t);
  assert.equal(validateSdkRuntimeSelectionShape(fixture.selection), undefined);
  assert.deepEqual(parseSdkRuntimeSelection(fixture.selection), fixture.selection);
  assert.equal(sdkRuntimeSdkPath(fixture.selection), fixture.sdkPath);
  for (const surface of ['cold', 'full'] as const) {
    assert.deepEqual(sdkRuntimeLoadMode(fixture.selection, surface), {
      mode: 'workspace-development', workspaceRoot: fixture.workspaceRoot, surface,
    });
  }
  assert.throws(() => parseSdkRuntimeSelection({ ...fixture.selection, identity: 'a'.repeat(64) }));
  await assert.rejects(verifyWorkspaceDevelopmentSdkRoot(fixture.selection, {}), /PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK=1/);
  const environment = { ...process.env, [WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV]: '1' };
  for (const name of ['@earendil-works/pi-tui', '@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent']) {
    await assert.rejects(realpath(path.join(fixture.workspaceRoot, 'node_modules', ...name.split('/'))));
  }
  const verified = await verifyWorkspaceDevelopmentSdkRoot(fixture.selection, environment);
  assert.equal(verified.workspaceRoot, await realpath(fixture.workspaceRoot));
  assert.equal(verified.sdkPath, await realpath(fixture.sdkPath));
  assert.equal(verified.version, '0.80.6');
  assert.equal(Object.hasOwn(verified, 'identity'), false);
  await assert.rejects(verifySdkRuntimeSelection(path.dirname(fixture.sdkPath), fixture.selection, environment), /SDK path does not match/);
});

test('workspace-development route rejects mixed package versions, broken TypeBox coherence and incomplete compiled roots', async t => {
  const environment = { ...process.env, [WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV]: '1' };
  const mismatched = await workspaceDevelopmentFixture(t);
  const agentManifest = path.join(mismatched.packageRoots['@earendil-works/pi-agent-core'], 'package.json');
  await writeFile(agentManifest, JSON.stringify({
    ...JSON.parse(await readFile(agentManifest, 'utf8')), version: '0.80.5',
  }));
  await assert.rejects(verifyWorkspaceDevelopmentSdkRoot(mismatched.selection, environment), /one shared version/);

  const wrongLocalDependency = await workspaceDevelopmentFixture(t);
  const localAiAlias = path.join(wrongLocalDependency.packageRoots['@earendil-works/pi-agent-core'], 'node_modules', '@earendil-works', 'pi-ai');
  await rm(localAiAlias, { recursive: true, force: true });
  await symlink(wrongLocalDependency.packageRoots['@earendil-works/pi-tui'], localAiAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyWorkspaceDevelopmentSdkRoot(wrongLocalDependency.selection, environment), /not the selected local root/);

  const splitTypebox = await workspaceDevelopmentFixture(t);
  const localTypebox = path.join(splitTypebox.packageRoots['@earendil-works/pi-ai'], 'node_modules', 'typebox');
  await mkdir(path.join(localTypebox, 'build'), { recursive: true });
  await writeFile(path.join(localTypebox, 'package.json'), JSON.stringify({
    name: 'typebox', version: '1.1.38', type: 'module',
    exports: { '.': { import: './build/index.mjs', default: './build/index.mjs' } },
  }));
  await writeFile(path.join(localTypebox, 'build', 'index.mjs'), 'export {}\n');
  await assert.rejects(verifyWorkspaceDevelopmentSdkRoot(splitTypebox.selection, environment), /different TypeBox installations/);

  const incomplete = await workspaceDevelopmentFixture(t);
  await rm(path.join(incomplete.sdkPath, 'dist', 'core', 'model-registry.js'));
  await assert.rejects(verifyWorkspaceDevelopmentSdkRoot(incomplete.selection, environment), /compiled output does not match its stamp/);
});

test('workspace-development route refuses missing stamps and missing or tampered compiled output', async t => {
  const environment = { ...process.env, [WORKSPACE_DEVELOPMENT_SDK_OPT_IN_ENV]: '1' };

  const noStamp = await workspaceDevelopmentFixture(t);
  await rm(path.join(noStamp.workspaceRoot, '.cache', 'build.json'));
  await assert.rejects(verifyWorkspaceDevelopmentSdkRoot(noStamp.selection, environment), /requires a complete compiled-output stamp/);

  const oversizedStamp = await workspaceDevelopmentFixture(t);
  await writeFile(path.join(oversizedStamp.workspaceRoot, '.cache', 'build.json'), 'x'.repeat(4097));
  await assert.rejects(verifyWorkspaceDevelopmentSdkRoot(oversizedStamp.selection, environment), /bounded ordinary single-link file/);

  const missingOutput = await workspaceDevelopmentFixture(t);
  await rm(path.join(missingOutput.sdkPath, 'dist', 'core', 'model-registry.js'));
  await assert.rejects(verifyWorkspaceDevelopmentSdkRoot(missingOutput.selection, environment), /compiled output does not match its stamp/);

  const tamperedOutput = await workspaceDevelopmentFixture(t);
  await writeFile(path.join(tamperedOutput.sdkPath, 'dist', 'index.js'), 'export const tampered = true;\n');
  await assert.rejects(verifyWorkspaceDevelopmentSdkRoot(tamperedOutput.selection, environment), /compiled output does not match its stamp/);
});

test('source-only loaders reject missing and legacy modes before any SDK import or mutation', async t => {
  const { descriptor } = await fixture(t);
  const before = await readFile(descriptor.cliPath);
  for (const mode of [undefined, null, {}, { mode: 'coordinator' }, { mode: 'cold-coordinator' },
    { mode: 'worker', patchIdentity: {} }, { mode: 'cold-worker', patchIdentity: {} }]) {
    await assert.rejects(loadSdk(descriptor.sdkPath, mode as SdkLoadMode), /explicit source-artifact/);
    await assert.rejects(loadSdkInternalModule(descriptor.sdkPath, 'index.js', mode as SdkLoadMode), /explicit source-artifact/);
  }
  await assert.rejects(loadSdk(descriptor.sdkPath, { mode: 'source-artifact',
    descriptor: undefined, backendTarget: currentBackendTarget() }), /Invalid Pi runtime descriptor/);
  for (const key of ['platform', 'arch', 'nodeAbi'] as const) {
    const mode = { mode: 'source-artifact' as const, descriptor,
      backendTarget: { ...currentBackendTarget(), [key]: 'not-the-executing-target' } };
    await assert.rejects(loadSdk(descriptor.sdkPath, mode), new RegExp(`target\\.${key} mismatch`));
    await assert.rejects(loadSdkInternalModule(descriptor.sdkPath, 'index.js', mode), new RegExp(`target\\.${key} mismatch`));
  }
  assert.deepEqual(await readFile(descriptor.cliPath), before);
});

test('source selection verifies own target, immutable payload and canonical SDK path', async t => {
  const { root, descriptor, selection } = await fixture(t);
  // Verifier reads only. A successful transport must not rewrite payload bytes.
  const cliBefore = await readFile(descriptor.cliPath);
  const verified = await verifySdkRuntimeSelection(descriptor.sdkPath, selection);
  assert.deepEqual(verified, selection);
  assert.deepEqual(await readFile(descriptor.cliPath), cliBefore);
  for (const surface of ['cold', 'full'] as const) {
    const mode = surface === 'cold' ? sdkRuntimeLoadMode(verified, 'cold') : sdkRuntimeLoadMode(verified, 'full');
    assert.equal(mode.mode, 'source-artifact');
    if (mode.mode === 'source-artifact') {
      assert.deepEqual(mode.backendTarget, currentBackendTarget());
      assert.equal(mode.surface, surface);
    }
  }
  await assert.rejects(verifySdkRuntimeSelection(root, selection), /SDK path/);
  const tampered = structuredClone(selection) as Extract<SdkRuntimeSelection, { kind: 'source-artifact' }>;
  tampered.descriptor.identity = '0'.repeat(64);
  await assert.rejects(verifySdkRuntimeSelection(descriptor.sdkPath, tampered), /identity/);
  await writeFile(descriptor.cliPath, 'tampered payload');
  await assert.rejects(verifySdkRuntimeSelection(descriptor.sdkPath, selection));
});

test('manifest target is not trusted as the executing backend target', async t => {
  const own = currentBackendTarget();
  const { descriptor, selection } = await fixture(t, { ...own, nodeAbi: own.nodeAbi === '99999' ? '99998' : '99999' });
  await assert.rejects(verifySdkRuntimeSelection(descriptor.sdkPath, selection));
});

test('preload and promotion agreement reject missing selection, route/path/identity changes', async t => {
  const { descriptor, selection } = await fixture(t);
  assert.doesNotThrow(() => assertSdkRuntimeAgreement(descriptor.sdkPath, selection, structuredClone(selection)));
  assert.throws(() => assertSdkRuntimeAgreement(descriptor.sdkPath, selection, undefined));
  assert.throws(() => assertSdkRuntimeAgreement(path.dirname(descriptor.sdkPath), selection));
  const other = structuredClone(selection) as Extract<SdkRuntimeSelection, { kind: 'source-artifact' }>;
  other.descriptor.identity = 'c'.repeat(64);
  assert.throws(() => assertSdkRuntimeAgreement(descriptor.sdkPath, selection, other));
});
