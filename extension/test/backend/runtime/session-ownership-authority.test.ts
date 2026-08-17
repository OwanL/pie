import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  ColdSessionLeaseAuthority,
  ColdSessionStore,
  StaleColdSessionLeaseError,
} from '../../../src/backend/cold-session-store';
import type {
  SdkSessionOwnershipAdapter,
  SdkSessionReplacementIntent,
  SdkSessionWriteLease,
  SdkWorkerOwnershipIdentity,
} from '../../../src/backend/sdk';
import { ensureSdkPatchBarrier } from '../../../src/backend/sdk-patch-barrier';
import {
  SessionOwnershipAuthority,
  SessionOwnershipConflictError,
  SessionOwnershipFailClosedError,
  StaleSessionWriteLeaseError,
} from '../../../src/backend/session-ownership-authority';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pinnedSdkPath = path.join(extensionRoot, 'node_modules', '@earendil-works', 'pi-coding-agent');

interface PatchedSdkModules {
  SessionManager: any;
  createAgentSessionRuntime: (factory: unknown, options: unknown) => Promise<any>;
}

let modulesPromise: Promise<PatchedSdkModules> | undefined;

async function patchedSdk(): Promise<PatchedSdkModules> {
  modulesPromise ??= (async () => {
    const previousTrustedRoot = process.env.PIE_TRUSTED_SDK_ROOT;
    process.env.PIE_TRUSTED_SDK_ROOT = extensionRoot;
    try {
      await ensureSdkPatchBarrier(pinnedSdkPath);
    } finally {
      if (previousTrustedRoot === undefined) delete process.env.PIE_TRUSTED_SDK_ROOT;
      else process.env.PIE_TRUSTED_SDK_ROOT = previousTrustedRoot;
    }
    const nonce = `phase4=${Date.now()}`;
    const managerModule = await import(`${pathToFileURL(path.join(pinnedSdkPath, 'dist', 'core', 'session-manager.js')).href}?${nonce}`);
    const runtimeModule = await import(`${pathToFileURL(path.join(pinnedSdkPath, 'dist', 'core', 'agent-session-runtime.js')).href}?${nonce}`);
    return {
      SessionManager: managerModule.SessionManager,
      createAgentSessionRuntime: runtimeModule.createAgentSessionRuntime,
    };
  })();
  return await modulesPromise;
}

function owner(workerId = 'worker-a', workerGeneration = 1): SdkWorkerOwnershipIdentity {
  return { coordinatorGeneration: 1, workerId, workerGeneration };
}

async function tempSessionRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(extensionRoot, '.pie-phase4-ownership-test-'));
}

function intent(
  source: SdkSessionWriteLease,
  destinationPath: string,
  operationId = 'replace-1',
  destinationMustNotExist = true,
): SdkSessionReplacementIntent {
  return {
    operationId,
    reason: 'new',
    source,
    destinationPath,
    destinationMustNotExist,
  };
}

function assertStale(error: unknown): boolean {
  return error instanceof Error
    && (error as Error & { code?: string }).code === 'STALE_SESSION_WRITE_LEASE';
}

test('authority reserves exact canonical intent, transfers once, and rejects stale/replayed/wrong-path writes', async () => {
  const root = await tempSessionRoot();
  try {
    const { SessionManager } = await patchedSdk();
    const sessionDir = path.join(root, 'sessions');
    const sourceManager = SessionManager.create(root, sessionDir);
    const sourcePath = sourceManager.getSessionFile();
    const authority = new SessionOwnershipAuthority();
    const identity = owner();
    const adapter = authority.createAdapter(identity);
    const sourceLease = await authority.registerHot(sourcePath, identity);
    sourceManager.attachPieWriteLease(adapter, sourceLease);

    const prepared = SessionManager.preparePieCreate(root, sessionDir, undefined, adapter);
    const requestedDestination = prepared.getSessionFile();
    await assert.rejects(fs.access(requestedDestination));

    const reservation = await adapter.reserveReplacement(intent(sourceLease, requestedDestination));
    assert.equal(reservation.canonicalDestinationPath, (await authority.canonicalize(requestedDestination)).canonicalPath);
    await assert.rejects(fs.access(requestedDestination), 'reservation must not create the destination');

    const authorization = await adapter.commitTransfer(reservation, sourceLease);
    sourceManager.revokePieWriteLease();
    prepared.sessionFile = reservation.canonicalDestinationPath;
    const destinationLease = await prepared.activatePiePrepared(authorization);
    await fs.access(reservation.canonicalDestinationPath);
    await adapter.runtimeReady(destinationLease, reservation.canonicalDestinationPath);
    assert.equal((await authority.inspect(sourcePath))?.state, 'cold');

    const staleSeams = [
      () => sourceManager.appendSessionInfo('stale'),
      () => sourceManager.appendMessage({ role: 'user', content: 'stale', timestamp: Date.now() }),
      () => sourceManager.appendThinkingLevelChange('high'),
      () => sourceManager.appendModelChange('fixture', 'fixture'),
      () => sourceManager.appendCustomEntry('fixture', {}),
      () => sourceManager.appendCustomMessageEntry('fixture', 'stale', false),
      () => sourceManager.branch('missing'),
      () => sourceManager.resetLeaf(),
      () => sourceManager.branchWithSummary(null, 'stale'),
      () => sourceManager.createBranchedSession('missing'),
      () => sourceManager.newSession(),
      () => sourceManager.setSessionFile(reservation.canonicalDestinationPath),
      () => sourceManager._rewriteFile(),
      () => sourceManager._persist({}),
      () => sourceManager._appendEntry({}),
    ];
    for (const staleWrite of staleSeams) assert.throws(staleWrite, assertStale);
    await assert.rejects(prepared.activatePiePrepared(authorization), assertStale);
    assert.throws(
      () => adapter.assertWriteLease(
        { ...destinationLease, canonicalSessionPath: sourcePath },
        sourcePath,
        'wrong-path-probe',
      ),
      assertStale,
    );
    assert.throws(
      () => adapter.assertWriteLease({ ...destinationLease, nonce: 'replayed' }, reservation.canonicalDestinationPath, 'nonce-probe'),
      assertStale,
    );
    prepared.appendSessionInfo('destination-still-live');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('shared cold authority fences sorted canonical paths and rejects a real cold write between reserve and commit', async () => {
  const root = await tempSessionRoot();
  try {
    const { SessionManager } = await patchedSdk();
    const sessionDir = path.join(root, 'sessions');
    const source = SessionManager.create(root, sessionDir);
    const destination = SessionManager.create(root, sessionDir);
    const coldLeases = new ColdSessionLeaseAuthority(1);
    const coldStore = new ColdSessionStore({
      sdk: { SessionManager },
      coordinatorGeneration: 1,
      startupCwd: root,
      agentDir: root,
      sessionDir,
      leaseAuthority: coldLeases,
    });
    const authority = new SessionOwnershipAuthority({ coldLeaseAuthority: coldLeases });
    const identity = owner('shared-cold-fence');
    const adapter = authority.createAdapter(identity);
    const sourceLease = await authority.registerHot(source.getSessionFile(), identity);
    source.attachPieWriteLease(adapter, sourceLease);
    const existingStamp = coldLeases.capture(destination.getSessionFile());

    const reservation = await adapter.reserveReplacement(
      intent(sourceLease, destination.getSessionFile(), 'cold-collision', false),
    );
    assert.throws(
      () => coldLeases.assertCurrent(existingStamp),
      (error) => error instanceof StaleColdSessionLeaseError && error.reason === 'ownership-revision',
    );
    assert.throws(
      () => coldLeases.capture(destination.getSessionFile()),
      (error) => error instanceof StaleColdSessionLeaseError && error.reason === 'path-reserved',
    );
    const before = await fs.readFile(destination.getSessionFile(), 'utf8');
    const destinationAlias = process.platform === 'win32'
      ? destination.getSessionFile().toUpperCase()
      : path.join(root, 'destination-alias.jsonl');
    if (process.platform !== 'win32') await fs.symlink(destination.getSessionFile(), destinationAlias);
    assert.throws(
      () => coldLeases.capture(destinationAlias),
      (error) => error instanceof StaleColdSessionLeaseError && error.reason === 'path-reserved',
      'canonical aliases cannot bypass a replacement fence',
    );
    await assert.rejects(
      coldStore.truncateAfter(destination.getSessionFile(), 'never-reached'),
      (error) => error instanceof StaleColdSessionLeaseError && error.reason === 'path-reserved',
    );
    assert.equal(await fs.readFile(destination.getSessionFile(), 'utf8'), before);

    await adapter.commitTransfer(reservation, sourceLease);
    assert.throws(
      () => coldLeases.capture(destination.getSessionFile()),
      (error) => error instanceof StaleColdSessionLeaseError && error.reason === 'path-reserved',
      'the committed hot destination remains fenced from cold writes',
    );
    await authority.reconcileCrash({
      owner: identity,
      processDeathConfirmed: true,
      fingerprints: {
        [reservation.canonicalDestinationPath]: { exists: true, size: 1, sha256: '0'.repeat(64) },
      },
    });
    assert.equal((await authority.inspect(destination.getSessionFile()))?.state, 'retiring');
    assert.throws(
      () => coldLeases.capture(destination.getSessionFile()),
      (error) => error instanceof StaleColdSessionLeaseError && error.reason === 'path-reserved',
      'ambiguous crash reconciliation must retain the cold fence',
    );

    const direct = new ColdSessionLeaseAuthority(1);
    const tokens = direct.reserveCanonicalPaths(
      [path.join(root, 'z.jsonl'), path.join(root, 'a.jsonl'), path.join(root, 'z.jsonl')],
      'sorted-probe',
    );
    assert.deepEqual(
      tokens.map((token) => token.sessionPathKey),
      [...tokens.map((token) => token.sessionPathKey)].sort(),
    );
    direct.releaseCanonicalPaths([...tokens].reverse());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('authority aborts precommit safely and detects conflicts and destination fingerprint changes', async () => {
  const root = await tempSessionRoot();
  try {
    const { SessionManager } = await patchedSdk();
    const sessionDir = path.join(root, 'sessions');
    const source = SessionManager.create(root, sessionDir);
    const authority = new SessionOwnershipAuthority();
    const identity = owner();
    const adapter = authority.createAdapter(identity);
    const sourceLease = await authority.registerHot(source.getSessionFile(), identity);
    source.attachPieWriteLease(adapter, sourceLease);

    const cancelledDestination = path.join(sessionDir, 'cancelled.jsonl');
    const cancelled = await adapter.reserveReplacement(intent(sourceLease, cancelledDestination, 'cancel'));
    await adapter.abortPrecommit(cancelled, 'cancelled by extension');
    source.appendSessionInfo('source-remains-live');
    assert.equal((await authority.inspect(source.getSessionFile()))?.state, 'hot');
    assert.equal((await authority.inspect(cancelledDestination))?.state, 'cold');
    await assert.rejects(fs.access(cancelledDestination));

    const collision = SessionManager.create(root, sessionDir);
    const collisionOwner = owner('worker-b');
    await authority.registerHot(collision.getSessionFile(), collisionOwner);
    await assert.rejects(
      adapter.reserveReplacement(intent(sourceLease, collision.getSessionFile(), 'conflict', false)),
      SessionOwnershipConflictError,
    );
    source.appendSessionInfo('source-after-conflict');

    const changedPath = path.join(sessionDir, 'changed.jsonl');
    const changed = await adapter.reserveReplacement(intent(sourceLease, changedPath, 'fingerprint'));
    await fs.writeFile(changedPath, 'external mutation\n', 'utf8');
    await assert.rejects(adapter.commitTransfer(changed, sourceLease), SessionOwnershipConflictError);
    await adapter.abortPrecommit(changed, 'fingerprint changed');
    source.appendSessionInfo('source-after-fingerprint-conflict');

    const boundPath = path.join(sessionDir, 'bound.jsonl');
    const bound = await adapter.reserveReplacement(intent(sourceLease, boundPath, 'bound-reservation'));
    await assert.rejects(
      adapter.commitTransfer({ ...bound, canonicalDestinationPath: path.join(sessionDir, 'decoy.jsonl') }, sourceLease),
      StaleSessionWriteLeaseError,
    );
    await adapter.abortPrecommit(bound, 'tampered reservation rejected');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('crash reconciliation distinguishes pre-transfer and post-transfer ownership and requires confirmed death', async () => {
  const root = await tempSessionRoot();
  try {
    const { SessionManager } = await patchedSdk();
    const sessionDir = path.join(root, 'sessions');

    const beforeAuthority = new SessionOwnershipAuthority();
    const beforeOwner = owner('before-crash');
    const beforeAdapter = beforeAuthority.createAdapter(beforeOwner);
    const beforeSource = SessionManager.create(root, sessionDir);
    const beforeLease = await beforeAuthority.registerHot(beforeSource.getSessionFile(), beforeOwner);
    const beforeDestination = path.join(sessionDir, 'before-crash.jsonl');
    await beforeAdapter.reserveReplacement(intent(beforeLease, beforeDestination, 'before-crash'));
    await assert.rejects(
      beforeAuthority.reconcileCrash({ owner: beforeOwner, processDeathConfirmed: false }),
      SessionOwnershipConflictError,
    );
    await beforeAuthority.reconcileCrash({ owner: beforeOwner, processDeathConfirmed: true });
    assert.equal((await beforeAuthority.inspect(beforeSource.getSessionFile()))?.state, 'cold');
    assert.equal((await beforeAuthority.inspect(beforeDestination))?.state, 'cold');

    const afterAuthority = new SessionOwnershipAuthority();
    const afterOwner = owner('after-crash');
    const afterAdapter = afterAuthority.createAdapter(afterOwner);
    const afterSource = SessionManager.create(root, sessionDir);
    const afterLease = await afterAuthority.registerHot(afterSource.getSessionFile(), afterOwner);
    const prepared = SessionManager.preparePieCreate(root, sessionDir, undefined, afterAdapter);
    const reservation = await afterAdapter.reserveReplacement(intent(afterLease, prepared.getSessionFile(), 'after-crash'));
    const authorization = await afterAdapter.commitTransfer(reservation, afterLease);
    assert.equal((await afterAuthority.inspect(afterSource.getSessionFile()))?.state, 'cold');
    assert.equal((await afterAuthority.inspect(reservation.canonicalDestinationPath))?.state, 'hot');
    await assert.rejects(
      afterAdapter.consumeTransferAuthorization({ ...authorization, nonce: 'wrong' }, reservation.canonicalDestinationPath),
      assertStale,
    );
    await afterAuthority.reconcileCrash({ owner: afterOwner, processDeathConfirmed: true });
    assert.equal((await afterAuthority.inspect(afterSource.getSessionFile()))?.state, 'cold');
    assert.equal((await afterAuthority.inspect(reservation.canonicalDestinationPath))?.state, 'cold');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function tracedAdapter(base: SdkSessionOwnershipAdapter, trace: string[]): SdkSessionOwnershipAdapter {
  return {
    reserveReplacement: async (replacementIntent) => {
      trace.push(`reserve:${replacementIntent.reason}`);
      return await base.reserveReplacement(replacementIntent);
    },
    abortPrecommit: async (reservation, reason) => {
      trace.push('abort-precommit');
      await base.abortPrecommit(reservation, reason);
    },
    commitTransfer: async (reservation, sourceLease) => {
      trace.push('commit-transfer');
      return await base.commitTransfer(reservation, sourceLease);
    },
    consumeTransferAuthorization: async (authorization, destination) => {
      trace.push('activate-destination');
      return await base.consumeTransferAuthorization(authorization, destination);
    },
    assertWriteLease: (lease, sessionPath, seam) => base.assertWriteLease(lease, sessionPath, seam),
    runtimeReady: async (lease, sessionPath) => {
      trace.push('runtime-ready');
      await base.runtimeReady(lease, sessionPath);
    },
    failClosed: async (error) => await base.failClosed(error),
  };
}

function fakeSession(manager: any, trace: string[], cancelNext: { value: boolean }): any {
  const session: any = {
    sessionManager: manager,
    sessionFile: manager.getSessionFile(),
    isStreaming: false,
    agent: {
      state: { messages: manager.buildSessionContext().messages },
      waitForIdle: async () => { trace.push('quiesced'); },
    },
    extensionRunner: {
      hasHandlers: () => true,
      emit: async (event: { type: string }) => {
        trace.push(event.type);
        if ((event.type === 'session_before_switch' || event.type === 'session_before_fork') && cancelNext.value) {
          cancelNext.value = false;
          return { cancel: true };
        }
        return undefined;
      },
    },
    abort: async () => { trace.push('abort-stream'); },
    dispose: () => { trace.push('disposed'); },
    createReplacedSessionContext: () => ({ sessionFile: manager.getSessionFile() }),
  };
  return session;
}

test('patched runtime serializes new/switch/root fork/branch/clone/import/self-reopen and preserves lifecycle readiness order', async () => {
  const root = await tempSessionRoot();
  try {
    const { SessionManager, createAgentSessionRuntime } = await patchedSdk();
    const sessionDir = path.join(root, 'sessions');
    const importDir = path.join(root, 'imports');
    const source = SessionManager.create(root, sessionDir);
    const authority = new SessionOwnershipAuthority();
    const identity = owner('runtime-worker');
    const initialLease = await authority.registerHot(source.getSessionFile(), identity);
    const trace: string[] = [];
    const adapter = tracedAdapter(authority.createAdapter(identity), trace);
    const cancelNext = { value: false };
    const factory = async (options: any) => {
      trace.push(`session-start:${options.sessionStartEvent?.reason ?? 'initial'}`);
      return {
        session: fakeSession(options.sessionManager, trace, cancelNext),
        services: { cwd: options.cwd, agentDir: options.agentDir },
        diagnostics: [],
      };
    };
    const runtime = await createAgentSessionRuntime(factory, {
      cwd: root,
      agentDir: root,
      sessionManager: source,
      ownershipAdapter: adapter,
      writeLease: initialLease,
    });
    runtime.setRebindSession(async () => { trace.push('rebind'); });

    trace.length = 0;
    const initialPath = runtime.session.sessionFile;
    await runtime.newSession({ withSession: async () => { trace.push('with-session'); } });
    const firstNewPath = runtime.session.sessionFile;
    assert.deepEqual(trace.slice(0, 11), [
      'session_before_switch',
      'reserve:new',
      'abort-stream',
      'quiesced',
      'session_shutdown',
      'disposed',
      'commit-transfer',
      'activate-destination',
      'session-start:new',
      'runtime-ready',
      'rebind',
    ]);
    assert.equal(trace[11], 'with-session');
    assert.equal((await authority.inspect(initialPath))?.state, 'cold');
    await runtime.switchSession(initialPath);
    await runtime.switchSession(firstNewPath);

    // Build enough history to exercise root fork, branch fork, and clone.
    const rootUserId = runtime.session.sessionManager.appendMessage({ role: 'user', content: 'root', timestamp: Date.now() });
    runtime.session.sessionManager.appendMessage({
      role: 'assistant', content: [{ type: 'text', text: 'reply' }], provider: 'fixture', model: 'fixture',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now(),
    });
    const branchUserId = runtime.session.sessionManager.appendMessage({ role: 'user', content: 'branch', timestamp: Date.now() });

    const activitySession = runtime.session;
    activitySession.isBashRunning = true;
    activitySession.abortBash = () => {
      setTimeout(() => {
        activitySession.sessionManager.appendSessionInfo('background bash settled');
        activitySession.isBashRunning = false;
        trace.push('background-bash-settled');
      }, 5);
    };
    await runtime.fork(rootUserId, { position: 'before' });
    assert.ok(trace.includes('background-bash-settled'));
    const newRootUser = runtime.session.sessionManager.appendMessage({ role: 'user', content: 'new-root', timestamp: Date.now() });
    runtime.session.sessionManager.appendMessage({
      role: 'assistant', content: [{ type: 'text', text: 'new reply' }], provider: 'fixture', model: 'fixture',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now(),
    });
    const newBranchUser = runtime.session.sessionManager.appendMessage({ role: 'user', content: 'new branch', timestamp: Date.now() });
    await runtime.fork(newBranchUser, { position: 'before' });
    const cloneEntry = runtime.session.sessionManager.getEntries().at(-1)?.id ?? newRootUser;
    await runtime.fork(cloneEntry, { position: 'at' });

    const switchTarget = SessionManager.create(root, sessionDir);
    await runtime.switchSession(switchTarget.getSessionFile());
    runtime.session.agent.waitForIdle = async () => {
      trace.push('quiesced-with-source-write');
      runtime.session.sessionManager.appendSessionInfo('quiescing self-reopen');
    };
    const selfReopenRunner = runtime.session.extensionRunner;
    const selfReopenEmit = selfReopenRunner.emit.bind(selfReopenRunner);
    selfReopenRunner.emit = async (event: { type: string }) => {
      if (event.type === 'session_shutdown') {
        runtime.session.sessionManager.appendSessionInfo('shutdown-complete self-reopen');
      }
      return await selfReopenEmit(event);
    };
    await runtime.switchSession(runtime.session.sessionFile); // exact self-reopen
    assert.equal(runtime.session.sessionManager.getSessionName(), 'shutdown-complete self-reopen');

    const canonicalSelfPath = runtime.session.sessionFile as string;
    let aliasedSelfPath: string;
    if (process.platform === 'win32') {
      aliasedSelfPath = canonicalSelfPath.toUpperCase();
    } else {
      aliasedSelfPath = path.join(root, 'self-reopen-alias.jsonl');
      await fs.symlink(canonicalSelfPath, aliasedSelfPath);
    }
    assert.notEqual(aliasedSelfPath, canonicalSelfPath);
    const aliasRunner = runtime.session.extensionRunner;
    const aliasEmit = aliasRunner.emit.bind(aliasRunner);
    aliasRunner.emit = async (event: { type: string }) => {
      if (event.type === 'session_shutdown') {
        runtime.session.sessionManager.appendSessionInfo('canonical alias shutdown');
      }
      return await aliasEmit(event);
    };
    await runtime.switchSession(aliasedSelfPath);
    assert.equal(runtime.session.sessionManager.getSessionName(), 'canonical alias shutdown');

    const sameDirectoryImport = SessionManager.create(root, sessionDir);
    await runtime.importFromJsonl(sameDirectoryImport.getSessionFile());

    await fs.mkdir(importDir, { recursive: true });
    const importSource = SessionManager.create(root, importDir);
    await runtime.importFromJsonl(importSource.getSessionFile());

    assert.ok(trace.includes('reserve:root-fork'));
    assert.ok(trace.includes('reserve:branch-fork'));
    assert.ok(trace.includes('reserve:clone'));
    assert.ok(trace.includes('reserve:switch'));
    assert.ok(trace.includes('reserve:self-reopen'));
    assert.ok(trace.includes('reserve:import'));
    assert.notEqual(branchUserId, newBranchUser);

    cancelNext.value = true;
    const beforeCancelPath = runtime.session.sessionFile;
    const beforeReserveCount = trace.filter((entry) => entry.startsWith('reserve:')).length;
    assert.deepEqual(await runtime.newSession(), { cancelled: true });
    assert.equal(runtime.session.sessionFile, beforeCancelPath);
    assert.equal(trace.filter((entry) => entry.startsWith('reserve:')).length, beforeReserveCount);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('patched runtime fails worker ownership closed after an ambiguous transfer failure', async () => {
  const root = await tempSessionRoot();
  try {
    const { SessionManager, createAgentSessionRuntime } = await patchedSdk();
    const sessionDir = path.join(root, 'sessions');
    const source = SessionManager.create(root, sessionDir);
    const authority = new SessionOwnershipAuthority();
    const identity = owner('failed-worker');
    const lease = await authority.registerHot(source.getSessionFile(), identity);
    const base = authority.createAdapter(identity);
    let commitEntered!: () => void;
    let rejectCommit!: (error: Error) => void;
    const entered = new Promise<void>((resolve) => { commitEntered = resolve; });
    const blockedCommit = new Promise<never>((_resolve, reject) => { rejectCommit = reject; });
    const adapter: SdkSessionOwnershipAdapter = {
      ...base,
      commitTransfer: async () => {
        commitEntered();
        return await blockedCommit;
      },
    };
    const runtime = await createAgentSessionRuntime(async (options: any) => ({
      session: fakeSession(options.sessionManager, [], { value: false }),
      services: { cwd: options.cwd, agentDir: options.agentDir },
      diagnostics: [],
    }), {
      cwd: root,
      agentDir: root,
      sessionManager: source,
      ownershipAdapter: adapter,
      writeLease: lease,
    });

    const replacement = runtime.newSession();
    await entered;
    assert.throws(() => source.appendSessionInfo('write during coordinator commit'), assertStale);
    rejectCommit(new Error('ambiguous transfer acknowledgement'));
    await assert.rejects(replacement, SessionOwnershipFailClosedError);
    assert.throws(() => source.appendSessionInfo('write after lost commit response'), assertStale);
    assert.equal((await authority.inspect(source.getSessionFile()))?.state, 'retiring');
    await assert.rejects(runtime.newSession(), /failed closed/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('failClosed revokes a hot lease before awaiting durable fingerprint reconciliation', async () => {
  const root = await tempSessionRoot();
  try {
    const { SessionManager } = await patchedSdk();
    const source = SessionManager.create(root, path.join(root, 'sessions'));
    const authority = new SessionOwnershipAuthority();
    const identity = owner('synchronous-fence');
    const lease = await authority.registerHot(source.getSessionFile(), identity);
    const adapter = authority.createAdapter(identity);
    source.attachPieWriteLease(adapter, lease);
    const observed = await authority.fingerprint(source.getSessionFile());
    let releaseFingerprint!: () => void;
    const fingerprintBlocked = new Promise<void>((resolve) => { releaseFingerprint = resolve; });
    const authorityProbe = authority as SessionOwnershipAuthority & {
      fingerprint(sessionPath: string): Promise<typeof observed>;
    };
    authorityProbe.fingerprint = async () => {
      await fingerprintBlocked;
      return observed;
    };

    const failing = adapter.failClosed(new Error('ambiguous'));
    await Promise.resolve();
    await Promise.resolve();
    assert.throws(() => source.appendSessionInfo('must be fenced'), assertStale);
    releaseFingerprint();
    await assert.rejects(failing, SessionOwnershipFailClosedError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('authority failClosed exposes a typed terminal error', async () => {
  const authority = new SessionOwnershipAuthority();
  await assert.rejects(authority.failClosed(owner('terminal'), new Error('boom')), SessionOwnershipFailClosedError);
  assert.throws(() => { throw new StaleSessionWriteLeaseError('stale'); }, assertStale);
});
