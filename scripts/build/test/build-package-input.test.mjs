import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const extensionDir = path.join(repositoryRoot, 'application/hosts/vscode');
const shippedRuntimeLock = 'runtime/windows-runtime-lock.cjs';
const packagedRuntimeLock = 'out/windows-runtime-lock.cjs';
const neutralLockPath = path.join(repositoryRoot, 'lib/windows-runtime-lock/windows-runtime-lock.cjs');
const neutralLockBytes = await readFile(neutralLockPath);
const adapterSource = path.join(extensionDir, shippedRuntimeLock);

/**
 * A private fixture root that mirrors the production layout: the tracked
 * source adapter at application/hosts/vscode/runtime/, the authoritative lib
 * source it falls back to at lib/, and an optional packaged build-output copy
 * at application/hosts/vscode/out/. The adapter's checkout-relative fallback
 * resolves lib/ four levels above runtime/, so the fixture keeps lib/ and
 * runtime/ on their production-relative paths.
 */
async function adapterFixture(t, { packagedBytes, libBytes = neutralLockBytes } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pie-runtime-lock-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hostDir = path.join(root, 'application', 'hosts', 'vscode');
  await mkdir(path.join(hostDir, 'runtime'), { recursive: true });
  await copyFile(adapterSource, path.join(hostDir, shippedRuntimeLock));
  if (libBytes !== undefined) {
    await mkdir(path.join(root, 'lib', 'windows-runtime-lock'), { recursive: true });
    await writeFile(path.join(root, 'lib/windows-runtime-lock/windows-runtime-lock.cjs'), libBytes);
  }
  if (packagedBytes !== undefined) {
    await mkdir(path.join(hostDir, 'out'), { recursive: true });
    await writeFile(path.join(hostDir, packagedRuntimeLock), packagedBytes);
  }
  return hostDir;
}

test('the source adapter resolves the packaged module when the build output ships it', async (t) => {
  const root = await adapterFixture(t, {
    // A distinguishable packaged copy proves the packaged module was selected,
    // not a silent fallback to the authoritative lib source.
    packagedBytes: "module.exports = { acquireWindowsRuntimeLock: 'packaged-module-sentinel' };\n",
  });
  const adapter = require(path.join(root, shippedRuntimeLock));
  assert.equal(adapter.acquireWindowsRuntimeLock, 'packaged-module-sentinel');
});

test('a defective packaged module surfaces instead of silently falling back', async (t) => {
  const root = await adapterFixture(t, {
    // The authoritative lib source is present, so a require-failure-gated
    // fallback would succeed quietly; the packaged defect must surface anyway.
    packagedBytes: "throw new Error('packaged module defect');\n",
  });
  assert.throws(() => require(path.join(root, shippedRuntimeLock)), /packaged module defect/);
});

test('without packaged bytes the adapter falls back to the checkout-authoritative lib', async (t) => {
  const root = await adapterFixture(t, {});
  const adapter = require(path.join(root, shippedRuntimeLock));
  assert.equal(typeof adapter.acquireWindowsRuntimeLock, 'function');
});
