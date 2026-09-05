import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  classifyFileUpdateLockContention,
  updateSettingsJsonObject,
  withFileUpdateLock,
  withFileUpdateLockSync,
} from '../../../src/shared/settings-json-update';

async function withTempSettings(run: (file: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-settings-update-'));
  try {
    await run(path.join(dir, 'settings.json'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('concurrent settings updates are serialized without losing unrelated fields', async () => {
  await withTempSettings(async (file) => {
    await fs.writeFile(file, '{"existing":{"kept":true}}\n', 'utf8');

    await Promise.all([
      updateSettingsJsonObject(file, (current) => ({ ...current, pruning: { mode: 'off' } })),
      updateSettingsJsonObject(file, (current) => ({ ...current, toolResultPruning: { enabled: false } })),
    ]);

    const raw = await fs.readFile(file, 'utf8');
    assert.ok(raw.endsWith('\n'), 'settings updates preserve the canonical terminating newline');
    const written = JSON.parse(raw);
    assert.deepEqual(written, {
      existing: { kept: true },
      pruning: { mode: 'off' },
      toolResultPruning: { enabled: false },
    });
  });
});

test('malformed settings are preserved instead of being replaced by a partial update', async () => {
  await withTempSettings(async (file) => {
    const malformed = '{"models": [}';
    await fs.writeFile(file, malformed, 'utf8');

    await assert.rejects(
      updateSettingsJsonObject(file, (current) => ({ ...current, pruning: { mode: 'off' } })),
      /Cannot update malformed JSON file/,
    );
    assert.equal(await fs.readFile(file, 'utf8'), malformed);
  });
});

test('a missing settings file is created from an empty object', async () => {
  await withTempSettings(async (file) => {
    await updateSettingsJsonObject(file, (current) => ({ ...current, pruning: { mode: 'shadow' } }));
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { pruning: { mode: 'shadow' } });
  });
});

function errorWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test('platform lock errors distinguish confirmed, unconfirmed, and unrelated failures', async () => {
  await withTempSettings(async (file) => {
    const lockPath = `${file}.pie-lock`;

    await fs.writeFile(lockPath, 'holder\n', 'utf8');
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      assert.equal(await classifyFileUpdateLockContention(errorWithCode(code), lockPath), 'confirmed', code);
    }

    await fs.unlink(lockPath);
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      assert.equal(await classifyFileUpdateLockContention(errorWithCode(code), lockPath), 'unconfirmed', code);
    }
    assert.equal(await classifyFileUpdateLockContention(errorWithCode('EEXIST'), lockPath), 'confirmed');
    assert.equal(await classifyFileUpdateLockContention(errorWithCode('ENOENT'), lockPath), 'none');
  });
});

test('an unconfirmed platform lock error gets one retry before acquisition succeeds', async (t) => {
  await withTempSettings(async (file) => {
    const realOpen = fsSync.openSync.bind(fsSync);
    let openCalls = 0;
    t.mock.method(fsSync, 'openSync', (...args: Parameters<typeof fsSync.openSync>) => {
      openCalls += 1;
      if (openCalls === 1) throw errorWithCode('EPERM');
      return realOpen(...args);
    });

    let ran = false;
    await withFileUpdateLock(file, async () => { ran = true; }, { retryMs: 1 });

    assert.equal(ran, true);
    assert.equal(openCalls, 2);
  });
});

test('a persistent unconfirmed platform lock error is propagated on the second attempt', async (t) => {
  await withTempSettings(async (file) => {
    let openCalls = 0;
    t.mock.method(fsSync, 'openSync', () => {
      openCalls += 1;
      throw errorWithCode('EPERM');
    });

    await assert.rejects(
      withFileUpdateLock(file, async () => undefined, { retryMs: 1 }),
      (error: NodeJS.ErrnoException) => error.code === 'EPERM',
    );
    assert.equal(openCalls, 2);
  });
});

test('a synchronous same-process mutation joins an async-owned lock without blocking its release', async () => {
  await withTempSettings(async (file) => {
    let releaseHolder!: () => void;
    let signalAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => { signalAcquired = resolve; });
    const release = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = withFileUpdateLock(file, async () => {
      signalAcquired();
      await release;
    });
    await acquired;

    let joined = false;
    withFileUpdateLockSync(file, () => { joined = true; }, { timeoutMs: 20 });
    assert.equal(joined, true);
    releaseHolder();
    await holder;
  });
});

for (const boundary of ['acquire', 'release'] as const) {
  test(`a synchronous contender cannot deadlock its own async lock during ${boundary}`, async (t) => {
    await withTempSettings(async (file) => {
      const lockPath = `${file}.pie-lock`;
      const failures: unknown[] = [];
      let probes = 0;
      const probe = (): void => {
        probes += 1;
        try { withFileUpdateLockSync(file, () => undefined, { timeoutMs: 10, retryMs: 1 }); }
        catch (error) { failures.push(error); }
      };
      if (boundary === 'acquire') {
        const asyncOpen = fs.open.bind(fs);
        t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
          const handle = await asyncOpen(...args);
          if (args[0] === lockPath) queueMicrotask(probe);
          return handle;
        });
        const syncOpen = fsSync.openSync.bind(fsSync);
        let scheduled = false;
        t.mock.method(fsSync, 'openSync', (...args: Parameters<typeof fsSync.openSync>) => {
          const fd = syncOpen(...args);
          if (args[0] === lockPath && !scheduled) { scheduled = true; queueMicrotask(probe); }
          return fd;
        });
      } else {
        const asyncUnlink = fs.unlink.bind(fs);
        t.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>) => {
          if (args[0] === lockPath) probe();
          return asyncUnlink(...args);
        });
        const syncUnlink = fsSync.unlinkSync.bind(fsSync);
        let scheduled = false;
        t.mock.method(fsSync, 'unlinkSync', (...args: Parameters<typeof fsSync.unlinkSync>) => {
          if (args[0] === lockPath && !scheduled) { scheduled = true; queueMicrotask(probe); }
          return syncUnlink(...args);
        });
      }
      await withFileUpdateLock(file, async () => undefined);
      assert.ok(probes > 0, 'the contender must run at the filesystem boundary');
      assert.deepEqual(failures, []);
      await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
    });
  });
}

test('an external lock holds the complete settings read-modify-write cycle', async () => {
  await withTempSettings(async (file) => {
    await fs.writeFile(file, '{"model":"before"}\n', 'utf8');
    let releaseHolder!: () => void;
    let signalAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => { signalAcquired = resolve; });
    const release = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = withFileUpdateLock(file, async () => {
      signalAcquired();
      await release;
    });
    await acquired;

    let updateFinished = false;
    const update = updateSettingsJsonObject(file, (current) => ({ ...current, pruning: { mode: 'off' } }))
      .then(() => { updateFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(updateFinished, false, 'writer must wait for the other process lock');

    releaseHolder();
    await holder;
    await update;
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {
      model: 'before',
      pruning: { mode: 'off' },
    });
    await assert.rejects(fs.access(`${file}.pie-lock`), { code: 'ENOENT' });
  });
});

test('an old lock owned by a live process is never stolen', async () => {
  await withTempSettings(async (file) => {
    let releaseHolder!: () => void;
    let signalAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => { signalAcquired = resolve; });
    const release = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = withFileUpdateLock(file, async () => {
      signalAcquired();
      await release;
    });
    await acquired;
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(`${file}.pie-lock`, old, old);

    let contenderEntered = false;
    const contender = withFileUpdateLock(file, async () => { contenderEntered = true; }, {
      retryMs: 1,
      staleMs: 0,
      timeoutMs: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(contenderEntered, false);
    releaseHolder();
    await Promise.all([holder, contender]);
    assert.equal(contenderEntered, true);
  });
});

test('stale settings locks are recovered', async () => {
  await withTempSettings(async (file) => {
    const lockPath = `${file}.pie-lock`;
    await fs.writeFile(lockPath, 'dead-owner\n', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);

    let ran = false;
    await withFileUpdateLock(file, async () => { ran = true; }, {
      retryMs: 1,
      staleMs: 10,
      timeoutMs: 1000,
    });
    assert.equal(ran, true);
    await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
  });
});

test('a lock owned by an exited process is recovered without waiting for the stale-age window', async () => {
  await withTempSettings(async (file) => {
    const exitedPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', () => resolve(child.pid!));
    });
    const lockPath = `${file}.pie-lock`;
    await fs.writeFile(lockPath, `${exitedPid}:orphaned-token\n`, 'utf8');

    let ran = false;
    await withFileUpdateLock(file, async () => { ran = true; }, {
      retryMs: 1,
      staleMs: 60_000,
      timeoutMs: 1_000,
    });

    assert.equal(ran, true);
    await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
  });
});
