import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  PI_RUNTIME_PACKAGES,
  PI_RUNTIME_SDK_RELATIVE_PATH,
  verifyPiRuntimeArtifact,
  type GenerationPiRuntimeDescriptor,
  type PiRuntimeManifest,
  type PiRuntimeTarget,
} from '../../../../lib/pi-runtime/artifact.mjs';

const DESCRIPTOR_KEYS = ['schemaVersion', 'artifactDir', 'sdkPath', 'cliPath', 'identity', 'manifest'];
const MANIFEST_KEYS = [
  'schemaVersion', 'upstreamVersion', 'upstreamCommit', 'sourceTreeSha256',
  'lockSha256', 'target', 'packages', 'payloadSha256',
];
const TARGET_KEYS = ['platform', 'arch', 'nodeAbi'];
const PACKAGE_KEYS = ['version', 'treeSha256'];
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z0-9_-]+$/;
const MAX_PATH_LENGTH = 4096;
const MAX_IDENTIFIER_LENGTH = 64;
const MAX_TEXT_LENGTH = 128;

function invalid(message: string): never {
  throw new TypeError(`Invalid Pi runtime descriptor: ${message}`);
}

function ownFields(value: unknown, label: string, expectedKeys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) {
    invalid(`${label} has an unsupported shape`);
  }
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) {
      invalid(`${label}.${key} must be an own data property`);
    }
    fields[key] = property.value;
  }
  return fields;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    invalid(`${label} must be a nonempty string of at most ${maximum} characters`);
  }
  return value;
}

function validateDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(`${label} must be a SHA-256 hex digest`);
  return value;
}

function validateTarget(value: unknown, label: string): PiRuntimeTarget {
  const fields = ownFields(value, label, TARGET_KEYS);
  const platform = boundedString(fields.platform, `${label}.platform`, MAX_IDENTIFIER_LENGTH);
  const arch = boundedString(fields.arch, `${label}.arch`, MAX_IDENTIFIER_LENGTH);
  const nodeAbi = boundedString(fields.nodeAbi, `${label}.nodeAbi`, MAX_IDENTIFIER_LENGTH);
  if (!IDENTIFIER.test(platform)) invalid(`${label}.platform must be a nonempty identifier`);
  if (!IDENTIFIER.test(arch)) invalid(`${label}.arch must be a nonempty identifier`);
  if (!/^\d+$/.test(nodeAbi)) invalid(`${label}.nodeAbi must be a decimal string`);
  return { platform, arch, nodeAbi };
}

function validateManifest(value: unknown): PiRuntimeManifest {
  const fields = ownFields(value, 'manifest', MANIFEST_KEYS);
  if (fields.schemaVersion !== 1) invalid('manifest.schemaVersion must be 1');
  const upstreamVersion = boundedString(fields.upstreamVersion, 'manifest.upstreamVersion', MAX_TEXT_LENGTH);
  const upstreamCommit = boundedString(fields.upstreamCommit, 'manifest.upstreamCommit', MAX_TEXT_LENGTH);
  const sourceTreeSha256 = validateDigest(fields.sourceTreeSha256, 'manifest.sourceTreeSha256');
  const lockSha256 = validateDigest(fields.lockSha256, 'manifest.lockSha256');
  const target = validateTarget(fields.target, 'manifest.target');
  const payloadSha256 = validateDigest(fields.payloadSha256, 'manifest.payloadSha256');
  const packageFields = ownFields(fields.packages, 'manifest.packages', PI_RUNTIME_PACKAGES);
  const packages: PiRuntimeManifest['packages'] = {};
  for (const name of PI_RUNTIME_PACKAGES) {
    const pkg = ownFields(packageFields[name], `manifest.packages.${name}`, PACKAGE_KEYS);
    const version = boundedString(pkg.version, `manifest.packages.${name}.version`, MAX_TEXT_LENGTH);
    const treeSha256 = validateDigest(pkg.treeSha256, `manifest.packages.${name}.treeSha256`);
    packages[name] = { version, treeSha256 };
  }
  return {
    schemaVersion: 1,
    upstreamVersion,
    upstreamCommit,
    sourceTreeSha256,
    lockSha256,
    target,
    packages,
    payloadSha256,
  };
}

function validateDescriptor(value: unknown): GenerationPiRuntimeDescriptor {
  const fields = ownFields(value, 'descriptor', DESCRIPTOR_KEYS);
  if (fields.schemaVersion !== 1) invalid('schemaVersion must be 1');
  const artifactDir = boundedString(fields.artifactDir, 'artifactDir', MAX_PATH_LENGTH);
  const sdkPath = boundedString(fields.sdkPath, 'sdkPath', MAX_PATH_LENGTH);
  const cliPath = boundedString(fields.cliPath, 'cliPath', MAX_PATH_LENGTH);
  for (const [label, value] of [['artifactDir', artifactDir], ['sdkPath', sdkPath], ['cliPath', cliPath]] as const) {
    if (!path.isAbsolute(value)) invalid(`${label} must be an absolute path`);
  }
  const identity = validateDigest(fields.identity, 'identity');
  const manifest = validateManifest(fields.manifest);
  return { schemaVersion: 1, artifactDir, sdkPath, cliPath, identity, manifest };
}

function manifestsMatch(actual: PiRuntimeManifest, expected: PiRuntimeManifest): boolean {
  return actual.schemaVersion === expected.schemaVersion
    && actual.upstreamVersion === expected.upstreamVersion
    && actual.upstreamCommit === expected.upstreamCommit
    && actual.sourceTreeSha256 === expected.sourceTreeSha256
    && actual.lockSha256 === expected.lockSha256
    && actual.target.platform === expected.target.platform
    && actual.target.arch === expected.target.arch
    && actual.target.nodeAbi === expected.target.nodeAbi
    && actual.payloadSha256 === expected.payloadSha256
    && PI_RUNTIME_PACKAGES.every((name) => actual.packages[name].version === expected.packages[name].version
      && actual.packages[name].treeSha256 === expected.packages[name].treeSha256);
}

/**
 * Independently verify a serialized Pi runtime descriptor for the backend Node
 * target that will load it. The artifact verifier re-reads and hashes the full
 * payload; descriptor-provided identity and manifest values are only compared,
 * never trusted as verification evidence. This function does not modify files.
 */
export async function verifySdkRuntimeArtifactDescriptor(
  receivedDescriptor: unknown,
  backendTarget: PiRuntimeTarget,
): Promise<GenerationPiRuntimeDescriptor> {
  if (backendTarget === undefined || backendTarget === null) {
    invalid('an explicit backend target is required');
  }
  const descriptor = validateDescriptor(receivedDescriptor);
  const target = validateTarget(backendTarget, 'backend target');
  const verified = await verifyPiRuntimeArtifact(descriptor.artifactDir, { target });

  // The shared verifier permits unknown manifest fields for compatibility. A
  // received descriptor has a fixed bounded schema, so reject such extensions
  // rather than silently omitting data that could affect its identity.
  const verifiedManifest = validateManifest(verified.manifest);
  const sdkPath = await realpath(path.join(verified.artifactDir, PI_RUNTIME_SDK_RELATIVE_PATH));
  const cliPath = await realpath(path.join(sdkPath, 'dist', 'cli.js'));

  if (descriptor.artifactDir !== verified.artifactDir) invalid('artifactDir is not the canonical artifact path');
  if (descriptor.sdkPath !== sdkPath) invalid('sdkPath does not match the canonical SDK path');
  if (descriptor.cliPath !== cliPath) invalid('cliPath does not match the canonical CLI path');
  if (descriptor.identity !== verified.identity) invalid('identity does not match the verified artifact');
  if (!manifestsMatch(descriptor.manifest, verifiedManifest)) invalid('manifest does not match the verified artifact');

  return {
    schemaVersion: 1,
    artifactDir: verified.artifactDir,
    sdkPath,
    cliPath,
    identity: verified.identity,
    manifest: verifiedManifest,
  };
}
