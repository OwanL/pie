import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PI_RUNTIME_PACKAGES } from '../pi-runtime-artifact.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OPTIONAL_COMPUTER_USE_PEERS = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  'typebox',
];

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
}

function packageNameFromLockPath(packagePath) {
  const match = packagePath.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
  return match?.[1];
}

function assertNoPiRuntimePackageRecords(lockPath, lock) {
  assert.equal(lock.lockfileVersion, 3, `${lockPath} should use the npm package graph`);
  const piPackageNames = new Set(PI_RUNTIME_PACKAGES);
  const records = Object.keys(lock.packages).filter((packagePath) =>
    piPackageNames.has(packageNameFromLockPath(packagePath)));
  assert.deepEqual(records, [], `${lockPath} must not lock registry Pi runtime packages`);
}

test('shipped host and computer-use install locks exclude the Pi runtime package graph', () => {
  const hostManifestPath = 'application/hosts/vscode/package.json';
  const hostLockPath = 'application/hosts/vscode/package-lock.json';
  const computerUseManifestPath = 'extensions/computer-use/package.json';
  const computerUseLockPath = 'extensions/computer-use/package-lock.json';
  const hostManifest = readJson(hostManifestPath);
  const hostLock = readJson(hostLockPath);
  const computerUseManifest = readJson(computerUseManifestPath);
  const computerUseLock = readJson(computerUseLockPath);

  assert.equal(hostManifest.dependencies['@earendil-works/pi-coding-agent'], undefined);
  assert.equal(hostLock.packages[''].dependencies['@earendil-works/pi-coding-agent'], undefined);
  assertNoPiRuntimePackageRecords(hostLockPath, hostLock);
  assertNoPiRuntimePackageRecords(computerUseLockPath, computerUseLock);

  assert.deepEqual(Object.keys(computerUseManifest.peerDependencies).sort(), OPTIONAL_COMPUTER_USE_PEERS);
  assert.deepEqual(Object.keys(computerUseLock.packages[''].peerDependencies).sort(), OPTIONAL_COMPUTER_USE_PEERS);
  for (const peerName of OPTIONAL_COMPUTER_USE_PEERS) {
    assert.equal(computerUseManifest.peerDependencies[peerName], '*', `${peerName} manifest peer range`);
    assert.equal(computerUseManifest.peerDependenciesMeta[peerName]?.optional, true, `${peerName} manifest peer must be optional`);
    assert.equal(computerUseLock.packages[''].peerDependencies[peerName], '*', `${peerName} lock peer range`);
    assert.equal(computerUseLock.packages[''].peerDependenciesMeta[peerName]?.optional, true, `${peerName} lock peer must be optional`);
  }
});
