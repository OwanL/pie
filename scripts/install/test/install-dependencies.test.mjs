import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { acquireDevelopmentReader } from '../../../lib/development-runtime/lifetime.mjs';
import { buildRootInstallStep, runRootInstall } from '../install-dependencies.mjs';
import { repoRoot } from '../toolchain.mjs';

const expectedArgs = ['run', 'pnpm', '--', 'install', '--frozen-lockfile', '--ignore-scripts'];

async function withFixtureRepo(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'pie-root-install-'));
  await mkdir(path.join(root, 'harness', 'pi'), { recursive: true });
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('root setup is one Proto-selected frozen pnpm install with lifecycle scripts disabled', () => {
  assert.deepEqual(buildRootInstallStep(repoRoot), {
    command: 'proto',
    args: expectedArgs,
    cwd: repoRoot,
  });
});

test('root setup does not invoke per-host npm installers or Playwright browser downloads', async () => {
  await withFixtureRepo(async (root) => {
    const calls = [];
    const result = await runRootInstall({
      root,
      spawn(command, args, options) {
        calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
        return { status: 0 };
      },
      stdio: 'ignore',
    });

    assert.deepEqual(calls, [{ command: 'proto', args: expectedArgs, cwd: root, stdio: 'ignore' }]);
    assert.equal(result.cwd, root);
  });
});

test('an active development reader blocks pnpm until its confirmed release', async () => {
  await withFixtureRepo(async (root) => {
    const workspace = path.join(root, 'harness', 'pi');
    const reader = await acquireDevelopmentReader(workspace);
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0 };
    };

    await assert.rejects(runRootInstall({ root, spawn }), /writer denied[\s\S]*reader/u);
    assert.deepEqual(calls, [], 'a blocked writer must not start the mocked package manager');

    await reader.release({ teardownConfirmed: true });
    const result = await runRootInstall({ root, spawn });
    assert.equal(result.cwd, root);
    assert.deepEqual(calls, [{ command: 'proto', args: expectedArgs, cwd: root }],
      'confirmed reader release admits the workspace install');
  });
});

test('root setup propagates failure without retrying or invoking another package manager', async () => {
  await withFixtureRepo(async (root) => {
    let calls = 0;
    await assert.rejects(runRootInstall({
      root,
      spawn() { calls += 1; return { status: 19 }; },
    }), (error) => {
      assert.equal(error.exitCode, 19);
      assert.match(error.message, /proto run pnpm -- install --frozen-lockfile --ignore-scripts/);
      return true;
    });
    assert.equal(calls, 1);
  });
});
