import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { PI_RUNTIME_PACKAGES, PI_RUNTIME_SDK_RELATIVE_PATH, verifyPiRuntimeArtifact } from '../../../../../lib/pi-runtime/artifact.mjs';
import { writePiRuntimeManifest } from '../../../../../scripts/lib/pi-runtime-artifact.mjs';
import { assertSdkRuntimeAgreement, currentBackendTarget, parseSdkRuntimeSelection, sdkRuntimeLoadMode, verifySdkRuntimeSelection, type SdkRuntimeSelection } from '../sdk-runtime-selection';

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
  return { root, descriptor, selection: { kind: 'source-artifact', descriptor } as SdkRuntimeSelection };
}

test('closed selection rejects missing, mixed and unknown identity routes', async t => {
  const { selection } = await fixture(t);
  for (const value of [undefined, {}, { descriptor: (selection as any).descriptor }, { ...selection, kind: 'unknown' }, { ...selection, patchIdentity: {} }, { kind: 'legacy-patched', descriptor: (selection as any).descriptor }, { ...selection, backendTarget: currentBackendTarget() }]) assert.throws(() => parseSdkRuntimeSelection(value));
  assert.equal(parseSdkRuntimeSelection(selection), selection);
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
