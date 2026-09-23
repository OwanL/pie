/**
 * Host coordinator tests: the OS-owned exclusive single-host authority shared
 * by the VS Code extension and the standalone Node entry.
 *
 * Covered contract (docs/ARCHITECTURE.md, "Single active pie host per
 * machine"):
 * - ownership contention: exactly one host acquires the fixed loopback
 *   listener; a second host is refused with the active host's identity;
 * - graceful handoff: VS Code asks a standalone host to stop, waits bounded,
 *   and acquires only after the release (the bind attempt is the evidence);
 * - handoff timeout fails closed without killing anything;
 * - release and crash (abort) both free the port for the next host;
 * - a VS Code owner rejects shutdown requests (refusal, not handoff).
 */
import * as net from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acquirePieHostOwnership,
  describePieHostRefusal,
  probePieHost,
  requestPieHostRelease,
  type PieHostOwnership,
} from '../../../src/host/coordinator/host-coordinator';

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function release(ownership: PieHostOwnership | undefined): Promise<void> {
  if (ownership) await ownership.release();
}

test('ownership contention: exactly one host acquires; the second is refused with the active identity', async () => {
  const port = await freePort();
  const first = await acquirePieHostOwnership({ kind: 'vscode', port, handoffTimeoutMs: 0 });
  assert.equal(first.status, 'acquired');
  if (first.status !== 'acquired') return;

  // Probe identifies the active host without disturbing ownership.
  const active = await probePieHost(port);
  assert.ok(active);
  assert.equal(active!.kind, 'vscode');
  assert.equal(active!.pid, process.pid);

  // A second standalone host is refused outright.
  const secondStandalone = await acquirePieHostOwnership({ kind: 'standalone', port, handoffTimeoutMs: 0 });
  assert.equal(secondStandalone.status, 'refused-host-active');
  if (secondStandalone.status === 'refused-host-active') {
    assert.equal(secondStandalone.active.kind, 'vscode');
    assert.equal(secondStandalone.active.pid, process.pid);
  }

  // A second VS Code window is refused without attempting a handoff.
  const secondVscode = await acquirePieHostOwnership({ kind: 'vscode', port, handoffTimeoutMs: 0 });
  assert.equal(secondVscode.status, 'refused-host-active');

  const message = describePieHostRefusal(secondStandalone as never, port);
  assert.match(message, /another pie host is already active/);
  assert.match(message, new RegExp(`pid ${process.pid}`));

  await release(first.status === 'acquired' ? first.ownership : undefined);
  // After release the port answers no probe.
  assert.equal(await probePieHost(port), undefined);
});

test('graceful handoff: VS Code requests standalone stop, waits bounded, acquires after release', { timeout: 15_000 }, async () => {
  const port = await freePort();
  let shutdownRequests = 0;
  const standalone = await acquirePieHostOwnership({
    kind: 'standalone',
    port,
    onHandoffRequested: () => {
      shutdownRequests += 1;
      // Simulates the standalone's graceful shutdown: the port is released
      // only after the (short, fake) drain completes.
      setTimeout(() => {
        void ownership.release();
      }, 150);
    },
  });
  assert.equal(standalone.status, 'acquired');
  if (standalone.status !== 'acquired') return;
  const ownership = standalone.ownership;

  const vscode = await acquirePieHostOwnership({
    kind: 'vscode',
    port,
    handoffTimeoutMs: 10_000,
    onHandoffStart: (active) => {
      assert.equal(active.kind, 'standalone');
      assert.equal(active.pid, process.pid);
    },
  });
  assert.equal(vscode.status, 'acquired', 'VS Code must acquire only after the standalone released');
  assert.equal(shutdownRequests, 1, 'the standalone host must receive exactly one stop request');

  // The acquired ownership now identifies the VS Code host.
  const active = await probePieHost(port);
  assert.ok(active);
  assert.equal(active!.kind, 'vscode');
  assert.equal(active!.pid, process.pid);

  await release(vscode.status === 'acquired' ? vscode.ownership : undefined);
});

test('handoff timeout fails closed without terminating the standalone host', { timeout: 15_000 }, async () => {
  const port = await freePort();
  const standalone = await acquirePieHostOwnership({ kind: 'standalone', port });
  assert.equal(standalone.status, 'acquired');

  const vscode = await acquirePieHostOwnership({
    kind: 'vscode',
    port,
    handoffTimeoutMs: 400,
    probeTimeoutMs: 200,
  });
  assert.equal(vscode.status, 'refused-handoff-timeout');
  if (vscode.status === 'refused-handoff-timeout') {
    assert.equal(vscode.active.kind, 'standalone');
    assert.equal(vscode.active.pid, process.pid);
  }
  const message = describePieHostRefusal(vscode as never, port);
  assert.match(message, /did not release/);
  assert.match(message, /terminated no process/);

  // The standalone host still owns the port and keeps serving probes.
  const stillActive = await probePieHost(port);
  assert.ok(stillActive);
  assert.equal(stillActive!.kind, 'standalone');

  await release(standalone.status === 'acquired' ? standalone.ownership : undefined);
});

test('release frees ownership for the next host', async () => {
  const port = await freePort();
  const first = await acquirePieHostOwnership({ kind: 'standalone', port });
  assert.equal(first.status, 'acquired');
  await release(first.status === 'acquired' ? first.ownership : undefined);
  const second = await acquirePieHostOwnership({ kind: 'standalone', port });
  assert.equal(second.status, 'acquired');
  await release(second.status === 'acquired' ? second.ownership : undefined);
});

test('crash (immediate abort, no graceful release) frees the port for the next host', async () => {
  const port = await freePort();
  const first = await acquirePieHostOwnership({ kind: 'vscode', port, handoffTimeoutMs: 0 });
  assert.equal(first.status, 'acquired');
  // Simulates an ungraceful host death: the OS frees the listening socket.
  if (first.status === 'acquired') first.ownership.abort();
  const second = await acquirePieHostOwnership({ kind: 'standalone', port, handoffTimeoutMs: 0 });
  assert.equal(second.status, 'acquired', 'a crashed holder must not block the next host');
  await release(second.status === 'acquired' ? second.ownership : undefined);
});

test('a VS Code owner rejects shutdown requests (only standalone may yield)', async () => {
  const port = await freePort();
  const owner = await acquirePieHostOwnership({ kind: 'vscode', port, handoffTimeoutMs: 0 });
  assert.equal(owner.status, 'acquired');
  const released = await requestPieHostRelease(port, 1_000);
  assert.equal(released, false, 'a VS Code host must not accept a shutdown request');
  const active = await probePieHost(port);
  assert.ok(active, 'the VS Code owner must keep ownership after a rejected request');
  await release(owner.status === 'acquired' ? owner.ownership : undefined);
});

test('a foreign port occupant fails acquisition closed', { timeout: 20_000 }, async () => {
  const foreignSockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    foreignSockets.add(socket);
    socket.on('close', () => foreignSockets.delete(socket));
    // A foreign listener: accepts, responds with non-pie bytes, closes.
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  try {
    const refusal = await acquirePieHostOwnership({
      kind: 'standalone',
      port,
      handoffTimeoutMs: 0,
      probeTimeoutMs: 150,
    });
    assert.equal(refusal.status, 'refused-port-unavailable');
    const message = describePieHostRefusal(refusal as never, port);
    assert.match(message, /did not answer the pie probe/);
    assert.match(message, /started nothing here/);
  } finally {
    // On Windows the close callback can wait on linger-destroyed probe
    // sockets; destroy them explicitly to bound teardown deterministically.
    server.close();
    for (const socket of [...foreignSockets]) socket.destroy();
  }
});

// ─── Adapter boundary guards ────────────────────────────────────────────────

test('adapters acquire before runtime startup and release after shutdown completes', async () => {
  const standaloneSource = await readFile(
    new URL('../../../src/standalone/index.ts', import.meta.url),
    'utf8',
  );
  const adapterSource = await readFile(
    new URL('../../../src/host/extension-host.ts', import.meta.url),
    'utf8',
  );
  const runtimeSource = await readFile(
    new URL('../../../src/host/runtime/host-runtime.ts', import.meta.url),
    'utf8',
  );

  // Standalone: acquisition happens BEFORE environment resolution/runtime
  // composition; release happens in the shutdown finally; abort on failure.
  const acquireIndex = standaloneSource.indexOf('await acquirePieHostOwnership');
  const environmentIndex = standaloneSource.indexOf('resolveStandaloneEnvironment(');
  assert.ok(acquireIndex >= 0 && environmentIndex >= 0 && acquireIndex < environmentIndex,
    'the standalone entry must acquire ownership before environment/runtime startup');
  assert.match(standaloneSource, /await ownership\.release\(\);/);
  assert.match(standaloneSource, /ownership\.abort\(\);/);
  assert.match(standaloneSource, /Active requests will stop; saved sessions will remain available\./);
  assert.match(standaloneSource, /requested pie to stop/);

  // VS Code adapter: refusal notifications, visible bounded handoff progress,
  // and release only after `runtime.shutdown()` completes.
  assert.match(adapterSource, /showWarningMessage\(`pie did not start/);
  assert.match(adapterSource, /withProgress/);
  const shutdownIndex = adapterSource.indexOf('await this.runtime.shutdown();');
  const releaseIndex = adapterSource.indexOf('await this.hostOwnership.release();');
  assert.ok(shutdownIndex >= 0 && releaseIndex > shutdownIndex,
    'the VS Code adapter must release ownership only after the runtime shutdown');
  assert.match(adapterSource, /handoffTimeoutMs: resolvePieHostHandoffTimeoutMs\(\)/);

  // The machine-wide lock is a composition-root concern, not runtime state.
  assert.ok(!runtimeSource.includes('coordinator/host-coordinator'),
    'HostRuntime must not own the machine-wide lock; composition roots do');
});