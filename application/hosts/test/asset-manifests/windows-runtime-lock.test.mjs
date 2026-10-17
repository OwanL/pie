import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm, symlink, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = fileURLToPath(new URL('../../vscode/runtime/windows-runtime-lock.cjs', import.meta.url));
const neutralHelper = fileURLToPath(new URL('../../../../lib/windows-runtime-lock/windows-runtime-lock.cjs', import.meta.url));
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

  // Isolated CommonJS evaluation supplies private dependencies, not a production
  // test API, and gives each fixture its own process-local qualification cache.
  async function isolatedLock(probe) {
    const servers = [];
    let realpaths = 0;
    let stats = 0;
    let inode = 2n;
    const module = { exports: {} };
    runInNewContext(await readFile(neutralHelper, 'utf8'), {
      module, Buffer,
      process: { platform: 'win32', env: {} },
      require(name) {
        if (name === 'node:fs/promises') return {
          realpath: async () => { realpaths++; return 'C:\\root'; },
          stat: async () => { stats++; return { dev: 1n, ino: inode, isDirectory: () => true }; },
        };
        if (name === 'node:child_process') return { execFile: (...args) => {
          probe().then(stdout => args.at(-1)(null, { stdout }), error => args.at(-1)(error));
        } };
        // The real util.promisify special-cases execFile's callback shape; this
        // fake already supplies the result object.
        if (name === 'node:net') return { createServer() {
          const server = new EventEmitter();
          server.listen = (_options, callback) => { server.listening = true; callback(); };
          server.close = callback => {
            server.listening = false;
            server.emit('close');
            callback();
          };
          servers.push(server);
          return server;
        } };
        return require(name);
      },
    });
    return { acquire: module.exports.acquireWindowsRuntimeLock, servers,
      counts: () => ({ realpaths, stats }), changeInode: () => { inode++; } };
  }

  test('qualification shares inflight/success per device and refreshes directory checks', async () => {
    let probes = 0;
    let finish;
    const lock = await isolatedLock(() => { probes++; return new Promise(resolve => { finish = resolve; }); });
    const a = lock.acquire('C:\\root');
    const b = lock.acquire('C:\\alias');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(probes, 1);
    finish('local-fixed-ntfs');
    await (await a)();
    await (await b)();
    lock.changeInode();
    await (await lock.acquire('C:\\other'))();
    assert.equal(probes, 1);
    assert.deepEqual(lock.counts(), { realpaths: 6, stats: 6 });
  });

  test('failed qualification is evicted for retry', async () => {
    let probes = 0;
    const lock = await isolatedLock(async () => {
      if (++probes === 1) throw new Error('probe failed');
      return 'local-fixed-ntfs';
    });
    await assert.rejects(lock.acquire('C:\\root'), /probe failed/);
    await (await lock.acquire('C:\\root'))();
    assert.equal(probes, 2);
  });

  test('owned listener errors retain ownership and first failure until awaited release', async () => {
    const lock = await isolatedLock(async () => 'local-fixed-ntfs');
    const release = await lock.acquire('C:\\root');
    const server = lock.servers[0];
    const first = new Error('first listener failure');
    server.emit('error', first);
    server.emit('error', new Error('later failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(server.listening, true);
    const released = release();
    assert.equal(release(), released);
    await assert.rejects(released, error => error === first);
    assert.equal(server.listening, false);
  });

  test('unexpected private listener close is reported by release', async () => {
    const lock = await isolatedLock(async () => 'local-fixed-ntfs');
    const release = await lock.acquire('C:\\root');
    lock.servers[0].emit('close');
    await assert.rejects(release(), /closed unexpectedly/);
  });

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
