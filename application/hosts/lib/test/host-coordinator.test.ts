import assert from 'node:assert/strict';
import * as net from 'node:net';
import { once } from 'node:events';
import test from 'node:test';

import { acquirePieHostOwnership } from '../host-coordinator';

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('concurrent ownership release callers all wait for connected peers to drain', async () => {
  const port = await unusedPort();
  const result = await acquirePieHostOwnership({ kind: 'standalone', port });
  assert.equal(result.status, 'acquired');
  if (result.status !== 'acquired') return;
  const socket = net.createConnection({ host: '127.0.0.1', port, allowHalfOpen: true });
  socket.on('error', () => undefined);
  try {
    await once(socket, 'connect');
    // A probe response confirms the listener has registered this connection.
    socket.write('{"type":"probe"}\n');
    await once(socket, 'data');
    const first = result.ownership.release();
    let secondFinished = false;
    const second = result.ownership.release().then(() => { secondFinished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondFinished, false, 'a repeated release must not bypass the pending drain');
    await Promise.all([first, second]);
    const replacement = await acquirePieHostOwnership({ kind: 'standalone', port });
    assert.equal(replacement.status, 'acquired');
    if (replacement.status === 'acquired') await replacement.ownership.release();
  } finally {
    socket.destroy();
    await result.ownership.release();
  }
});
