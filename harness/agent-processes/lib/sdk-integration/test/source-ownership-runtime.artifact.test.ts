import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Import the private candidate distribution directly and constrain its full
// runtime graph to the selected source graph and its approved private packages.
import { sourceFixture } from './source-fixture.js';
const { piRoot, packageRoots } = sourceFixture;
const runtimeEntry = path.join(packageRoots.codingAgent, 'dist/core/agent-session-runtime.js');
const managerEntry = path.join(packageRoots.codingAgent, 'dist/core/session-manager.js');
const approvedPackages: Readonly<Record<string, string>> = {
  '@earendil-works/pi-ai': packageRoots.ai,
  '@earendil-works/pi-agent-core': packageRoots.agent,
  '@earendil-works/pi-tui': packageRoots.tui,
  '@earendil-works/pi-coding-agent': packageRoots.codingAgent,
};
const isWithin = (file: string, root: string): boolean => file.startsWith(`${root}${path.sep}`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isBuiltin(specifier)) return nextResolve(specifier, context);
    if (specifier.startsWith('@earendil-works/')) {
      const packageName = Object.keys(approvedPackages).find((name) => (
        specifier === name || specifier.startsWith(`${name}/`)
      ));
      const packageRoot = packageName ? approvedPackages[packageName] : undefined;
      assert.ok(packageRoot, `Unapproved private SDK package import: ${specifier}`);
      const subpath = specifier.slice(packageName!.length).replace(/^\//u, '');
      const target = subpath === 'package.json'
        ? path.join(packageRoot!, 'package.json')
        : path.join(packageRoot!, 'dist', subpath ? `${subpath.replace(/\.js$/u, '')}.js` : 'index.js');
      const resolved = realpathSync(target);
      assert.ok(isWithin(resolved, packageRoot!), `Private SDK package graph escape for ${specifier}: ${resolved}`);
      return nextResolve(pathToFileURL(resolved).href, context);
    }

    const result = nextResolve(specifier, context);
    assert.ok(result.url.startsWith('file:'), `Unexpected non-file runtime dependency: ${specifier} -> ${result.url}`);
    const resolved = realpathSync(fileURLToPath(result.url));
    assert.ok(isWithin(resolved, realpathSync(piRoot)), `Private SDK runtime graph escape for ${specifier}: ${resolved}`);
    return result;
  },
});

const runtimeModules = (async () => {
  const [{ createAgentSessionRuntime }, { SessionManager }] = await Promise.all([
    import(pathToFileURL(runtimeEntry).href),
    import(pathToFileURL(managerEntry).href),
  ]);
  return { createAgentSessionRuntime, SessionManager };
})();

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function fingerprint(filePath: string) {
  if (!existsSync(filePath)) return { exists: false, size: 0, sha256: null };
  const bytes = readFileSync(filePath);
  return { exists: true, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

class FixtureOwnershipAdapter {
  readonly events: string[];
  readonly reservations: any[] = [];
  readonly aborts: any[] = [];
  readonly consumptions: any[] = [];
  readonly ready: any[] = [];
  readonly writes: any[] = [];
  readonly failures: unknown[] = [];
  readonly activeLeases = new Map<string, any>();
  readonly aliases = new Map<string, string>();
  failCommit = false;
  failAbort = false;
  failConsumeAcknowledgement = false;
  failReady = false;
  private sequence = 0;
  private readonly pending = new Map<string, { reservation: any; destinationLease: any; consumed: boolean; committedFingerprint?: any }>();
  private readonly authorizationById = new Map<string, any>();

  constructor(sourcePath: string, events: string[] = []) {
    this.events = events;
    const source = canonicalPath(sourcePath);
    this.activeLeases.set(pathKey(source), this.lease(source, 1));
  }

  get sourceLease(): any {
    return [...this.activeLeases.values()][0];
  }

  alias(requestedPath: string, canonical: string): void {
    this.aliases.set(pathKey(requestedPath), canonicalPath(canonical));
  }

  private lease(sessionPath: string, generation: number): any {
    this.sequence += 1;
    return {
      coordinatorGeneration: 1,
      workerId: 'source-runtime-fixture',
      workerGeneration: generation,
      ownershipRevision: generation,
      nonce: `lease-${this.sequence}`,
      canonicalSessionPath: sessionPath,
    };
  }

  private canonical(value: string): string {
    return this.aliases.get(pathKey(value)) ?? canonicalPath(value);
  }

  assertWriteLease(lease: any, requestedPath: string, seam: string): void {
    const sessionPath = this.canonical(requestedPath);
    const active = this.activeLeases.get(pathKey(sessionPath));
    if (!active || active.nonce !== lease?.nonce || pathKey(lease.canonicalSessionPath) !== pathKey(sessionPath)) {
      throw new Error(`Stale fixture session write lease at ${seam}.`);
    }
  }

  runWriteMutation<T>(lease: any, requestedPath: string, seam: string, _sessionId: string, mutation: () => T): T {
    this.assertWriteLease(lease, requestedPath, seam);
    const prepared = [...this.pending.values()].find((item) => item.destinationLease.nonce === lease.nonce);
    if (prepared && !prepared.consumed) {
      throw new Error('Prepared destination write attempted before transfer authorization consumption.');
    }
    this.writes.push({ path: this.canonical(requestedPath), seam, nonce: lease.nonce });
    this.events.push(`write:${lease.nonce}`);
    return mutation();
  }

  async reserveReplacement(intent: any): Promise<any> {
    this.assertWriteLease(intent.source, intent.source.canonicalSessionPath, 'reserveReplacement');
    const sourcePath = this.canonical(intent.source.canonicalSessionPath);
    const destinationPath = this.canonical(intent.destinationPath);
    if (
      intent.destinationMustNotExist
      && pathKey(destinationPath) !== pathKey(sourcePath)
      && existsSync(destinationPath)
    ) {
      throw new Error('Fixture destination already exists.');
    }
    const id = `reservation-${this.reservations.length + 1}`;
    const reservation = {
      reservationId: id,
      operationId: intent.operationId,
      canonicalSourcePath: sourcePath,
      canonicalDestinationPath: destinationPath,
      ownershipRevision: intent.source.ownershipRevision + 1,
      nonce: `reservation-nonce-${this.reservations.length + 1}`,
      destinationFingerprint: fingerprint(destinationPath),
    };
    const destinationLease = this.lease(destinationPath, intent.source.workerGeneration + 1);
    this.pending.set(id, { reservation, destinationLease, consumed: false });
    this.reservations.push({ intent: structuredClone(intent), reservation });
    this.events.push('reserve');
    return reservation;
  }

  async abortPrecommit(reservation: any, reason: string): Promise<void> {
    this.events.push('abortReservation');
    this.aborts.push({ reservation, reason });
    if (this.failAbort) throw new Error('fixture abort failed');
    this.pending.delete(reservation.reservationId);
  }

  async commitTransfer(reservation: any, sourceLease: any): Promise<any> {
    this.assertWriteLease(sourceLease, reservation.canonicalSourcePath, 'commitTransfer');
    this.events.push('commit');
    if (this.failCommit) throw new Error('fixture commit failed');
    const pending = this.pending.get(reservation.reservationId);
    assert.ok(pending, 'commit must use the active reservation');
    if (pathKey(reservation.canonicalSourcePath) !== pathKey(reservation.canonicalDestinationPath)) {
      assert.deepEqual(
        fingerprint(reservation.canonicalDestinationPath),
        reservation.destinationFingerprint,
        'preparation must not publish destination bytes before authorization consumption',
      );
    }
    pending.committedFingerprint = fingerprint(reservation.canonicalDestinationPath);
    this.activeLeases.delete(pathKey(reservation.canonicalSourcePath));
    const authorization = {
      authorizationId: `authorization-${reservation.reservationId}`,
      reservationId: reservation.reservationId,
      canonicalDestinationPath: reservation.canonicalDestinationPath,
      ownershipRevision: reservation.ownershipRevision,
      nonce: reservation.nonce,
      destinationLease: pending.destinationLease,
    };
    this.authorizationById.set(authorization.authorizationId, authorization);
    return authorization;
  }

  async consumeTransferAuthorization(authorization: any, requestedPath: string): Promise<any> {
    const stored = this.authorizationById.get(authorization.authorizationId);
    assert.equal(stored, authorization, 'transfer authorization is consumed exactly once');
    const pending = this.pending.get(authorization.reservationId);
    assert.ok(pending && !pending.consumed, 'destination must still be prepared');
    assert.equal(pathKey(this.canonical(requestedPath)), pathKey(pending.reservation.canonicalDestinationPath));
    assert.deepEqual(
      fingerprint(pending.reservation.canonicalDestinationPath),
      pending.committedFingerprint,
      'prepared bytes cannot be written in the commit-to-consume gap',
    );
    pending.consumed = true;
    this.activeLeases.set(pathKey(pending.reservation.canonicalDestinationPath), pending.destinationLease);
    this.authorizationById.delete(authorization.authorizationId);
    this.consumptions.push({
      path: pending.reservation.canonicalDestinationPath,
      before: fingerprint(pending.reservation.canonicalDestinationPath),
      lease: pending.destinationLease,
    });
    this.events.push('consume');
    if (this.failConsumeAcknowledgement) throw new Error('fixture consume acknowledgement lost');
    return pending.destinationLease;
  }

  async runtimeReady(lease: any, requestedPath: string): Promise<void> {
    this.assertWriteLease(lease, requestedPath, 'runtimeReady');
    if (this.failReady) throw new Error('fixture runtimeReady failed');
    this.ready.push({ path: this.canonical(requestedPath), lease });
    this.events.push('ready');
  }

  async failClosed(error: unknown): Promise<never> {
    this.events.push('failClosed');
    this.failures.push(error);
    this.activeLeases.clear();
    throw new Error('fixture ownership failed closed', { cause: error });
  }
}

function fakeSession(manager: any, behavior: any, events: string[]): any {
  const runner = {
    hasHandlers(type: string) {
      return type === 'session_shutdown' ? Boolean(behavior.onShutdown)
        : type === 'session_before_switch' ? Boolean(behavior.beforeSwitch)
          : type === 'session_before_fork' ? Boolean(behavior.beforeFork)
            : false;
    },
    async emit(event: any) {
      events.push(event.type);
      if (event.type === 'session_shutdown') return behavior.onShutdown?.(manager, event);
      if (event.type === 'session_before_switch') return behavior.beforeSwitch?.(event);
      if (event.type === 'session_before_fork') return behavior.beforeFork?.(event);
      return undefined;
    },
  };
  return {
    sessionManager: manager,
    get sessionFile() { return manager.getSessionFile(); },
    extensionRunner: runner,
    agent: { state: { messages: manager.buildSessionContext().messages }, async waitForIdle() { events.push('idle'); } },
    get isStreaming() { return false; },
    get isCompacting() { return false; },
    get isRetrying() { return false; },
    get isBashRunning() { return false; },
    clearQueue() { events.push('clearQueue'); },
    abortCompaction() { events.push('abortCompaction'); },
    abortBranchSummary() { events.push('abortBranchSummary'); },
    abortBash() { events.push('abortBash'); },
    abortRetry() { events.push('abortRetry'); },
    async abort() {
      events.push('abort');
      if (behavior.abortFailure) throw new Error('fixture source abort failed');
    },
    dispose() { events.push('dispose'); },
    createReplacedSessionContext() { return { sessionManager: manager }; },
  };
}

async function fixture(t: test.TestContext, options: {
  behavior?: any;
  failFactoryCall?: number;
  failCommit?: boolean;
  failAbort?: boolean;
  failConsumeAcknowledgement?: boolean;
  failReady?: boolean;
  onFactory?: (manager: any, call: number) => void;
} = {}) {
  const { SessionManager, createAgentSessionRuntime } = await runtimeModules;
  const root = mkdtempSync(path.join(tmpdir(), 'pie-source-ownership-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'cwd');
  const sessionDir = path.join(root, 'sessions');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const manager = SessionManager.create(cwd, sessionDir);
  const orderedEvents: string[] = [];
  const adapter = new FixtureOwnershipAdapter(manager.getSessionFile(), orderedEvents);
  adapter.failCommit = options.failCommit ?? false;
  adapter.failAbort = options.failAbort ?? false;
  adapter.failConsumeAcknowledgement = options.failConsumeAcknowledgement ?? false;
  adapter.failReady = options.failReady ?? false;
  const behavior = options.behavior ?? {};
  const sessionEvents = orderedEvents;
  let factoryCalls = 0;
  const createRuntime = async ({ sessionManager: targetManager, cwd: targetCwd, agentDir }: any) => {
    factoryCalls += 1;
    options.onFactory?.(targetManager, factoryCalls);
    if (factoryCalls === options.failFactoryCall) throw new Error('fixture runtime startup failed');
    return {
      session: fakeSession(targetManager, behavior, sessionEvents),
      services: { cwd: targetCwd, agentDir },
      diagnostics: [],
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime as any, {
    cwd,
    agentDir: path.join(root, 'agent'),
    sessionManager: manager,
    ownershipAdapter: adapter as any,
    writeLease: adapter.sourceLease,
  } as any);
  return {
    root,
    cwd,
    sessionDir,
    manager,
    adapter,
    runtime,
    sessionEvents,
    createAgentSessionRuntime,
    get factoryCalls() { return factoryCalls; },
    SessionManager,
  };
}

function appendUser(manager: any, content: string): string {
  return manager.appendMessage({ role: 'user', content, timestamp: Date.now() });
}

const replacementCases = [
  ['new', async (f: any) => f.runtime.newSession(), 'new'],
  ['root fork', async (f: any) => {
    const rootEntry = appendUser(f.manager, 'root prompt');
    return f.runtime.fork(rootEntry, { position: 'before' });
  }, 'root-fork'],
  ['branch fork', async (f: any) => {
    appendUser(f.manager, 'root prompt');
    const child = appendUser(f.manager, 'branch prompt');
    return f.runtime.fork(child, { position: 'before' });
  }, 'branch-fork'],
  ['clone', async (f: any) => {
    const entry = appendUser(f.manager, 'clone prompt');
    return f.runtime.fork(entry, { position: 'at' });
  }, 'clone'],
  ['switch', async (f: any) => {
    const target = f.SessionManager.create(f.cwd, f.sessionDir);
    return f.runtime.switchSession(target.getSessionFile());
  }, 'switch'],
  ['import', async (f: any) => {
    const importDir = path.join(f.root, 'import-source');
    mkdirSync(importDir, { recursive: true });
    const imported = f.SessionManager.create(f.cwd, importDir);
    appendUser(imported, 'imported prompt');
    return f.runtime.importFromJsonl(imported.getSessionFile());
  }, 'import'],
] as const;

for (const [name, run, reason] of replacementCases) {
  test(`source ownership runtime replaces ${name} through the real prepared SessionManager`, async (t) => {
    const f = await fixture(t);
    let rebound = false;
    f.runtime.setRebindSession(async () => {
      rebound = true;
      f.adapter.events.push('rebind');
    });
    const result = await run(f);
    assert.equal(result.cancelled, false);
    assert.equal(f.adapter.reservations.length, 1);
    assert.equal(f.adapter.reservations[0].intent.reason, reason);
    assert.equal(f.adapter.consumptions.length, 1);
    assert.equal(f.adapter.ready.length, 1);
    assert.equal(rebound, true);
    assert.deepEqual(f.adapter.events.slice(-2), ['ready', 'rebind']);
    const reserve = f.adapter.events.indexOf('reserve');
    const quiesce = f.adapter.events.indexOf('clearQueue');
    const dispose = f.adapter.events.indexOf('dispose');
    const commit = f.adapter.events.indexOf('commit');
    assert.ok(reserve >= 0 && reserve < quiesce, 'reservation precedes source quiescence');
    assert.ok(dispose >= 0 && dispose < commit, 'transfer commits only after source disposal');
    assert.ok(f.runtime.session.sessionFile, 'the replacement has a real canonical manager file');
    assert.throws(() => appendUser(f.manager, 'stale source write'), /Stale (?:fixture )?session write lease/u);
  });
}

test('omitting both ownership options retains legacy creation and its single parent-session file', async (t) => {
  const { SessionManager, createAgentSessionRuntime } = await runtimeModules;
  const root = mkdtempSync(path.join(tmpdir(), 'pie-source-ownership-legacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'cwd');
  const sessionDir = path.join(root, 'sessions');
  const parentDir = path.join(root, 'parent');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(parentDir, { recursive: true });
  const manager = SessionManager.create(cwd, sessionDir);
  const parent = SessionManager.create(cwd, parentDir);
  const events: string[] = [];
  const factory = async ({ sessionManager: target, cwd: targetCwd, agentDir }: any) => ({
    session: fakeSession(target, {}, events),
    services: { cwd: targetCwd, agentDir },
    diagnostics: [],
  });
  const runtime = await createAgentSessionRuntime(factory as any, {
    cwd, agentDir: root, sessionManager: manager,
  });
  await runtime.newSession({ parentSession: parent.getSessionFile() });
  assert.equal(runtime.session.sessionManager.getHeader()?.parentSession, parent.getSessionFile());
  assert.equal(readdirSync(sessionDir).filter((name) => name.endsWith('.jsonl')).length, 2);
});

test('runtime factory attaches a paired lease before startup and rejects a partial pair', async (t) => {
  const f = await fixture(t, {
    onFactory: (manager, call) => {
      if (call === 1) appendUser(manager, 'factory startup write');
    },
  });
  assert.equal(f.manager.getEntries().some((entry: any) => entry.message?.content === 'factory startup write'), true);

  const root = mkdtempSync(path.join(tmpdir(), 'pie-source-ownership-partial-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'cwd');
  const dir = path.join(root, 'sessions');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const manager = f.SessionManager.create(cwd, dir);
  let factoryCalled = false;
  await assert.rejects(f.createAgentSessionRuntime(async () => {
    factoryCalled = true;
    return {} as any;
  }, { cwd, agentDir: root, sessionManager: manager, ownershipAdapter: f.adapter } as any), /requires both ownershipAdapter and writeLease/u);
  assert.equal(factoryCalled, false);
});

test('runtimeReady, rebind, and withSession run in transaction order after full source quiescence', async (t) => {
  const f = await fixture(t, { behavior: { onShutdown: () => undefined } });
  f.runtime.setRebindSession(async () => { f.adapter.events.push('rebind'); });
  await f.runtime.newSession({
    setup: async (manager: any) => { appendUser(manager, 'setup after activation'); },
    withSession: async () => { f.adapter.events.push('withSession'); },
  });
  const quiesceStart = f.sessionEvents.indexOf('clearQueue');
  assert.deepEqual(f.sessionEvents.slice(quiesceStart, quiesceStart + 9), [
    'clearQueue', 'abortCompaction', 'abortBranchSummary', 'abortBash', 'abortRetry', 'abort', 'idle',
    'session_shutdown', 'dispose',
  ]);
  assert.ok(f.sessionEvents.indexOf('reserve') < quiesceStart);
  assert.ok(f.sessionEvents.indexOf('dispose') < f.sessionEvents.indexOf('commit'));
  assert.deepEqual(f.adapter.events.slice(-3), ['ready', 'rebind', 'withSession']);
  assert.equal(f.runtime.session.sessionManager.getEntries().some((entry: any) => entry.message?.content === 'setup after activation'), true);
});

test('replacement methods serialize behind the active source transfer', async (t) => {
  const f = await fixture(t);
  let releaseFirst!: () => void;
  let enteredFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const reserve = f.adapter.reserveReplacement.bind(f.adapter);
  let pause = true;
  f.adapter.reserveReplacement = async (intent: any) => {
    const reservation = await reserve(intent);
    if (pause) {
      pause = false;
      enteredFirst();
      await firstGate;
    }
    return reservation;
  };

  const first = f.runtime.newSession();
  await firstEntered;
  const second = f.runtime.newSession();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.adapter.reservations.length, 1, 'the queued replacement cannot reserve against the old source');
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(f.adapter.reservations.length, 2);
  assert.equal(f.adapter.ready.length, 2);
  assert.throws(() => appendUser(f.manager, 'stale after serialized replacements'), /Stale (?:fixture )?session write lease/u);
});

test('before-hook cancellation reserves nothing and fork cancellation stays source-owned', async (t) => {
  const f = await fixture(t, { behavior: { beforeSwitch: () => ({ cancel: true }), beforeFork: () => ({ cancel: true }) } });
  assert.deepEqual(await f.runtime.newSession(), { cancelled: true });
  assert.deepEqual(await f.runtime.switchSession(path.join(f.root, 'cancelled-switch.jsonl')), { cancelled: true });
  const id = appendUser(f.manager, 'source');
  assert.deepEqual(await f.runtime.fork(id), { cancelled: true });
  assert.equal(f.adapter.reservations.length, 0);
  assert.equal(f.adapter.aborts.length, 0);
  appendUser(f.manager, 'still writable');
});

test('source quiesce failure aborts pre-teardown and preserves the source lease', async (t) => {
  const f = await fixture(t, { behavior: { abortFailure: true } });
  await assert.rejects(f.runtime.newSession(), /fixture source abort failed/u);
  assert.equal(f.adapter.reservations.length, 1);
  assert.equal(f.adapter.aborts.length, 1);
  assert.equal(f.adapter.consumptions.length, 0);
  assert.equal(f.adapter.failures.length, 0);
  assert.equal(f.sessionEvents.includes('session_shutdown'), false);
  appendUser(f.manager, 'source survived quiesce failure');
});

test('pre-teardown preparation failure aborts reservation and preserves the source lease', async (t) => {
  const f = await fixture(t);
  const invalid = path.join(f.root, 'invalid-session.jsonl');
  writeFileSync(invalid, 'not a session record\n');
  await assert.rejects(f.runtime.switchSession(invalid), /not a valid pi session/u);
  assert.equal(f.adapter.aborts.length, 1);
  assert.equal(f.adapter.failures.length, 0);
  assert.equal(f.sessionEvents.includes('session_shutdown'), false);
  appendUser(f.manager, 'source survived precommit failure');
});

test('abort failure and teardown failure fail closed, revoke source writes, and reject repeats', async (t) => {
  const aborted = await fixture(t, { failAbort: true });
  const invalid = path.join(aborted.root, 'invalid-session.jsonl');
  writeFileSync(invalid, 'invalid\n');
  await assert.rejects(aborted.runtime.switchSession(invalid), /fixture ownership failed closed/u);
  assert.equal(aborted.adapter.failures.length, 1);
  await assert.rejects(aborted.runtime.newSession(), /already failed closed/u);

  const teardown = await fixture(t, { behavior: { onShutdown: () => { throw new Error('shutdown failed'); } } });
  await assert.rejects(teardown.runtime.newSession(), /fixture ownership failed closed/u);
  assert.equal(teardown.adapter.failures.length, 1);
  assert.throws(() => appendUser(teardown.manager, 'stale after teardown entry'), /Stale (?:fixture )?session write lease/u);
  const reservations = teardown.adapter.reservations.length;
  await assert.rejects(teardown.runtime.newSession(), /already failed closed/u);
  assert.equal(teardown.adapter.reservations.length, reservations);
});

test('consumption acknowledgement loss fails closed without source or retained destination revival', async (t) => {
  const f = await fixture(t, { failConsumeAcknowledgement: true });
  const managerClass = f.SessionManager as any;
  const originalPrepare = managerClass.preparePieCreate;
  let destination: any;
  managerClass.preparePieCreate = (...args: any[]) => {
    destination = originalPrepare.apply(managerClass, args);
    return destination;
  };
  try {
    await assert.rejects(f.runtime.newSession(), /fixture ownership failed closed/u);
  } finally {
    managerClass.preparePieCreate = originalPrepare;
  }
  assert.equal(f.adapter.consumptions.length, 1);
  assert.equal(f.adapter.failures.length, 1);
  assert.throws(() => appendUser(f.manager, 'stale after lost consumption acknowledgement'), /Stale (?:fixture )?session write lease/u);
  assert.throws(() => appendUser(destination, 'stale retained destination after lost acknowledgement'), /Stale (?:fixture )?session write lease/u);
  await assert.rejects(f.runtime.newSession(), /already failed closed/u);
});

test('runtimeReady and rebind failures fail closed and revoke retained destination writers', async (t) => {
  let readyDestination: any;
  const ready = await fixture(t, {
    failReady: true,
    onFactory: (manager, call) => { if (call === 2) readyDestination = manager; },
  });
  await assert.rejects(ready.runtime.newSession(), /fixture ownership failed closed/u);
  assert.equal(ready.adapter.consumptions.length, 1);
  assert.equal(ready.adapter.ready.length, 0);
  assert.equal(ready.adapter.failures.length, 1);
  assert.throws(() => appendUser(readyDestination, 'stale after runtimeReady failure'), /Stale (?:fixture )?session write lease/u);

  let rebindDestination: any;
  const rebind = await fixture(t, {
    onFactory: (manager, call) => { if (call === 2) rebindDestination = manager; },
  });
  rebind.runtime.setRebindSession(async () => { throw new Error('fixture rebind failed'); });
  await assert.rejects(rebind.runtime.newSession(), /fixture ownership failed closed/u);
  assert.equal(rebind.adapter.ready.length, 1);
  assert.equal(rebind.adapter.failures.length, 1);
  assert.throws(() => appendUser(rebindDestination, 'stale after rebind failure'), /Stale (?:fixture )?session write lease/u);
});

test('commit and post-consumption startup failures fail closed without source revival', async (t) => {
  const commit = await fixture(t, { failCommit: true });
  await assert.rejects(commit.runtime.newSession(), /fixture ownership failed closed/u);
  assert.throws(() => appendUser(commit.manager, 'stale after commit failure'), /Stale (?:fixture )?session write lease/u);
  await assert.rejects(commit.runtime.newSession(), /already failed closed/u);

  let startupDestination: any;
  const startup = await fixture(t, {
    failFactoryCall: 2,
    onFactory: (manager, call) => { if (call === 2) startupDestination = manager; },
  });
  await assert.rejects(startup.runtime.newSession(), /fixture ownership failed closed/u);
  assert.equal(startup.adapter.consumptions.length, 1);
  assert.equal(startup.adapter.ready.length, 0);
  assert.throws(() => appendUser(startup.manager, 'stale after startup source failure'), /Stale (?:fixture )?session write lease/u);
  assert.throws(() => appendUser(startupDestination, 'stale after startup destination failure'), /Stale (?:fixture )?session write lease/u);
  await assert.rejects(startup.runtime.newSession(), /already failed closed/u);
});

test('canonical self-reopen aliases defer preparation until shutdown appends are durable', async (t) => {
  const f = await fixture(t, {
    behavior: { onShutdown: (manager: any) => appendUser(manager, 'shutdown append') },
  });
  const sourcePath = f.manager.getSessionFile();
  const alias = path.join(f.root, 'session-alias.jsonl');
  f.adapter.alias(alias, sourcePath);
  const initialPrepareCount = f.adapter.writes.length;

  // Reservation canonicalizes the alias to the source. Preparation must wait
  // until shutdown hooks have appended to the still-leased source manager.
  await f.runtime.switchSession(alias);
  let messages = f.runtime.session.sessionManager.getEntries()
    .filter((entry: any) => entry.type === 'message' && entry.message.role === 'user')
    .map((entry: any) => entry.message.content);
  assert.ok(messages.includes('shutdown append'));
  assert.ok(f.adapter.writes.length > initialPrepareCount);

  // Same-file import is another self-reopen spelling and must also prepare by
  // opening the post-shutdown source image instead of copying it over itself.
  await f.runtime.importFromJsonl(sourcePath);
  messages = f.runtime.session.sessionManager.getEntries()
    .filter((entry: any) => entry.type === 'message' && entry.message.role === 'user')
    .map((entry: any) => entry.message.content);
  assert.equal(messages.filter((message: string) => message === 'shutdown append').length, 2);
  assert.throws(() => appendUser(f.manager, 'stale self-reopen source'), /Stale (?:fixture )?session write lease/u);
});

test('all replacement preparations leave destination bytes untouched until authorization consumption', async (t) => {
  for (const [name, run] of replacementCases) {
    await t.test(name, async (nested) => {
      const f = await fixture(nested);
      await run(f);
      assert.equal(f.adapter.consumptions.length, 1);
      const preparedWrites = f.adapter.writes.filter((write: any) => write.nonce === f.adapter.consumptions[0].lease.nonce);
      const consumeEvent = f.adapter.events.indexOf('consume');
      assert.ok(consumeEvent >= 0);
      for (const write of preparedWrites) {
        assert.ok(f.adapter.events.indexOf(`write:${write.nonce}`) > consumeEvent);
      }
    });
  }
});
