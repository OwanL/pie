import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertPrivateOutput,
  assertRuntimeLock,
  buildChildEnvironment,
  createManifestTarball,
  createRuntimeOwnerManifest,
  sanitizePackageManifest,
} from '../pi-runtime.mjs';

const piNames = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-tui',
  '@earendil-works/pi-coding-agent',
];
const manifests = [
  {
    name: piNames[0],
    version: '0.80.6',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    bin: { 'pi-ai': './dist/cli.js' },
    dependencies: { 'tiny-invariant': '1.0.0' },
    optionalDependencies: { 'optional-fixture': '^2.0.0' },
    engines: { node: '>=20' },
    piConfig: { runtime: true },
    scripts: { prepare: 'node build.js' },
    devDependencies: { typescript: '^5.0.0' },
    overrides: { 'tiny-invariant': '1.0.1' },
    files: ['dist'],
    publishConfig: { access: 'public' },
  },
  {
    name: piNames[1],
    version: '0.80.6',
    dependencies: { [piNames[0]]: '^0.80.6' },
  },
  {
    name: piNames[2],
    version: '0.80.6',
    dependencies: { 'kleur': '^4.1.5' },
  },
  {
    name: piNames[3],
    version: '0.80.6',
    dependencies: {
      [piNames[0]]: '^0.80.6',
      [piNames[1]]: '^0.80.6',
      [piNames[2]]: '^0.80.6',
    },
  },
];
const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;

function makeValidLock(packageManifests = manifests) {
  const packages = {
    '': {
      name: 'pie-private-pi-runtime',
      version: '1.0.0',
      dependencies: Object.fromEntries(packageManifests.map((manifest) => {
        const slug = manifest.name.slice(manifest.name.lastIndexOf('/') + 1);
        return [manifest.name, `file:tarballs/${slug}.tgz`];
      })),
    },
  };
  for (const manifest of packageManifests) {
    const slug = manifest.name.slice(manifest.name.lastIndexOf('/') + 1);
    packages[`node_modules/${manifest.name}`] = {
      name: manifest.name,
      version: manifest.version,
      resolved: `file:tarballs/${slug}.tgz`,
      integrity,
      ...(manifest.dependencies && { dependencies: structuredClone(manifest.dependencies) }),
      ...(manifest.optionalDependencies && { optionalDependencies: structuredClone(manifest.optionalDependencies) }),
    };
  }
  return { name: 'pie-private-pi-runtime', lockfileVersion: 3, packages };
}

function readTarEntries(tarball) {
  const tar = gunzipSync(tarball);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/u, '');
    const name = field(0, 100);
    const prefix = field(345, 155);
    const sizeText = field(124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const bodyStart = offset + 512;
    entries.push({ name: fullName, type, body: tar.subarray(bodyStart, bodyStart + size) });
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test('sanitizePackageManifest keeps runtime metadata and drops build/publish-only fields', () => {
  const sanitized = sanitizePackageManifest(manifests[0]);
  for (const key of [
    'name', 'version', 'type', 'main', 'types', 'exports', 'bin',
    'dependencies', 'optionalDependencies', 'engines', 'piConfig',
  ]) {
    assert.deepEqual(sanitized[key], manifests[0][key], `${key} must be retained`);
  }
  for (const key of ['scripts', 'devDependencies', 'overrides', 'files', 'publishConfig']) {
    assert.equal(Object.hasOwn(sanitized, key), false, `${key} must not enter runtime metadata`);
  }
});

test('createManifestTarball is deterministic gzip tar with only sanitized package/package.json', () => {
  const first = createManifestTarball(manifests[0]);
  const second = createManifestTarball(manifests[0]);
  assert.ok(Buffer.isBuffer(first));
  assert.equal(first[9], 255, 'gzip OS field must be platform independent');
  assert.deepEqual(second, first, 'identical manifests must produce identical compressed bytes');
  const entries = readTarEntries(first);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'package/package.json');
  assert.equal(entries[0].type, '0');
  const content = JSON.parse(entries[0].body.toString('utf8'));
  assert.deepEqual(content, sanitizePackageManifest(manifests[0]));
  assert.equal(Object.hasOwn(content, 'scripts'), false);
});

test('tarball integrity depends on sanitized metadata, not script changes or key order', () => {
  const base = manifests[0];
  const reordered = Object.fromEntries(Object.entries(base).reverse());
  assert.deepEqual(createManifestTarball(reordered), createManifestTarball(base));
  assert.deepEqual(createManifestTarball({ ...base, scripts: { build: 'changed source build command' } }), createManifestTarball(base));
  assert.notDeepEqual(createManifestTarball({ ...base, dependencies: { 'tiny-invariant': '1.1.0' } }), createManifestTarball(base));
});

test('createRuntimeOwnerManifest points exactly four Pi packages at local tarballs', () => {
  const owner = createRuntimeOwnerManifest(manifests);
  assert.equal(owner.private, true);
  assert.deepEqual(Object.keys(owner.dependencies).sort(), [...piNames].sort());
  for (const name of piNames) {
    const slug = name.slice(name.lastIndexOf('/') + 1);
    assert.equal(owner.dependencies[name], `file:tarballs/${slug}.tgz`);
  }
});

test('assertRuntimeLock accepts matching local tarballs and dependency metadata', () => {
  assert.doesNotThrow(() => assertRuntimeLock(makeValidLock(), manifests));
});

test('assertRuntimeLock rejects wrong Pi versions, registry/nested/duplicate/extra entries, and bad metadata', () => {
  for (const manifest of manifests) {
    const lock = makeValidLock();
    lock.packages[`node_modules/${manifest.name}`].version = '9.9.9';
    assert.throws(() => assertRuntimeLock(lock, manifests));
  }

  const registryLock = makeValidLock();
  registryLock.packages[`node_modules/${piNames[0]}`].resolved = `https://registry.npmjs.org/${piNames[0].replace('/', '%2f')}/-/${piNames[0].split('/')[1]}-0.80.6.tgz`;
  assert.throws(() => assertRuntimeLock(registryLock, manifests));

  const nestedLock = makeValidLock();
  nestedLock.packages[`node_modules/fixture/node_modules/${piNames[0]}`] = {
    ...nestedLock.packages[`node_modules/${piNames[0]}`],
  };
  assert.throws(() => assertRuntimeLock(nestedLock, manifests));

  const duplicateLock = makeValidLock();
  duplicateLock.packages['node_modules/pi-ai-alias'] = {
    ...duplicateLock.packages[`node_modules/${piNames[0]}`],
  };
  assert.throws(() => assertRuntimeLock(duplicateLock, manifests));

  const extraPiLock = makeValidLock();
  extraPiLock.packages['node_modules/@earendil-works/pi-orchestrator'] = {
    name: '@earendil-works/pi-orchestrator',
    version: '0.80.6',
    resolved: 'file:tarballs/pi-orchestrator.tgz',
    integrity,
  };
  assert.throws(() => assertRuntimeLock(extraPiLock, manifests));

  const missingIntegrityLock = makeValidLock();
  delete missingIntegrityLock.packages[`node_modules/${piNames[0]}`].integrity;
  assert.throws(() => assertRuntimeLock(missingIntegrityLock, manifests));

  const changedDependenciesLock = makeValidLock();
  changedDependenciesLock.packages[`node_modules/${piNames[0]}`].dependencies['tiny-invariant'] = '9.0.0';
  assert.throws(() => assertRuntimeLock(changedDependenciesLock, manifests));

  const changedOptionalDependenciesLock = makeValidLock();
  changedOptionalDependenciesLock.packages[`node_modules/${piNames[0]}`].optionalDependencies['optional-fixture'] = '9.0.0';
  assert.throws(() => assertRuntimeLock(changedOptionalDependenciesLock, manifests));
});

test('assertPrivateOutput rejects protected locations, existing outputs, and symlink ancestors', (t) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'pie-pi-runtime-private-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const repositoryRoot = path.join(fixture, 'repository');
  mkdirSync(path.join(repositoryRoot, 'data'), { recursive: true });
  mkdirSync(path.join(repositoryRoot, 'settings'), { recursive: true });
  const safeOutput = path.join(fixture, 'private-runtime');
  assert.doesNotThrow(() => assertPrivateOutput(safeOutput, repositoryRoot));

  for (const protectedPath of [
    repositoryRoot,
    path.join(repositoryRoot, 'data', 'runtime'),
    path.join(repositoryRoot, 'settings', 'runtime'),
    path.parse(repositoryRoot).root,
    os.homedir(),
    path.join(os.homedir(), 'Documents', `pie-runtime-test-${process.pid}`),
    path.join(os.homedir(), '.pi', 'agent', 'data', `pie-runtime-test-${process.pid}`),
    path.join(os.homedir(), '.pi', 'agent', 'settings.json'),
    path.join(os.homedir(), '.vscode', 'extensions', `pie-runtime-test-${process.pid}`),
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
