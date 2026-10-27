import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCandidate, parseCandidateArgs } from '../build-candidate.mjs';
import { stageExtensionForPackaging } from '../../lib/delivery-package.mjs';
import { verifyCandidateIdentity } from '../../verification/lib/vsix-candidate.mjs';
import { BUNDLED_MANAGED_ROOT_RELATIVE_PATH } from '../../../lib/managed-packages/bundled-resources.mjs';
import { computeNodeRuntimePayloadIdentity, NODE_RUNTIME_TARGET } from '../../../lib/node-runtime/manifest.mjs';
import { TOOL_RUNTIME_DIRECTORY, TOOL_RUNTIME_FILES, toolRuntimeManifest } from '../tool-runtime-assets.mjs';

const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}

async function writePreparedNodePayload(directory) {
  await mkdir(directory, { recursive: true });
  const nodeVersion = (await readFile(path.join(sourceRoot, '.node-version'), 'utf8')).trim();
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

async function writeCandidateStage(stageRoot, nodeRuntimeDirectory, playwrightRuntimeIdentity) {
  const buildId = 'a'.repeat(20);
  await mkdir(path.join(stageRoot, 'out/webview/panel'), { recursive: true });
  await writeFile(path.join(stageRoot, 'package.json'), JSON.stringify({ publisher: 'pie', name: 'pie', version: '1.0.0', main: './runtime/bootstrap.cjs' }));
  for (const file of ['out/pie-build-id.txt', 'out/webview/panel/pie-build-id.txt']) await writeFile(path.join(stageRoot, file), buildId);
  const runtimeRoot = path.join(stageRoot, 'out', TOOL_RUNTIME_DIRECTORY);
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(path.join(runtimeRoot, 'manifest.json'), JSON.stringify(toolRuntimeManifest({ playwrightRuntimeIdentity })));
  await Promise.all(TOOL_RUNTIME_FILES.map(async file => {
    const asset = path.join(runtimeRoot, file);
    await mkdir(path.dirname(asset), { recursive: true });
    await writeFile(asset, 'verified tool runtime asset');
  }));
  const extensions = Array.from({ length: 12 }, (_, index) => ({ id: `fixture-${index}`, entry: `fixture-${index}.js` }));
  const resources = path.join(stageRoot, 'out/resources');
  await mkdir(resources, { recursive: true });
  await writeFile(path.join(resources, 'bundled-extensions-build-id.txt'), buildId);
  await writeFile(path.join(resources, 'bundled-extensions.json'), JSON.stringify({ version: 1, extensions }));
  await Promise.all(extensions.map(item => writeFile(path.join(stageRoot, 'out', item.entry), 'module.exports = {};')));
  await mkdir(path.join(stageRoot, 'out', BUNDLED_MANAGED_ROOT_RELATIVE_PATH), { recursive: true });
  await cp(nodeRuntimeDirectory, path.join(resources, 'node-runtime'), { recursive: true });
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pie-candidate-test-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const scratch = path.join(base, 'scratch');
  await mkdir(root);
  await mkdir(scratch);
  const output = path.join(base, 'candidate.vsix');
  const calls = [];
  const source = { head: 'fixture-head', status: ' M fixture' };
  const identity = { buildId: 'fixture-build', piRuntimeIdentity: 'fixture-runtime', target: 'win32-x64' };
  const bytes = Buffer.from('fake packaged candidate bytes');
  const deps = {
    root, status() {}, createScratch: async () => scratch,
    sourceIdentity: async () => source,
    verifyRuntime: async artifact => { calls.push(['verify-runtime', artifact]); return { identity: 'fixture-runtime' }; },
    stagePackage: async (...args) => { calls.push(['stage', ...args]); await mkdir(args[2]); },
    verifyIdentity: async (stage, context) => { calls.push(['identity', stage, context]); return identity; },
    resolveVsce: async () => 'fake-vsce',
    runStage: async (stage, options) => {
      calls.push([stage.name, stage, options]);
      if (stage.name === 'candidate-package') await writeFile(stage.args.at(-1), bytes);
      return { code: 0, outerConfirmed: true, innerConfirmed: true };
    },
  };
  return { base, root, scratch, output, calls, source, identity, bytes, deps };
}

async function absent(file) {
  await assert.rejects(lstat(file), { code: 'ENOENT' });
}

test('VSIX package allowlist retains the separate prepared Node runtime resource tree', async () => {
  const ignore = await readFile(path.join(sourceRoot, 'application/hosts/vscode/.vscodeignore'), 'utf8');
  assert.match(ignore, /^!out\/resources\/node-runtime\/\*\*$/mu);
  assert.doesNotMatch(ignore, /^!out\/resources\/tool-runtimes\/node-runtime\/\*\*$/mu,
    'Node runtime payload is not a tool-runtime role');
});

test('candidate arguments require explicit absolute VSIX output and reject ambiguous options', () => {
  const output = path.resolve('candidate.vsix');
  const artifactDir = path.resolve('runtime-fixture');
  const nodeRuntimeDir = path.resolve('prepared-node-runtime');
  const playwrightPayloadDir = path.resolve('prepared-playwright-payload');
  const playwrightRuntimeDir = path.resolve('prepared-playwright-runtime');
  assert.deepEqual(parseCandidateArgs(['--output', output]), { output });
  assert.deepEqual(parseCandidateArgs([`--output=${output}`, `--pi-runtime=${artifactDir}`]), { output, artifactDir });
  assert.deepEqual(parseCandidateArgs(['--output', output, '--node-runtime', nodeRuntimeDir]), { output, nodeRuntimeDir });
  assert.deepEqual(parseCandidateArgs(['--output', output, '--playwright-payload', playwrightPayloadDir]), { output, playwrightPayloadDir });
  assert.deepEqual(parseCandidateArgs(['--output', output, '--playwright-runtime', playwrightRuntimeDir]), { output, playwrightRuntimeDir });
  assert.deepEqual(parseCandidateArgs(['--help']), { help: true });
  for (const args of [[], ['--output', 'relative.vsix'], ['--output', path.resolve('bad.zip')],
    ['--output'], ['--output', output, '--output', output], ['--output', output, '--pi-runtime', 'relative'],
    ['--output', output, '--node-runtime', 'relative'], ['--output', output, '--node-runtime', nodeRuntimeDir, '--node-runtime', nodeRuntimeDir],
    ['--output', output, '--playwright-payload', 'relative'], ['--output', output, '--playwright-payload', playwrightPayloadDir, '--playwright-payload', playwrightPayloadDir],
    ['--output', output, '--playwright-runtime', 'relative'], ['--output', output, '--playwright-runtime', playwrightRuntimeDir, '--playwright-runtime', playwrightRuntimeDir],
    ['--output', output, '--playwright-runtime', playwrightRuntimeDir, '--playwright-payload', playwrightPayloadDir],
    ['--output', output, '--unknown'], ['--output', output, '--pi-runtime', artifactDir, '--pi-runtime', artifactDir]]) {
    assert.throws(() => parseCandidateArgs(args));
  }
});

test('managed candidate CLI requires a paired selection, explicit runtime and no watch', () => {
  const output = path.resolve('candidate.vsix');
  const artifactDir = path.resolve('runtime');
  const stageRoot = path.resolve('private-stage');
  const receiptPath = path.resolve('private-receipt.json');
  const pair = ['--managed-stage', stageRoot, '--managed-qualification-receipt', receiptPath];
  assert.deepEqual(parseCandidateArgs(['--output', output, '--pi-runtime', artifactDir, ...pair]), { output, artifactDir, managedIntegration: { stageRoot, receiptPath } });
  for (const extra of [pair, ['--pi-runtime', artifactDir, '--managed-stage', stageRoot], ['--pi-runtime', artifactDir, ...pair, '--watch'], ['--pi-runtime', artifactDir, ...pair, '--managed-stage', stageRoot]]) {
    assert.throws(() => parseCandidateArgs(['--output', output, ...extra]));
  }
});

for (const valid of [true, false]) {
  test(`managed candidate propagates private inputs and ${valid ? 'publishes public evidence only' : 'rejects extracted identity mismatch'}`, async t => {
    const f = await fixture(t);
    const managedIntegration = { stageRoot: path.join(f.base, 'private-stage'), receiptPath: path.join(f.base, 'private-receipt.json') };
    f.deps.verifyCandidate = async (candidate, extracted, context) => {
      f.calls.push(['verify-candidate', candidate, extracted, context]);
      return valid ? { ...f.identity } : { ...f.identity, piRuntimeIdentity: 'tampered' };
    };
    const operation = buildCandidate({ output: f.output, artifactDir: path.join(f.base, 'runtime'), managedIntegration }, undefined, f.deps);
    if (!valid) {
      await assert.rejects(operation, /Packaged candidate identity/);
      await absent(f.output);
      await absent(`${f.output}.evidence.json`);
      return;
    }
    const result = await operation;
    const delivery = f.calls.find(call => call[0] === 'delivery-build')[1];
    assert.deepEqual(delivery.args.slice(-4), ['--managed-stage', managedIntegration.stageRoot, '--managed-qualification-receipt', managedIntegration.receiptPath]);
    assert.deepEqual(f.calls.map(call => call[0]), ['verify-runtime', 'delivery-build', 'stage', 'identity', 'candidate-package', 'verify-candidate']);
    const verificationContext = { managedIntegration, expectedRuntimeIdentity: 'fixture-runtime' };
    assert.deepEqual(f.calls.find(call => call[0] === 'identity').slice(1), [path.join(f.scratch, 'stage'), verificationContext]);
    assert.deepEqual(f.calls.at(-1).slice(1), [path.join(f.scratch, 'candidate.vsix'), path.join(f.scratch, 'extracted'), verificationContext]);
    const evidence = await readFile(result.evidencePath, 'utf8');
    for (const privatePath of Object.values(managedIntegration)) assert.equal(evidence.includes(privatePath.replaceAll('\\', '\\\\')), false);
    assert.equal(evidence.includes('managed-qualification-receipt'), false);
  });
}

for (const name of ['candidate', 'evidence']) {
  test(`refuses existing ${name} before invoking build dependencies`, async t => {
    const f = await fixture(t);
    const existing = name === 'candidate' ? f.output : `${f.output}.evidence.json`;
    await writeFile(existing, 'preserve me');
    await assert.rejects(buildCandidate({ output: f.output }, undefined, f.deps), /Refusing to overwrite/);
    assert.equal(await readFile(existing, 'utf8'), 'preserve me');
    assert.deepEqual(f.calls, []);
    await absent(name === 'candidate' ? `${f.output}.evidence.json` : f.output);
  });
}

for (const reuse of [false, true]) {
  test(`candidate ${reuse ? 'verifies explicit runtime reuse without compilation' : 'compiles, builds delivery and packages exactly once'}`, async t => {
    const f = await fixture(t);
    const artifactDir = path.join(f.base, 'runtime');
    const result = await buildCandidate({ output: f.output, ...(reuse ? { artifactDir } : {}) }, undefined, f.deps);
    assert.deepEqual(f.calls.map(call => call[0]), [reuse ? 'verify-runtime' : 'pi-compile', 'delivery-build', 'stage', 'identity', 'candidate-package']);
    const delivery = f.calls.find(call => call[0] === 'delivery-build')[1];
    assert.deepEqual(delivery.args, [path.join(f.root, 'scripts/build/build.mjs'), '--delivery', '--no-sync', '--output-dir', path.join(f.scratch, 'build'), ...(reuse ? ['--pi-runtime', artifactDir] : [])]);
    if (reuse) assert.equal(f.calls[0][1], artifactDir);
    else assert.deepEqual(f.calls[0][1].args, [path.join(f.root, 'scripts/build/pi-workspace.mjs')]);
    assert.deepEqual(f.calls.find(call => call[0] === 'stage').slice(1), [f.root, path.join(f.scratch, 'build'), path.join(f.scratch, 'stage')]);
    const packaging = f.calls.find(call => call[0] === 'candidate-package');
    assert.equal(packaging[2].root, path.join(f.scratch, 'stage'));
    assert.deepEqual(packaging[1].args, ['fake-vsce', 'package', '--no-dependencies', '--allow-missing-repository', '--target', 'win32-x64', '--out', path.join(f.scratch, 'candidate.vsix')]);
    assert.deepEqual(await readFile(f.output), f.bytes);
    const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8'));
    assert.deepEqual(evidence, { schema: 1, purpose: 'local-development-only', qualified: false, licenseQualified: false, cleanMachineQualified: false,
      source: f.source, runtime: { selection: reuse ? artifactDir : 'workspace', identity: f.identity.piRuntimeIdentity },
      build: f.identity, candidate: { path: f.output, target: 'win32-x64', sha256: createHash('sha256').update(f.bytes).digest('hex'), size: f.bytes.length }, scratch: f.scratch });
    assert.deepEqual(result.evidence, evidence);
    assert.deepEqual(await readFile(path.join(f.scratch, 'candidate.vsix')), f.bytes);
    assert.ok((await lstat(path.join(f.scratch, 'stage'))).isDirectory());
  });
}

for (const mismatch of [false, true]) {
  test(`candidate ${mismatch ? 'rejects a copied payload identity mismatch before packaging' : 'forwards and records the selected payload identity'}`, async t => {
    const f = await fixture(t);
    const artifactDir = path.join(f.base, 'runtime');
    const playwrightPayloadDir = path.join(f.base, 'prepared-payload');
    const payloadIdentity = 'c'.repeat(64);
    const expected = { target: { platform: 'win32', arch: 'x64' }, playwrightVersion: '1.2.3', browserVersion: '140.1.2.3', browserRevision: '2222' };
    f.deps.resolvePlaywrightExpected = async root => { f.calls.push(['resolve-playwright-pins', root]); return expected; };
    f.deps.validatePlaywrightPayload = async selection => {
      f.calls.push(['validate-playwright-input', selection]);
      return { identity: payloadIdentity };
    };
    f.deps.verifyPlaywrightPayloadOutput = async (output, selection) => {
      f.calls.push(['verify-playwright-output', output, selection]);
      return { identity: mismatch ? 'd'.repeat(64) : payloadIdentity };
    };
    f.deps.verifyCandidate = async (candidate, extracted, context) => {
      f.calls.push(['verify-candidate', candidate, extracted, context]);
      return { ...f.identity };
    };
    const operation = buildCandidate({ output: f.output, artifactDir, playwrightPayloadDir }, undefined, f.deps);
    if (mismatch) {
      await assert.rejects(operation, /Staged Playwright payload identity/);
      assert.equal(f.calls.some(call => call[0] === 'candidate-package'), false);
      await absent(f.output);
      await absent(`${f.output}.evidence.json`);
      return;
    }
    const result = await operation;
    const delivery = f.calls.find(call => call[0] === 'delivery-build')[1];
    assert.deepEqual(delivery.args.slice(-2), ['--playwright-payload', playwrightPayloadDir]);
    assert.deepEqual(f.calls.filter(call => call[0] === 'verify-playwright-output').map(call => call[2].expectedIdentity), [payloadIdentity, payloadIdentity]);
    const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8'));
    assert.equal(evidence.playwrightPayloadIdentity, payloadIdentity);
    assert.equal(evidence.build.playwrightPayloadIdentity, payloadIdentity);
    assert.deepEqual(f.calls.map(call => call[0]), [
      'resolve-playwright-pins', 'validate-playwright-input', 'verify-runtime', 'delivery-build', 'stage', 'identity',
      'verify-playwright-output', 'candidate-package', 'verify-candidate', 'verify-playwright-output',
    ]);
  });
}

test('managed candidate with full Playwright runtime propagates expected SDK identity to staged and extracted verification', async t => {
  const f = await fixture(t);
  const artifactDir = path.join(f.base, 'runtime');
  const playwrightRuntimeDir = path.join(f.base, 'prepared-runtime');
  const managedIntegration = { stageRoot: path.join(f.base, 'managed-stage'), receiptPath: path.join(f.base, 'managed-receipt.json') };
  const payloadIdentity = 'e'.repeat(64);
  f.deps.validatePlaywrightRuntimePayload = async selection => ({ directory: selection.directory, identity: payloadIdentity });
  f.deps.verifyPlaywrightRuntimeOutput = async () => ({ identity: payloadIdentity });
  f.deps.verifyCandidate = async (candidate, extracted, context) => {
    f.calls.push(['verify-candidate', candidate, extracted, context]);
    return { ...f.identity };
  };
  const result = await buildCandidate({ output: f.output, artifactDir, playwrightRuntimeDir, managedIntegration }, undefined, f.deps);
  const expectedContext = {
    managedIntegration, expectedRuntimeIdentity: 'fixture-runtime', expectedPlaywrightRuntimeIdentity: payloadIdentity,
  };
  assert.deepEqual(f.calls.find(call => call[0] === 'identity').slice(1), [path.join(f.scratch, 'stage'), expectedContext]);
  assert.deepEqual(f.calls.find(call => call[0] === 'verify-candidate').slice(1), [
    path.join(f.scratch, 'candidate.vsix'), path.join(f.scratch, 'extracted'), expectedContext,
  ]);
  assert.equal(result.evidence.build.playwrightRuntimeIdentity, payloadIdentity);
});

test('candidate forwards the composite runtime and rechecks source, staged and extracted identities', async t => {
  const f = await fixture(t);
  const playwrightRuntimeDir = path.join(f.base, 'prepared-runtime');
  const payloadIdentity = 'e'.repeat(64);
  f.deps.validatePlaywrightRuntimePayload = async selection => {
    f.calls.push(['validate-playwright-runtime-input', selection]);
    return { directory: selection.directory, identity: payloadIdentity };
  };
  f.deps.verifyPlaywrightRuntimeOutput = async (output, selection) => {
    f.calls.push(['verify-playwright-runtime-output', output, selection]);
    return { identity: payloadIdentity };
  };
  f.deps.verifyCandidate = async (candidate, extracted, context) => {
    f.calls.push(['verify-candidate', candidate, extracted, context]);
    return { ...f.identity };
  };
  const result = await buildCandidate({ output: f.output, playwrightRuntimeDir }, undefined, f.deps);
  const delivery = f.calls.find(call => call[0] === 'delivery-build')[1];
  assert.deepEqual(delivery.args.slice(-2), ['--playwright-runtime', playwrightRuntimeDir]);
  const validations = f.calls.filter(call => call[0] === 'verify-playwright-runtime-output');
  assert.deepEqual(validations.map(call => call[1]), [path.join(f.scratch, 'stage', 'out'), path.join(f.scratch, 'extracted', 'out')]);
  assert.ok(validations.every(call => call[2].repositoryRoot === f.root && call[2].expectedIdentity === payloadIdentity));
  const candidateVerifications = f.calls.filter(call => call[0] === 'verify-candidate');
  assert.deepEqual(candidateVerifications.map(call => call[3]), [
    { managedIntegration: undefined, expectedPlaywrightRuntimeIdentity: payloadIdentity },
  ]);
  const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8'));
  assert.equal(evidence.playwrightRuntimeIdentity, payloadIdentity);
  assert.equal(evidence.build.playwrightRuntimeIdentity, payloadIdentity);
});

for (const mismatch of ['stage', 'extracted']) {
  test(`candidate rejects composite runtime identity mismatch in ${mismatch} output`, async t => {
    const f = await fixture(t);
    const playwrightRuntimeDir = path.join(f.base, 'prepared-runtime');
    const payloadIdentity = 'e'.repeat(64);
    let outputCount = 0;
    f.deps.validatePlaywrightRuntimePayload = async selection => ({ directory: selection.directory, identity: payloadIdentity });
    f.deps.verifyPlaywrightRuntimeOutput = async () => {
      outputCount += 1;
      return { identity: mismatch === 'stage' || outputCount === 2 ? 'f'.repeat(64) : payloadIdentity };
    };
    f.deps.verifyCandidate = async () => ({ ...f.identity });
    const operation = buildCandidate({ output: f.output, playwrightRuntimeDir }, undefined, f.deps);
    await assert.rejects(operation, mismatch === 'stage' ? /Staged Playwright runtime identity/ : /Packaged Playwright runtime identity/);
    assert.equal(f.calls.some(call => call[0] === 'candidate-package'), mismatch === 'extracted');
    await absent(f.output);
    await absent(`${f.output}.evidence.json`);
  });
}

test('candidate forwards and revalidates the selected Node payload at source, staged and extracted paths', async t => {
  const f = await fixture(t);
  const artifactDir = path.join(f.base, 'runtime');
  const nodeRuntimeDir = path.join(f.base, 'prepared-node-runtime');
  const nodeRuntimeIdentity = '9'.repeat(64);
  const target = { platform: 'win32', arch: 'x64', nodeAbi: '137' };
  f.deps.verifyRuntime = async artifact => {
    f.calls.push(['verify-runtime', artifact]);
    return { identity: 'fixture-runtime', manifest: { target } };
  };
  f.deps.validateNodeRuntimePayload = async selection => {
    f.calls.push(['validate-node-source', selection]);
    return { directory: path.resolve(selection.directory), identity: nodeRuntimeIdentity, manifest: { target } };
  };
  f.deps.validateNodeRuntimeOutput = async selection => {
    f.calls.push(['validate-node-output', selection]);
    return { directory: path.resolve(selection.directory), identity: nodeRuntimeIdentity, manifest: { target } };
  };
  f.deps.verifyIdentity = async (stage, context) => {
    f.calls.push(['identity', stage, context]);
    return { ...f.identity, nodeRuntimeIdentity };
  };
  f.deps.verifyCandidate = async (candidate, extracted, context) => {
    f.calls.push(['verify-candidate', candidate, extracted, context]);
    return { ...f.identity, nodeRuntimeIdentity };
  };

  const result = await buildCandidate({ output: f.output, artifactDir, nodeRuntimeDir }, undefined, f.deps);
  const delivery = f.calls.find(call => call[0] === 'delivery-build')[1];
  assert.deepEqual(delivery.args.slice(-2), ['--node-runtime', nodeRuntimeDir]);
  const context = {
    managedIntegration: undefined, expectedRuntimeIdentity: 'fixture-runtime',
    expectedNodeRuntimeIdentity: nodeRuntimeIdentity, repositoryRoot: f.root,
  };
  assert.deepEqual(f.calls.filter(call => call[0] === 'identity').map(call => call[2]), [context]);
  assert.deepEqual(f.calls.filter(call => call[0] === 'verify-candidate').map(call => call[3]), [context]);
  assert.deepEqual(f.calls.filter(call => call[0] === 'validate-node-output').map(call => call[1].directory), [
    path.join(f.scratch, 'stage/out/resources/node-runtime'),
    path.join(f.scratch, 'extracted/out/resources/node-runtime'),
  ]);
  assert.equal(f.calls.filter(call => call[0] === 'validate-node-source').length, 3);
  const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8'));
  assert.equal(evidence.nodeRuntimeIdentity, nodeRuntimeIdentity);
  assert.equal(evidence.build.nodeRuntimeIdentity, nodeRuntimeIdentity);
});

test('candidate pipeline exercises the real verifier with Node, v2 Playwright and managed identities at both stages', async t => {
  const f = await fixture(t);
  const nodeSource = path.join(f.base, 'prepared-node-runtime');
  const selectedNode = await writePreparedNodePayload(nodeSource);
  const nodeRuntimeIdentity = selectedNode.identity;
  const playwrightRuntimeIdentity = '8'.repeat(64);
  const runtime = { identity: '7'.repeat(64), manifest: { target: NODE_RUNTIME_TARGET } };
  const managedIntegration = { stageRoot: path.join(f.base, 'managed-stage'), receiptPath: path.join(f.base, 'managed-proof.json') };
  const qualification = {
    runtime,
    stage: { root: managedIntegration.stageRoot, receipt: { inventorySha256: '6'.repeat(64), inventory: [] } },
    qualificationRecipeSha256: '5'.repeat(64),
  };
  const verifierDependencies = {
    verifyPiRuntimeArtifact: async () => runtime,
    verifyManagedIntegrationQualification: async () => qualification,
    verifyBundledManagedOutput: async () => {},
  };
  const verifierContexts = [];
  f.deps.root = sourceRoot;
  f.deps.verifyRuntime = async () => runtime;
  f.deps.verifyIdentity = undefined;
  f.deps.validatePlaywrightRuntimePayload = async selection => ({ directory: selection.directory, identity: playwrightRuntimeIdentity });
  f.deps.verifyPlaywrightRuntimeOutput = async () => ({ identity: playwrightRuntimeIdentity });
  f.deps.stagePackage = async (_root, _build, stageRoot) => writeCandidateStage(stageRoot, nodeSource, playwrightRuntimeIdentity);
  f.deps.verifyCandidateIdentity = async (destination, context) => {
    verifierContexts.push(context);
    return verifyCandidateIdentity(destination, context, verifierDependencies);
  };
  f.deps.verifyCandidate = async (_candidate, destination, context) => {
    verifierContexts.push(context);
    await cp(path.join(f.scratch, 'stage'), destination, { recursive: true });
    const identity = await verifyCandidateIdentity(destination, context, verifierDependencies);
    return identity;
  };

  const result = await buildCandidate({
    output: f.output, artifactDir: path.join(f.base, 'pi-runtime'), nodeRuntimeDir: nodeSource,
    playwrightRuntimeDir: path.join(f.base, 'playwright-runtime'), managedIntegration,
  }, undefined, f.deps);
  const expectedContext = {
    managedIntegration, expectedRuntimeIdentity: runtime.identity,
    expectedNodeRuntimeIdentity: nodeRuntimeIdentity, repositoryRoot: path.resolve(sourceRoot),
    expectedPlaywrightRuntimeIdentity: playwrightRuntimeIdentity,
  };
  assert.deepEqual(verifierContexts, [expectedContext, expectedContext], 'staged and extracted real verifiers receive every selected identity');
  assert.equal(result.evidence.build.nodeRuntimeIdentity, nodeRuntimeIdentity);
  assert.equal(result.evidence.build.playwrightRuntimeIdentity, playwrightRuntimeIdentity);
  assert.deepEqual(result.evidence.build.managedIntegration, {
    runtimeIdentity: runtime.identity, closureInventorySha256: '6'.repeat(64), qualificationRecipeSha256: '5'.repeat(64),
  });
});

test('explicit runtime mismatch stops before packaging or final outputs', async t => {
  const f = await fixture(t);
  f.deps.verifyRuntime = async () => ({ identity: 'different-runtime' });
  await assert.rejects(buildCandidate({ output: f.output, artifactDir: path.join(f.base, 'runtime') }, undefined, f.deps), /does not match/);
  assert.equal(f.calls.some(call => call[0] === 'candidate-package'), false);
  await absent(f.output);
  await absent(`${f.output}.evidence.json`);
});

for (const failure of ['outer', 'inner', '125', 'cancel']) {
  test(`${failure} at package stage stops publication and retains scratch`, async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    const run = f.deps.runStage;
    f.deps.runStage = async (stage, options) => {
      const result = await run(stage, options);
      if (stage.name === 'candidate-package') {
        if (failure === 'cancel') controller.abort(new Error('fixture cancellation'));
        if (failure === 'outer') result.outerConfirmed = false;
        if (failure === 'inner') result.innerConfirmed = false;
        if (failure === '125') result.code = 125;
      }
      return result;
    };
    await assert.rejects(buildCandidate({ output: f.output }, controller.signal, f.deps), failure === 'cancel' ? /fixture cancellation/ : /failed or teardown is unconfirmed/);
    await absent(f.output);
    await absent(`${f.output}.evidence.json`);
    assert.deepEqual(await readFile(path.join(f.scratch, 'candidate.vsix')), f.bytes);
  });
}

async function packageFixture(t) {
  const f = await fixture(t);
  const source = path.join(f.root, 'application/hosts/vscode');
  const build = path.join(f.base, 'isolated-build');
  const stage = path.join(f.base, 'package');
  const put = async (file, bytes) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); };
  for (const [name, bytes] of Object.entries({ 'package.json': '{"name":"fixture"}', '.vscodeignore': 'ignored', 'media/icon.svg': 'icon', 'media/nested/full.svg': 'full media', 'runtime/bootstrap.cjs': 'bootstrap', 'runtime/windows-runtime-lock.cjs': 'checkout adapter', 'out/stale.js': 'must not copy' })) await put(path.join(source, name), bytes);
  await put(path.join(f.root, 'LICENSE'), Buffer.from('root license\r\n'));
  await put(path.join(f.root, 'COPYRIGHT'), Buffer.from('root copyright\r\n'));
  await put(path.join(f.root, 'lib/windows-runtime-lock/windows-runtime-lock.cjs'), 'neutral lock owner');
  for (const [name, bytes] of Object.entries({ 'pi-runtime/manifest.json': '{}', 'host.js': 'isolated output', '.cache/secret': 'excluded', 'nested/.cache/secret': 'excluded', 'nested/asset': 'included',
    'resources/tool-runtimes/playwright-headless-shell/manifest.json': 'prepared payload manifest',
    'resources/tool-runtimes/playwright-headless-shell/headless-shell/chrome-headless-shell.exe': 'headless executable' })) await put(path.join(build, name), bytes);
  return { ...f, source, build, stage };
}

test('real staging copies root licence notices byte-for-byte with full media, neutral lock and isolated output', async t => {
  const f = await packageFixture(t);
  await stageExtensionForPackaging(f.root, f.build, f.stage);
  for (const [name, bytes] of Object.entries({ 'runtime/windows-runtime-lock.cjs': 'neutral lock owner', 'runtime/bootstrap.cjs': 'bootstrap', 'media/nested/full.svg': 'full media', 'media/icon.svg': 'icon', 'out/host.js': 'isolated output', 'out/nested/asset': 'included', 'out/pi-runtime/manifest.json': '{}',
    'out/resources/tool-runtimes/playwright-headless-shell/manifest.json': 'prepared payload manifest',
    'out/resources/tool-runtimes/playwright-headless-shell/headless-shell/chrome-headless-shell.exe': 'headless executable', '.vscodeignore': 'ignored' })) assert.equal(await readFile(path.join(f.stage, name), 'utf8'), bytes);
  assert.deepEqual(await readFile(path.join(f.stage, 'LICENSE')), Buffer.from('root license\r\n'));
  assert.deepEqual(await readFile(path.join(f.stage, 'COPYRIGHT')), Buffer.from('root copyright\r\n'));
  for (const name of ['LICENSE', 'COPYRIGHT']) await absent(path.join(f.source, name));
  for (const name of ['out/stale.js', 'out/.cache', 'out/nested/.cache']) await absent(path.join(f.stage, name));
});

for (const name of ['LICENSE', 'COPYRIGHT']) {
  test(`real staging requires a regular root ${name} file`, async t => {
    const f = await packageFixture(t);
    await rm(path.join(f.root, name));
    await assert.rejects(stageExtensionForPackaging(f.root, f.build, f.stage), /requires a regular file/);
    await absent(f.stage);
  });
}

test('real staging refuses prepublish hooks without executing them', async t => {
  const f = await packageFixture(t);
  await writeFile(path.join(f.source, 'package.json'), JSON.stringify({ scripts: { 'vscode:prepublish': 'never execute this' } }));
  await assert.rejects(stageExtensionForPackaging(f.root, f.build, f.stage), /refuses manifest vscode:prepublish/);
  await absent(f.stage);
});

for (const location of ['media', 'runtime', 'build']) {
  test(`real staging rejects ${location} symlinks`, async t => {
    const f = await packageFixture(t);
    const directory = location === 'build' ? f.build : path.join(f.source, location);
    // Directory junctions are available without Windows symlink privileges.
    await symlink(f.scratch, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(stageExtensionForPackaging(f.root, f.build, f.stage), /non-regular/);
  });
}
