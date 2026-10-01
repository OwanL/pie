import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { atomicWriteText, renameWithTransientRetry } from '../temporary-files/atomic-write';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-atomic-write-test-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('atomicWriteText preserves existing POSIX file permissions', { skip: process.platform === 'win32' }, async () => {
  await withTempDir(async (directory) => {
    for (const [mode, umask] of [[0o600, 0o022], [0o750, 0o077]] as const) {
      const target = path.join(directory, `target-${mode.toString(8)}.txt`);
      await fs.writeFile(target, 'before');
      await fs.chmod(target, mode);

      const previousUmask = process.umask(umask);
      try {
        await atomicWriteText(target, 'after');
      } finally {
        process.umask(previousUmask);
      }

      assert.equal((await fs.stat(target)).mode & 0o7777, mode);
      assert.equal(await fs.readFile(target, 'utf8'), 'after');
    }
  });
});

test('atomicWriteText keeps the default writeFile permission policy for new files', async () => {
  await withTempDir(async (directory) => {
    const target = path.join(directory, 'target.txt');
    const control = path.join(directory, 'control.txt');
    await fs.writeFile(control, 'control');

    await atomicWriteText(target, 'created');

    assert.equal((await fs.stat(target)).mode & 0o7777, (await fs.stat(control)).mode & 0o7777);
    assert.equal(await fs.readFile(target, 'utf8'), 'created');
  });
});

test('atomicWriteText carries existing permission bits through write and chmod before rename', async (t) => {
  const existingMode = 0o2750;
  const events: string[] = [];
  let tempPath = '';
  t.mock.method(fs, 'stat', async (targetPath) => {
    assert.equal(targetPath, 'target.txt');
    return { mode: 0o100000 | existingMode } as Awaited<ReturnType<typeof fs.stat>>;
  });
  t.mock.method(fs, 'writeFile', async (filePath, _data, options) => {
    tempPath = String(filePath);
    assert.deepEqual(options, { encoding: 'utf8', mode: existingMode });
    events.push('write');
  });
  t.mock.method(fs, 'chmod', async (filePath, mode) => {
    assert.equal(filePath, tempPath);
    assert.equal(mode, existingMode);
    events.push('chmod');
  });
  t.mock.method(fs, 'rename', async (source, destination) => {
    assert.equal(source, tempPath);
    assert.equal(destination, 'target.txt');
    events.push('rename');
  });
  t.mock.method(fs, 'unlink', async () => undefined);

  await atomicWriteText('target.txt', 'content');

  assert.deepEqual(events, ['write', 'chmod', 'rename']);
});

test('atomicWriteText propagates non-ENOENT stat failures without replacing the target', async (t) => {
  const failure = errno('EACCES');
  let writes = 0;
  let renames = 0;
  t.mock.method(fs, 'stat', async () => { throw failure; });
  t.mock.method(fs, 'writeFile', async () => { writes += 1; });
  t.mock.method(fs, 'rename', async () => { renames += 1; });
  t.mock.method(fs, 'unlink', async () => undefined);

  await assert.rejects(atomicWriteText('target.txt', 'replacement'), failure);
  assert.equal(writes, 0);
  assert.equal(renames, 0);
});

test('atomicWriteText cleans up the temp file when chmod fails and leaves the target intact', async (t) => {
  await withTempDir(async (directory) => {
    const target = path.join(directory, 'target.txt');
    await fs.writeFile(target, 'original');
    t.mock.method(fs, 'chmod', async () => { throw errno('EACCES'); });

    await assert.rejects(atomicWriteText(target, 'replacement'), { code: 'EACCES' });

    assert.equal(await fs.readFile(target, 'utf8'), 'original');
    assert.deepEqual(await fs.readdir(directory), ['target.txt']);
  });
});

test('renameWithTransientRetry retries transient Windows sharing violations', async () => {
  const attempts: number[] = [];
  const delays: number[] = [];

  await renameWithTransientRetry('source.tmp', 'target.json', {
    retryDelaysMs: [10, 25, 50],
    rename: async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length === 1) throw errno('EPERM');
      if (attempts.length === 2) throw errno('EBUSY');
    },
    delay: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.equal(attempts.length, 3);
  assert.deepEqual(delays, [10, 25]);
});

test('renameWithTransientRetry does not retry permanent failures', async () => {
  let attempts = 0;
  await assert.rejects(
    renameWithTransientRetry('source.tmp', 'target.json', {
      retryDelaysMs: [1, 1],
      rename: async () => {
        attempts += 1;
        throw errno('ENOENT');
      },
      delay: async () => undefined,
    }),
    { code: 'ENOENT' },
  );
  assert.equal(attempts, 1);
});

test('renameWithTransientRetry surfaces a persistent sharing violation after bounded retries', async () => {
  let attempts = 0;
  await assert.rejects(
    renameWithTransientRetry('source.tmp', 'target.json', {
      retryDelaysMs: [1, 2],
      rename: async () => {
        attempts += 1;
        throw errno('EACCES');
      },
      delay: async () => undefined,
    }),
    { code: 'EACCES' },
  );
  assert.equal(attempts, 3);
});

test('renameWithTransientRetry gives Windows readers the full default contention window', async () => {
  let attempts = 0;
  const delays: number[] = [];
  await assert.rejects(
    renameWithTransientRetry('source.tmp', 'target.json', {
      rename: async () => {
        attempts += 1;
        throw errno('EPERM');
      },
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    }),
    { code: 'EPERM' },
  );
  assert.equal(attempts, 10);
  assert.deepEqual(delays, [10, 25, 50, 100, 250, 500, 1000, 2000, 4000]);
});
