import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isBuiltin, registerHooks, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SessionOwnershipAdapter } from '../../../../pi/packages/coding-agent/dist/core/session-ownership.js';

// Import the private candidate distribution directly. This suite must not load
// the installed SDK or invoke its patch barrier.
import { sourceFixture } from './source-fixture.js';
const { piRoot, packageRoots } = sourceFixture;
const codingAgentEntry = path.join(packageRoots.codingAgent, 'dist/core/session-manager.js');
const approvedPackages: Readonly<Record<string, string>> = {
  '@earendil-works/pi-ai': packageRoots.ai,
  '@earendil-works/pi-agent-core': packageRoots.agent,
  '@earendil-works/pi-tui': packageRoots.tui,
  '@earendil-works/pi-coding-agent': packageRoots.codingAgent,
};
const isWithin = (file: string, root: string): boolean => file.startsWith(`${root}${path.sep}`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (isBuiltin(specifier)) return result;

    assert.ok(result.url.startsWith('file:'), `Unexpected non-file runtime dependency: ${specifier} -> ${result.url}`);
    const resolved = fs.realpathSync(fileURLToPath(result.url));
    if (specifier.startsWith('@earendil-works/')) {
      const packageName = Object.keys(approvedPackages).find((name) => (
        specifier === name || specifier.startsWith(`${name}/`)
      ));
      const expectedRoot = packageName ? approvedPackages[packageName] : undefined;
      assert.ok(expectedRoot, `Unapproved private SDK package import: ${specifier}`);
      assert.ok(isWithin(resolved, expectedRoot), `Private SDK package graph escape for ${specifier}: ${resolved}`);
      return result;
    }

    assert.ok(isWithin(resolved, fs.realpathSync(piRoot)), `Private SDK runtime graph escape for ${specifier}: ${resolved}`);
    return result;
  },
});

let SessionManager: typeof import('../../../../pi/packages/coding-agent/dist/core/session-manager.js').SessionManager;
before(async () => {
  ({ SessionManager } = await import(pathToFileURL(codingAgentEntry).href));
});

interface Lease {
  coordinatorGeneration: number;
  workerId: string;
  workerGeneration: number;
  canonicalSessionPath: string;
  ownershipRevision: number;
  nonce: string;
}

interface TransferAuthorization {
  authorizationId: string;
  reservationId: string;
  canonicalDestinationPath: string;
  ownershipRevision: number;
  nonce: string;
  destinationLease: Lease;
}

function ownershipFixture(
  initialPath = path.resolve('unbound-session.jsonl'),
  onConsume?: () => void,
) {
  const lease: Lease = {
    coordinatorGeneration: 1,
    workerId: 'worker-fixture',
    workerGeneration: 1,
    canonicalSessionPath: initialPath,
    ownershipRevision: 1,
    nonce: 'lease-fixture',
  };
  let valid = true;
  let consumeFailure: Error | undefined;
  let returnedLease = lease;
  let consumed = 0;
  let depth = 0;
  let maximumDepth = 0;
  let mutationRuns = 0;

  const assertWriteLease = (current: Lease, canonicalPath: string, seam: string): void => {
    if (!valid || current !== lease || path.resolve(current.canonicalSessionPath) !== path.resolve(canonicalPath)) {
      throw new Error(`stale lease at ${seam}`);
    }
  };
  const adapter: SessionOwnershipAdapter = {
    async reserveReplacement() { throw new Error('unused manager fixture reservation'); },
    async abortPrecommit() {},
    async commitTransfer() { throw new Error('unused manager fixture commit'); },
    async runtimeReady() {},
    async failClosed(error: unknown): Promise<never> { throw error; },
    assertWriteLease,
    async consumeTransferAuthorization(authorization: TransferAuthorization, canonicalPath: string): Promise<Lease> {
      consumed++;
      if (consumeFailure) throw consumeFailure;
      assert.equal(path.resolve(authorization.canonicalDestinationPath), path.resolve(canonicalPath));
      assert.equal(authorization.destinationLease, lease);
      onConsume?.();
      return returnedLease;
    },
    runWriteMutation<T>(current: Lease, canonicalPath: string, seam: string, _sessionId: string, mutation: () => T): T {
      assertWriteLease(current, canonicalPath, seam);
      mutationRuns++;
      depth++;
      maximumDepth = Math.max(maximumDepth, depth);
      try {
        return mutation();
      } finally {
        depth--;
      }
    },
  };

  return {
    adapter,
    lease,
    setPath(value: string): void { lease.canonicalSessionPath = path.resolve(value); },
    authorization(): TransferAuthorization {
      return {
        authorizationId: 'authorization-fixture',
        reservationId: 'reservation-fixture',
        canonicalDestinationPath: lease.canonicalSessionPath,
        ownershipRevision: lease.ownershipRevision,
        nonce: lease.nonce,
        destinationLease: lease,
      };
    },
    setValid(value: boolean): void { valid = value; },
    setConsumeFailure(error: Error | undefined): void { consumeFailure = error; },
    setReturnedLease(value: Lease): void { returnedLease = value; },
    getConsumed(): number { return consumed; },
    getMaximumDepth(): number { return maximumDepth; },
    getMutationRuns(): number { return mutationRuns; },
  };
}

function tempRoot(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-source-ownership-manager-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sessionHeader(cwd: string, id = 'session-fixture', version = 3) {
  return {
    type: 'session',
    version,
    id,
    timestamp: '2026-08-25T00:00:00.000Z',
    cwd,
  };
}

function userEntry(id: string, parentId: string | null, content: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-08-25T00:00:01.000Z',
    message: { role: 'user', content, timestamp: 1 },
  };
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

type FsOverride = 'openSync';

function withFsOverrides<T>(overrides: Partial<Record<FsOverride, unknown>>, run: () => T): T {
  const mutableFs = fs as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  for (const [name, replacement] of Object.entries(overrides)) {
    originals.set(name, mutableFs[name]);
    mutableFs[name] = replacement;
  }
  syncBuiltinESMExports();
  try {
    return run();
  } finally {
    for (const [name, original] of originals) mutableFs[name] = original;
    syncBuiltinESMExports();
  }
}

function withSessionReadCount<T>(sessionPath: string, run: () => T): { value: T; reads: number } {
  const originalOpenSync = fs.openSync;
  const expectedPath = path.resolve(sessionPath);
  let reads = 0;
  const countedOpenSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (args[1] === 'r' && path.resolve(String(args[0])) === expectedPath) reads++;
    return Reflect.apply(originalOpenSync, fs, args);
  }) as typeof fs.openSync;
  const value = withFsOverrides({ openSync: countedOpenSync }, run);
  return { value, reads };
}

test('prepared create performs no destination write until transfer authorization consumption succeeds', { concurrency: false }, async (t) => {
  const root = tempRoot(t);
  const sessionDir = path.join(root, 'sessions');
  let authorizationConsumed = false;
  const ownership = ownershipFixture(path.resolve('unbound-session.jsonl'), () => {
    assert.equal(fs.existsSync(sessionDir), false, 'destination directory is absent until authorization is consumed');
    authorizationConsumed = true;
  });
  const manager = SessionManager.preparePieCreate(root, sessionDir, { id: 'prepared-create' }, ownership.adapter);
  const sessionPath = path.join(sessionDir, 'canonical-create.jsonl');
  manager.bindPiePreparedPath(sessionPath);
  ownership.setPath(sessionPath);

  assert.equal(fs.existsSync(sessionDir), false, 'preparing a create does not make its destination directory');
  assert.equal(fs.existsSync(sessionPath), false);
  ownership.setConsumeFailure(new Error('authorization rejected'));
  await assert.rejects(manager.activatePiePrepared(ownership.authorization()), /authorization rejected/);
  assert.equal(authorizationConsumed, false);
  assert.equal(fs.existsSync(sessionDir), false);
  assert.equal(fs.existsSync(sessionPath), false);

  ownership.setConsumeFailure(undefined);
  const activatedLease = await manager.activatePiePrepared(ownership.authorization());
  assert.equal(authorizationConsumed, true);
  assert.equal(fs.existsSync(sessionDir), true, 'activation creates the destination directory after consumption');
  assert.equal(activatedLease, ownership.lease);
  assert.equal(readJsonl(sessionPath).length, 1);
  assert.equal(manager.getHeader()?.id, 'prepared-create');
  const committedBytes = fs.readFileSync(sessionPath);
  await assert.rejects(manager.activatePiePrepared(ownership.authorization()), /not an inactive prepared destination/);
  assert.equal(ownership.getConsumed(), 2, 'replay is rejected without consuming authorization again');
  assert.equal(fs.readFileSync(sessionPath).equals(committedBytes), true);
  assert.throws(() => manager.bindPiePreparedPath(path.join(sessionDir, 'late.jsonl')), /inactive prepared destination/);
});

test('prepared open is read-only, import defers destination creation, and branch writes only after activation', { concurrency: false }, async (t) => {
  const root = tempRoot(t);
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionDir);
  const sourcePath = path.join(root, 'source.jsonl');
  const sourceRows = [sessionHeader(root), userEntry('user-1', null, 'hello')];
  writeJsonl(sourcePath, sourceRows);
  const sourceBytes = fs.readFileSync(sourcePath);

  const openOwnership = ownershipFixture(sourcePath);
  const opened = SessionManager.preparePieOpen(sourcePath, sessionDir, undefined, openOwnership.adapter);
  assert.equal(fs.readFileSync(sourcePath).equals(sourceBytes), true);
  assert.equal(opened.getEntries().length, 1);
  await opened.activatePiePrepared(openOwnership.authorization());
  assert.equal(fs.readFileSync(sourcePath).equals(sourceBytes), true, 'unchanged v3 open does not rewrite');

  const importPath = path.join(sessionDir, 'imported.jsonl');
  const importOwnership = ownershipFixture(importPath);
  const imported = SessionManager.preparePieImport(sourcePath, importPath, sessionDir, undefined, importOwnership.adapter);
  assert.equal(fs.existsSync(importPath), false);
  await imported.activatePiePrepared(importOwnership.authorization());
  assert.deepEqual(readJsonl(importPath), sourceRows);

  const source = SessionManager.open(sourcePath, sessionDir);
  const sourceOwnership = ownershipFixture(sourcePath);
  source.attachPieWriteLease(sourceOwnership.adapter, sourceOwnership.lease);
  const branchPath = path.join(sessionDir, 'branch.jsonl');
  const branchOwnership = ownershipFixture(branchPath);
  const preparedBranch = SessionManager.preparePieBranched(source, 'user-1', branchOwnership.adapter);
  preparedBranch.bindPiePreparedPath(branchPath);
  assert.equal(fs.existsSync(branchPath), false);
  await preparedBranch.activatePiePrepared(branchOwnership.authorization());
  const branchRows = readJsonl(branchPath);
  assert.equal(branchRows[0]?.parentSession, path.resolve(sourcePath));
  assert.deepEqual(branchRows.slice(1), sourceRows.slice(1));
});

test('prepared missing, empty, and migrating opens remain read-only until activation and read each existing file once', { concurrency: false }, async (t) => {
  const root = tempRoot(t);
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionDir);

  const missingPath = path.join(root, 'missing.jsonl');
  const missingOwnership = ownershipFixture(missingPath);
  const missing = SessionManager.preparePieOpen(missingPath, sessionDir, undefined, missingOwnership.adapter);
  assert.equal(fs.existsSync(missingPath), false);
  await missing.activatePiePrepared(missingOwnership.authorization());
  assert.equal(readJsonl(missingPath)[0]?.version, 3);

  const emptyPath = path.join(root, 'empty.jsonl');
  fs.writeFileSync(emptyPath, '', 'utf8');
  const emptyBytes = fs.readFileSync(emptyPath);
  const emptyOwnership = ownershipFixture(emptyPath);
  const empty = withSessionReadCount(emptyPath, () => (
    SessionManager.preparePieOpen(emptyPath, sessionDir, undefined, emptyOwnership.adapter)
  ));
  assert.equal(empty.reads, 1, 'empty existing source is physically read once');
  assert.equal(fs.readFileSync(emptyPath).equals(emptyBytes), true, 'preparation does not initialize the empty source');
  await empty.value.activatePiePrepared(emptyOwnership.authorization());
  assert.equal(readJsonl(emptyPath)[0]?.version, 3);

  const legacyPath = path.join(root, 'legacy.jsonl');
  writeJsonl(legacyPath, [sessionHeader(root, 'legacy', 2), userEntry('legacy-user', null, 'legacy')]);
  const legacyBytes = fs.readFileSync(legacyPath);
  const legacyOwnership = ownershipFixture(legacyPath);
  const legacy = withSessionReadCount(legacyPath, () => (
    SessionManager.preparePieOpen(legacyPath, sessionDir, undefined, legacyOwnership.adapter)
  ));
  assert.equal(legacy.reads, 1, 'migrating source is physically read once');
  assert.equal(fs.readFileSync(legacyPath).equals(legacyBytes), true, 'migration remains staged in memory before activation');
  await legacy.value.activatePiePrepared(legacyOwnership.authorization());
  const migratedRows = readJsonl(legacyPath);
  assert.equal(migratedRows[0]?.version, 3);
  assert.equal(migratedRows[1]?.id, 'legacy-user');

  const invalidPath = path.join(root, 'invalid.jsonl');
  const invalidBytes = Buffer.from('not-a-session\n');
  fs.writeFileSync(invalidPath, invalidBytes);
  const invalidOwnership = ownershipFixture(invalidPath);
  const invalid = withSessionReadCount(invalidPath, () => {
    assert.throws(
      () => SessionManager.preparePieOpen(invalidPath, sessionDir, undefined, invalidOwnership.adapter),
      /Session file is not a valid pi session/,
    );
  });
  assert.equal(invalid.reads, 1);
  assert.equal(fs.readFileSync(invalidPath).equals(invalidBytes), true, 'invalid bytes are never rewritten');
});

test('prepared destination rejects wrong-path authorization and lease, collisions, and replay before publication', { concurrency: false }, async (t) => {
  const root = tempRoot(t);
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionDir);

  const wrongAuthPath = path.join(sessionDir, 'wrong-auth.jsonl');
  const wrongAuthOwnership = ownershipFixture(wrongAuthPath);
  const wrongAuthManager = SessionManager.preparePieCreate(root, sessionDir, { id: 'wrong-auth' }, wrongAuthOwnership.adapter);
  wrongAuthManager.bindPiePreparedPath(wrongAuthPath);
  const wrongAuthorization = wrongAuthOwnership.authorization();
  wrongAuthorization.canonicalDestinationPath = path.join(sessionDir, 'other.jsonl');
  await assert.rejects(wrongAuthManager.activatePiePrepared(wrongAuthorization), /wrong prepared destination/);
  assert.equal(wrongAuthOwnership.getConsumed(), 0, 'wrong-path authorization is rejected before consumption');
  assert.equal(fs.existsSync(wrongAuthPath), false);

  const wrongLeasePath = path.join(sessionDir, 'wrong-lease.jsonl');
  const wrongLeaseOwnership = ownershipFixture(wrongLeasePath);
  const wrongLeaseManager = SessionManager.preparePieCreate(root, sessionDir, { id: 'wrong-lease' }, wrongLeaseOwnership.adapter);
  wrongLeaseManager.bindPiePreparedPath(wrongLeasePath);
  wrongLeaseOwnership.setReturnedLease({
    ...wrongLeaseOwnership.lease,
    canonicalSessionPath: path.join(sessionDir, 'other.jsonl'),
  });
  await assert.rejects(wrongLeaseManager.activatePiePrepared(wrongLeaseOwnership.authorization()), /wrong-path session write lease/);
  assert.equal(fs.existsSync(wrongLeasePath), false, 'invalid consumed lease cannot publish a header');

  const collisionPath = path.join(sessionDir, 'collision.jsonl');
  const collisionBytes = Buffer.from('{"type":"session","id":"preexisting"}\n');
  const collisionOwnership = ownershipFixture(collisionPath);
  const collisionManager = SessionManager.preparePieCreate(root, sessionDir, { id: 'collision' }, collisionOwnership.adapter);
  collisionManager.bindPiePreparedPath(collisionPath);
  fs.writeFileSync(collisionPath, collisionBytes, { flag: 'wx' });
  await assert.rejects(collisionManager.activatePiePrepared(collisionOwnership.authorization()), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
  assert.equal(fs.readFileSync(collisionPath).equals(collisionBytes), true, 'exclusive collision preserves the pre-existing destination');
  assert.deepEqual(fs.readdirSync(sessionDir), ['collision.jsonl']);
});

test('stale guards precede leaf and entry mutations, and nested mutation callbacks cover appends', { concurrency: false }, (t) => {
  const root = tempRoot(t);
  const manager = SessionManager.create(root, root, { id: 'stale-guard' });
  const firstId = manager.appendMessage({ role: 'user', content: 'first', timestamp: 1 });
  manager.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 2,
    api: 'anthropic-messages', provider: 'fixture', model: 'fixture', stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const sessionPath = manager.getSessionFile();
  assert.ok(sessionPath);

  const ownership = ownershipFixture(sessionPath);
  manager.attachPieWriteLease(ownership.adapter, ownership.lease);
  manager.appendMessage({ role: 'user', content: 'active append', timestamp: 3 });
  const summaryId = manager.branchWithSummary(firstId, 'active branch summary');
  assert.equal(manager.getLeafId(), summaryId);
  assert.ok(ownership.getMaximumDepth() >= 2, 'state and persistence callbacks run nested under the adapter');

  const beforeEntries = manager.getEntries();
  const beforeLeaf = manager.getLeafId();
  const beforeSessionId = manager.getSessionId();
  const beforePath = manager.getSessionFile();
  const beforeBytes = fs.readFileSync(sessionPath);
  const assertUnchanged = (seam: string): void => {
    assert.deepEqual(manager.getEntries(), beforeEntries, `${seam} must not mutate entries`);
    assert.equal(manager.getLeafId(), beforeLeaf, `${seam} must not advance the leaf`);
    assert.equal(manager.getSessionId(), beforeSessionId, `${seam} must not change session identity`);
    assert.equal(manager.getSessionFile(), beforePath, `${seam} must not change the path`);
    assert.equal(fs.readFileSync(sessionPath).equals(beforeBytes), true, `${seam} must not persist bytes`);
  };
  ownership.setValid(false);
  const staleEntry = beforeEntries[0]!;
  const internal = manager as unknown as { _rewriteFile(): void };
  const staleSeams: Array<{ name: string; run: () => unknown; expected: RegExp }> = [
    { name: 'appendMessage', run: () => manager.appendMessage({ role: 'user', content: 'stale', timestamp: 4 }), expected: /stale lease/ },
    { name: 'appendModelChange', run: () => manager.appendModelChange('provider', 'model'), expected: /stale lease/ },
    { name: 'appendThinkingLevelChange', run: () => manager.appendThinkingLevelChange('high'), expected: /stale lease/ },
    { name: 'appendCustomEntry', run: () => manager.appendCustomEntry('fixture', { value: 'stale' }), expected: /stale lease/ },
    { name: 'appendCustomMessageEntry', run: () => manager.appendCustomMessageEntry('fixture', 'stale', false), expected: /stale lease/ },
    { name: 'appendSessionInfo', run: () => manager.appendSessionInfo('stale name'), expected: /stale lease/ },
    { name: '_persist', run: () => manager._persist(staleEntry), expected: /stale lease/ },
    { name: '_rewriteFile', run: () => internal._rewriteFile(), expected: /stale lease/ },
    { name: 'setSessionFile', run: () => manager.setSessionFile(path.join(root, 'replacement.jsonl')), expected: /cannot change paths/ },
    { name: 'newSession', run: () => manager.newSession({ id: 'stale-new-session' }), expected: /cannot allocate a new path/ },
    { name: 'branch', run: () => manager.branch(firstId), expected: /stale lease/ },
    { name: 'resetLeaf', run: () => manager.resetLeaf(), expected: /stale lease/ },
    { name: 'branchWithSummary', run: () => manager.branchWithSummary(firstId, 'stale summary'), expected: /stale lease/ },
    { name: 'createBranchedSession', run: () => manager.createBranchedSession(firstId), expected: /preparePieBranched/ },
  ];
  for (const seam of staleSeams) {
    assert.throws(seam.run, seam.expected, `${seam.name} rejects a stale lease`);
    assertUnchanged(seam.name);
  }
  ownership.setValid(true);
  manager.revokePieWriteLease();
  assert.throws(() => manager.appendMessage({ role: 'user', content: 'revoked', timestamp: 5 }), /Stale session write lease/);
  assertUnchanged('revoked append');
});
