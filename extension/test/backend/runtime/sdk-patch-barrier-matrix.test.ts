import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  RETRY_RELATIVE_PATH,
  withFixture,
  runPinnedProductionFingerprintFixture,
  cleanupPristineTemplate,
} from './sdk-patch-barrier-shared';

import {
  ensureSdkPatchBarrier,
  validateSdkPatchBarrier,
} from '../../../src/backend/sdk-patch-barrier';
import {
  hasSdkSessionOpenSingleReadMarkers,
} from '../../../src/backend/sdk-session-open-patch';
import {
  reverseSdkSessionManagerOwnership,
} from '../../../src/backend/sdk-session-ownership-patch';
test.after(async () => { await cleanupPristineTemplate(); });

test('coordinator upgrades the exact supported v3 manager image to v4 and validates it', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const managerPath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const v4Source = await fs.readFile(managerPath, 'utf8');
    const v3Source = reverseSdkSessionManagerOwnership(v4Source);
    assert.ok(v3Source, 'the current manager transform must reverse exactly to v3');
    await fs.writeFile(managerPath, v3Source, 'utf8');

    const identity = await ensureSdkPatchBarrier(sdkPath, { lockRoot: path.join(lockRoot, 'upgrade') });
    assert.equal(identity.sessionOwnershipAdapter.patchVersion, 4);
    assert.equal(await fs.readFile(managerPath, 'utf8'), v4Source);
    await validateSdkPatchBarrier(sdkPath, identity);
  });
});

test('coordinator rejects an SDK package version outside the explicit compatibility contract', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const managerPath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    const beforeManager = await fs.readFile(managerPath, 'utf8');
    await fs.writeFile(path.join(sdkPath, 'package.json'), JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version: '0.80.7',
      type: 'module',
    }), 'utf8');

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot }),
      /SDK 0\.80\.7 has no explicit supported semantic fingerprints/,
    );
    assert.equal(await fs.readFile(managerPath, 'utf8'), beforeManager);
  });
});

test('coordinator fails closed without touching other targets when the pinned create seam changes', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const sessionManagerPath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    const agentSessionPath = path.join(sdkPath, 'dist', 'core', 'agent-session.js');
    const retryPath = path.join(sdkPath, RETRY_RELATIVE_PATH);
    const original = await fs.readFile(sessionManagerPath, 'utf8');
    const changed = original.replace(
      'return new SessionManager(cwd, dir, undefined, true, options);',
      'return makeSessionManager(cwd, dir, options);',
    );
    assert.notEqual(changed, original);
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
    await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const original = await fs.readFile(sessionManagerPath, 'utf8');
    const changed = original.replace('        return this._runPieWriteMutation("_persist", () => {',
      '        return this._runPieWriteMutation("other", () => {');
    assert.notEqual(changed, original);
    await fs.writeFile(sessionManagerPath, changed, 'utf8');

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot: path.join(lockRoot, 'recheck') }),
      /SDK semantic fingerprint is unsupported for dist\/core\/session-manager\.js/,
    );
    assert.equal(await fs.readFile(sessionManagerPath, 'utf8'), changed);
  });
});

test('coordinator rejects an already-patched runtime with weakened same-directory import ownership', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const runtimePath = path.join(sdkPath, 'dist', 'core', 'agent-session-runtime.js');
    await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const original = await fs.readFile(runtimePath, 'utf8');
    const changed = original.replace(
      'prepare: async (canonicalPath) => importAlreadyAtDestination',
      'prepare: async (canonicalPath) => selfReopen',
    );
    assert.notEqual(changed, original);
    await fs.writeFile(runtimePath, changed, 'utf8');

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot: path.join(lockRoot, 'recheck') }),
      /SDK semantic fingerprint is unsupported for dist\/core\/agent-session-runtime\.js/,
    );
    assert.equal(await fs.readFile(runtimePath, 'utf8'), changed);
  });
});

test('fresh pinned production 0.80.6 clone patches, validates, and remains idempotent', async () => {
  await runPinnedProductionFingerprintFixture(async (sdkPath, root) => {
    process.env.PIE_TRUSTED_SDK_ROOT = root;
    delete process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS;
    const lockRoot = path.join(root, 'locks');
    const managerPath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    assert.equal(
      createHash('sha256').update(await fs.readFile(managerPath)).digest('hex'),
      '879e80cc6e2371e4b06887e6fb041c323ba4e86f7687bfdac6474c9f61486112',
      'production clone must start at the pinned pristine manager image',
    );
    const identity = await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const patched = await fs.readFile(managerPath, 'utf8');
    assert.equal(createHash('sha256').update(patched).digest('hex'),
      '39af403e353734e42ec4852550d2fa0d90869d36d7ee60f856e637f324856c6f',
      'fresh patch must match the retained canonical installed manager exactly');
    assert.match(patched, /this\._runPieWriteMutation\("activatePiePrepared\.create", \(\) => persistCreatedSessionHeader\(this\)\)/u);
    await validateSdkPatchBarrier(sdkPath, identity);
    const repeated = await ensureSdkPatchBarrier(sdkPath, { lockRoot: path.join(root, 'idempotence-locks') });
    assert.deepEqual(repeated, identity);
    assert.equal(await fs.readFile(managerPath, 'utf8'), patched);
  });
});

test('pinned production 0.80.6 rejects marker-preserving reordered code by exact reversible fingerprint', async () => {
  await runPinnedProductionFingerprintFixture(async (sdkPath, root) => {
    process.env.PIE_TRUSTED_SDK_ROOT = root;
    delete process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS;
    await ensureSdkPatchBarrier(sdkPath, { lockRoot: path.join(root, 'locks') });
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
      ensureSdkPatchBarrier(sdkPath, { lockRoot: path.join(root, 'recheck') }),
      /SDK semantic fingerprint is unsupported for dist\/core\/agent-session-runtime\.js/,
    );
    assert.equal(await fs.readFile(runtimePath, 'utf8'), changed);
  });
});

test('coordinator rejects marker-preserving weakened ownership code by exact semantic fingerprint', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const managerPath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const original = await fs.readFile(managerPath, 'utf8');
    const changed = original.replace(
      '        return this._runPieWriteMutation("_persist", () => {',
      '        if (false) this._runPieWriteMutation("_persist", () => {});\n        return this._runPieWriteMutation("other", () => {',
    );
    assert.notEqual(changed, original);
    assert.match(changed, /this\._runPieWriteMutation\("_persist"/u, 'marker remains present');
    await fs.writeFile(managerPath, changed, 'utf8');

    await assert.rejects(
      ensureSdkPatchBarrier(sdkPath, { lockRoot: path.join(lockRoot, 'recheck') }),
      /SDK semantic fingerprint is unsupported for dist\/core\/session-manager\.js/,
    );
    assert.equal(await fs.readFile(managerPath, 'utf8'), changed);
  });
});

test('worker rejects marker-preserving weakened single-read code by exact semantic fingerprint', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const identity = await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const managerPath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    const optimizedReturn =
      '        return new SessionManager(cwd, dir, resolvedPath, true, undefined, entries);';
    const changed = (await fs.readFile(managerPath, 'utf8')).replace(
      optimizedReturn,
      `        if (false) {\n${optimizedReturn}\n        }\n        return new SessionManager(cwd, dir, resolvedPath, true);`,
    );
    assert.equal(
      hasSdkSessionOpenSingleReadMarkers(changed),
      true,
      'all shallow single-read markers remain present',
    );
    await fs.writeFile(managerPath, changed, 'utf8');

    await assert.rejects(
      validateSdkPatchBarrier(sdkPath, identity),
      /SDK semantic fingerprint is unsupported for dist\/core\/session-manager\.js/,
    );
    assert.equal(await fs.readFile(managerPath, 'utf8'), changed, 'worker validation must never repair');
  });
});
