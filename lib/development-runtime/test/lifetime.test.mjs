import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireDevelopmentReader, withDevelopmentWriter } from '../lifetime.mjs';

async function withWorkspace(run) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-development-lifetime-'));
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  await fs.mkdir(workspaceRoot);
  try {
    await run(workspaceRoot);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

test('readers are admitted together and deny a writer before its operation starts', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const readers = await Promise.all([
      acquireDevelopmentReader(workspaceRoot),
      acquireDevelopmentReader(workspaceRoot),
    ]);
    let writes = 0;

    await assert.rejects(
      withDevelopmentWriter(workspaceRoot, async () => { writes += 1; }),
      (error) => {
        assert.match(error.message, /writer denied/);
        assert.match(error.message, /2 blocker\(s\)/);
        assert.match(error.message, /reader \(pid/);
        assert.match(error.message, /reader-[0-9a-f-]+\.json/);
        assert.match(error.message, /operation was not started/);
        return true;
      },
    );
    assert.equal(writes, 0);

    await Promise.all(readers.map((reader) => reader.release({ teardownConfirmed: true })));
    assert.equal(await withDevelopmentWriter(workspaceRoot, async () => 'written'), 'written');
  });
});

test('writer intent excludes readers for the full operation lifetime', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const entered = deferred();
    const finish = deferred();
    const writer = withDevelopmentWriter(workspaceRoot, async () => {
      entered.resolve();
      await finish.promise;
      return 'complete';
    });

    await entered.promise;
    await assert.rejects(acquireDevelopmentReader(workspaceRoot), /reader denied.*writer intent/s);
    finish.resolve();
    assert.equal(await writer, 'complete');

    const reader = await acquireDevelopmentReader(workspaceRoot);
    await reader.release({ teardownConfirmed: true });
  });
});

test('unconfirmed teardown retains its reader record and blocks writers even when its PID is dead', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const reader = await acquireDevelopmentReader(workspaceRoot);
    await reader.release({ teardownConfirmed: false });
    const readerDirectory = path.join(workspaceRoot, '.cache', 'development-runtime', 'readers');
    const [readerFile] = await fs.readdir(readerDirectory);
    const recordPath = path.join(readerDirectory, readerFile);
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    record.pid = 2_147_483_647;
    await fs.writeFile(recordPath, `${JSON.stringify(record)}\n`);

    await assert.rejects(withDevelopmentWriter(workspaceRoot, async () => assert.fail('writer must remain blocked')), (error) => {
      assert.match(error.message, /writer denied.*1 blocker\(s\)/s);
      assert.match(error.message, /pid 2147483647/);
      assert.match(error.message, /Records are never reclaimed by PID or age/);
      return true;
    });
    await reader.release({ teardownConfirmed: true });
    assert.equal(await withDevelopmentWriter(workspaceRoot, async () => 'released'), 'released');
  });
});

test('writer operation failure is drained before its intent is released', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const failure = new Error('development write failed');
    const entered = deferred();
    const finish = deferred();
    let settled = false;

    const writer = withDevelopmentWriter(workspaceRoot, async () => {
      entered.resolve();
      await finish.promise;
      settled = true;
      throw failure;
    });
    await entered.promise;
    await assert.rejects(acquireDevelopmentReader(workspaceRoot), /reader denied.*writer intent/s);
    assert.equal(settled, false);

    finish.resolve();
    await assert.rejects(writer, (error) => error === failure);
    assert.equal(settled, true);

    const reader = await acquireDevelopmentReader(workspaceRoot);
    await reader.release({ teardownConfirmed: true });
  });
});

test('concurrent writer claims serialize and only the owner operation runs', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const entered = deferred();
    const finish = deferred();
    let firstCalls = 0;
    let secondCalls = 0;
    const first = withDevelopmentWriter(workspaceRoot, async () => {
      firstCalls += 1;
      entered.resolve();
      await finish.promise;
    });

    await entered.promise;
    await assert.rejects(withDevelopmentWriter(workspaceRoot, async () => { secondCalls += 1; }), /writer denied.*writer intent/s);
    finish.resolve();
    await first;

    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 0);
  });
});

test('workspace path aliases share state keyed by the canonical root', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const alias = path.join(path.dirname(workspaceRoot), 'workspace-alias');
    await fs.symlink(workspaceRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');

    const reader = await acquireDevelopmentReader(workspaceRoot);
    await assert.rejects(withDevelopmentWriter(alias, async () => assert.fail('writer must be blocked')), /writer denied/);
    await reader.release({ teardownConfirmed: true });
    assert.equal(await withDevelopmentWriter(alias, async () => 'canonical'), 'canonical');
  });
});

test('state under a linked .cache path is rejected rather than followed', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const externalCache = path.join(path.dirname(workspaceRoot), 'external-cache');
    await fs.mkdir(externalCache);
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(externalCache, path.join(workspaceRoot, '.cache'), linkType);

    await assert.rejects(acquireDevelopmentReader(workspaceRoot), /refusing linked workspace \.cache path/);
    assert.deepEqual(await fs.readdir(externalCache), []);
  });
});
