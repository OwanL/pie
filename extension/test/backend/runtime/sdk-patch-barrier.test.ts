import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { createRequire } from 'node:module';
import {
  withFixture,
  withSessionReadCount,
  sessionManagerSnapshot,
  cleanupPristineTemplate,
} from './sdk-patch-barrier-shared';

import {
  SDK_PATCH_IDENTITY_VERSION,
  ensureSdkPatchBarrier,
  validateSdkPatchBarrier,
} from '../../../src/backend/sdk-patch-barrier';
import {
  SDK_SESSION_OPEN_SINGLE_READ_PATCH_VERSION,
  hasSdkSessionOpenSingleReadMarkers,
} from '../../../src/backend/sdk-session-open-patch';
test.after(async () => { await cleanupPristineTemplate(); });

test('coordinator barrier patches both files and returns a closed, versioned identity', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const identity = await ensureSdkPatchBarrier(sdkPath, { lockRoot });

    assert.equal(identity.identityVersion, SDK_PATCH_IDENTITY_VERSION);
    assert.equal(identity.sdkPath, await fs.realpath(sdkPath));
    assert.equal(identity.sdkVersion, '0.80.6-test');
    assert.equal(identity.terminalDurability.patchVersion, 3);
    assert.equal(identity.retryClassifier.patchVersion, 1);
    assert.equal(identity.coldCreateDurability.patchVersion, 2);
    assert.equal(identity.coldCreateDurability.relativePath, 'dist/core/session-manager.js');
    assert.equal(identity.sessionOwnershipAdapter.patchVersion, 3);
    assert.equal(identity.sessionOwnershipAdapter.relativePath, 'dist/core/session-manager.js');
    assert.equal(identity.sessionReplacementAdapter.patchVersion, 10);
    assert.equal(identity.sessionReplacementAdapter.relativePath, 'dist/core/agent-session-runtime.js');
    assert.match(identity.terminalDurability.sha256, /^[a-f0-9]{64}$/u);
    assert.match(identity.retryClassifier.sha256, /^[a-f0-9]{64}$/u);

    const patchedAgentSession = await fs.readFile(
      path.join(sdkPath, 'dist', 'core', 'agent-session.js'),
      'utf8',
    );
    assert.match(patchedAgentSession, /Pie malformed-terminal guard v2/u);
    assert.match(patchedAgentSession, /hasReasoning && !hasVisibleResult/u);
    assert.match(patchedAgentSession, /Stream ended before a terminal response event/u);

    const guardStart = patchedAgentSession.indexOf('        if (event.type === "message_end"');
    const guardEnd = patchedAgentSession.indexOf('        // Emit to extensions first', guardStart);
    assert.ok(guardStart >= 0 && guardEnd > guardStart, 'generated malformed-terminal guard is extractable');
    const executeGuard = new Function('event', patchedAgentSession.slice(guardStart, guardEnd));
    const classify = (message: Record<string, unknown>): Record<string, unknown> => {
      const event = { type: 'message_end', message: structuredClone(message) };
      executeGuard.call({
        _replaceMessageInPlace(target: Record<string, unknown>, replacement: Record<string, unknown>) {
          for (const key of Object.keys(target)) delete target[key];
          Object.assign(target, replacement);
        },
      }, event);
      return event.message;
    };
    const zeroUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const malformed = classify({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'thinking', thinking: 'I will render `' }],
      usage: zeroUsage,
    });
    assert.equal(malformed.stopReason, 'error');
    assert.match(String(malformed.errorMessage), /Stream ended before a terminal response event/u);
    assert.equal(classify({
      role: 'assistant',
      stopReason: 'stop',
      content: [
        { type: 'thinking', thinking: 'Reasoning' },
        { type: 'text', text: 'Visible answer' },
      ],
      usage: zeroUsage,
    }).stopReason, 'stop', 'a visible final answer remains a valid success');
    const meteredReasoningOnly = classify({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'thinking', thinking: 'Reasoning-only but metered' }],
      usage: { ...zeroUsage, totalTokens: 10 },
    });
    assert.equal(meteredReasoningOnly.stopReason, 'error', 'usage cannot make a blank reasoning-only turn successful');
    assert.match(identity.coldCreateDurability.sha256, /^[a-f0-9]{64}$/u);
    assert.match(identity.sessionOwnershipAdapter.sha256, /^[a-f0-9]{64}$/u);
    assert.match(identity.sessionReplacementAdapter.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(Object.isFrozen(identity), true);
    assert.equal(SDK_SESSION_OPEN_SINGLE_READ_PATCH_VERSION, 1);
    const managerSource = await fs.readFile(
      path.join(sdkPath, 'dist', 'core', 'session-manager.js'),
      'utf8',
    );
    assert.equal(hasSdkSessionOpenSingleReadMarkers(managerSource), true);
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

test('patched SessionManager.open reuses its first parse with identical v3 tree and context semantics', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    const managerModulePath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    const beforeSource = await fs.readFile(managerModulePath, 'utf8');
    assert.equal(
      hasSdkSessionOpenSingleReadMarkers(beforeSource),
      false,
      'the fixture is the supported pre-single-read transitional manager',
    );

    const storedCwd = path.join(sdkPath, 'stored-cwd');
    const explicitSessionDir = path.join(sdkPath, 'future-sessions');
    const sessionPath = path.join(sdkPath, 'single-read-v3.jsonl');
    await fs.mkdir(storedCwd);
    await fs.mkdir(explicitSessionDir);
    await fs.writeFile(sessionPath, [
      JSON.stringify({
        type: 'session', version: 3, id: 'single-read-session',
        timestamp: '2026-08-25T00:00:00.000Z', cwd: storedCwd,
      }),
      JSON.stringify({
        type: 'message', id: 'user-1', parentId: null,
        timestamp: '2026-08-25T00:00:01.000Z',
        message: { role: 'user', content: 'hello', timestamp: 1 },
      }),
      JSON.stringify({
        type: 'message', id: 'assistant-1', parentId: 'user-1',
        timestamp: '2026-08-25T00:00:02.000Z',
        message: {
          role: 'assistant', content: [{ type: 'text', text: 'hi' }],
          api: 'test', provider: 'test', model: 'model-a',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
          stopReason: 'stop', timestamp: 2,
        },
      }),
    ].join('\n') + '\n', 'utf8');

    const baselineModule = await import(
      `${pathToFileURL(managerModulePath).href}?single-read-baseline=${Date.now()}`
    );
    const baseline = await withSessionReadCount(sessionPath, () => (
      baselineModule.SessionManager.open(sessionPath, explicitSessionDir)
    ));
    assert.equal(baseline.reads, 2, 'pinned 0.80.6 reads the same JSONL in open() and setSessionFile()');

    await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const patchedModule = await import(
      `${pathToFileURL(managerModulePath).href}?single-read-patched=${Date.now()}`
    );
    const patched = await withSessionReadCount(sessionPath, () => (
      patchedModule.SessionManager.open(sessionPath, explicitSessionDir)
    ));

    assert.equal(patched.reads, 1);
    assert.deepEqual(sessionManagerSnapshot(patched.value), sessionManagerSnapshot(baseline.value));
    assert.equal(patched.value.getCwd(), path.resolve(storedCwd));
    assert.equal(patched.value.getSessionDir(), path.resolve(explicitSessionDir));
  });
});

test('single-read open preserves migration, invalid-file, empty-file, and cwd-override behavior', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const managerModulePath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    const module = await import(`${pathToFileURL(managerModulePath).href}?single-read-semantics=${Date.now()}`);

    const v2Path = path.join(sdkPath, 'migrate-v2.jsonl');
    await fs.writeFile(v2Path, [
      JSON.stringify({
        type: 'session', version: 2, id: 'migrate-v2',
        timestamp: '2026-08-25T00:00:00.000Z', cwd: sdkPath,
      }),
      JSON.stringify({
        type: 'message', id: 'hook-1', parentId: null,
        timestamp: '2026-08-25T00:00:01.000Z',
        message: { role: 'hookMessage', content: 'legacy', timestamp: 1 },
      }),
    ].join('\n') + '\n', 'utf8');
    const migrated = await withSessionReadCount(v2Path, () => module.SessionManager.open(v2Path));
    assert.equal(migrated.reads, 1);
    assert.equal(migrated.value.getHeader().version, 3);
    assert.equal(migrated.value.getEntries()[0].message.role, 'custom');
    const migratedRows = (await fs.readFile(v2Path, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(migratedRows[0].version, 3);
    assert.equal(migratedRows[1].message.role, 'custom');

    const invalidPath = path.join(sdkPath, 'invalid.jsonl');
    await fs.writeFile(invalidPath, 'not-json-but-not-empty\n', 'utf8');
    const invalid = await withSessionReadCount(invalidPath, () => {
      assert.throws(
        () => module.SessionManager.open(invalidPath),
        /Session file is not a valid pi session/,
      );
    });
    assert.equal(invalid.reads, 1);
    assert.equal(await fs.readFile(invalidPath, 'utf8'), 'not-json-but-not-empty\n');

    const emptyPath = path.join(sdkPath, 'empty.jsonl');
    const overrideCwd = path.join(sdkPath, 'override-cwd');
    await fs.mkdir(overrideCwd);
    await fs.writeFile(emptyPath, '', 'utf8');
    const empty = await withSessionReadCount(emptyPath, () => (
      module.SessionManager.open(emptyPath, undefined, overrideCwd)
    ));
    assert.equal(empty.reads, 1);
    assert.equal(empty.value.getSessionFile(), path.resolve(emptyPath));
    assert.equal(empty.value.getCwd(), path.resolve(overrideCwd));
    assert.equal(empty.value.getHeader().version, 3);
    assert.equal((await fs.readFile(emptyPath, 'utf8')).trim().length > 0, true);
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

test('patched manager atomically publishes model and thinking changes and commits state after rename', async () => {
  await withFixture(async ({ sdkPath, lockRoot }) => {
    await ensureSdkPatchBarrier(sdkPath, { lockRoot });
    const sessionManagerPath = path.join(sdkPath, 'dist', 'core', 'session-manager.js');
    const module = await import(`${pathToFileURL(sessionManagerPath).href}?model-settings=${Date.now()}`);
    const sessionDir = path.join(sdkPath, 'model-settings-sessions');
    await fs.mkdir(sessionDir);
    const manager = module.SessionManager.create(sdkPath, sessionDir);
    const sessionPath = manager.getSessionFile();
    assert.equal(typeof sessionPath, 'string');
    // Exercise the separator decision against the copied temp image rather
    // than relying on the usual trailing newline from SessionManager.create.
    await fs.writeFile(sessionPath, (await fs.readFile(sessionPath, 'utf8')).trimEnd(), 'utf8');

    assert.throws(
      () => manager.appendPieModelSettingsChange(undefined, 'model-without-provider', 'high'),
      /requires both provider and modelId/,
    );
    const beforeFailure = await fs.readFile(sessionPath, 'utf8');
    const beforeEntries = JSON.stringify(manager.getEntries());

    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
    const originalRenameSync = mutableFs.renameSync;
    mutableFs.renameSync = ((..._args: Parameters<typeof mutableFs.renameSync>) => {
      throw Object.assign(new Error('injected model-settings rename failure'), { code: 'EIO' });
    }) as typeof mutableFs.renameSync;
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => manager.appendPieModelSettingsChange('test-provider', 'model-b', 'high'),
        /injected model-settings rename failure/,
      );
    } finally {
      mutableFs.renameSync = originalRenameSync;
      syncBuiltinESMExports();
    }

    assert.equal(await fs.readFile(sessionPath, 'utf8'), beforeFailure);
    assert.equal(JSON.stringify(manager.getEntries()), beforeEntries);
    assert.deepEqual(
      (await fs.readdir(sessionDir)).filter((name) => name.includes('.pie-model-settings-')),
      [],
    );

    const originalWriteFileSync = mutableFs.writeFileSync;
    let writes = 0;
    mutableFs.writeFileSync = ((...args: unknown[]) => {
      writes += 1;
      if (writes === 2) {
        throw Object.assign(new Error('injected model-settings staging write failure'), { code: 'EIO' });
      }
      return Reflect.apply(originalWriteFileSync, mutableFs, args as Parameters<typeof mutableFs.writeFileSync>);
    }) as typeof mutableFs.writeFileSync;
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => manager.appendPieModelSettingsChange('test-provider', 'model-b', 'high'),
        /injected model-settings staging write failure/,
      );
    } finally {
      mutableFs.writeFileSync = originalWriteFileSync;
      syncBuiltinESMExports();
    }
    assert.equal(await fs.readFile(sessionPath, 'utf8'), beforeFailure);
    assert.equal(JSON.stringify(manager.getEntries()), beforeEntries);
    assert.deepEqual(
      (await fs.readdir(sessionDir)).filter((name) => name.includes('.pie-model-settings-')),
      [],
    );

    const originalFsyncSync = mutableFs.fsyncSync;
    mutableFs.fsyncSync = ((..._args: Parameters<typeof mutableFs.fsyncSync>) => {
      throw Object.assign(new Error('injected model-settings staging fsync failure'), { code: 'EIO' });
    }) as typeof mutableFs.fsyncSync;
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => manager.appendPieModelSettingsChange('test-provider', 'model-b', 'high'),
        /injected model-settings staging fsync failure/,
      );
    } finally {
      mutableFs.fsyncSync = originalFsyncSync;
      syncBuiltinESMExports();
    }
    assert.equal(await fs.readFile(sessionPath, 'utf8'), beforeFailure);
    assert.equal(JSON.stringify(manager.getEntries()), beforeEntries);
    assert.deepEqual(
      (await fs.readdir(sessionDir)).filter((name) => name.includes('.pie-model-settings-')),
      [],
    );

    const result = manager.appendPieModelSettingsChange('test-provider', 'model-b', 'high');
    assert.match(result.modelChangeId, /^[a-z0-9-]+$/u);
    assert.match(result.thinkingLevelChangeId, /^[a-z0-9-]+$/u);
    const rows = (await fs.readFile(sessionPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.at(-2)?.type, 'model_change');
    assert.equal(rows.at(-2)?.provider, 'test-provider');
    assert.equal(rows.at(-2)?.modelId, 'model-b');
    assert.equal(rows.at(-1)?.type, 'thinking_level_change');
    assert.equal(rows.at(-1)?.thinkingLevel, 'high');
    assert.equal(rows.at(-1)?.parentId, rows.at(-2)?.id);
    assert.equal(manager.getEntries().length, rows.length - 1, 'getEntries excludes the session header');
    assert.deepEqual(
      (await fs.readdir(sessionDir)).filter((name) => name.includes('.pie-model-settings-')),
      [],
    );
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
