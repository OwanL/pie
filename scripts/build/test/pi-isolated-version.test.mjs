import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { readPnpmVersion } from '../pi-isolated-workspace.mjs';
import { watchChildProcess } from '../../lib/process-watchdog.mjs';

function fixture(tree, code = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  let captured = false;
  child.stdin.end = () => {
    assert.equal(captured, true, 'CLI release follows ownership capture');
    child.stdout.emit('data', Buffer.from('10.34.4\n'));
    child.emit('close', code);
  };
  return {
    spawn: (executable, args, options) => {
      assert.equal(executable, process.execPath);
      assert.equal(args[0], '-e');
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
      return child;
    },
    watchChildProcess: (root, options) => {
      captured = true;
      return watchChildProcess(root, { ...options, platform: 'linux', killTree: async () => tree });
    },
  };
}

test('version helper accepts the canonical direct teardown receipt after capture/release', async () => {
  assert.equal(await readPnpmVersion('/cli.cjs', '/', {}, undefined, fixture({ gone: true, survivors: [], diagnostics: [] })), '10.34.4');
});

test('uncertain, absent and rejected teardown proof fail closed with evidence', async () => {
  for (const tree of [{ gone: false, survivors: [], diagnostics: ['census unavailable'] }, {}, undefined]) {
    await assert.rejects(readPnpmVersion('/cli.cjs', '/', {}, undefined, fixture(tree)), error => {
      assert.equal(error.teardownUnconfirmed, true);
      assert.equal(error.teardown, tree);
      return true;
    });
  }
  const dependencies = fixture();
  dependencies.watchChildProcess = () => ({ settle: async () => { throw new Error('census failed'); } });
  // The alternate watcher still releases; it needs no real process census.
  dependencies.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = () => child.emit('close', 0);
    return child;
  };
  await assert.rejects(readPnpmVersion('/cli.cjs', '/', {}, undefined, dependencies), error => {
    assert.deepEqual(error.teardown.diagnostics, ['census failed']);
    return error.teardownUnconfirmed === true;
  });
});

test('Windows live ownership stays provable until helper releases the CLI', async () => {
  const child = new EventEmitter();
  child.pid = 12345; child.exitCode = null; child.signalCode = null;
  child.stdout = new EventEmitter(); child.stdin = new EventEmitter();
  let released = false;
  let captures = 0;
  child.stdin.end = () => {
    assert.equal(captures, 2, 'global census and targeted root verification precede execution');
    released = true; child.exitCode = 0;
    child.stdout.emit('data', '10.34.4\n'); child.emit('close', 0);
  };
  const version = await readPnpmVersion('/cli.cjs', '/', {}, undefined, {
    spawn: () => child,
    watchChildProcess: (root, options) => watchChildProcess(root, {
      ...options, platform: 'win32', gracefulMs: 0, forceMs: 0,
      spawnSyncImpl: () => {
        if (!released) captures++;
        return { status: 0, stdout: released ? '' : '12345|1|20261011114225.487235+780\n' };
      },
      killImpl: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    }),
  });
  assert.equal(version, '10.34.4');
});

test('confirmed teardown does not turn a failed CLI into success', async () => {
  await assert.rejects(readPnpmVersion('/cli.cjs', '/', {}, undefined, fixture({ gone: true }, 1)), /version check failed/);
});
