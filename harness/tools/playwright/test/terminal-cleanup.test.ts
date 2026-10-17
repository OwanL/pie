import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { RuntimeClient } from '../runtime-client.js';
import { acknowledgeTerminalCleanup } from '../sidecar-core.mjs';

test('terminal acknowledgement follows confirmed teardown and retains redacted original reason', async () => {
  const order: string[] = [];
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  let record: any;
  const done = acknowledgeTerminalCleanup({ forceKillAll: async () => { await cleanup; order.push('clean'); } },
    async (value: any) => { record = value; order.push('ack'); }, new Error('Execution context was destroyed token=private-secret'));
  assert.deepEqual(order, []);
  release(); await done;
  assert.deepEqual(order, ['clean', 'ack']);
  assert.match(record.reason, /Execution context was destroyed/);
  assert.ok(!record.reason.includes('private-secret'));
  await assert.rejects(acknowledgeTerminalCleanup({ forceKillAll: async () => { throw new Error('tree unresolved'); } },
    () => { throw new Error('must not acknowledge'); }), /tree unresolved/);
});

for (const ack of [true, false, undefined, 'true']) for (const code of [0, 1]) {
  test(`terminal cleanup ack ${String(ack)} with exit ${code}`, async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null,
      kill: () => { throw new Error('must not kill an exited PID'); },
      stdin: { write: () => true },
    });
    const client = new RuntimeClient('terminal-test', () => child, 20, 20);
    const request = client.request('hang', {});
    const rejection = assert.rejects(request, (error: any) => ack === true
      ? error.code === 'BROWSER_CRASHED' && /Execution context was destroyed/.test(error.message)
      : error.code === 'RUNTIME_CLEANUP_UNRESOLVED');
    if (ack !== undefined) child.stdout.emit('data', Buffer.from(JSON.stringify({
      v: 1, kind: 'terminal_cleanup', confirmed: ack, reason: 'Execution context was destroyed',
    }) + '\n'));
    child.exitCode = code;
    child.emit('exit', code, null);
    child.emit('close', code, null);
    await rejection;
    if (ack === true) {
      await assert.rejects(client.request('observe', {}), { code: 'RUNTIME_REOPEN_REQUIRED' });
      await client.shutdown();
    } else await assert.rejects(client.shutdown(), { code: 'RUNTIME_CLEANUP_UNRESOLVED' });
  });
}
