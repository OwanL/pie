/**
 * Standalone owned-teardown tests.
 *
 * The standalone entry holds the machine-wide host-coordinator ownership from
 * acquisition until teardown finishes. The ownership invariant under test:
 * machine-wide ownership is NEVER released (or aborted) while the owned
 * backend process may still be alive — including when the graceful shutdown
 * times out, when the shutdown fails, and when startup fails. BackendClient
 * `stop()` resolves only after the child `exit` event (stdin close first,
 * then a 5s SIGKILL escalation), so a resolved stop is the only proof the
 * backend is dead; `dispose()` merely kicks that stop and returns
 * immediately, which is why a fixed short wait after it released ownership
 * mid-drain (regression: stop can legitimately take ~5s to escalate).
 *
 * The tests drive the real teardown helpers with real `PieHostOwnership`
 * handles (a live loopback listener on an ephemeral port) and real timers,
 * with a gated fake backend standing in for a slow/hung backend drain. The
 * coordinator port is probed to observe whether ownership is still held.
 */
import * as net from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { BackendClient } from '../../src/host/backend/client';
import { acquirePieHostOwnership, probePieHost } from '../../src/host/coordinator/host-coordinator';
import {
  confirmBackendProcessExit,
  shutdownOwnedStandaloneHost,
  teardownAfterStandaloneStartupFailure,
} from '../../src/standalone';

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GatedBackendHandle {
  backend: BackendClient;
  stopCalls(): number;
  disposeCalls(): number;
  stopStarted(): boolean;
  stopSettled(): boolean;
  releaseGate(): void;
}

/**
 * A fake backend whose stop() coalesces like BackendClient.stop() and stays
 * pending until the test releases the gate (or an auto-release timer fires).
 * While the gate is held the fake backend models a live process draining.
 */
function createGatedBackend(options: { autoReleaseAfterMs?: number } = {}): GatedBackendHandle {
  let stopCalls = 0;
  let disposeCalls = 0;
  let started = false;
  let settled = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  if (options.autoReleaseAfterMs !== undefined) {
    const timer = setTimeout(() => release(), options.autoReleaseAfterMs);
    timer.unref?.();
  }
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (!stopPromise) {
      stopCalls += 1;
      started = true;
      const operation = gate.then(() => { settled = true; });
      const tracked = operation.finally(() => {
        if (stopPromise === tracked) stopPromise = undefined;
      });
      stopPromise = tracked;
    }
    return stopPromise;
  };
  return {
    backend: { stop, dispose: () => { disposeCalls += 1; } } as unknown as BackendClient,
    stopCalls: () => stopCalls,
    disposeCalls: () => disposeCalls,
    stopStarted: () => started,
    stopSettled: () => settled,
    releaseGate: () => release(),
  };
}

/** Acquire a real standalone ownership handle on an ephemeral port. */
async function acquireTestOwnership(): Promise<{ port: number; ownership: import('../../src/host/coordinator/host-coordinator').PieHostOwnership }> {
  const port = await freePort();
  const holder = await acquirePieHostOwnership({ kind: 'standalone', port, handoffTimeoutMs: 0 });
  assert.equal(holder.status, 'acquired');
  assert.equal((holder as { ownership?: unknown }).ownership !== undefined, true);
  return { port, ownership: (holder as { ownership: import('../../src/host/coordinator/host-coordinator').PieHostOwnership }).ownership };
}

async function probeOwner(port: number): Promise<boolean> {
  const active = await probePieHost(port, 500);
  return active !== undefined;
}

test('owned standalone shutdown keeps ownership while the backend drain is pending and releases only after the stop confirms', { timeout: 20_000 }, async () => {
  const { port, ownership } = await acquireTestOwnership();
  try {
    const backend = createGatedBackend();
    let restored = false;
    // Simulate a runtime producer that never reaches backend shutdown, so
    // the graceful race times out and the final fence must take over.
    const shutdownPromise = shutdownOwnedStandaloneHost({
      runtime: { shutdown: async () => { await new Promise<never>(() => undefined); }, backend: backend.backend },
      browserServer: { stop: async () => undefined, dispose: () => undefined },
      ownership,
      restoreEnvironment: () => { restored = true; },
      shutdownTimeoutMs: 100,
    });

    // Outlast the entire previous sequence: 100ms timeout + the old 250ms
    // fixed wait. The backend gate is still held, so the process is
    // "alive"; ownership must NOT have been released.
    await sleep(500);
    assert.ok(backend.stopStarted(), 'the final fence must have kicked the backend stop');
    assert.ok(await probeOwner(port),
      'machine-wide ownership must still be held while the owned backend drain is pending');

    backend.releaseGate();
    await shutdownPromise;
    assert.ok(backend.stopSettled(), 'the backend stop must have been awaited to completion');
    assert.ok(!await probeOwner(port), 'ownership must be released after the backend stop confirmed');
    assert.ok(restored, 'environment overrides are restored with the released ownership');
    assert.ok(backend.disposeCalls() >= 1, 'the backend client is disposed after the confirmed stop');
  } finally {
    ownership.abort();
  }
});

test('owned standalone shutdown fails closed: ownership is retained when the backend exit cannot be confirmed', { timeout: 10_000 }, async () => {
  const { port, ownership } = await acquireTestOwnership();
  try {
    const backend = createGatedBackend(); // gate never released: stop never confirms
    await assert.rejects(
      shutdownOwnedStandaloneHost({
        runtime: { shutdown: async () => { await new Promise<never>(() => undefined); }, backend: backend.backend },
        browserServer: { stop: async () => undefined, dispose: () => undefined },
        ownership,
        restoreEnvironment: () => undefined,
        shutdownTimeoutMs: 50,
        backendStopConfirmTimeoutMs: 150,
      }),
      /did not confirm that the backend process exited/,
    );
    assert.ok(await probeOwner(port),
      'fail closed: ownership must be retained while the backend may still be alive');
    assert.ok(backend.disposeCalls() >= 1, 'the backend client is still disposed on the fail-closed path');
  } finally {
    ownership.abort();
  }
});

test('owned standalone graceful shutdown releases ownership only after the backend stop confirms', { timeout: 20_000 }, async () => {
  const { port, ownership } = await acquireTestOwnership();
  try {
    const backend = createGatedBackend({ autoReleaseAfterMs: 120 });
    let browserServerStopped = false;
    const shutdownPromise = shutdownOwnedStandaloneHost({
      // Mirror HostRuntime.shutdown: the ordered teardown awaits backend.stop().
      runtime: {
        shutdown: async () => { await backend.backend.stop(); },
        backend: backend.backend,
      },
      browserServer: { stop: async () => { browserServerStopped = true; }, dispose: () => undefined },
      ownership,
      restoreEnvironment: () => undefined,
      shutdownTimeoutMs: 10_000,
    });

    await sleep(30);
    assert.ok(await probeOwner(port),
      'ownership must still be held while the graceful backend drain is in flight');
    await shutdownPromise;
    assert.ok(browserServerStopped, 'the browser server stop is awaited on the graceful path');
    assert.ok(backend.stopSettled(), 'the backend stop confirmed before the shutdown resolved');
    assert.ok(!await probeOwner(port), 'ownership is released only after the confirmed backend stop');
  } finally {
    ownership.abort();
  }
});

test('startup-failure teardown aborts ownership only after the backend exit is confirmed and rethrows the original error', { timeout: 20_000 }, async () => {
  const { port, ownership } = await acquireTestOwnership();
  try {
    const backend = createGatedBackend();
    let browserServerDisposed = false;
    let restored = false;
    const startupError = new Error('standalone startup failed');
    // Runtime shutdown hangs behind the same gated backend stop, so the
    // bounded startup teardown times out and the confirmed-exit fence applies.
    const teardown = teardownAfterStandaloneStartupFailure({
      runtime: { shutdown: async () => { await backend.backend.stop(); }, backend: backend.backend },
      browserServer: { dispose: () => { browserServerDisposed = true; } },
      ownership,
      restoreEnvironment: () => { restored = true; },
      shutdownTimeoutMs: 100,
    }, startupError);

    // Outlast the previous immediate abort: while the backend drain is
    // pending, ownership must NOT have been aborted.
    await sleep(500);
    assert.ok(await probeOwner(port),
      'machine-wide ownership must still be held after a startup failure while the backend may be alive');

    backend.releaseGate();
    await assert.rejects(teardown, (error: unknown) => error === startupError,
      'the original startup error must be rethrown after the confirmed teardown');
    assert.ok(browserServerDisposed, 'the browser server is force-disposed after the shutdown timeout');
    assert.ok(backend.stopSettled(), 'the backend stop was awaited before ownership was aborted');
    assert.ok(backend.disposeCalls() >= 1);
    assert.ok(restored, 'environment overrides are restored after the teardown');
    assert.ok(!await probeOwner(port), 'ownership is aborted only after the confirmed backend exit');
  } finally {
    ownership.abort();
  }
});

test('startup-failure teardown fails closed: ownership is retained when the backend exit cannot be confirmed', { timeout: 10_000 }, async () => {
  const { port, ownership } = await acquireTestOwnership();
  try {
    const backend = createGatedBackend(); // gate never released
    const startupError = new Error('standalone startup failed');
    await assert.rejects(
      teardownAfterStandaloneStartupFailure({
        runtime: { shutdown: async () => { await backend.backend.stop(); }, backend: backend.backend },
        browserServer: { dispose: () => undefined },
        ownership,
        restoreEnvironment: () => undefined,
        shutdownTimeoutMs: 50,
        backendStopConfirmTimeoutMs: 150,
      }, startupError),
      /fail closed/,
    );
    assert.ok(await probeOwner(port),
      'fail closed: ownership must be retained while the backend may still be alive');
  } finally {
    ownership.abort();
  }
});

test('confirmBackendProcessExit is true only for a confirmed (or absent) backend and false on hang or rejection', { timeout: 10_000 }, async () => {
  // No backend ever started: stop() resolves immediately — confirmed.
  const idle = { stop: async () => undefined };
  assert.equal(await confirmBackendProcessExit(idle, 200), true);

  // Stop hangs beyond the budget: cannot confirm — fail closed.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const hung = { stop: () => gate };
  assert.equal(await confirmBackendProcessExit(hung, 100), false);
  release();

  // Stop itself rejects: cannot confirm — fail closed.
  const failing = { stop: async () => { throw new Error('stop failed'); } };
  assert.equal(await confirmBackendProcessExit(failing, 200), false);
});

test('standalone startup delegates both owned teardown paths to the confirmed-exit helpers', async () => {
  const source = await readFile(new URL('../../src/standalone/index.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('shutdownOwnedStandaloneHost('),
    'the graceful shutdown must use the confirmed-exit teardown helper');
  assert.ok(source.includes('teardownAfterStandaloneStartupFailure('),
    'the startup-failure path must use the confirmed-exit teardown helper');
  assert.ok(source.includes('Active requests will stop; saved sessions will remain available.'),
    'the visible handoff message must explain request termination and session retention');
  // The regression: a bare 250ms wait standing in for a confirmed backend stop.
  assert.ok(!source.includes('setTimeout(resolve, 250))'),
    'ownership release must not be gated on a bare 250ms wait');
});