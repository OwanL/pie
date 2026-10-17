import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = fileURLToPath(new URL('../../vscode/runtime/windows-runtime-lock.cjs', import.meta.url));
const { acquireWindowsRuntimeLock: acquire } = require(helper);
const windows = { skip: process.platform !== 'win32', timeout: 60000 };

// Fork this exact fixture in a private IPC mode; cleanup uses only the owned ChildProcess handle.
if (process.env.PIE_LOCK_TEST_CHILD === '1') {
  process.on('message', async ({ root, timeoutMs }) => {
    try {
      const release = await acquire(root, { timeoutMs, retryMs: 20 });
      process.send({ acquired: true });
      process.once('message', async () => {
        await release();
        process.disconnect();
      });
    } catch (error) {
      process.send({ error: error.code || error.message });
      process.disconnect();
    }
  });
} else {
  async function fixture(t) {
    const base = await mkdtemp(join(tmpdir(), 'pie-runtime-lock-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = join(base, 'Root');
    await mkdir(root);
    return { base, root };
  }

  function contender(t, root, timeoutMs = 10000) {
    const child = fork(fileURLToPath(import.meta.url), [], {
      env: { ...process.env, PIE_LOCK_TEST_CHILD: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    });
    const message = new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Contender exited ${code}: ${stderr}`)));
    });
    child.send({ root, timeoutMs });
    return { child, message, exited };
  }

  test('unsupported platform and path forms fail closed without creating roots', async () => {
    await assert.rejects(acquire('relative-path'));
    await assert.rejects(acquire('\\\\server\\share\\root'));
    if (process.platform !== 'win32') await assert.rejects(acquire('/tmp'), /requires Windows/);
    await assert.rejects(acquire('C:\\missing', { retryMs: 0 }), TypeError);
  });

  test('same-process contention, bounded timeout, awaited idempotent release', windows, async t => {
    const { root } = await fixture(t);
    const release = await acquire(root);
    t.after(release);
    const start = performance.now();
    await assert.rejects(acquire(root, { timeoutMs: 120, retryMs: 25 }), { code: 'ETIMEDOUT' });
    assert.ok(performance.now() - start >= 120);
    const first = release();
    assert.equal(release(), first);
    await first;
    await (await acquire(root))();
  });

  test('missing roots are not created; accidental pipe clients are destroyed', windows, async t => {
    const { base, root } = await fixture(t);
    const missing = join(base, 'missing');
    await assert.rejects(acquire(missing), { code: 'ENOENT' });
    await assert.rejects(stat(missing), { code: 'ENOENT' });
    const release = await acquire(root);
    t.after(release);
    const identity = await stat(root, { bigint: true });
    const hash = createHash('sha256').update(`pie-windows-runtime-lock-v1\0${identity.dev}\0${identity.ino}`).digest('hex');
    const socket = connect(`\\\\.\\pipe\\pie-windows-runtime-lock-v1-${hash}`);
    t.after(() => socket.destroy());
    await once(socket, 'close');
    await assert.rejects(acquire(root, { timeoutMs: 10 }), { code: 'ETIMEDOUT' });
  });

  test('independent contender waits until release', windows, async t => {
    const { root } = await fixture(t);
    const release = await acquire(root);
    t.after(release);
    const other = contender(t, root);
    // Timeout contender independently demonstrates real cross-process exclusion.
    const timed = contender(t, root, 100);
    assert.deepEqual(await timed.message, { error: 'ETIMEDOUT' });
    await release();
    assert.deepEqual(await other.message, { acquired: true });
    other.child.send({ release: true });
    await other.exited;
  });

  test('owner crash releases kernel ownership without deleting state', windows, async t => {
    const { root } = await fixture(t);
    const owner = contender(t, root);
    assert.deepEqual(await owner.message, { acquired: true });
    owner.child.kill();
    await owner.exited;
    await (await acquire(root, { timeoutMs: 2000 }))();
  });

  test('case and junction aliases contend; distinct roots do not', windows, async t => {
    const { base, root } = await fixture(t);
    const alias = join(base, 'junction');
    const distinct = join(base, 'distinct');
    await symlink(root, alias, 'junction');
    await mkdir(distinct);
    const release = await acquire(root);
    t.after(release);
    for (const path of [root.toUpperCase(), alias]) {
      await assert.rejects(acquire(path, { timeoutMs: 30 }), { code: 'ETIMEDOUT' });
    }
    await (await acquire(distinct, { timeoutMs: 0 }))();
  });
}
