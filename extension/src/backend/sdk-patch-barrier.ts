import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { renameWithTransientRetry } from '../shared/atomic-write';
import {
  SDK_SESSION_MANAGER_RELATIVE_PATH,
  SDK_SESSION_OWNERSHIP_MANAGER_PATCH_VERSION,
  SDK_SESSION_REPLACEMENT_RUNTIME_PATCH_VERSION,
  SDK_SESSION_RUNTIME_RELATIVE_PATH,
  hasSdkSessionManagerOwnershipMarkers,
  hasSdkSessionRuntimeOwnershipMarkers,
  reverseSdkSessionManagerOwnership,
  reverseSdkSessionRuntimeOwnership,
  transformSdkSessionManagerOwnership,
  transformSdkSessionRuntimeOwnership,
  type SdkSessionOwnershipTransformResult,
} from './sdk-session-ownership-patch';
import {
  hasSdkSessionOpenSingleReadMarkers,
  reverseSdkSessionOpenSingleRead,
  transformSdkSessionOpenSingleRead,
  type SdkSessionOpenTransformResult,
} from './sdk-session-open-patch';

export const SDK_PATCH_IDENTITY_VERSION = 5 as const;
const TERMINAL_DURABILITY_PATCH_VERSION = 1 as const;
const RETRY_CLASSIFIER_PATCH_VERSION = 1 as const;
const COLD_CREATE_DURABILITY_PATCH_VERSION = 2 as const;
const LOCK_OWNER_VERSION = 1 as const;

const TERMINAL_DURABILITY_RELATIVE_PATH = 'dist/core/agent-session.js';
const COLD_CREATE_DURABILITY_RELATIVE_PATH = SDK_SESSION_MANAGER_RELATIVE_PATH;
const RETRY_INSERTS = [
  'stream ended before a terminal response event',
  'upstream stream stalled',
  'upstream header phase stalled',
  'upstream transport circuit open',
] as const;

type RetryPatchShape = 'array' | 'inline';

interface RetryPatchCandidate {
  relativePath: string;
  needle: string;
  shape: RetryPatchShape;
}

const PINNED_PRODUCTION_SDK_VERSION = '0.80.6';
const PINNED_PRODUCTION_PRISTINE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  [TERMINAL_DURABILITY_RELATIVE_PATH]: 'b2b3b0e2b95ff88290232da4117920a6fd0cceb06bb5d66bb8f120fc934644e7',
  'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': '2bb9127db55cff5f34cd71b280f975d5e2bb7e17adcf48259482f6f36c69c18e',
  [SDK_SESSION_MANAGER_RELATIVE_PATH]: '879e80cc6e2371e4b06887e6fb041c323ba4e86f7687bfdac6474c9f61486112',
  [SDK_SESSION_RUNTIME_RELATIVE_PATH]: 'c00dc388caeb7f3c3ed1501a9387ad7f2a2013b3fe51253019cf62a945440ce7',
});
// Exact v7 input supported only as the known one-step upgrade to v8. It is not
// accepted as already patched after the v8 transform has been computed.
const PINNED_RUNTIME_V7_SHA256 = '888487c8d7bd6bab2271a2fb28cb14831a55d520617c8752188468cd8e745738';
const PINNED_RETRY_LEGACY_PATCHED_SHA256 = '276dca5929c91fdb1245ea799e063d9fb3bb6f642c89906804a31087e3f5866f';

const RETRY_CANDIDATES: readonly RetryPatchCandidate[] = [
  {
    relativePath: 'node_modules/@earendil-works/pi-ai/dist/utils/retry.js',
    needle: '"stream ended before message_stop",',
    shape: 'array',
  },
  {
    relativePath: TERMINAL_DURABILITY_RELATIVE_PATH,
    needle: 'stream ended before message_stop',
    shape: 'inline',
  },
];

const DURABILITY_NOTIFY_NEEDLE = `        // Notify all listeners\n        this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);\n        // Handle session persistence`;
const DURABILITY_NOTIFY_REPLACEMENT = `        // Notify non-terminal events immediately. message_end is published only\n        // after append returns below, with its stable sessionEntryId.\n        const emittedEvent = event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event;\n        if (event.type !== "message_end")\n            this._emit(emittedEvent);\n        // Handle session persistence`;
const DURABILITY_CUSTOM_NEEDLE = `                this.sessionManager.appendCustomMessageEntry(event.message.customType, event.message.content, event.message.display, event.message.details);`;
const DURABILITY_CUSTOM_REPLACEMENT = `                const sessionEntryId = this.sessionManager.appendCustomMessageEntry(event.message.customType, event.message.content, event.message.display, event.message.details);\n                this._emit({ ...emittedEvent, sessionEntryId });`;
const DURABILITY_REGULAR_NEEDLE = `                this.sessionManager.appendMessage(event.message);\n            }\n            // Other message types`;
const DURABILITY_REGULAR_REPLACEMENT = `                const sessionEntryId = this.sessionManager.appendMessage(event.message);\n                this._emit({ ...emittedEvent, sessionEntryId });\n            }\n            else {\n                this._emit(emittedEvent);\n            }\n            // Other message types`;

const DURABILITY_MARKERS = [
  DURABILITY_NOTIFY_REPLACEMENT,
  DURABILITY_CUSTOM_REPLACEMENT,
  DURABILITY_REGULAR_REPLACEMENT,
] as const;

const COLD_CREATE_IMPORT_NEEDLE = `import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync, } from "fs";`;
const COLD_CREATE_IMPORT_REPLACEMENT_V1 = `import { appendFileSync, closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync, } from "fs";`;
const COLD_CREATE_IMPORT_REPLACEMENT = `import { appendFileSync, closeSync, createReadStream, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync, } from "fs";`;
// The ownership adapter's v3 upgrade adds renameSync to the same import for
// its batch settings commit. Keep cold-create's marker tolerant of that
// compositional import so the two reversible transforms can be layered.
const COLD_CREATE_IMPORT_REPLACEMENT_WITH_RENAME = `import { appendFileSync, closeSync, createReadStream, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync, } from "fs";`;
const COLD_CREATE_HELPER_NEEDLE = `export const CURRENT_SESSION_VERSION = 3;`;
const COLD_CREATE_HELPER_REPLACEMENT_V1 = `export const CURRENT_SESSION_VERSION = 3;
// Pie cold-create durability patch v1. SessionManager remains the format
// owner; this only adds an atomic durability boundary to its create seam.
function persistCreatedSessionHeader(manager) {
    const sessionFile = manager.getSessionFile();
    const header = manager.getHeader();
    if (!sessionFile || !header || header.type !== "session" || header.version !== CURRENT_SESSION_VERSION) {
        throw new Error("SessionManager.create did not produce a v3 session header and path");
    }
    const temporaryPath = \`\${sessionFile}.pie-create-\${process.pid}-\${randomUUID()}.tmp\`;
    let fileDescriptor;
    try {
        fileDescriptor = openSync(temporaryPath, "wx", 0o600);
        writeFileSync(fileDescriptor, \`\${JSON.stringify(header)}\\n\`, "utf8");
        fsyncSync(fileDescriptor);
        closeSync(fileDescriptor);
        fileDescriptor = undefined;
        renameSync(temporaryPath, sessionFile);
        let directoryDescriptor;
        try {
            directoryDescriptor = openSync(resolve(sessionFile, ".."), "r");
            fsyncSync(directoryDescriptor);
        }
        catch (error) {
            if (process.platform !== "win32")
                throw error;
        }
        finally {
            if (directoryDescriptor !== undefined)
                closeSync(directoryDescriptor);
        }
    }
    finally {
        if (fileDescriptor !== undefined)
            closeSync(fileDescriptor);
        rmSync(temporaryPath, { force: true });
    }
}`;
const COLD_CREATE_HELPER_REPLACEMENT = `export const CURRENT_SESSION_VERSION = 3;
// Pie cold-create durability patch v2. SessionManager remains the format
// owner; this only adds an atomic durability boundary to its create seam.
function persistCreatedSessionHeader(manager) {
    const sessionFile = manager.getSessionFile();
    const header = manager.getHeader();
    if (!sessionFile || !header || header.type !== "session" || header.version !== CURRENT_SESSION_VERSION) {
        throw new Error("SessionManager.create did not produce a v3 session header and path");
    }
    const temporaryPath = \`\${sessionFile}.pie-create-\${process.pid}-\${randomUUID()}.tmp\`;
    let fileDescriptor;
    let published = false;
    try {
        fileDescriptor = openSync(temporaryPath, "wx", 0o600);
        writeFileSync(fileDescriptor, \`\${JSON.stringify(header)}\\n\`, "utf8");
        fsyncSync(fileDescriptor);
        closeSync(fileDescriptor);
        fileDescriptor = undefined;
        // Hard-link publication is same-filesystem atomic and fails with
        // EEXIST instead of replacing another session at the same path.
        linkSync(temporaryPath, sessionFile);
        published = true;
        rmSync(temporaryPath);
        let directoryDescriptor;
        try {
            directoryDescriptor = openSync(resolve(sessionFile, ".."), "r");
            fsyncSync(directoryDescriptor);
        }
        catch (error) {
            if (process.platform !== "win32")
                throw error;
        }
        finally {
            if (directoryDescriptor !== undefined)
                closeSync(directoryDescriptor);
        }
    }
    catch (error) {
        // A post-publication durability failure is not a commit. Remove the
        // destination before rethrowing so the coordinator ledger cannot lose
        // an unregistered path and a retry cannot create a second survivor.
        if (published)
            rmSync(sessionFile, { force: true });
        throw error;
    }
    finally {
        if (fileDescriptor !== undefined)
            closeSync(fileDescriptor);
        rmSync(temporaryPath, { force: true });
    }
}`;
const COLD_CREATE_SEAM_NEEDLE = `        const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
        return new SessionManager(cwd, dir, undefined, true, options);`;
const COLD_CREATE_SEAM_REPLACEMENT = `        const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
        const manager = new SessionManager(cwd, dir, undefined, true, options);
        persistCreatedSessionHeader(manager);
        manager.flushed = true;
        return manager;`;
const COLD_CREATE_MARKERS = [
  COLD_CREATE_IMPORT_REPLACEMENT,
  COLD_CREATE_HELPER_REPLACEMENT,
  COLD_CREATE_SEAM_REPLACEMENT,
] as const;

export type SdkRetryHotPatchResult =
  | 'patched'
  | 'already-present'
  | 'missing-target'
  | 'unsupported-shape';

export type SdkTerminalDurabilityPatchResult =
  | 'patched'
  | 'already-present'
  | 'missing-target'
  | 'unsupported-shape';

export type SdkColdCreateDurabilityPatchResult =
  | 'patched'
  | 'already-present'
  | 'missing-target'
  | 'unsupported-shape';

export interface SdkPatchFileIdentity {
  patchVersion: number;
  relativePath: string;
  sha256: string;
}

export interface SdkPatchIdentity {
  identityVersion: typeof SDK_PATCH_IDENTITY_VERSION;
  sdkPath: string;
  sdkVersion: string;
  terminalDurability: SdkPatchFileIdentity;
  retryClassifier: SdkPatchFileIdentity;
  coldCreateDurability: SdkPatchFileIdentity;
  sessionOwnershipAdapter: SdkPatchFileIdentity;
  sessionReplacementAdapter: SdkPatchFileIdentity;
}

export interface SdkPatchFixtureFingerprints {
  /** Must match a non-production fixture package version. */
  sdkVersion: string;
  /** Exact pristine full-file hashes for every patch target used by the fixture. */
  pristineSha256ByRelativePath: Readonly<Record<string, string>>;
}

export interface SdkPatchBarrierOptions {
  /** Override only for isolated tests. All production coordinators use the shared OS temp root. */
  lockRoot?: string;
  lockTimeoutMs?: number;
  lockPollMs?: number;
  /** Explicit test-fixture support. Rejected for the production 0.80.6 version,
   * so fixture hashes cannot weaken production acceptance. */
  fixtureFingerprints?: SdkPatchFixtureFingerprints;
}

const LOCK_DIRECTORY_REMOVE_RETRY_DELAYS_MS = [10, 25, 50, 100, 250] as const;
const LOCK_DIRECTORY_REMOVE_RETRY_CODES = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);

export interface SdkPatchBarrierRemoveOptions {
  /** Per-attempt delays; the attempt count is `retryDelaysMs.length + 1`. */
  retryDelaysMs?: readonly number[];
  /** Delay between attempts. Defaults to a real timer. */
  delay?: (milliseconds: number) => Promise<void>;
  /** Test seam for deterministic transient-remove interleavings. */
  remove?: (directoryPath: string) => Promise<void>;
}

interface SdkDescriptor {
  canonicalPath: string;
  version: string;
}

interface LockOwner {
  ownerVersion: typeof LOCK_OWNER_VERSION;
  pid: number;
  token: string;
  createdAt: string;
  sdkPath: string;
  sdkVersion: string;
}

interface PatchPlan {
  files: Map<string, string>;
  pristineFingerprints: Readonly<Record<string, string>>;
  terminalResult: SdkTerminalDurabilityPatchResult;
  retryResult: SdkRetryHotPatchResult;
  coldCreateResult: SdkColdCreateDurabilityPatchResult;
  sessionOwnershipResult: SdkSessionOwnershipTransformResult | 'missing-target';
  sessionOpenResult: SdkSessionOpenTransformResult | 'missing-target';
  sessionReplacementResult: SdkSessionOwnershipTransformResult | 'missing-target';
  retryCandidate?: RetryPatchCandidate;
}

const coordinatorEnsures = new Map<string, Promise<SdkPatchIdentity>>();

function isPathAllowed(sdkPath: string): boolean {
  const normalized = path.resolve(sdkPath);
  const allowedRoots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'],
    process.env['APPDATA'],
    process.env['HOME'],
    process.env['USERPROFILE'],
    process.env['NPM_CONFIG_PREFIX'],
    process.env['PIE_TRUSTED_SDK_ROOT'],
    '/usr/local',
    '/usr/lib',
    '/opt',
  ].filter((root): root is string => typeof root === 'string' && root.length > 0);

  return allowedRoots.some((root) => {
    const allowed = path.resolve(root);
    const candidate = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    const boundary = process.platform === 'win32' ? allowed.toLowerCase() : allowed;
    return candidate === boundary || candidate.startsWith(boundary + path.sep);
  });
}

export function assertAllowedSdkPath(sdkPath: string): void {
  if (!isPathAllowed(sdkPath)) {
    throw new Error(
      `Refusing to load SDK from disallowed path: ${sdkPath}. `
      + 'Set pie.sdkPath in VS Code settings (or the PI_SDK_PATH env var) to a directory under your user profile, system program directories, or the npm global prefix.',
    );
  }
}

function assertPlainClosedObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SDK patch identity has invalid ${label}.`);
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`SDK patch identity has non-closed ${label}.`);
  }
}

function sha256(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function replaceExactlyOnce(source: string, needle: string, replacement: string): string | undefined {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) return undefined;
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function reverseDurability(source: string): string | undefined {
  let reversed = source;
  const replacements: ReadonlyArray<readonly [string, string]> = [
    [DURABILITY_NOTIFY_NEEDLE, DURABILITY_NOTIFY_REPLACEMENT],
    [DURABILITY_CUSTOM_NEEDLE, DURABILITY_CUSTOM_REPLACEMENT],
    [DURABILITY_REGULAR_NEEDLE, DURABILITY_REGULAR_REPLACEMENT],
  ];
  for (const [needle, replacement] of [...replacements].reverse()) {
    const next = replaceExactlyOnce(reversed, replacement, needle);
    if (next === undefined) return undefined;
    reversed = next;
  }
  return reversed;
}

function reverseColdCreate(source: string): string | undefined {
  let reversed = source;
  const replacements: ReadonlyArray<readonly [string, string]> = [
    [COLD_CREATE_IMPORT_NEEDLE, COLD_CREATE_IMPORT_REPLACEMENT],
    [COLD_CREATE_HELPER_NEEDLE, COLD_CREATE_HELPER_REPLACEMENT],
    [COLD_CREATE_SEAM_NEEDLE, COLD_CREATE_SEAM_REPLACEMENT],
  ];
  for (const [needle, replacement] of [...replacements].reverse()) {
    const next = replaceExactlyOnce(reversed, replacement, needle);
    if (next === undefined) return undefined;
    reversed = next;
  }
  return reversed;
}

/** Reverse the session-manager transforms in the opposite order to planning.
 * Test fixtures may deliberately fingerprint the previously patched manager,
 * so accept the exact pre-single-read source before continuing toward the
 * production pristine source. */
function reverseSessionManagerPatchStack(
  source: string,
  pristineFingerprints: Readonly<Record<string, string>>,
): string | undefined {
  const pristine = pristineFingerprints[SDK_SESSION_MANAGER_RELATIVE_PATH];
  if (!pristine) return undefined;
  let current = source;
  if (hasSdkSessionOpenSingleReadMarkers(current)) {
    const withoutSingleRead = reverseSdkSessionOpenSingleRead(current);
    if (withoutSingleRead === undefined) return undefined;
    current = withoutSingleRead;
    if (sha256(current) === pristine) return current;
  }
  // Ownership upgrades are themselves reversible layers. For example, v3
  // reverses first to the supported v2 shape, and v2 then reverses to the
  // cold-create-only manager. Peel every supported layer while preserving the
  // exact transitional fingerprint escape hatch used by isolated fixtures.
  for (let layer = 0; layer < SDK_SESSION_OWNERSHIP_MANAGER_PATCH_VERSION; layer += 1) {
    const withoutOwnership = reverseSdkSessionManagerOwnership(current);
    if (withoutOwnership === undefined) break;
    if (withoutOwnership === current) return undefined;
    current = withoutOwnership;
    if (sha256(current) === pristine) return current;
  }
  return reverseColdCreate(current);
}

function reverseRetry(source: string, candidate: RetryPatchCandidate): string | undefined {
  const replacement = buildRetryReplacement(candidate, RETRY_INSERTS);
  return replaceExactlyOnce(source, replacement, candidate.needle);
}

function resolvePristineFingerprints(
  descriptor: SdkDescriptor,
  options: SdkPatchBarrierOptions,
): Readonly<Record<string, string>> {
  let fixture = options.fixtureFingerprints;
  if (!fixture && descriptor.version.endsWith('-test')) {
    const encoded = process.env['PIE_SDK_PATCH_FIXTURE_FINGERPRINTS'];
    if (encoded) {
      try {
        fixture = JSON.parse(encoded) as SdkPatchFixtureFingerprints;
      } catch {
        throw new Error('SDK fixture semantic fingerprints are malformed.');
      }
    }
  }
  if (descriptor.version === PINNED_PRODUCTION_SDK_VERSION) {
    if (fixture) throw new Error('Fixture SDK fingerprints cannot override pinned production SDK 0.80.6.');
    return PINNED_PRODUCTION_PRISTINE_SHA256;
  }
  if (!fixture || fixture.sdkVersion !== descriptor.version || !descriptor.version.endsWith('-test')) {
    throw new Error(`SDK ${descriptor.version} has no explicit supported semantic fingerprints.`);
  }
  for (const [relativePath, fingerprint] of Object.entries(fixture.pristineSha256ByRelativePath)) {
    if (!relativePath || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
      throw new Error('SDK fixture semantic fingerprints are malformed.');
    }
  }
  return Object.freeze({ ...fixture.pristineSha256ByRelativePath });
}

function assertSemanticFingerprint(
  relativePath: string,
  source: string,
  pristineFingerprints: Readonly<Record<string, string>>,
  reverse: (value: string) => string | undefined,
  exactTransitionalFingerprints: readonly string[] = [],
): void {
  const pristine = pristineFingerprints[relativePath];
  if (!pristine) throw new Error(`SDK semantic fingerprint is missing for ${relativePath}.`);
  const current = sha256(source);
  if (current === pristine || exactTransitionalFingerprints.includes(current)) return;
  const reversed = reverse(source);
  if (reversed !== undefined && sha256(reversed) === pristine) return;
  throw new Error(`SDK semantic fingerprint is unsupported for ${relativePath}.`);
}

async function resolveSdkDescriptor(sdkPath: string): Promise<SdkDescriptor> {
  assertAllowedSdkPath(sdkPath);
  const canonicalPath = await fs.realpath(sdkPath);
  assertAllowedSdkPath(canonicalPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(canonicalPath, 'package.json'), 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    throw new Error(`SDK patch barrier could not read package metadata at ${canonicalPath}.${detail}`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { version?: unknown }).version !== 'string'
      || (parsed as { version: string }).version.trim().length === 0) {
    throw new Error(`SDK patch barrier found an invalid or missing SDK version at ${canonicalPath}.`);
  }
  return { canonicalPath, version: (parsed as { version: string }).version };
}

function buildRetryReplacement(candidate: RetryPatchCandidate, inserts: readonly string[]): string {
  if (candidate.shape === 'array') {
    return `${candidate.needle} ${inserts.map((pattern) => `"${pattern}"`).join(', ')},`;
  }
  return `${candidate.needle}|${inserts.join('|')}`;
}

function hasDurabilityMarkers(source: string): boolean {
  return DURABILITY_MARKERS.every((marker) => source.includes(marker));
}

function hasRetryMarkers(source: string, candidate: RetryPatchCandidate): boolean {
  if (!source.includes(candidate.needle)) return false;
  return RETRY_INSERTS.every((pattern) => source.includes(
    candidate.shape === 'array' ? `"${pattern}"` : pattern,
  ));
}

function hasColdCreateMarkers(source: string): boolean {
  return source.includes(COLD_CREATE_HELPER_REPLACEMENT)
    && source.includes(COLD_CREATE_SEAM_REPLACEMENT)
    && (source.includes(COLD_CREATE_IMPORT_REPLACEMENT)
      || source.includes(COLD_CREATE_IMPORT_REPLACEMENT_WITH_RENAME));
}

function transformDurability(source: string): { result: SdkTerminalDurabilityPatchResult; source: string } {
  if (hasDurabilityMarkers(source)) return { result: 'already-present', source };
  if (DURABILITY_MARKERS.some((marker) => source.includes(marker))) {
    return { result: 'unsupported-shape', source };
  }
  if (!source.includes(DURABILITY_NOTIFY_NEEDLE)
      || !source.includes(DURABILITY_CUSTOM_NEEDLE)
      || !source.includes(DURABILITY_REGULAR_NEEDLE)) {
    return { result: 'unsupported-shape', source };
  }
  return {
    result: 'patched',
    source: source
      .replace(DURABILITY_NOTIFY_NEEDLE, DURABILITY_NOTIFY_REPLACEMENT)
      .replace(DURABILITY_CUSTOM_NEEDLE, DURABILITY_CUSTOM_REPLACEMENT)
      .replace(DURABILITY_REGULAR_NEEDLE, DURABILITY_REGULAR_REPLACEMENT),
  };
}

function transformColdCreate(
  source: string,
): { result: SdkColdCreateDurabilityPatchResult; source: string } {
  if (hasColdCreateMarkers(source)) return { result: 'already-present', source };
  const hasV1 = source.includes(COLD_CREATE_IMPORT_REPLACEMENT_V1)
    && source.includes(COLD_CREATE_HELPER_REPLACEMENT_V1)
    && source.includes(COLD_CREATE_SEAM_REPLACEMENT);
  if (hasV1) {
    return {
      result: 'patched',
      source: source
        .replace(COLD_CREATE_IMPORT_REPLACEMENT_V1, COLD_CREATE_IMPORT_REPLACEMENT)
        .replace(COLD_CREATE_HELPER_REPLACEMENT_V1, COLD_CREATE_HELPER_REPLACEMENT),
    };
  }
  if (COLD_CREATE_MARKERS.some((marker) => source.includes(marker))
      || source.includes(COLD_CREATE_IMPORT_REPLACEMENT_V1)
      || source.includes(COLD_CREATE_HELPER_REPLACEMENT_V1)) {
    return { result: 'unsupported-shape', source };
  }
  if (!source.includes(COLD_CREATE_IMPORT_NEEDLE)
      || !source.includes(COLD_CREATE_HELPER_NEEDLE)
      || !source.includes(COLD_CREATE_SEAM_NEEDLE)) {
    return { result: 'unsupported-shape', source };
  }
  return {
    result: 'patched',
    source: source
      .replace(COLD_CREATE_IMPORT_NEEDLE, COLD_CREATE_IMPORT_REPLACEMENT)
      .replace(COLD_CREATE_HELPER_NEEDLE, COLD_CREATE_HELPER_REPLACEMENT)
      .replace(COLD_CREATE_SEAM_NEEDLE, COLD_CREATE_SEAM_REPLACEMENT),
  };
}

function transformRetry(
  source: string,
  candidate: RetryPatchCandidate,
): { result: SdkRetryHotPatchResult; source: string } {
  if (hasRetryMarkers(source, candidate)) return { result: 'already-present', source };
  if (!source.includes(candidate.needle)) return { result: 'unsupported-shape', source };
  const missing = RETRY_INSERTS.filter((pattern) => !source.includes(
    candidate.shape === 'array' ? `"${pattern}"` : pattern,
  ));
  if (missing.length === 0) return { result: 'unsupported-shape', source };
  return {
    result: 'patched',
    source: source.replace(candidate.needle, buildRetryReplacement(candidate, missing)),
  };
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function createPatchPlan(
  descriptor: SdkDescriptor,
  options: SdkPatchBarrierOptions,
): Promise<PatchPlan> {
  const canonicalPath = descriptor.canonicalPath;
  const pristineFingerprints = resolvePristineFingerprints(descriptor, options);
  const files = new Map<string, string>();
  const durabilityPath = path.join(canonicalPath, TERMINAL_DURABILITY_RELATIVE_PATH);
  const durabilitySource = await readOptional(durabilityPath);
  if (durabilitySource === undefined) {
    return {
      files,
      pristineFingerprints,
      terminalResult: 'missing-target',
      retryResult: 'missing-target',
      coldCreateResult: 'missing-target',
      sessionOwnershipResult: 'missing-target',
      sessionOpenResult: 'missing-target',
      sessionReplacementResult: 'missing-target',
    };
  }
  assertSemanticFingerprint(
    TERMINAL_DURABILITY_RELATIVE_PATH,
    durabilitySource,
    pristineFingerprints,
    reverseDurability,
  );
  const durability = transformDurability(durabilitySource);
  files.set(TERMINAL_DURABILITY_RELATIVE_PATH, durability.source);

  const coldCreateSource = await readOptional(path.join(canonicalPath, COLD_CREATE_DURABILITY_RELATIVE_PATH));
  if (coldCreateSource !== undefined) {
    assertSemanticFingerprint(
      COLD_CREATE_DURABILITY_RELATIVE_PATH,
      coldCreateSource,
      pristineFingerprints,
      (source) => reverseSessionManagerPatchStack(source, pristineFingerprints),
    );
  }
  const coldCreate = coldCreateSource === undefined
    ? { result: 'missing-target' as const, source: '' }
    : transformColdCreate(coldCreateSource);
  const sessionOwnership = coldCreateSource === undefined
    ? { result: 'missing-target' as const, source: '' }
    : transformSdkSessionManagerOwnership(coldCreate.source);
  const sessionOpen = coldCreateSource === undefined
    ? { result: 'missing-target' as const, source: '' }
    : transformSdkSessionOpenSingleRead(sessionOwnership.source);
  if (coldCreateSource !== undefined) {
    files.set(COLD_CREATE_DURABILITY_RELATIVE_PATH, sessionOpen.source);
  }

  const sessionRuntimeSource = await readOptional(path.join(canonicalPath, SDK_SESSION_RUNTIME_RELATIVE_PATH));
  if (sessionRuntimeSource !== undefined) {
    assertSemanticFingerprint(
      SDK_SESSION_RUNTIME_RELATIVE_PATH,
      sessionRuntimeSource,
      pristineFingerprints,
      reverseSdkSessionRuntimeOwnership,
      descriptor.version === PINNED_PRODUCTION_SDK_VERSION ? [PINNED_RUNTIME_V7_SHA256] : [],
    );
  }
  const sessionReplacement = sessionRuntimeSource === undefined
    ? { result: 'missing-target' as const, source: '' }
    : transformSdkSessionRuntimeOwnership(sessionRuntimeSource);
  if (sessionRuntimeSource !== undefined) {
    files.set(SDK_SESSION_RUNTIME_RELATIVE_PATH, sessionReplacement.source);
  }

  // Fall back across candidates exactly like applySdkRetryHotPatch: an existing
  // preferred candidate with an unsupported shape must not block a valid legacy
  // inline candidate. Only when every existing candidate is unsupported (or none
  // exists) does the plan fail closed.
  let retryCandidate: RetryPatchCandidate | undefined;
  let retryResult: SdkRetryHotPatchResult = 'missing-target';
  for (const candidate of RETRY_CANDIDATES) {
    const candidateSource = candidate.relativePath === TERMINAL_DURABILITY_RELATIVE_PATH
      ? files.get(candidate.relativePath)
      : await readOptional(path.join(canonicalPath, candidate.relativePath));
    if (candidateSource === undefined) continue;
    assertSemanticFingerprint(
      candidate.relativePath,
      candidateSource,
      pristineFingerprints,
      (source) => {
        const withoutRetry = reverseRetry(source, candidate) ?? source;
        return candidate.relativePath === TERMINAL_DURABILITY_RELATIVE_PATH
          ? reverseDurability(withoutRetry)
          : withoutRetry === source ? undefined : withoutRetry;
      },
      descriptor.version === PINNED_PRODUCTION_SDK_VERSION ? [PINNED_RETRY_LEGACY_PATCHED_SHA256] : [],
    );
    const retry = transformRetry(candidateSource, candidate);
    if (retry.result === 'unsupported-shape') {
      retryResult = 'unsupported-shape';
      continue;
    }
    retryCandidate = candidate;
    retryResult = retry.result;
    files.set(candidate.relativePath, retry.source);
    break;
  }
  if (!retryCandidate) {
    return {
      files,
      pristineFingerprints,
      terminalResult: durability.result,
      retryResult,
      coldCreateResult: coldCreate.result,
      sessionOwnershipResult: sessionOwnership.result,
      sessionOpenResult: sessionOpen.result,
      sessionReplacementResult: sessionReplacement.result,
    };
  }
  return {
    files,
    pristineFingerprints,
    terminalResult: durability.result,
    retryResult,
    coldCreateResult: coldCreate.result,
    sessionOwnershipResult: sessionOwnership.result,
    sessionOpenResult: sessionOpen.result,
    sessionReplacementResult: sessionReplacement.result,
    retryCandidate,
  };
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directoryPath, 'r');
    await handle.sync();
  } catch (error) {
    // Windows does not consistently permit opening directories. File fsync plus
    // same-directory atomic rename is the strongest portable guarantee there.
    if (process.platform !== 'win32') throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicDurableWrite(filePath: string, source: string): Promise<void> {
  const tempPath = `${filePath}.pie-patch-${process.pid}-${randomUUID()}.tmp`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, 'wx', 0o644);
    await handle.writeFile(source, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await handle?.close();
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function commitPatchPlan(canonicalPath: string, plan: PatchPlan): Promise<void> {
  if (plan.terminalResult === 'missing-target' || plan.terminalResult === 'unsupported-shape') {
    throw new Error(`SDK terminal durability patch failed: ${plan.terminalResult}.`);
  }
  if (plan.retryResult === 'missing-target' || plan.retryResult === 'unsupported-shape' || !plan.retryCandidate) {
    throw new Error(`SDK retry-classifier patch failed: ${plan.retryResult}.`);
  }
  if (plan.coldCreateResult === 'missing-target' || plan.coldCreateResult === 'unsupported-shape') {
    throw new Error(`SDK cold-create durability patch failed: ${plan.coldCreateResult}.`);
  }
  if (plan.sessionOwnershipResult === 'missing-target' || plan.sessionOwnershipResult === 'unsupported-shape') {
    throw new Error(`SDK session ownership adapter patch failed: ${plan.sessionOwnershipResult}.`);
  }
  if (plan.sessionOpenResult === 'missing-target' || plan.sessionOpenResult === 'unsupported-shape') {
    throw new Error(`SDK session open single-read patch failed: ${plan.sessionOpenResult}.`);
  }
  if (plan.sessionReplacementResult === 'missing-target' || plan.sessionReplacementResult === 'unsupported-shape') {
    throw new Error(`SDK session replacement adapter patch failed: ${plan.sessionReplacementResult}.`);
  }
  for (const [relativePath, finalSource] of plan.files) {
    const filePath = path.join(canonicalPath, relativePath);
    const currentSource = await fs.readFile(filePath, 'utf8');
    if (currentSource !== finalSource) await atomicDurableWrite(filePath, finalSource);
  }
}

function defaultLockRoot(): string {
  return path.join(os.tmpdir(), 'pie-sdk-patch-barriers-v1');
}

export function resolveSdkPatchBarrierLockPath(
  canonicalSdkPath: string,
  sdkVersion: string,
  lockRoot = defaultLockRoot(),
): string {
  const key = createHash('sha256')
    .update(canonicalSdkPath)
    .update('\0')
    .update(sdkVersion)
    .digest('hex');
  return path.join(lockRoot, `${key}.lock`);
}

function parseLockOwner(value: unknown, descriptor: SdkDescriptor): LockOwner | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const owner = value as Partial<LockOwner>;
  if (owner.ownerVersion !== LOCK_OWNER_VERSION
      || !Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0
      || typeof owner.token !== 'string' || owner.token.length === 0
      || typeof owner.createdAt !== 'string'
      || owner.sdkPath !== descriptor.canonicalPath
      || owner.sdkVersion !== descriptor.version) return undefined;
  return owner as LockOwner;
}

async function readLockOwner(lockPath: string, descriptor: SdkDescriptor): Promise<LockOwner | undefined> {
  try {
    return parseLockOwner(
      JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')),
      descriptor,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function sameOwner(left: LockOwner, right: LockOwner | undefined): boolean {
  return !!right
    && left.ownerVersion === right.ownerVersion
    && left.pid === right.pid
    && left.token === right.token
    && left.createdAt === right.createdAt
    && left.sdkPath === right.sdkPath
    && left.sdkVersion === right.sdkVersion;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Remove a lock directory with a bounded retry budget for the transient errors
 * produced when a contender creates/removes `.takeover` during recursive rm.
 * The bounded loop is intentional: after the budget is exhausted, cleanup
 * errors still fail closed instead of being swallowed.
 */
export async function removeSdkPatchBarrierDirectory(
  directoryPath: string,
  options: SdkPatchBarrierRemoveOptions = {},
): Promise<void> {
  const retryDelaysMs = options.retryDelaysMs ?? LOCK_DIRECTORY_REMOVE_RETRY_DELAYS_MS;
  const delay = options.delay ?? sleep;
  const remove = options.remove ?? (async (targetPath: string) => {
    await fs.rm(targetPath, { recursive: true, force: true });
  });

  for (let attempt = 0; ; attempt += 1) {
    try {
      await remove(directoryPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryDelay = retryDelaysMs[attempt];
      if (!LOCK_DIRECTORY_REMOVE_RETRY_CODES.has(code ?? '') || retryDelay === undefined) {
        throw error;
      }
      await delay(retryDelay);
    }
  }
}

async function acquirePatchLock(
  descriptor: SdkDescriptor,
  options: SdkPatchBarrierOptions,
): Promise<() => Promise<void>> {
  const lockRoot = options.lockRoot ?? defaultLockRoot();
  const lockPath = resolveSdkPatchBarrierLockPath(descriptor.canonicalPath, descriptor.version, lockRoot);
  const timeoutMs = options.lockTimeoutMs ?? 30_000;
  const pollMs = options.lockPollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  const owner: LockOwner = {
    ownerVersion: LOCK_OWNER_VERSION,
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
    sdkPath: descriptor.canonicalPath,
    sdkVersion: descriptor.version,
  };
  await fs.mkdir(lockRoot, { recursive: true });
  // Fully prepare the owner record off to the side, then publish the complete
  // lock directory with one same-filesystem rename. A crash can leave only an
  // unreferenced candidate, never a canonical lock with no owner metadata.
  const candidatePath = `${lockPath}.candidate-${process.pid}-${owner.token}`;
  await fs.mkdir(candidatePath);
  let acquired = false;
  let handedOff = false;
  let releasePublishedLock: (() => Promise<void>) | undefined;
  try {
    await atomicDurableWrite(path.join(candidatePath, 'owner.json'), `${JSON.stringify(owner)}\n`);

    while (true) {
      try {
        await fs.rename(candidatePath, lockPath);
        acquired = true;
        releasePublishedLock = async () => {
          const current = await readLockOwner(lockPath, descriptor);
          if (!sameOwner(owner, current)) return;
          // Detach the validated lock atomically before recursive removal. A
          // contender can then publish a successor at lockPath without ever
          // becoming reachable by this owner's cleanup retry.
          const quarantine = `${lockPath}.release-${process.pid}-${owner.token}`;
          await renameWithTransientRetry(lockPath, quarantine);
          await removeSdkPatchBarrierDirectory(quarantine);
        };
        await syncDirectory(lockRoot);
        handedOff = true;
        return releasePublishedLock;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const destinationExists = code === 'EEXIST' || code === 'ENOTEMPTY'
          // Windows can report EPERM when rename targets an existing directory,
          // including while its `.takeover` entry is being removed. The target
          // may disappear before it can be inspected, so retry EPERM as lock
          // contention; the deadline still keeps unrelated failures fail-closed.
          || code === 'EPERM';
        if (!destinationExists) throw error;
      }

      // Claim stale-owner inspection inside the exact lock directory before
      // reading its owner. Every contender follows this protocol, so once this
      // mkdir succeeds no other contender can rename this directory, and a new
      // owner cannot appear at the canonical lock path until we rename it. This
      // avoids the read-owner/rename race that could otherwise move a newly
      // acquired live lock.
      const takeoverPath = path.join(lockPath, '.takeover');
      let ownsTakeover = false;
      try {
        await fs.mkdir(takeoverPath);
        ownsTakeover = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windows may report EPERM while another contender is publishing or
        // removing this exact takeover directory. Treat it like the adjacent
        // rename contention path; the outer deadline still fails closed for a
        // persistent permission problem.
        if (code !== 'EEXIST' && code !== 'ENOENT' && code !== 'EPERM') throw error;
      }

      let existing: LockOwner | undefined;
      if (ownsTakeover) {
        existing = await readLockOwner(lockPath, descriptor);
        if (existing && !isOwnerAlive(existing.pid)) {
          const quarantine = `${lockPath}.stale-${existing.pid}-${randomUUID()}`;
          try {
            await renameWithTransientRetry(lockPath, quarantine);
            await removeSdkPatchBarrierDirectory(quarantine);
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
        }
        await removeSdkPatchBarrierDirectory(takeoverPath);
      }

      if (Date.now() >= deadline) {
        existing ??= await readLockOwner(lockPath, descriptor);
        if (!existing || !isOwnerAlive(existing.pid)) {
          throw new Error('SDK patch barrier lock or takeover owner is missing, invalid, or dead; takeover ownership cannot be confirmed.');
        }
        throw new Error(`Timed out waiting for SDK patch barrier lock held by live process ${existing.pid}.`);
      }
      await sleep(pollMs);
    }
  } finally {
    if (!acquired) await removeSdkPatchBarrierDirectory(candidatePath);
    else if (!handedOff) await releasePublishedLock?.();
  }
}

function freezeIdentity(identity: SdkPatchIdentity): SdkPatchIdentity {
  Object.freeze(identity.terminalDurability);
  Object.freeze(identity.retryClassifier);
  Object.freeze(identity.coldCreateDurability);
  Object.freeze(identity.sessionOwnershipAdapter);
  Object.freeze(identity.sessionReplacementAdapter);
  return Object.freeze(identity);
}

async function buildIdentity(
  descriptor: SdkDescriptor,
  plan: PatchPlan,
): Promise<SdkPatchIdentity> {
  const retryCandidate = plan.retryCandidate!;
  const durabilitySource = await fs.readFile(
    path.join(descriptor.canonicalPath, TERMINAL_DURABILITY_RELATIVE_PATH),
    'utf8',
  );
  const retrySource = retryCandidate.relativePath === TERMINAL_DURABILITY_RELATIVE_PATH
    ? durabilitySource
    : await fs.readFile(path.join(descriptor.canonicalPath, retryCandidate.relativePath), 'utf8');
  const coldCreateSource = await fs.readFile(
    path.join(descriptor.canonicalPath, COLD_CREATE_DURABILITY_RELATIVE_PATH),
    'utf8',
  );
  const sessionRuntimeSource = await fs.readFile(
    path.join(descriptor.canonicalPath, SDK_SESSION_RUNTIME_RELATIVE_PATH),
    'utf8',
  );
  assertSemanticFingerprint(
    TERMINAL_DURABILITY_RELATIVE_PATH,
    durabilitySource,
    plan.pristineFingerprints,
    (source) => {
      const withoutRetry = retryCandidate.relativePath === TERMINAL_DURABILITY_RELATIVE_PATH
        ? reverseRetry(source, retryCandidate)
        : source;
      return withoutRetry === undefined ? undefined : reverseDurability(withoutRetry);
    },
  );
  if (retryCandidate.relativePath !== TERMINAL_DURABILITY_RELATIVE_PATH) {
    assertSemanticFingerprint(
      retryCandidate.relativePath,
      retrySource,
      plan.pristineFingerprints,
      (source) => reverseRetry(source, retryCandidate),
      descriptor.version === PINNED_PRODUCTION_SDK_VERSION ? [PINNED_RETRY_LEGACY_PATCHED_SHA256] : [],
    );
  }
  assertSemanticFingerprint(
    COLD_CREATE_DURABILITY_RELATIVE_PATH,
    coldCreateSource,
    plan.pristineFingerprints,
    (source) => reverseSessionManagerPatchStack(source, plan.pristineFingerprints),
  );
  assertSemanticFingerprint(
    SDK_SESSION_RUNTIME_RELATIVE_PATH,
    sessionRuntimeSource,
    plan.pristineFingerprints,
    reverseSdkSessionRuntimeOwnership,
  );
  if (!hasDurabilityMarkers(durabilitySource)
      || !hasRetryMarkers(retrySource, retryCandidate)
      || !hasColdCreateMarkers(coldCreateSource)
      || !hasSdkSessionManagerOwnershipMarkers(coldCreateSource)
      || !hasSdkSessionOpenSingleReadMarkers(coldCreateSource)
      || !hasSdkSessionRuntimeOwnershipMarkers(sessionRuntimeSource)) {
    throw new Error('SDK patch barrier verification failed after patch commit.');
  }
  return freezeIdentity({
    identityVersion: SDK_PATCH_IDENTITY_VERSION,
    sdkPath: descriptor.canonicalPath,
    sdkVersion: descriptor.version,
    terminalDurability: {
      patchVersion: TERMINAL_DURABILITY_PATCH_VERSION,
      relativePath: TERMINAL_DURABILITY_RELATIVE_PATH,
      sha256: sha256(durabilitySource),
    },
    retryClassifier: {
      patchVersion: RETRY_CLASSIFIER_PATCH_VERSION,
      relativePath: retryCandidate.relativePath,
      sha256: sha256(retrySource),
    },
    coldCreateDurability: {
      patchVersion: COLD_CREATE_DURABILITY_PATCH_VERSION,
      relativePath: COLD_CREATE_DURABILITY_RELATIVE_PATH,
      sha256: sha256(coldCreateSource),
    },
    sessionOwnershipAdapter: {
      patchVersion: SDK_SESSION_OWNERSHIP_MANAGER_PATCH_VERSION,
      relativePath: SDK_SESSION_MANAGER_RELATIVE_PATH,
      sha256: sha256(coldCreateSource),
    },
    sessionReplacementAdapter: {
      patchVersion: SDK_SESSION_REPLACEMENT_RUNTIME_PATCH_VERSION,
      relativePath: SDK_SESSION_RUNTIME_RELATIVE_PATH,
      sha256: sha256(sessionRuntimeSource),
    },
  });
}

/** Coordinator-only pre-import barrier. All shared SDK patches are planned,
 * atomically replaced per file, fsynced, and verified while one cross-process lock is held. */
export async function ensureSdkPatchBarrier(
  sdkPath: string,
  options: SdkPatchBarrierOptions = {},
): Promise<SdkPatchIdentity> {
  const descriptor = await resolveSdkDescriptor(sdkPath);
  const fixtureKey = options.fixtureFingerprints
    ? sha256(JSON.stringify(options.fixtureFingerprints))
    : '';
  const key = `${descriptor.canonicalPath}\0${descriptor.version}\0${options.lockRoot ?? ''}\0${fixtureKey}`;
  const existing = coordinatorEnsures.get(key);
  if (existing) return await existing;
  const ensuring = (async () => {
    // The versioned lock is the barrier identity. A path-only outer guard also
    // serializes an in-place package upgrade that changes package.json between
    // two coordinators' initial descriptor reads.
    const pathGuardDescriptor: SdkDescriptor = {
      canonicalPath: descriptor.canonicalPath,
      version: '__path-guard-v1__',
    };
    const releasePathGuard = await acquirePatchLock(pathGuardDescriptor, options);
    try {
      const lockedDescriptor = await resolveSdkDescriptor(descriptor.canonicalPath);
      const releaseVersion = await acquirePatchLock(lockedDescriptor, options);
      try {
        const plan = await createPatchPlan(lockedDescriptor, options);
        await commitPatchPlan(lockedDescriptor.canonicalPath, plan);
        const finalDescriptor = await resolveSdkDescriptor(lockedDescriptor.canonicalPath);
        if (finalDescriptor.canonicalPath !== lockedDescriptor.canonicalPath
            || finalDescriptor.version !== lockedDescriptor.version) {
          throw new Error('SDK package path or version changed while the patch barrier was held.');
        }
        return await buildIdentity(finalDescriptor, plan);
      } finally {
        await releaseVersion();
      }
    } finally {
      await releasePathGuard();
    }
  })();
  coordinatorEnsures.set(key, ensuring);
  try {
    return await ensuring;
  } catch (error) {
    coordinatorEnsures.delete(key);
    throw error;
  }
}

function parsePatchFileIdentity(
  value: unknown,
  label: string,
  expectedVersion: number,
): SdkPatchFileIdentity {
  assertPlainClosedObject(value, ['patchVersion', 'relativePath', 'sha256'], label);
  if (value.patchVersion !== expectedVersion
      || typeof value.relativePath !== 'string'
      || typeof value.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new Error(`SDK patch identity has invalid ${label}.`);
  }
  return value as unknown as SdkPatchFileIdentity;
}

/** Worker-only pre-import validation. This function performs reads only and
 * rejects any stale, malformed, wrong-path/version/marker, or SHA identity. */
export async function validateSdkPatchBarrier(
  sdkPath: string,
  identityValue: unknown,
  options: Pick<SdkPatchBarrierOptions, 'fixtureFingerprints'> = {},
): Promise<SdkPatchIdentity> {
  const descriptor = await resolveSdkDescriptor(sdkPath);
  const pristineFingerprints = resolvePristineFingerprints(descriptor, options);
  assertPlainClosedObject(identityValue, [
    'identityVersion',
    'sdkPath',
    'sdkVersion',
    'terminalDurability',
    'retryClassifier',
    'coldCreateDurability',
    'sessionOwnershipAdapter',
    'sessionReplacementAdapter',
  ], 'root');
  if (identityValue.identityVersion !== SDK_PATCH_IDENTITY_VERSION
      || identityValue.sdkPath !== descriptor.canonicalPath
      || identityValue.sdkVersion !== descriptor.version) {
    throw new Error('SDK patch identity version, SDK path, or SDK version does not match this worker.');
  }
  const terminalDurability = parsePatchFileIdentity(
    identityValue.terminalDurability,
    'terminal durability fingerprint',
    TERMINAL_DURABILITY_PATCH_VERSION,
  );
  const retryClassifier = parsePatchFileIdentity(
    identityValue.retryClassifier,
    'retry classifier fingerprint',
    RETRY_CLASSIFIER_PATCH_VERSION,
  );
  const coldCreateDurability = parsePatchFileIdentity(
    identityValue.coldCreateDurability,
    'cold-create durability fingerprint',
    COLD_CREATE_DURABILITY_PATCH_VERSION,
  );
  const sessionOwnershipAdapter = parsePatchFileIdentity(
    identityValue.sessionOwnershipAdapter,
    'session ownership adapter fingerprint',
    SDK_SESSION_OWNERSHIP_MANAGER_PATCH_VERSION,
  );
  const sessionReplacementAdapter = parsePatchFileIdentity(
    identityValue.sessionReplacementAdapter,
    'session replacement adapter fingerprint',
    SDK_SESSION_REPLACEMENT_RUNTIME_PATCH_VERSION,
  );
  if (terminalDurability.relativePath !== TERMINAL_DURABILITY_RELATIVE_PATH) {
    throw new Error('SDK patch identity has the wrong terminal durability path.');
  }
  if (coldCreateDurability.relativePath !== COLD_CREATE_DURABILITY_RELATIVE_PATH) {
    throw new Error('SDK patch identity has the wrong cold-create durability path.');
  }
  if (sessionOwnershipAdapter.relativePath !== SDK_SESSION_MANAGER_RELATIVE_PATH) {
    throw new Error('SDK patch identity has the wrong session ownership adapter path.');
  }
  if (sessionReplacementAdapter.relativePath !== SDK_SESSION_RUNTIME_RELATIVE_PATH) {
    throw new Error('SDK patch identity has the wrong session replacement adapter path.');
  }
  const retryCandidate = RETRY_CANDIDATES.find(
    (candidate) => candidate.relativePath === retryClassifier.relativePath,
  );
  if (!retryCandidate) throw new Error('SDK patch identity has the wrong retry classifier path.');

  const durabilitySource = await fs.readFile(
    path.join(descriptor.canonicalPath, terminalDurability.relativePath),
    'utf8',
  );
  const retrySource = retryClassifier.relativePath === terminalDurability.relativePath
    ? durabilitySource
    : await fs.readFile(path.join(descriptor.canonicalPath, retryClassifier.relativePath), 'utf8');
  const coldCreateSource = await fs.readFile(
    path.join(descriptor.canonicalPath, coldCreateDurability.relativePath),
    'utf8',
  );
  const sessionRuntimeSource = await fs.readFile(
    path.join(descriptor.canonicalPath, sessionReplacementAdapter.relativePath),
    'utf8',
  );
  assertSemanticFingerprint(
    TERMINAL_DURABILITY_RELATIVE_PATH,
    durabilitySource,
    pristineFingerprints,
    (source) => {
      const withoutRetry = retryCandidate.relativePath === TERMINAL_DURABILITY_RELATIVE_PATH
        ? reverseRetry(source, retryCandidate)
        : source;
      return withoutRetry === undefined ? undefined : reverseDurability(withoutRetry);
    },
  );
  if (retryCandidate.relativePath !== TERMINAL_DURABILITY_RELATIVE_PATH) {
    assertSemanticFingerprint(
      retryCandidate.relativePath,
      retrySource,
      pristineFingerprints,
      (source) => reverseRetry(source, retryCandidate),
      descriptor.version === PINNED_PRODUCTION_SDK_VERSION ? [PINNED_RETRY_LEGACY_PATCHED_SHA256] : [],
    );
  }
  assertSemanticFingerprint(
    COLD_CREATE_DURABILITY_RELATIVE_PATH,
    coldCreateSource,
    pristineFingerprints,
    (source) => reverseSessionManagerPatchStack(source, pristineFingerprints),
  );
  assertSemanticFingerprint(
    SDK_SESSION_RUNTIME_RELATIVE_PATH,
    sessionRuntimeSource,
    pristineFingerprints,
    reverseSdkSessionRuntimeOwnership,
  );
  if (!hasDurabilityMarkers(durabilitySource)
      || !hasRetryMarkers(retrySource, retryCandidate)
      || !hasColdCreateMarkers(coldCreateSource)
      || !hasSdkSessionManagerOwnershipMarkers(coldCreateSource)
      || !hasSdkSessionOpenSingleReadMarkers(coldCreateSource)
      || !hasSdkSessionRuntimeOwnershipMarkers(sessionRuntimeSource)) {
    throw new Error('SDK patch identity marker verification failed.');
  }
  if (sha256(durabilitySource) !== terminalDurability.sha256
      || sha256(retrySource) !== retryClassifier.sha256
      || sha256(coldCreateSource) !== coldCreateDurability.sha256
      || sha256(coldCreateSource) !== sessionOwnershipAdapter.sha256
      || sha256(sessionRuntimeSource) !== sessionReplacementAdapter.sha256) {
    throw new Error('SDK patch identity SHA-256 fingerprint verification failed.');
  }
  return freezeIdentity({
    identityVersion: SDK_PATCH_IDENTITY_VERSION,
    sdkPath: descriptor.canonicalPath,
    sdkVersion: descriptor.version,
    terminalDurability: { ...terminalDurability },
    retryClassifier: { ...retryClassifier },
    coldCreateDurability: { ...coldCreateDurability },
    sessionOwnershipAdapter: { ...sessionOwnershipAdapter },
    sessionReplacementAdapter: { ...sessionReplacementAdapter },
  });
}

/** Compatibility-level patch helpers. Runtime loading no longer calls these;
 * coordinator code must use ensureSdkPatchBarrier so both patches share a lock. */
export async function applySdkTerminalDurabilityPatch(
  sdkPath: string,
): Promise<SdkTerminalDurabilityPatchResult> {
  assertAllowedSdkPath(sdkPath);
  const filePath = path.join(sdkPath, TERMINAL_DURABILITY_RELATIVE_PATH);
  const source = await readOptional(filePath);
  if (source === undefined) return 'missing-target';
  const transformed = transformDurability(source);
  if (transformed.result === 'patched') await atomicDurableWrite(filePath, transformed.source);
  return transformed.result;
}

export async function applySdkRetryHotPatch(sdkPath: string): Promise<SdkRetryHotPatchResult> {
  assertAllowedSdkPath(sdkPath);
  let found = false;
  for (const candidate of RETRY_CANDIDATES) {
    const filePath = path.join(sdkPath, candidate.relativePath);
    const source = await readOptional(filePath);
    if (source === undefined) continue;
    found = true;
    const transformed = transformRetry(source, candidate);
    if (transformed.result === 'patched') await atomicDurableWrite(filePath, transformed.source);
    if (transformed.result !== 'unsupported-shape') return transformed.result;
  }
  return found ? 'unsupported-shape' : 'missing-target';
}
