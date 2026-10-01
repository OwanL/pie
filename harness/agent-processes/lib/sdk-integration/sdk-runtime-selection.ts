import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { GenerationPiRuntimeDescriptor, PiRuntimeTarget } from '../../../../lib/pi-runtime/artifact.mjs';
import { SDK_PATCH_IDENTITY_VERSION, validateSdkPatchBarrier, type SdkPatchIdentity } from './sdk-patch-barrier';
import { verifySdkRuntimeArtifactDescriptor } from './sdk-runtime-artifact';
import type { SdkLoadMode, SourceSdkLoadMode } from './sdk';

/** Required on internal transports. Only the coordinator constructor supplies a local legacy default. */
export type SdkRuntimeSelection =
  | { kind: 'legacy-patched'; patchIdentity: SdkPatchIdentity }
  | { kind: 'source-artifact'; descriptor: GenerationPiRuntimeDescriptor };

function fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const digest = (value: unknown) => text(value, 64) && /^[a-f0-9]{64}$/.test(value);

export function validateSdkRuntimeSelectionShape(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return 'sdkRuntime must be a discriminated object.';
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
  if (kind === 'legacy-patched') {
    if (!fields(value, ['kind', 'patchIdentity'])) return 'sdkRuntime legacy selection has unsupported fields.';
    const identity = value.patchIdentity;
    const names = ['terminalDurability', 'retryClassifier', 'coldCreateDurability', 'sessionOwnershipAdapter', 'sessionReplacementAdapter'];
    if (!fields(identity, ['identityVersion', 'sdkPath', 'sdkVersion', ...names])
      || identity.identityVersion !== SDK_PATCH_IDENTITY_VERSION || !text(identity.sdkPath) || !text(identity.sdkVersion, 128)) return 'sdkRuntime patchIdentity is invalid.';
    for (const name of names) {
      const file = identity[name];
      if (!fields(file, ['patchVersion', 'relativePath', 'sha256']) || !Number.isSafeInteger(file.patchVersion)
        || (file.patchVersion as number) <= 0 || !text(file.relativePath) || !digest(file.sha256)) return `sdkRuntime patchIdentity.${name} is invalid.`;
    }
    return undefined;
  }
  if (kind === 'source-artifact') {
    if (!fields(value, ['kind', 'descriptor'])) return 'sdkRuntime source selection has unsupported fields.';
    const descriptor = value.descriptor;
    if (!fields(descriptor, ['schemaVersion', 'artifactDir', 'sdkPath', 'cliPath', 'identity', 'manifest'])
      || descriptor.schemaVersion !== 1 || !digest(descriptor.identity)
      || !['artifactDir', 'sdkPath', 'cliPath'].every(key => text(descriptor[key]) && path.isAbsolute(descriptor[key] as string))) return 'sdkRuntime descriptor is invalid.';
    // Full bounded manifest schema and payload verification belong to E1 and run before every import.
    if (!fields(descriptor.manifest, ['schemaVersion', 'upstreamVersion', 'upstreamCommit', 'sourceTreeSha256', 'lockSha256', 'target', 'packages', 'payloadSha256'])) return 'sdkRuntime manifest has unsupported fields.';
    return undefined;
  }
  return 'sdkRuntime.kind must be legacy-patched or source-artifact.';
}

export function parseSdkRuntimeSelection(value: unknown): SdkRuntimeSelection {
  const error = validateSdkRuntimeSelectionShape(value);
  if (error) throw new TypeError(error);
  return value as SdkRuntimeSelection;
}

export function currentBackendTarget(): PiRuntimeTarget {
  return { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
}

export function sdkRuntimeSdkPath(selection: SdkRuntimeSelection): string {
  const parsed = parseSdkRuntimeSelection(selection);
  return parsed.kind === 'source-artifact' ? parsed.descriptor.sdkPath : parsed.patchIdentity.sdkPath;
}

export async function verifySdkRuntimeSelection(sdkPath: string, selection: unknown): Promise<SdkRuntimeSelection> {
  const parsed = parseSdkRuntimeSelection(selection);
  if (parsed.kind === 'legacy-patched') {
    return { kind: parsed.kind, patchIdentity: await validateSdkPatchBarrier(sdkPath, parsed.patchIdentity) };
  }
  const descriptor = await verifySdkRuntimeArtifactDescriptor(parsed.descriptor, currentBackendTarget());
  if (!path.isAbsolute(sdkPath) || await realpath(sdkPath) !== descriptor.sdkPath) throw new Error('SDK path does not match source runtime selection.');
  return { kind: parsed.kind, descriptor };
}

export function sdkRuntimeLoadMode(selection: SdkRuntimeSelection, surface: 'cold'): (SourceSdkLoadMode & { surface: 'cold' }) | { mode: 'cold-worker'; patchIdentity: SdkPatchIdentity };
export function sdkRuntimeLoadMode(selection: SdkRuntimeSelection, surface: 'full'): (SourceSdkLoadMode & { surface: 'full' }) | { mode: 'worker'; patchIdentity: SdkPatchIdentity };
export function sdkRuntimeLoadMode(selection: SdkRuntimeSelection, surface: 'cold' | 'full'): SdkLoadMode {
  const parsed = parseSdkRuntimeSelection(selection);
  return parsed.kind === 'source-artifact'
    ? { mode: 'source-artifact', descriptor: parsed.descriptor, backendTarget: currentBackendTarget(), surface }
    : { mode: surface === 'cold' ? 'cold-worker' : 'worker', patchIdentity: parsed.patchIdentity };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function assertSdkRuntimeAgreement(sdkPath: string, retained: SdkRuntimeSelection, requested?: unknown): void {
  if (sdkPath !== sdkRuntimeSdkPath(retained)) throw new Error('SDK path does not match retained runtime selection.');
  if (arguments.length >= 3 && canonical(parseSdkRuntimeSelection(requested)) !== canonical(retained)) throw new Error('SDK runtime selection does not match initialization.');
}
