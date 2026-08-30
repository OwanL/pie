import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { describe } from 'node:test';

import {
  SDK_PATCH_IDENTITY_VERSION,
  ensureSdkPatchBarrier,
  removeSdkPatchBarrierDirectory,
  resolveSdkPatchBarrierLockPath,
  validateSdkPatchBarrier,
  type SdkPatchFixtureFingerprints,
  type SdkPatchIdentity,
} from '../../../src/backend/sdk-patch-barrier';
import { cloneTreeByHardlink } from '../../helpers/clone-tree-by-hardlink';
import {
  SDK_SESSION_OPEN_SINGLE_READ_PATCH_VERSION,
  hasSdkSessionOpenSingleReadMarkers,
  reverseSdkSessionOpenSingleRead,
} from '../../../src/backend/sdk-session-open-patch';
import {
  SDK_SESSION_OWNERSHIP_MANAGER_PATCH_VERSION,
  reverseSdkSessionManagerOwnership,
} from '../../../src/backend/sdk-session-ownership-patch';



export const DURABILITY_SOURCE = `
        // Emit to extensions first
        await this._emitExtensionEvent(event);
        // Notify all listeners
        this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
        // Handle session persistence
        if (event.type === "message_end") {
            if (event.message.role === "custom") {
                this.sessionManager.appendCustomMessageEntry(event.message.customType, event.message.content, event.message.display, event.message.details);
            }
            else if (event.message.role === "user" || event.message.role === "assistant" || event.message.role === "toolResult") {
                this.sessionManager.appendMessage(event.message);
            }
            // Other message types
        }
`;

// A valid terminal-durability target that also carries the legacy inline retry
// needle, so the inline candidate is patchable when the preferred array-shaped
// candidate is unsupported.
export const DURABILITY_SOURCE_WITH_INLINE_RETRY = `
        // Emit to extensions first
        await this._emitExtensionEvent(event);
        // Notify all listeners
        this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
        // Handle session persistence
        if (event.type === "message_end") {
            if (event.message.role === "custom") {
                this.sessionManager.appendCustomMessageEntry(event.message.customType, event.message.content, event.message.display, event.message.details);
            }
            else if (event.message.role === "user" || event.message.role === "assistant" || event.message.role === "toolResult") {
                this.sessionManager.appendMessage(event.message);
            }
            // Other message types
        }
        // Retry classifier
        const RETRYABLE = ["stream ended before message_stop"];
`;

export const RETRY_SOURCE = `
const RETRYABLE = [
  "ended without",
  "stream ended before message_stop",
  "http2 request did not get a response",
];
`;

export const RETRY_RELATIVE_PATH = 'node_modules/@earendil-works/pi-ai/dist/utils/retry.js';
export const FIXTURE_MANAGER_SHA256 = 'c0dd3878ff943ea87fbd2010fe86fe5ddce5ef96290d4bc91ba7273e0329330a';
export const FIXTURE_RUNTIME_SHA256 = '2a070a8e400d40eb5aef0bbf708e7c90b7cba08cffa4079bcebd17f88dd18f55';
export const FIXTURE_DURABILITY_SHA256 = new Set([
  'f6d819ac0873d6c806a18126d7c26569b7b0f4bcf4cf5355470f1a331bb74b2a',
  '8b6302cfac26ca67bac8f5ab327ea2acfcbb43263cb10accea634ee7d5a6cad0',
]);
export const FIXTURE_RETRY_SHA256 = new Set([
  '50e13cb5059f6483dd56e3d607645d0111adce40b9b64cef81bd101640b014d2',
  '20fd9e689ef7b24be9ee7ba9b51f00d9b9191d397701c6575f66af1992a3f91e',
]);

export interface SdkFixture {
  root: string;
  sdkPath: string;
  lockRoot: string;
  fixtureFingerprints: SdkPatchFixtureFingerprints;
}

export const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const pinnedSdkPath = path.join(extensionRoot, 'node_modules', '@earendil-works', 'pi-coding-agent');

// Building a fixture costs ~1s of filesystem work (657-file dist copy + patch
// normalization) and every test needs its own mutable copy. Build the pristine
// normalized variant once, then hardlink-clone per test and re-copy only the
// four patch targets so test mutations never reach the template.
export let pristineTemplatePromise: Promise<string> | undefined;
export let pristineTemplateRoot: string | undefined;

export const CLONE_MUTABLE_TARGETS = [
  path.join('dist', 'core', 'agent-session.js'),
  path.join('dist', 'core', 'session-manager.js'),
  path.join('dist', 'core', 'agent-session-runtime.js'),
  path.join('node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'retry.js'),
  'package.json',
];


export async function createNormalizeSessionManager(distPath: string): Promise<void> {
  const managerPath = path.join(distPath, 'core', 'session-manager.js');
  const copiedManager = await fs.readFile(managerPath, 'utf8');
  let fixtureManager = copiedManager;
  if (hasSdkSessionOpenSingleReadMarkers(fixtureManager)) {
    const priorManager = reverseSdkSessionOpenSingleRead(fixtureManager);
    assert.ok(priorManager, 'the shared manager single-read patch must reverse exactly');
    fixtureManager = priorManager;
  }
  for (
    let layer = 0;
    createHash('sha256').update(fixtureManager).digest('hex') !== FIXTURE_MANAGER_SHA256
      && layer < SDK_SESSION_OWNERSHIP_MANAGER_PATCH_VERSION;
    layer += 1
  ) {
    const priorManager = reverseSdkSessionManagerOwnership(fixtureManager);
    assert.ok(priorManager, 'the shared manager ownership patch must reverse exactly');
    fixtureManager = priorManager;
  }
  assert.equal(
    createHash('sha256').update(fixtureManager).digest('hex'),
    FIXTURE_MANAGER_SHA256,
    'the shared manager must normalize to the exact supported fixture baseline',
  );
  if (fixtureManager !== copiedManager) await fs.writeFile(managerPath, fixtureManager, 'utf8');
}

export async function createPristineSdkTemplate(): Promise<string> {
  // Keep the copied package beneath extension/ so Node resolves its ordinary
  // hoisted dependencies from extension/node_modules and so hardlinks share
  // the extension volume.
  const root = await fs.mkdtemp(path.join(extensionRoot, '.pie-sdk-barrier-test-'));
  pristineTemplateRoot = path.join(root, 'sdk');
  await fs.cp(path.join(pinnedSdkPath, 'dist'), path.join(pristineTemplateRoot, 'dist'), { recursive: true });
  await fs.mkdir(path.join(pristineTemplateRoot, 'node_modules', '@earendil-works'), { recursive: true });
  await fs.symlink(
    path.join(pinnedSdkPath, 'node_modules', '@earendil-works', 'pi-agent-core'),
    path.join(pristineTemplateRoot, 'node_modules', '@earendil-works', 'pi-agent-core'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await fs.writeFile(
    path.join(pristineTemplateRoot, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.80.6-test', type: 'module' }),
    'utf8',
  );
  await createNormalizeSessionManager(path.join(pristineTemplateRoot, 'dist'));
  // The template package.json is hardlinked into fixtures it also must survive
  // per-test rewrites, so start every clone from a private copy of it.
  return pristineTemplateRoot;
}

export async function createSdkFixture(
  retrySource = RETRY_SOURCE,
  durabilitySource = DURABILITY_SOURCE,
): Promise<SdkFixture> {
  const template = await (pristineTemplatePromise ??= createPristineSdkTemplate());
  const root = await fs.mkdtemp(path.join(extensionRoot, '.pie-sdk-barrier-test-'));
  const sdkPath = path.join(root, 'sdk');
  const lockRoot = path.join(root, 'locks');
  await cloneTreeByHardlink(
    template,
    sdkPath,
    CLONE_MUTABLE_TARGETS,
  );
  await fs.writeFile(path.join(sdkPath, 'dist', 'core', 'agent-session.js'), durabilitySource, 'utf8');
  await fs.mkdir(path.join(sdkPath, path.dirname(RETRY_RELATIVE_PATH)), { recursive: true });
  await fs.writeFile(path.join(sdkPath, RETRY_RELATIVE_PATH), retrySource, 'utf8');

  const patchTargets = [
    'dist/core/agent-session.js',
    RETRY_RELATIVE_PATH,
    'dist/core/session-manager.js',
    'dist/core/agent-session-runtime.js',
  ] as const;
  const pristineSha256ByRelativePath = Object.fromEntries(await Promise.all(patchTargets.map(async (relativePath) => [
    relativePath,
    createHash('sha256').update(await fs.readFile(path.join(sdkPath, relativePath))).digest('hex'),
  ])));
  assert.equal(pristineSha256ByRelativePath['dist/core/session-manager.js'], FIXTURE_MANAGER_SHA256);
  assert.equal(pristineSha256ByRelativePath['dist/core/agent-session-runtime.js'], FIXTURE_RUNTIME_SHA256);
  assert.equal(FIXTURE_DURABILITY_SHA256.has(pristineSha256ByRelativePath['dist/core/agent-session.js']), true);
  assert.equal(FIXTURE_RETRY_SHA256.has(pristineSha256ByRelativePath[RETRY_RELATIVE_PATH]), true);
  return {
    root,
    sdkPath,
    lockRoot,
    fixtureFingerprints: { sdkVersion: '0.80.6-test', pristineSha256ByRelativePath },
  };
}

export async function withFixture(
  run: (fixture: SdkFixture) => Promise<void>,
  retrySource = RETRY_SOURCE,
  durabilitySource = DURABILITY_SOURCE,
): Promise<void> {
  const fixture = await createSdkFixture(retrySource, durabilitySource);
  const previousTrustedRoot = process.env.PIE_TRUSTED_SDK_ROOT;
  const previousFixtureFingerprints = process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS;
  process.env.PIE_TRUSTED_SDK_ROOT = fixture.root;
  process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS = JSON.stringify(fixture.fixtureFingerprints);
  try {
    await run(fixture);
  } finally {
    if (previousTrustedRoot === undefined) delete process.env.PIE_TRUSTED_SDK_ROOT;
    else process.env.PIE_TRUSTED_SDK_ROOT = previousTrustedRoot;
    if (previousFixtureFingerprints === undefined) delete process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS;
    else process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS = previousFixtureFingerprints;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
}

export function runBarrierChild(fixture: SdkFixture): Promise<SdkPatchIdentity> {
  const tsxCli = path.join(extensionRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const childFixture = path.join(extensionRoot, 'test', 'fixtures', 'sdk-patch-barrier-child.ts');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      tsxCli,
      childFixture,
      fixture.sdkPath,
      fixture.root,
      fixture.lockRoot,
      JSON.stringify(fixture.fixtureFingerprints),
    ], {
      cwd: extensionRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill(), 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`barrier child failed (${code ?? signal}): ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as SdkPatchIdentity);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        reject(new Error(`barrier child returned invalid JSON: ${stdout}\n${stderr}\n${detail}`));
      }
    });
  });
}

export async function exitedProcessId(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['--eval', ''], { stdio: 'ignore' });
    const pid = child.pid;
    if (!pid) {
      reject(new Error('stale-owner fixture did not receive a PID'));
      return;
    }
    child.once('error', reject);
    child.once('exit', () => resolve(pid));
  });
}

export async function withSessionReadCount<T>(
  sessionPath: string,
  run: () => Promise<T> | T,
): Promise<{ value: T; reads: number }> {
  const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const originalOpenSync = mutableFs.openSync;
  const expectedPath = path.resolve(sessionPath);
  let reads = 0;
  mutableFs.openSync = ((...args: unknown[]) => {
    const [file, flags] = args;
    if (flags === 'r' && path.resolve(String(file)) === expectedPath) reads += 1;
    return Reflect.apply(originalOpenSync, mutableFs, args);
  }) as typeof mutableFs.openSync;
  syncBuiltinESMExports();
  try {
    return { value: await run(), reads };
  } finally {
    mutableFs.openSync = originalOpenSync;
    syncBuiltinESMExports();
  }
}

export function sessionManagerSnapshot(manager: {
  getSessionFile(): string | undefined;
  getSessionDir(): string;
  getSessionId(): string;
  getCwd(): string;
  getHeader(): unknown;
  getEntries(): unknown[];
  getBranch(): unknown[];
  getTree(): unknown[];
  buildSessionContext(): unknown;
}): unknown {
  return JSON.parse(JSON.stringify({
    sessionFile: manager.getSessionFile(),
    sessionDir: manager.getSessionDir(),
    sessionId: manager.getSessionId(),
    cwd: manager.getCwd(),
    header: manager.getHeader(),
    entries: manager.getEntries(),
    branch: manager.getBranch(),
    tree: manager.getTree(),
    context: manager.buildSessionContext(),
  }));
}

export async function runPinnedProductionFingerprintFixture(run: (sdkPath: string, root: string) => Promise<void>): Promise<void> {
  // Replaces the culled 'stress concurrent cross-process barriers' test (18 tsx
  // spawns, ~5s isolated and far worse under parallel load): the two-process
  // serialization test and the lock-takeover tests already cover cross-process
  // serialization and cleanup.
  const root = await fs.mkdtemp(path.join(extensionRoot, '.pie-sdk-production-fingerprint-test-'));
  const sdkPath = path.join(root, 'sdk');
  const previousTrustedRoot = process.env.PIE_TRUSTED_SDK_ROOT;
  const previousFixtureFingerprints = process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS;
  try {
    // Only the runtime target is mutated by this fixture; everything else can
    // hardlink straight from the pinned install instead of a full copy.
    await cloneTreeByHardlink(
      path.join(pinnedSdkPath, 'dist'),
      path.join(sdkPath, 'dist'),
      ['core/agent-session-runtime.js'],
    );
    const retryPath = path.join('node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'retry.js');
    await fs.mkdir(path.join(sdkPath, path.dirname(retryPath)), { recursive: true });
    await fs.copyFile(path.join(pinnedSdkPath, retryPath), path.join(sdkPath, retryPath));
    await fs.writeFile(path.join(sdkPath, 'package.json'), JSON.stringify({ version: '0.80.6' }), 'utf8');
    await run(sdkPath, root);
  } finally {
    if (previousTrustedRoot === undefined) delete process.env.PIE_TRUSTED_SDK_ROOT;
    else process.env.PIE_TRUSTED_SDK_ROOT = previousTrustedRoot;
    if (previousFixtureFingerprints === undefined) delete process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS;
    else process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS = previousFixtureFingerprints;
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function cleanupPristineTemplate(): Promise<void> {
  if (pristineTemplateRoot) await fs.rm(path.dirname(pristineTemplateRoot), { recursive: true, force: true });
}
