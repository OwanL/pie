import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenOperationLedger } from '../open-operation-ledger.js';
import { handleBackendRequest, type BackendRequestHandlerDeps } from '../request-handler.js';
import type { SessionOpenedPayload } from '../../lib/rpc/session-events.js';
import { validateOperationStatus } from '../../lib/rpc/backend-rpc.js';

const snapshot = { session: { path: '/session' }, runtimeReady: false } as SessionOpenedPayload;

test('open shares pending work and retains committed snapshot before publication failure', async () => {
  const ledger = new OpenOperationLedger();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const options = { operationId: 'open', sessionPath: '/session', selectionToken: 'selection',
    execute: async (commit: (value: SessionOpenedPayload) => void) => {
      calls++;
      await gate;
      commit(snapshot);
      assert.equal(ledger.status('open', '/session').state, 'committed');
      throw new Error('lost event');
    } };
  const first = ledger.run(options);
  assert.equal(ledger.run(options), first);
  assert.equal(ledger.status('open', '/session').state, 'pending');
  release();
  assert.equal((await first).ok, true);
  await ledger.run(options);
  assert.equal(calls, 1);
  const status = ledger.status('open', '/session');
  assert.deepEqual(status.snapshot, snapshot);
  status.snapshot!.runtimeReady = true;
  assert.equal(ledger.status('open', '/session').snapshot!.runtimeReady, false);
  assert.throws(() => ledger.run({ ...options, selectionToken: 'other' }), /another open intent/);
  assert.throws(() => ledger.status('open', '/other'), /another session path/);
});

test('snapshot serialization failure retains committed outcome without replaying the open', async () => {
  const ledger = new OpenOperationLedger();
  const circular = { session: { path: '/session' }, runtimeReady: false } as SessionOpenedPayload & { self?: unknown };
  circular.self = circular;
  let calls = 0;
  const execute = async (commit: (value: SessionOpenedPayload) => void) => {
    calls++;
    commit(circular);
    throw new Error('publication lost after viewed-path commit');
  };

  assert.deepEqual(await ledger.run({ operationId: 'circular', sessionPath: '/session', execute }), {
    ok: true, sessionPath: '/session',
  });
  const status = ledger.status('circular', '/session');
  assert.equal(status.state, 'committed');
  assert.equal(status.snapshot, undefined);
  await ledger.run({ operationId: 'circular', sessionPath: '/session', execute });
  assert.equal(calls, 1);
});

test('payload eviction retains outcomes and permits replay without reexecution', async () => {
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  const ledger = new OpenOperationLedger({ maxBytes: bytes });
  let calls = 0;
  const execute = async (commit: (value: SessionOpenedPayload) => void) => { calls++; commit(snapshot); };
  await ledger.run({ operationId: 'one', sessionPath: '/session', execute });
  await ledger.run({ operationId: 'two', sessionPath: '/session', execute });
  assert.equal(ledger.status('one', '/session').state, 'committed');
  assert.equal(ledger.status('one', '/session').snapshot, undefined);
  await ledger.run({ operationId: 'one', sessionPath: '/session', execute });
  assert.equal(calls, 2);
  const unknown = ledger.status('absent', '/session');
  assert.equal(unknown.state, 'unknown');
  assert.equal('committed' in unknown, false);
});

test('more than 512 opens retain old identities with a tiny payload budget', async () => {
  const ledger = new OpenOperationLedger({ maxBytes: 1 });
  let calls = 0;
  const execute = async (commit: (value: SessionOpenedPayload) => void) => { calls++; commit(snapshot); };
  for (let index = 0; index < 520; index++) {
    await ledger.run({ operationId: `open-${index}`, sessionPath: '/session', execute });
  }
  assert.equal(calls, 520);
  assert.equal(ledger.status('open-0', '/session').state, 'committed');
  assert.equal(ledger.status('open-0', '/session').snapshot, undefined);
  await ledger.run({ operationId: 'open-0', sessionPath: '/session', execute });
  assert.equal(calls, 520);
});

test('failure and pending identities cannot be evicted or reexecuted', async () => {
  const ledger = new OpenOperationLedger({ maxBytes: 0 });
  let calls = 0;
  const options = { operationId: 'bad', sessionPath: '/session', execute: async () => {
    calls++; throw new Error('read rejected');
  } };
  const result = ledger.run(options);
  await assert.rejects(result, /read rejected/);
  await assert.rejects(ledger.run(options), /read rejected/);
  assert.equal(calls, 1);
  assert.equal(ledger.status('bad', '/session').state, 'failed');
});

test('coordinator handler status is read-only and generation addressed without a hot context', async () => {
  const ledger = new OpenOperationLedger();
  let builds = 0;
  let viewed = 0;
  let emitted = 0;
  const deps = {
    backendGeneration: 7,
    openOperationLedger: ledger,
    buildSessionOpenedPayload: async () => { builds++; return snapshot; },
    setViewedSessionPath: () => { viewed++; },
    emit: () => { emitted++; throw new Error('publication lost'); },
    getSessionContext: () => undefined,
    emitSessionListChanged: async () => undefined,
  } as unknown as BackendRequestHandlerDeps;
  const open = { id: 'request', method: 'session.open', params: { sessionPath: '/session', operationId: 'open' } };
  await handleBackendRequest(deps, open);
  const lookup = { id: 'status', method: 'operation.status', params: {
    sessionPath: '/session', operationId: 'open', operationKind: 'session.open', backendGeneration: 7,
  } };
  const result = await handleBackendRequest(deps, lookup) as { state: string; snapshot: SessionOpenedPayload };
  assert.equal(result.state, 'committed');
  assert.deepEqual(result.snapshot, snapshot);
  await handleBackendRequest(deps, open);
  assert.deepEqual([builds, viewed, emitted], [1, 1, 1]);
  await assert.rejects(handleBackendRequest(deps, { ...lookup, params: { ...lookup.params, backendGeneration: 6 } }), /generation/);
  const unknown = await handleBackendRequest(deps, { ...lookup, params: { ...lookup.params, operationId: 'absent' } }) as { state: string };
  assert.equal(unknown.state, 'unknown');
});

test('legacy opens without operationId execute normally on every request', async () => {
  let builds = 0;
  const deps = {
    buildSessionOpenedPayload: async () => { builds++; return snapshot; },
    setViewedSessionPath: () => undefined,
    emit: () => undefined,
    getSessionContext: () => undefined,
    emitSessionListChanged: async () => undefined,
  } as unknown as BackendRequestHandlerDeps;
  const request = { id: 'legacy', method: 'session.open', params: { sessionPath: '/session' } };
  await handleBackendRequest(deps, request);
  await handleBackendRequest(deps, request);
  assert.equal(builds, 2);
});

test('open status discriminator validates additively', () => {
  assert.equal(validateOperationStatus({ sessionPath: '/session', operationId: 'open' }).operationKind, undefined);
  assert.equal(validateOperationStatus({ sessionPath: '/session', operationId: 'open', operationKind: 'session.open' }).operationKind, 'session.open');
  assert.throws(() => validateOperationStatus({ sessionPath: '/session', operationId: 'open', operationKind: 'other' }));
});
