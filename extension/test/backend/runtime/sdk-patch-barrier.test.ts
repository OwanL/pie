import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  SDK_PATCH_IDENTITY_VERSION,
  ensureSdkPatchBarrier,
  removeSdkPatchBarrierDirectory,
  resolveSdkPatchBarrierLockPath,
  validateSdkPatchBarrier,
  type SdkPatchFixtureFingerprints,
  type SdkPatchIdentity,
} from '../../../src/backend/sdk-patch-barrier';

const DURABILITY_SOURCE = `
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
const DURABILITY_SOURCE_WITH_INLINE_RETRY = `
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

const RETRY_SOURCE = `
const RETRYABLE = [
  "ended without",
  "stream ended before message_stop",
  "http2 request did not get a response",
];
`;

const RETRY_RELATIVE_PATH = 'node_modules/@earendil-works/pi-ai/dist/utils/retry.js';
const FIXTURE_MANAGER_SHA256 = 'c0dd3878ff943ea87fbd2010fe86fe5ddce5ef96290d4bc91ba7273e0329330a';
const FIXTURE_RUNTIME_SHA256 = '2a070a8e400d40eb5aef0bbf708e7c90b7cba08cffa4079bcebd17f88dd18f55';
const FIXTURE_DURABILITY_SHA256 = new Set([
  'b0cdc0224bf8a158e5ba9a7a8f88b2acb3690965f11f7e222a9b1e7b2c80a782',
  '46cbc5c7ab6776a4108c7609d19ac415b5dc0b40fd67dad1b5fd43635250d6a3',
]);
const FIXTURE_RETRY_SHA256 = new Set([
  '50e13cb5059f6483dd56e3d607645d0111adce40b9b64cef81bd101640b014d2',
  '20fd9e689ef7b24be9ee7ba9b51f00d9b9191d397701c6575f66af1992a3f91e',
]);

interface SdkFixture {
  root: string;
  sdkPath: string;
  lockRoot: string;
  fixtureFingerprints: SdkPatchFixtureFingerprints;
}

async function createSdkFixture(
  retrySource = RETRY_SOURCE,
  durabilitySource = DURABILITY_SOURCE,
): Promise<SdkFixture> {
  const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  // Keep the copied package beneath extension/ so Node resolves its ordinary
  // hoisted dependencies from extension/node_modules.
  const root = await fs.mkdtemp(path.join(extensionRoot, '.pie-sdk-barrier-test-'));
  const sdkPath = path.join(root, 'sdk');
  const lockRoot = path.join(root, 'locks');
  const pinnedSdkPath = path.join(extensionRoot, 'node_modules', '@earendil-works', 'pi-coding-agent');
  await fs.mkdir(sdkPath, { recursive: true });
  await fs.cp(path.join(pinnedSdkPath, 'dist'), path.join(sdkPath, 'dist'), { recursive: true });
  await fs.mkdir(path.join(sdkPath, path.dirname(RETRY_RELATIVE_PATH)), { recursive: true });
  await fs.symlink(
    path.join(pinnedSdkPath, 'node_modules', '@earendil-works', 'pi-agent-core'),
    path.join(sdkPath, 'node_modules', '@earendil-works', 'pi-agent-core'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await fs.writeFile(
    path.join(sdkPath, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.80.6-test', type: 'module' }),
    'utf8',
  );
  await fs.writeFile(path.join(sdkPath, 'dist', 'core', 'agent-session.js'), durabilitySource, 'utf8');
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

async function withFixture(
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

function runBarrierChild(fixture: SdkFixture): Promise<SdkPatchIdentity> {
  const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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

async function exitedProcessId(): Promise<number> {
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

test('coordinator barrier patches both files and returns a closed, versioned identity', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const identity = await ensureSdkPatchBarrier(sdkPath, { lockRoot });

    assert.equal(identity.identityVersion, SDK_PATCH_IDENTITY_VERSION);
    assert.equal(identity.sdkPath, await fs.realpath(sdkPath));
    assert.equal(identity.sdkVersion, '0.80.6-test');
    assert.equal(identity.terminalDurability.patchVersion, 1);
    assert.equal(identity.retryClassifier.patchVersion, 1);
    assert.equal(identity.coldCreateDurability.patchVersion, 2);
    assert.equal(identity.coldCreateDurability.relativePath, 'dist/core/session-manager.js');
    assert.equal(identity.sessionOwnershipAdapter.patchVersion, 2);
    assert.equal(identity.sessionOwnershipAdapter.relativePath, 'dist/core/session-manager.js');
    assert.equal(identity.sessionReplacementAdapter.patchVersion, 10);
    assert.equal(identity.sessionReplacementAdapter.relativePath, 'dist/core/agent-session-runtime.js');
    assert.match(identity.terminalDurability.sha256, /^[a-f0-9]{64}$/u);
    assert.match(identity.retryClassifier.sha256, /^[a-f0-9]{64}$/u);
    assert.match(identity.coldCreateDurability.sha256, /^[a-f0-9]{64}$/u);
    assert.match(identity.sessionOwnershipAdapter.sha256, /^[a-f0-9]{64}$/u);
    assert.match(identity.sessionReplacementAdapter.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(Object.isFrozen(identity), true);
    const runtimeSource = await fs.readFile(
      path.join(sdkPath, 'dist', 'core', 'agent-session-runtime.js'),
      'utf8',
    );
    assert.match(runtimeSource, /SessionManager\.create\(this\.cwd, sessionDir, options\?\.parentSession \? \{ parentSession: options\.parentSession \} : undefined\)/u);
    assert.match(runtimeSource, /SessionManager\.create\(this\.cwd, sessionDir, \{ parentSession: currentSessionFile \}\)/u);

    const validated = await validateSdkPatchBarrier(sdkPath, JSON.parse(JSON.stringify(identity)));
    assert.deepEqual(validated, identity);
  });
});

test('patched create seam returns the same manager after atomically publishing its v3 header', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const module = await import(`${pathToFileURL(path.join(sdkPath, 'dist', 'core', 'session-manager.js')).href}?probe=${Date.now()}`);
    const sessionDir = path.join(sdkPath, 'sessions');
    await fs.mkdir(sessionDir);
    const manager = module.SessionManager.create(sdkPath, sessionDir);
    const sessionPath = manager.getSessionFile();

    assert.equal(typeof sessionPath, 'string');
    const rows = (await fs.readFile(sessionPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'session');
    assert.equal(rows[0].version, 3);
    assert.deepEqual(
      JSON.parse(JSON.stringify(manager.getHeader())),
      rows[0],
      'the returned manager owns the persisted header values',
    );
    assert.deepEqual((await fs.readdir(sessionDir)).filter((name) => name.includes('.pie-create-')), []);
  });
});

test('patched durable create writes parent ownership into the one canonical initial header', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const module = await import(`${pathToFileURL(path.join(sdkPath, 'dist', 'core', 'session-manager.js')).href}?parent=${Date.now()}`);
    const sessionDir = path.join(sdkPath, 'parent-sessions');
    await fs.mkdir(sessionDir);
    const manager = module.SessionManager.create(sdkPath, sessionDir, { parentSession: 'canonical-parent.jsonl' });
    const rows = (await fs.readFile(manager.getSessionFile(), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

    assert.equal(rows.length, 1);
    assert.equal(rows[0].parentSession, 'canonical-parent.jsonl');
    assert.equal((await fs.readdir(sessionDir)).length, 1);
  });
});

test('patched create publication never replaces an existing destination', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const module = await import(`${pathToFileURL(path.join(sdkPath, 'dist', 'core', 'session-manager.js')).href}?collision=${Date.now()}`);
    const sessionDir = path.join(sdkPath, 'collision-sessions');
    await fs.mkdir(sessionDir);
    const RealDate = globalThis.Date;
    class FixedDate extends RealDate {
      constructor(value?: string | number) {
        super(value ?? '2026-01-02T03:04:05.000Z');
      }
      static override now(): number { return new RealDate('2026-01-02T03:04:05.000Z').getTime(); }
    }
    globalThis.Date = FixedDate as DateConstructor;
    let first: { getSessionFile(): string };
    try {
      first = module.SessionManager.create(sdkPath, sessionDir, { id: 'same-path' });
      assert.throws(
        () => module.SessionManager.create(sdkPath, sessionDir, { id: 'same-path' }),
        (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
      );
    } finally {
      globalThis.Date = RealDate;
    }
    const before = await fs.readFile(first!.getSessionFile(), 'utf8');
    assert.equal(await fs.readFile(first.getSessionFile(), 'utf8'), before);
    assert.deepEqual((await fs.readdir(sessionDir)).filter((name) => name.includes('.pie-create-')), []);
  });
});

test('post-publication durability failure removes the uncommitted destination before retry', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const sessionManagerPath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    const patched = await fs.readFile(sessionManagerPath, 'utf8');
    await fs.writeFile(
      sessionManagerPath,
      patched.replace(
        'if (directoryDescriptor !== undefined)\n                closeSync(directoryDescriptor);',
        'if (directoryDescriptor !== undefined)\n                throw Object.assign(new Error("injected directory close failure"), { code: "EIO" });',
      ),
      'utf8',
    );
    const module = await import(`${pathToFileURL(sessionManagerPath).href}?post-publish-failure=${Date.now()}`);
    const sessionDir = path.join(sdkPath, 'failed-sessions');
    await fs.mkdir(sessionDir);

    assert.throws(
      () => module.SessionManager.create(sdkPath, sessionDir, { id: 'failed-path' }),
      /injected directory close failure/,
    );
    assert.deepEqual(await fs.readdir(sessionDir), []);
  });
});

test('two real processes serialize patching and return the same final fingerprints', async () => {
  await withFixture(async (fixture) => {
    const [first, second] = await Promise.all([
      runBarrierChild(fixture),
      runBarrierChild(fixture),
    ]);

    assert.deepEqual(first, second);
    await validateSdkPatchBarrier(fixture.sdkPath, first);
    const lockEntries = await fs.readdir(fixture.lockRoot);
    assert.deepEqual(lockEntries, []);
  });
});

test('lock directory cleanup retries a deterministic transient takeover interleaving', async () => {
  let attempts = 0;
  const delays: number[] = [];

  await removeSdkPatchBarrierDirectory('unused-test-path', {
    retryDelaysMs: [1, 2, 3],
    delay: async (milliseconds) => { delays.push(milliseconds); },
    remove: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('directory changed during removal'), { code: 'ENOTEMPTY' });
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1, 2]);

  attempts = 0;
  await assert.rejects(
    removeSdkPatchBarrierDirectory('unused-test-path', {
      retryDelaysMs: [1, 2],
      delay: async () => undefined,
      remove: async () => {
        attempts += 1;
        throw Object.assign(new Error('directory remains busy'), { code: 'EBUSY' });
      },
    }),
    { code: 'EBUSY' },
  );
  assert.equal(attempts, 3, 'cleanup must remain bounded and fail closed');
});

test('stress concurrent cross-process barriers across repeated acquire and release cycles', async () => {
  await withFixture(async (fixture) => {
    let expected: SdkPatchIdentity | undefined;
    for (let round = 0; round < 3; round += 1) {
      const identities = await Promise.all(
        Array.from({ length: 6 }, () => runBarrierChild(fixture)),
      );
      expected ??= identities[0];
      for (const identity of identities) assert.deepEqual(identity, expected);
      await validateSdkPatchBarrier(fixture.sdkPath, expected);
      assert.deepEqual(await fs.readdir(fixture.lockRoot), []);
    }
  });
});

test('coordinator fails closed when every retry candidate has an unsupported shape', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const durabilityPath = path.join(sdkPath, 'dist', 'core', 'agent-session.js');
    const retryPath = path.join(sdkPath, RETRY_RELATIVE_PATH);
    const beforeDurability = await fs.readFile(durabilityPath, 'utf8');
    const beforeRetry = await fs.readFile(retryPath, 'utf8');

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot }),
      /SDK retry-classifier patch failed: unsupported-shape/,
    );
    assert.equal(await fs.readFile(durabilityPath, 'utf8'), beforeDurability);
    assert.equal(await fs.readFile(retryPath, 'utf8'), beforeRetry);
  }, 'const RETRYABLE = ["different fingerprint"];');
});

test('coordinator falls back to a valid legacy inline candidate when the preferred retry candidate has an unsupported shape', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const retryPath = path.join(sdkPath, RETRY_RELATIVE_PATH);
    const beforeRetry = await fs.readFile(retryPath, 'utf8');

    const identity = await ensureSdkPatchBarrier(sdkPath, { lockRoot });

    assert.equal(identity.retryClassifier.relativePath, 'dist/core/agent-session.js');
    assert.equal(
      await fs.readFile(retryPath, 'utf8'),
      beforeRetry,
      'the unsupported preferred candidate must not be written',
    );
    const patched = await fs.readFile(path.join(sdkPath, 'dist', 'core', 'agent-session.js'), 'utf8');
    assert.match(patched, /stream ended before message_stop\|stream ended before a terminal response event/);
    await validateSdkPatchBarrier(sdkPath, JSON.parse(JSON.stringify(identity)));
  }, 'const RETRYABLE = ["different fingerprint"];', DURABILITY_SOURCE_WITH_INLINE_RETRY);
});

test('coordinator fails closed without touching other targets when the pinned create seam changes', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const sessionManagerPath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    const agentSessionPath = path.join(sdkPath, 'dist', 'core', 'agent-session.js');
    const retryPath = path.join(sdkPath, RETRY_RELATIVE_PATH);
    const changed = (await fs.readFile(sessionManagerPath, 'utf8')).replace(
      'const manager = new SessionManager(cwd, dir, undefined, true, options);',
      'const manager = makeSessionManager(cwd, dir, options);',
    );
    await fs.writeFile(sessionManagerPath, changed, 'utf8');
    const beforeAgent = await fs.readFile(agentSessionPath, 'utf8');
    const beforeRetry = await fs.readFile(retryPath, 'utf8');

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot }),
      /SDK semantic fingerprint is unsupported for dist\/core\/session-manager\.js/, 
    );
    assert.equal(await fs.readFile(sessionManagerPath, 'utf8'), changed);
    assert.equal(await fs.readFile(agentSessionPath, 'utf8'), beforeAgent);
    assert.equal(await fs.readFile(retryPath, 'utf8'), beforeRetry);
  });
});

test('coordinator rejects an already-patched manager missing any required write-lease seam', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const sessionManagerPath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    const changed = (await fs.readFile(sessionManagerPath, 'utf8')).replace(
      '        this._assertPieWriteLease("_persist");\n',
      '',
    );
    await fs.writeFile(sessionManagerPath, changed, 'utf8');

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot }),
      /SDK semantic fingerprint is unsupported for dist\/core\/session-manager\.js/, 
    );
    assert.equal(await fs.readFile(sessionManagerPath, 'utf8'), changed);
  });
});

test('coordinator rejects an already-patched runtime with weakened same-directory import ownership', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const runtimePath = path.join(sdkPath, 'dist', 'core', 'agent-session-runtime.js');
    const changed = (await fs.readFile(runtimePath, 'utf8')).replace(
      'prepare: async (canonicalPath) => importAlreadyAtDestination',
      'prepare: async (canonicalPath) => selfReopen',
    );
    await fs.writeFile(runtimePath, changed, 'utf8');

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot }),
      /SDK semantic fingerprint is unsupported for dist\/core\/agent-session-runtime\.js/,
    );
    assert.equal(await fs.readFile(runtimePath, 'utf8'), changed);
  });
});

test('pinned production 0.80.6 rejects marker-preserving reordered code by exact reversible fingerprint', async () => {
  const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const root = await fs.mkdtemp(path.join(extensionRoot, '.pie-sdk-production-fingerprint-test-'));
  const sdkPath = path.join(root, 'sdk');
  const pinnedSdkPath = path.join(extensionRoot, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const previousTrustedRoot = process.env.PIE_TRUSTED_SDK_ROOT;
  const previousFixtureFingerprints = process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS;
  try {
    await fs.cp(path.join(pinnedSdkPath, 'dist'), path.join(sdkPath, 'dist'), { recursive: true });
    const retryPath = path.join('node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'retry.js');
    await fs.mkdir(path.join(sdkPath, path.dirname(retryPath)), { recursive: true });
    await fs.copyFile(path.join(pinnedSdkPath, retryPath), path.join(sdkPath, retryPath));
    await fs.writeFile(path.join(sdkPath, 'package.json'), JSON.stringify({ version: '0.80.6' }), 'utf8');
    const runtimePath = path.join(sdkPath, 'dist', 'core', 'agent-session-runtime.js');
    const changed = (await fs.readFile(runtimePath, 'utf8')).replace(
      '        this.session.abortCompaction?.();\n        this.session.abortBranchSummary?.();',
      '        this.session.abortBranchSummary?.();\n        this.session.abortCompaction?.();',
    );
    assert.match(changed, /this\.session\.abortCompaction\?\.\(\)/u);
    assert.match(changed, /this\.session\.abortBranchSummary\?\.\(\)/u);
    await fs.writeFile(runtimePath, changed, 'utf8');
    process.env.PIE_TRUSTED_SDK_ROOT = root;
    delete process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS;

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot: path.join(root, 'locks') }),
      /SDK semantic fingerprint is unsupported for dist\/core\/agent-session-runtime\.js/,
    );
    assert.equal(await fs.readFile(runtimePath, 'utf8'), changed);
  } finally {
    if (previousTrustedRoot === undefined) delete process.env.PIE_TRUSTED_SDK_ROOT;
    else process.env.PIE_TRUSTED_SDK_ROOT = previousTrustedRoot;
    if (previousFixtureFingerprints === undefined) delete process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS;
    else process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS = previousFixtureFingerprints;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('coordinator rejects marker-preserving weakened ownership code by exact semantic fingerprint', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const managerPath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    const changed = (await fs.readFile(managerPath, 'utf8')).replace(
      '        this._assertPieWriteLease("_persist");',
      '        if (false) this._assertPieWriteLease("_persist");',
    );
    assert.match(changed, /this\._assertPieWriteLease\("_persist"\)/u, 'legacy marker remains present');
    await fs.writeFile(managerPath, changed, 'utf8');

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot }),
      /SDK semantic fingerprint is unsupported for dist\/core\/session-manager\.js/,
    );
    assert.equal(await fs.readFile(managerPath, 'utf8'), changed);
  });
});

test('coordinator rejects an already-patched runtime missing any quiescence abort seam', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const runtimePath = path.join(sdkPath, 'dist', 'core', 'agent-session-runtime.js');
    const changed = (await fs.readFile(runtimePath, 'utf8')).replace(
      '        this.session.abortBash?.();\n',
      '',
    );
    await fs.writeFile(runtimePath, changed, 'utf8');

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot }),
      /SDK semantic fingerprint is unsupported for dist\/core\/agent-session-runtime\.js/,
    );
    assert.equal(await fs.readFile(runtimePath, 'utf8'), changed);
  });
});

test('worker validation rejects a wrong file fingerprint and never repairs it', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const identity = await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const retryPath = path.join(sdkPath, RETRY_RELATIVE_PATH);
    const changed = `${await fs.readFile(retryPath, 'utf8')}\n// changed after coordinator handoff\n`;
    await fs.writeFile(retryPath, changed, 'utf8');

    await assert.rejects(
      validateSdkPatchBarrier(sdkPath, identity),
      /SDK semantic fingerprint is unsupported/,
    );
    assert.equal(await fs.readFile(retryPath, 'utf8'), changed, 'worker validation must never write');
  });
});

test('worker rejects a changed cold-create file fingerprint without repairing it', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const identity = await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const sessionManagerPath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    const changed = `${await fs.readFile(sessionManagerPath, 'utf8')}\n// changed after handoff\n`;
    await fs.writeFile(sessionManagerPath, changed, 'utf8');

    await assert.rejects(validateSdkPatchBarrier(sdkPath, identity), /SDK semantic fingerprint is unsupported/);
    assert.equal(await fs.readFile(sessionManagerPath, 'utf8'), changed);
  });
});

test('worker validation rejects wrong identity version, SDK path/version, and extra fields', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const identity = await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    for (const changed of [
      { ...identity, identityVersion: 1 },
      { ...identity, sdkPath: `${identity.sdkPath}-other` },
      { ...identity, sdkVersion: '0.80.7' },
      { ...identity, unexpected: true },
    ]) {
      await assert.rejects(validateSdkPatchBarrier(sdkPath, changed), /SDK patch identity/);
    }
  });
});

test('coordinator confirms stale owner death before taking over its cross-process lock', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const canonicalPath = await fs.realpath(sdkPath);
    const lockPath = resolveSdkPatchBarrierLockPath(canonicalPath, '0.80.6-test', lockRoot);
    const stalePid = await exitedProcessId();
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
      ownerVersion: 1,
      pid: stalePid,
      token: 'dead-owner-token',
      createdAt: new Date(0).toISOString(),
      sdkPath: canonicalPath,
      sdkVersion: '0.80.6-test',
    }), 'utf8');

    const identity = await ensureSdkPatchBarrier(sdkPath, {
      lockRoot,
      lockTimeoutMs: 2_000,
      lockPollMs: 5,
    });
    assert.equal(identity.sdkVersion, '0.80.6-test');
    await assert.rejects(fs.access(lockPath));
  });
});

test('coordinator does not take over a lock whose owner death cannot be confirmed', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const canonicalPath = await fs.realpath(sdkPath);
    const lockPath = resolveSdkPatchBarrierLockPath(canonicalPath, '0.80.6-test', lockRoot);
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(path.join(lockPath, 'owner.json'), '{not-json', 'utf8');

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot, lockTimeoutMs: 20, lockPollMs: 2 }),
      /ownership cannot be confirmed/,
    );
    await fs.access(lockPath);
  });
});
