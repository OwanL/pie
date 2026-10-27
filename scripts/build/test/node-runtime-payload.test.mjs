import assert from 'node:assert/strict';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  computeNodeRuntimePayloadIdentity,
  readNodeRuntimeManifest,
} from '../../../lib/node-runtime/manifest.mjs';
import {
  parseNodeRuntimeOption,
  prepareNodeRuntimePayload,
  validateNodeRuntimePayload,
} from '../node-runtime-payload.mjs';

const NODE_VERSION = '24.16.0';
const ARCHIVE_URL = `https://nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`;
const ARCHIVE_SHA256 = 'edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56';
const LICENSE_BYTES = Buffer.from('Node.js official LICENSE fixture; preserved in full.\nCopyright OpenJS Foundation.\n');
const EXECUTABLE_BYTES = Buffer.from('synthetic node.exe fixture; never executed by these tests.\n');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-node-runtime-payload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, 'repository');
  const toolchainRoot = path.join(root, 'proto', 'tools', 'node');
  const versionRoot = path.join(toolchainRoot, NODE_VERSION);
  const outputs = path.join(root, 'outputs');
  await Promise.all([mkdir(repositoryRoot, { recursive: true }), mkdir(versionRoot, { recursive: true }), mkdir(outputs, { recursive: true })]);
  await writeFile(path.join(repositoryRoot, '.node-version'), `${NODE_VERSION}\n`);
  await writeFile(path.join(repositoryRoot, '.prototools'), `node = "${NODE_VERSION}"\npnpm = "10.34.4"\n`);
  const executablePath = path.join(versionRoot, 'node.exe');
  const licensePath = path.join(versionRoot, 'LICENSE');
  const toolchainManifestPath = path.join(toolchainRoot, 'manifest.json');
  await writeFile(executablePath, EXECUTABLE_BYTES);
  await writeFile(licensePath, LICENSE_BYTES);
  await writeFile(toolchainManifestPath, JSON.stringify({
    versions: {
      [NODE_VERSION]: {
        lock: { os: 'windows', arch: 'x64', checksum: `sha256:${ARCHIVE_SHA256}`, source: ARCHIVE_URL },
      },
    },
  }, null, 2) + '\n');
  return { root, repositoryRoot, executablePath, licensePath, toolchainManifestPath, outputs };
}

function probe(metadata = {}) {
  return async input => {
    assert.equal(input.timeoutMs, 5_000);
    assert.equal(path.basename(input.executablePath), 'node.exe');
    assert.equal(path.basename(input.cwd), 'cwd');
    assert.ok(input.cwd.startsWith(path.dirname(input.executablePath)));
    assert.equal(Object.hasOwn(input.env, 'NODE_OPTIONS'), false);
    assert.equal(Object.hasOwn(input.env, 'NODE_PATH'), false);
    assert.equal(input.env.HOME.startsWith(path.dirname(input.cwd)), true);
    assert.equal(input.env.TEMP.startsWith(path.dirname(input.cwd)), true);
    return {
      nodeVersion: NODE_VERSION,
      nodeAbi: '137',
      platform: 'win32',
      arch: 'x64',
      ...metadata,
    };
  };
}

async function prepare(fixtureValue, name = 'payload', dependencies = {}) {
  const destinationDirectory = path.join(fixtureValue.outputs, name);
  const result = await prepareNodeRuntimePayload({
    repositoryRoot: fixtureValue.repositoryRoot,
    executablePath: fixtureValue.executablePath,
    licensePath: fixtureValue.licensePath,
    toolchainManifestPath: fixtureValue.toolchainManifestPath,
    destinationDirectory,
  }, { probeRuntime: probe(), ...dependencies });
  return { ...result, destinationDirectory };
}

test('delivery parser accepts only one explicit absolute Node payload selection', () => {
  const directory = path.join(os.tmpdir(), 'prepared-node-runtime');
  assert.equal(parseNodeRuntimeOption(['--delivery', '--node-runtime', directory], { requireDelivery: true }), directory);
  assert.equal(parseNodeRuntimeOption(['--delivery', `--node-runtime=${directory}`], { requireDelivery: true }), directory);
  assert.equal(parseNodeRuntimeOption(['--delivery']), undefined);
  for (const args of [
    ['--node-runtime', directory], ['--delivery', '--node-runtime'],
    ['--delivery', '--node-runtime', 'relative'],
    ['--delivery', '--node-runtime', directory, '--node-runtime', directory],
    ['--delivery', '--node-runtime', directory, '--watch'],
  ]) assert.throws(() => parseNodeRuntimeOption(args, { requireDelivery: true }));
});

test('prepares and relocates an immutable pinned Node payload without running synthetic test executables', async t => {
  const source = await fixture(t);
  let probeCalls = 0;
  const destinationDirectory = path.join(source.outputs, 'payload');
  const result = await prepareNodeRuntimePayload({
    repositoryRoot: source.repositoryRoot,
    executablePath: source.executablePath,
    licensePath: source.licensePath,
    toolchainManifestPath: source.toolchainManifestPath,
    destinationDirectory,
  }, {
    probeRuntime: async input => {
      probeCalls += 1;
      return probe()(input);
    },
  });

  assert.equal(probeCalls, 1, 'preparation probes once through the injected test seam');
  assert.equal(result.manifest.schemaVersion, 1);
  assert.equal(result.manifest.kind, 'node-runtime');
  assert.equal(result.manifest.nodeVersion, NODE_VERSION, 'version comes from repository pins');
  assert.deepEqual(result.manifest.target, { platform: 'win32', arch: 'x64', nodeAbi: '137' });
  assert.equal(result.manifest.executable, 'node.exe');
  assert.deepEqual(result.manifest.inventory.map(({ relativePath }) => relativePath), ['LICENSE', 'node.exe']);
  assert.deepEqual(result.manifest.provenance, {
    kind: 'local-toolchain', archiveUrl: ARCHIVE_URL, archiveSha256: ARCHIVE_SHA256,
  });
  assert.doesNotMatch(JSON.stringify(result.manifest), /C:\\\\|repository|proto\\\\tools/u, 'provenance contains no personal/local source paths');
  assert.deepEqual(await readFile(path.join(destinationDirectory, 'LICENSE')), LICENSE_BYTES, 'the complete LICENSE bytes are copied');
  assert.deepEqual(await readFile(path.join(destinationDirectory, 'node.exe')), EXECUTABLE_BYTES);
  assert.deepEqual((await readdir(destinationDirectory)).sort(), ['LICENSE', 'manifest.json', 'node.exe']);
  assert.equal((await readNodeRuntimeManifest(destinationDirectory)).payloadIdentity, result.identity);

  const relocated = path.join(source.outputs, 'relocated');
  await cp(destinationDirectory, relocated, { recursive: true });
  const verified = await validateNodeRuntimePayload({ directory: relocated, repositoryRoot: source.repositoryRoot });
  assert.equal(verified.identity, result.identity);
  assert.equal(verified.directory, await realpath(relocated));
  assert.equal(probeCalls, 1, 'validation and relocation never execute node.exe');
});

test('shared identity is canonical and excludes only the payloadIdentity field', () => {
  const left = { z: [1, { y: true, a: 'x' }], a: 4 };
  const right = { a: 4, z: [1, { a: 'x', y: true }] };
  assert.equal(computeNodeRuntimePayloadIdentity(left), computeNodeRuntimePayloadIdentity(right));
  assert.throws(() => computeNodeRuntimePayloadIdentity({ ...left, payloadIdentity: 'a'.repeat(64) }), /without payloadIdentity/u);
});

test('preparation rejects a probe that does not match the repository version and removes staging', async t => {
  const source = await fixture(t);
  const destination = path.join(source.outputs, 'wrong-version');
  await assert.rejects(prepareNodeRuntimePayload({
    repositoryRoot: source.repositoryRoot,
    executablePath: source.executablePath,
    licensePath: source.licensePath,
    toolchainManifestPath: source.toolchainManifestPath,
    destinationDirectory: destination,
  }, { probeRuntime: probe({ nodeVersion: '24.18.0' }) }), /does not match repository pin/u);
  assert.equal(await lstat(destination).then(() => true, () => false), false);
  assert.deepEqual(await readdir(source.outputs), [], 'failed preparation removes only its private staging directory');
});

test('preparation rejects unsupported probe targets and invalid toolchain archive declarations', async t => {
  const source = await fixture(t);
  const base = {
    repositoryRoot: source.repositoryRoot,
    executablePath: source.executablePath,
    licensePath: source.licensePath,
    toolchainManifestPath: source.toolchainManifestPath,
  };
  await assert.rejects(prepareNodeRuntimePayload({ ...base, destinationDirectory: path.join(source.outputs, 'wrong-target') }, {
    probeRuntime: probe({ arch: 'arm64' }),
  }), /supported win32 x64 ABI 137 target/u);
  await writeFile(source.toolchainManifestPath, JSON.stringify({ versions: { [NODE_VERSION]: {
    lock: { os: 'windows', arch: 'x64', checksum: `sha256:${ARCHIVE_SHA256}`, source: 'file:///private/node.zip' },
  } } }));
  await assert.rejects(prepareNodeRuntimePayload({ ...base, destinationDirectory: path.join(source.outputs, 'wrong-source') }, {
    probeRuntime: probe(),
  }), /official Node .* archive and SHA-256/u);
  assert.deepEqual(await readdir(source.outputs), []);
});

test('destination is explicit, new, and does not overlap repository inputs', async t => {
  const source = await fixture(t);
  const base = {
    repositoryRoot: source.repositoryRoot,
    executablePath: source.executablePath,
    licensePath: source.licensePath,
    toolchainManifestPath: source.toolchainManifestPath,
  };
  await assert.rejects(prepareNodeRuntimePayload({ ...base, destinationDirectory: source.repositoryRoot }, { probeRuntime: probe() }), /already exists|overlap/u);
  const insideRepository = path.join(source.repositoryRoot, 'new-payload');
  await assert.rejects(prepareNodeRuntimePayload({ ...base, destinationDirectory: insideRepository }, { probeRuntime: probe() }), /overlap/u);
  await assert.rejects(prepareNodeRuntimePayload({ ...base, destinationDirectory: path.join(source.outputs, 'extra'), nodeVersion: NODE_VERSION }, { probeRuntime: probe() }), /unsupported shape/u);
  assert.deepEqual(await readdir(source.outputs), []);
});

test('validation rejects extra entries, symlinks, mutations, and inconsistent manifest target metadata', async t => {
  const source = await fixture(t);

  const extra = await prepare(source, 'extra');
  await writeFile(path.join(extra.directory, 'unexpected.txt'), 'extra');
  await assert.rejects(validateNodeRuntimePayload({ directory: extra.directory, repositoryRoot: source.repositoryRoot }), /exactly manifest\.json/u);

  const mutated = await prepare(source, 'mutated');
  await writeFile(path.join(mutated.directory, 'node.exe'), Buffer.concat([EXECUTABLE_BYTES, Buffer.from('changed')]));
  await assert.rejects(validateNodeRuntimePayload({ directory: mutated.directory, repositoryRoot: source.repositoryRoot }), /missing, extra, or mutated/u);

  const caseCollision = await prepare(source, 'case-collision');
  const executable = path.join(caseCollision.directory, 'node.exe');
  const caseAlias = path.join(caseCollision.directory, 'NODE.EXE');
  const originalExecutable = await readFile(executable);
  await writeFile(caseAlias, Buffer.from('case collision'));
  const names = await readdir(caseCollision.directory);
  if (names.includes('node.exe') && names.includes('NODE.EXE')) {
    await assert.rejects(validateNodeRuntimePayload({ directory: caseCollision.directory, repositoryRoot: source.repositoryRoot }), /case-colliding/u);
  } else {
    await writeFile(executable, originalExecutable);
    t.diagnostic('Host filesystem is case-insensitive; duplicate-case entry creation is unavailable.');
  }

  const linked = await prepare(source, 'linked');
  const license = path.join(linked.directory, 'LICENSE');
  const savedLicense = await readFile(license);
  await rm(license);
  try {
    await symlink(source.licensePath, license, 'file');
  } catch (error) {
    await writeFile(license, savedLicense);
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.diagnostic(`Symlink creation is unavailable on this host (${error.code}); other immutability checks passed.`);
    } else throw error;
  }
  if ((await lstat(license)).isSymbolicLink()) {
    await assert.rejects(validateNodeRuntimePayload({ directory: linked.directory, repositoryRoot: source.repositoryRoot }), /symbolic link|regular file/u);
    await rm(license);
    await writeFile(license, savedLicense);
  }

  const wrongMetadata = await prepare(source, 'wrong-metadata');
  const manifest = { ...wrongMetadata.manifest, target: { ...wrongMetadata.manifest.target, nodeAbi: '138' } };
  const { payloadIdentity: _oldIdentity, ...withoutIdentity } = manifest;
  manifest.payloadIdentity = computeNodeRuntimePayloadIdentity(withoutIdentity);
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  await writeFile(path.join(wrongMetadata.directory, 'manifest.json'), `${JSON.stringify(canonical(manifest), null, 2)}\n`);
  await assert.rejects(readNodeRuntimeManifest(wrongMetadata.directory), /target is unsupported/u);
});
