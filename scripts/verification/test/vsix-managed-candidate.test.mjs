import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyCandidateIdentity } from '../lib/vsix-candidate.mjs';

const buildId = 'a'.repeat(20);
const runtime = { identity: 'b'.repeat(64), manifest: { target: { platform: 'win32', arch: 'x64', nodeAbi: '127' } } };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsix-managed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'out/webview/panel'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ publisher: 'pie', name: 'pie', version: '1.0.0', main: './runtime/bootstrap.cjs' }));
  for (const file of ['out/pie-build-id.txt', 'out/webview/panel/pie-build-id.txt']) await writeFile(path.join(root, file), buildId);
  return root;
}
const deps = { verifyPiRuntimeArtifact: async () => runtime };

test('historical core candidate has no managed claims; present payload cannot downgrade', async t => {
  const root = await fixture(t);
  const identity = await verifyCandidateIdentity(root, {}, deps);
  assert.equal(identity.managedIntegration, undefined);
  await mkdir(path.join(root, 'out/resources/managed-integrations'), { recursive: true });
  await assert.rejects(verifyCandidateIdentity(root, {}, deps), /requires explicit/);
});

test('managed selection verifies relocated SDK, payload and extension output and exposes only hash bindings', async t => {
  const root = await fixture(t);
  const managedIntegration = { stageRoot: path.join(root, 'original-stage'), receiptPath: path.join(root, 'external-proof.json') };
  const q = { runtime, stage: { root: managedIntegration.stageRoot, receipt: { inventorySha256: 'c'.repeat(64), inventory: [] } }, qualificationRecipeSha256: 'd'.repeat(64) };
  const calls = [];
  const seams = {
    ...deps,
    verifyManagedIntegrationQualification: async args => { calls.push('qualification'); assert.deepEqual(args, { ...managedIntegration, artifactDir: path.join(root, 'out/pi-runtime') }); return q; },
    verifyBundledManagedOutput: async (out, qualification) => { calls.push('managed'); assert.equal(out, path.join(root, 'out')); assert.equal(qualification, q); },
    verifyBundledExtensionOutput: async (out, id) => { calls.push('extension'); assert.equal(out, path.join(root, 'out')); assert.equal(id, buildId); },
  };
  const identity = await verifyCandidateIdentity(root, { managedIntegration }, seams);
  assert.deepEqual(calls, ['qualification', 'managed', 'extension']);
  assert.deepEqual(identity.managedIntegration, { runtimeIdentity: runtime.identity, closureInventorySha256: 'c'.repeat(64), qualificationRecipeSha256: 'd'.repeat(64) });
  assert.equal(JSON.stringify(identity).includes(root), false);
  for (const key of ['verifyManagedIntegrationQualification', 'verifyBundledManagedOutput', 'verifyBundledExtensionOutput']) {
    await assert.rejects(verifyCandidateIdentity(root, { managedIntegration }, { ...seams, [key]: async () => { throw new Error(key); } }), new RegExp(key));
  }
});

test('candidate verifier enforces an explicitly expected full runtime identity', async t => {
  const root = await fixture(t);
  assert.equal((await verifyCandidateIdentity(root, { expectedRuntimeIdentity: runtime.identity }, deps)).piRuntimeIdentity, runtime.identity);
  await assert.rejects(verifyCandidateIdentity(root, { expectedRuntimeIdentity: 'c'.repeat(64) }, deps), /expected runtime identity/);
});

test('managed qualification must match selected runtime identity and target before payload validation', async t => {
  const root = await fixture(t);
  const managedIntegration = { stageRoot: root, receiptPath: path.join(root, 'proof.json') };
  for (const mismatch of [
    { ...runtime, identity: 'e'.repeat(64) },
    { ...runtime, manifest: { target: { ...runtime.manifest.target, nodeAbi: '999' } } },
  ]) {
    let payloadChecks = 0;
    await assert.rejects(verifyCandidateIdentity(root, { managedIntegration }, {
      ...deps,
      verifyManagedIntegrationQualification: async () => ({ runtime: mismatch }),
      verifyBundledManagedOutput: async () => { payloadChecks++; },
      verifyBundledExtensionOutput: async () => { payloadChecks++; },
    }), /runtime identity or target does not match/);
    assert.equal(payloadChecks, 0);
  }
});

test('incomplete selection and selected missing or malformed marker fail', async t => {
  const root = await fixture(t);
  await assert.rejects(verifyCandidateIdentity(root, { managedIntegration: {} }, deps), /absolute/);
  const managedIntegration = { stageRoot: root, receiptPath: path.join(root, 'proof.json') };
  const q = { runtime, stage: { receipt: { inventory: [], inventorySha256: 'c'.repeat(64) } }, qualificationRecipeSha256: 'd'.repeat(64) };
  const seams = { ...deps, verifyManagedIntegrationQualification: async () => q };
  await assert.rejects(verifyCandidateIdentity(root, { managedIntegration }, seams), /ENOENT/);
  const payload = path.join(root, 'out/resources/managed-integrations');
  await mkdir(payload, { recursive: true });
  await writeFile(path.join(payload, 'manifest.json'), '{bad');
  await assert.rejects(verifyCandidateIdentity(root, { managedIntegration }, seams), /JSON|property/i);
});
