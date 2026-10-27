import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCandidateIdentity } from '../lib/vsix-candidate.mjs';
import { BUNDLED_MANAGED_ROOT_RELATIVE_PATH } from '../../../lib/managed-packages/bundled-resources.mjs';
import { TOOL_RUNTIME_DIRECTORY, TOOL_RUNTIME_FILES, toolRuntimeManifest } from '../../build/tool-runtime-assets.mjs';
import { computeNodeRuntimePayloadIdentity, NODE_RUNTIME_TARGET } from '../../../lib/node-runtime/manifest.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}

async function writePreparedNodePayload(directory) {
  await mkdir(directory, { recursive: true });
  const nodeVersion = (await readFile(path.join(repositoryRoot, '.node-version'), 'utf8')).trim();
  const files = [
    { relativePath: 'LICENSE', bytes: Buffer.from('Node fixture license\n') },
    { relativePath: 'node.exe', bytes: Buffer.from('Node fixture executable\n') },
  ];
  const inventory = files.map(({ relativePath, bytes }) => ({
    relativePath, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  for (const { relativePath, bytes } of files) await writeFile(path.join(directory, relativePath), bytes);
  const withoutIdentity = {
    schemaVersion: 1, kind: 'node-runtime', nodeVersion, target: NODE_RUNTIME_TARGET,
    executable: 'node.exe', inventory,
    provenance: {
      kind: 'local-toolchain',
      archiveUrl: `https://nodejs.org/download/release/v${nodeVersion}/node-v${nodeVersion}-win-x64.zip`,
      archiveSha256: 'a'.repeat(64),
    },
  };
  const manifest = { ...withoutIdentity, payloadIdentity: computeNodeRuntimePayloadIdentity(withoutIdentity) };
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(canonicalize(manifest), null, 2)}\n`);
  return { directory, identity: manifest.payloadIdentity };
}

async function preparedV2Candidate(t, label, playwrightRuntimeIdentity, nodeRuntimeIdentity) {
  const root = await fixture(t);
  const outDir = path.join(root, 'out');
  await writeFile(path.join(outDir, 'pie-build-id.txt'), buildId);
  await writeFile(path.join(outDir, 'webview/panel/pie-build-id.txt'), buildId);
  const runtimeRoot = path.join(outDir, TOOL_RUNTIME_DIRECTORY);
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(path.join(runtimeRoot, 'manifest.json'), JSON.stringify(toolRuntimeManifest({ playwrightRuntimeIdentity })));
  await Promise.all(TOOL_RUNTIME_FILES.map(async file => {
    const asset = path.join(runtimeRoot, file);
    await mkdir(path.dirname(asset), { recursive: true });
    await writeFile(asset, `verified ${label} asset`);
  }));
  const inventory = { version: 1, extensions: Array.from({ length: 12 }, (_, index) => ({ id: `extension-${index}`, entry: `extension-${index}.js` })) };
  await mkdir(path.join(outDir, 'resources'), { recursive: true });
  await writeFile(path.join(outDir, 'resources/bundled-extensions-build-id.txt'), buildId);
  await writeFile(path.join(outDir, 'resources/bundled-extensions.json'), JSON.stringify(inventory));
  await Promise.all(inventory.extensions.map(item => writeFile(path.join(outDir, item.entry), 'module.exports = {};')));
  await mkdir(path.join(outDir, BUNDLED_MANAGED_ROOT_RELATIVE_PATH), { recursive: true });
  if (nodeRuntimeIdentity !== undefined) {
    const node = await writePreparedNodePayload(path.join(outDir, 'resources/node-runtime'));
    assert.equal(node.identity, nodeRuntimeIdentity);
  }
  return root;
}

test('real verifier checks v2 Playwright plus Node identity and managed evidence in staged and extracted candidates', async t => {
  const playwrightRuntimeIdentity = 'f'.repeat(64);
  const managedIntegration = { stageRoot: path.join(os.tmpdir(), 'selected-managed-stage'), receiptPath: path.join(os.tmpdir(), 'selected-managed-proof.json') };
  const nodeSource = await mkdtemp(path.join(os.tmpdir(), 'selected-node-runtime-'));
  t.after(() => rm(nodeSource, { recursive: true, force: true }));
  const selectedNode = await writePreparedNodePayload(nodeSource);
  const selectedRuntime = { ...runtime, manifest: { target: NODE_RUNTIME_TARGET } };
  const qualification = {
    runtime: selectedRuntime,
    stage: { root: managedIntegration.stageRoot, receipt: { inventorySha256: 'c'.repeat(64), inventory: [] } },
    qualificationRecipeSha256: 'd'.repeat(64),
  };
  for (const label of ['staged', 'extracted']) {
    const root = await preparedV2Candidate(t, label, playwrightRuntimeIdentity, selectedNode.identity);
    const verifyManaged = {
      verifyPiRuntimeArtifact: async () => selectedRuntime,
      verifyManagedIntegrationQualification: async () => qualification,
      verifyBundledManagedOutput: async () => {},
    };
    await assert.rejects(verifyCandidateIdentity(root, { managedIntegration, expectedPlaywrightRuntimeIdentity: playwrightRuntimeIdentity }, verifyManaged), /explicit expected Node runtime identity/u);
    const calls = [];
    const identity = await verifyCandidateIdentity(root, {
      managedIntegration, expectedRuntimeIdentity: selectedRuntime.identity,
      expectedPlaywrightRuntimeIdentity: playwrightRuntimeIdentity,
      expectedNodeRuntimeIdentity: selectedNode.identity, repositoryRoot,
    }, {
      ...verifyManaged,
      verifyManagedIntegrationQualification: async args => {
        calls.push(['qualification', args]);
        return qualification;
      },
      verifyBundledManagedOutput: async (out, proof) => {
        calls.push(['managed', out, proof]);
      },
    });
    assert.equal(identity.playwrightRuntimeIdentity, playwrightRuntimeIdentity);
    assert.equal(identity.nodeRuntimeIdentity, selectedNode.identity);
    assert.deepEqual(identity.managedIntegration, {
      runtimeIdentity: selectedRuntime.identity, closureInventorySha256: 'c'.repeat(64), qualificationRecipeSha256: 'd'.repeat(64),
    });
    assert.deepEqual(calls, [
      ['qualification', { ...managedIntegration, artifactDir: path.join(root, 'out/pi-runtime') }],
      ['managed', path.join(root, 'out'), qualification],
    ]);
    await assert.rejects(verifyCandidateIdentity(root, {
      expectedNodeRuntimeIdentity: selectedNode.identity, repositoryRoot,
    }, {
      ...deps,
      verifyPiRuntimeArtifact: async () => ({ ...selectedRuntime, manifest: { target: { ...NODE_RUNTIME_TARGET, nodeAbi: '999' } } }),
    }), /target does not match the selected Pi SDK target/u);
  }
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
