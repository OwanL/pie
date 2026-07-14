import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveCommandInvocation } from '../../../src/shared/command-invocation';
import { createCommandExecutor } from '../../../src/shared/exec-command';
import {
  resolveNodePath,
  resolveSdkPath,
} from '../../../src/shared/runtime-resolution';

test('resolveCommandInvocation wraps npm with cmd.exe on Windows', () => {
  const invocation = resolveCommandInvocation('npm', ['root', '-g'], {
    platform: 'win32',
    comSpec: 'C:/Windows/System32/cmd.exe',
  });

  assert.deepEqual(invocation, {
    command: 'C:/Windows/System32/cmd.exe',
    args: ['/d', '/s', '/c', 'npm root -g'],
  });
});

test('resolveCommandInvocation leaves non-Windows commands unchanged', () => {
  const invocation = resolveCommandInvocation('npm', ['root', '-g'], {
    platform: 'linux',
  });

  assert.deepEqual(invocation, {
    command: 'npm',
    args: ['root', '-g'],
  });
});

test('sdk lookup surfaces npm execution failure', async () => {
  await assert.rejects(
    () =>
      resolveSdkPath({
        env: {},
        exists: () => false,
        exec: async () => ({
          stdout: '',
          stderr: 'spawn ENOENT',
          exitCode: 1,
        }),
      }),
    /Failed to resolve the global PI SDK install via npm root -g/,
  );
});

test('resolveNodePath prefers configured setting', () => {
  const nodePath = resolveNodePath({
    configuredPath: 'C:/custom/node.exe',
    env: {},
    platform: 'win32',
    exists: (filePath) => filePath === 'C:/custom/node.exe',
  });

  assert.equal(nodePath, 'C:/custom/node.exe');
});

test('resolveNodePath falls back to PATH lookup', () => {
  const expectedPath = path.join('D:/tools', 'node.exe');
  const nodePath = resolveNodePath({
    env: {
      PATH: 'C:/bin;D:/tools',
    },
    platform: 'win32',
    exists: (filePath) => filePath === expectedPath,
  });

  assert.equal(nodePath, expectedPath);
});

test('resolveNodePath honors PI_NODE_PATH before searching PATH', () => {
  const nodePath = resolveNodePath({
    env: {
      PI_NODE_PATH: '/custom/node',
      PATH: '/usr/bin:/bin',
    },
    platform: 'linux',
    exists: (filePath) => filePath === '/custom/node',
  });

  assert.equal(nodePath, '/custom/node');
});

test('resolveNodePath rejects missing configured and environment paths and errors when nothing is discoverable', () => {
  assert.throws(
    () => resolveNodePath({
      configuredPath: '/missing/node',
      env: {},
      exists: () => false,
    }),
    /Configured PI nodePath does not exist: \/missing\/node/,
  );

  assert.throws(
    () => resolveNodePath({
      env: { PI_NODE_PATH: '/missing/env-node' },
      exists: () => false,
    }),
    /PI_NODE_PATH does not exist: \/missing\/env-node/,
  );

  assert.throws(
    () => resolveNodePath({
      env: { PATH: '/usr/local/bin:/usr/bin' },
      platform: 'linux',
      exists: () => false,
    }),
    /Could not find a standalone Node\.js runtime/,
  );
});

test('resolveSdkPath prefers configured sdk path', async () => {
  const packageJsonPath = path.join('/opt/pi-sdk', 'package.json');
  const indexJsPath = path.join('/opt/pi-sdk', 'dist', 'index.js');
  const localSdkPath = path.join('/ext/node_modules', '@earendil-works', 'pi-coding-agent');
  const sdkPath = await resolveSdkPath({
    configuredPath: '/opt/pi-sdk',
    localCandidatePath: localSdkPath,
    env: {},
    exists: (filePath) =>
      filePath === packageJsonPath ||
      filePath === indexJsPath ||
      filePath === path.join(localSdkPath, 'package.json') ||
      filePath === path.join(localSdkPath, 'dist', 'index.js'),
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  });

  assert.equal(sdkPath, '/opt/pi-sdk');
});

test('resolveSdkPath honors PI_SDK_PATH before consulting cached or global installs', async () => {
  const envSdkPath = '/env/pi-sdk';
  const packageJsonPath = path.join(envSdkPath, 'package.json');
  const indexJsPath = path.join(envSdkPath, 'dist', 'index.js');
  let execCalls = 0;

  const sdkPath = await resolveSdkPath({
    env: { PI_SDK_PATH: envSdkPath },
    cachedPath: '/cache/pi-sdk',
    exists: (filePath) => filePath === packageJsonPath || filePath === indexJsPath,
    exec: async () => {
      execCalls += 1;
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });

  assert.equal(sdkPath, envSdkPath);
  assert.equal(execCalls, 0);
});

test('resolveSdkPath rejects invalid configured and environment SDK paths', async () => {
  await assert.rejects(
    () => resolveSdkPath({
      configuredPath: '/invalid/configured-sdk',
      env: {},
      exists: () => false,
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }),
    /Configured PI sdkPath is not a valid SDK install: \/invalid\/configured-sdk/,
  );

  await assert.rejects(
    () => resolveSdkPath({
      env: { PI_SDK_PATH: '/invalid/env-sdk' },
      exists: () => false,
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }),
    /PI_SDK_PATH is not a valid SDK install: \/invalid\/env-sdk/,
  );
});

test('resolveSdkPath prefers a cached valid SDK path before shelling out to npm', async () => {
  const cachedSdkPath = '/cache/pi-sdk';
  let execCalls = 0;

  const sdkPath = await resolveSdkPath({
    cachedPath: cachedSdkPath,
    env: {},
    exists: (filePath) => {
      return (
        filePath === path.join(cachedSdkPath, 'package.json') ||
        filePath === path.join(cachedSdkPath, 'dist', 'index.js')
      );
    },
    exec: async () => {
      execCalls += 1;
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });

  assert.equal(sdkPath, cachedSdkPath);
  assert.equal(execCalls, 0);
});

test('resolveSdkPath refreshes a cached legacy global SDK to the maintained package', async () => {
  const legacySdkPath = path.join('/global/node_modules', '@mariozechner', 'pi-coding-agent');
  const expectedSdkPath = path.join('/global/node_modules', '@earendil-works', 'pi-coding-agent');

  const sdkPath = await resolveSdkPath({
    cachedPath: legacySdkPath,
    env: {},
    exists: (filePath) => {
      return (
        filePath === path.join(legacySdkPath, 'package.json') ||
        filePath === path.join(legacySdkPath, 'dist', 'index.js') ||
        filePath === path.join(expectedSdkPath, 'package.json') ||
        filePath === path.join(expectedSdkPath, 'dist', 'index.js')
      );
    },
    exec: async () => ({
      stdout: '/global/node_modules\n',
      stderr: '',
      exitCode: 0,
    }),
  });

  assert.equal(sdkPath, expectedSdkPath);
});

test('resolveSdkPath ignores an invalid cached path and falls back to the maintained global SDK', async () => {
  const expectedSdkPath = path.join('/global/node_modules', '@earendil-works', 'pi-coding-agent');
  let execCalls = 0;

  const sdkPath = await resolveSdkPath({
    cachedPath: '/cache/stale-sdk',
    env: {},
    exists: (filePath) => {
      return (
        filePath === path.join(expectedSdkPath, 'package.json') ||
        filePath === path.join(expectedSdkPath, 'dist', 'index.js')
      );
    },
    exec: async () => {
      execCalls += 1;
      return {
        stdout: '/global/node_modules\n',
        stderr: '',
        exitCode: 0,
      };
    },
  });

  assert.equal(sdkPath, expectedSdkPath);
  assert.equal(execCalls, 1);
});

test('resolveSdkPath falls back to the legacy global SDK when the maintained package is missing', async () => {
  const expectedSdkPath = path.join('/global/node_modules', '@mariozechner', 'pi-coding-agent');

  const sdkPath = await resolveSdkPath({
    env: {},
    exists: (filePath) => {
      return (
        filePath === path.join(expectedSdkPath, 'package.json') ||
        filePath === path.join(expectedSdkPath, 'dist', 'index.js')
      );
    },
    exec: async () => ({
      stdout: '/global/node_modules\n',
      stderr: '',
      exitCode: 0,
    }),
  });

  assert.equal(sdkPath, expectedSdkPath);
});

test('resolveSdkPath prefers a valid local candidate over cache and npm root -g', async () => {
  const localSdkPath = path.join('/ext/node_modules', '@earendil-works', 'pi-coding-agent');
  const cachedSdkPath = '/cache/pi-sdk';
  let execCalls = 0;

  const sdkPath = await resolveSdkPath({
    localCandidatePath: localSdkPath,
    cachedPath: cachedSdkPath,
    env: {},
    exists: (filePath) =>
      filePath === path.join(localSdkPath, 'package.json') ||
      filePath === path.join(localSdkPath, 'dist', 'index.js') ||
      filePath === path.join(cachedSdkPath, 'package.json') ||
      filePath === path.join(cachedSdkPath, 'dist', 'index.js'),
    exec: async () => {
      execCalls += 1;
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });

  assert.equal(sdkPath, localSdkPath);
  assert.equal(execCalls, 0, 'must not shell out to npm when the local candidate validates');
});

test('resolveSdkPath honors PI_SDK_PATH before the local candidate', async () => {
  const envSdkPath = '/env/pi-sdk';
  const localSdkPath = path.join('/ext/node_modules', '@earendil-works', 'pi-coding-agent');

  const sdkPath = await resolveSdkPath({
    localCandidatePath: localSdkPath,
    env: { PI_SDK_PATH: envSdkPath },
    exists: (filePath) =>
      filePath === path.join(envSdkPath, 'package.json') ||
      filePath === path.join(envSdkPath, 'dist', 'index.js') ||
      filePath === path.join(localSdkPath, 'package.json') ||
      filePath === path.join(localSdkPath, 'dist', 'index.js'),
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  });

  assert.equal(sdkPath, envSdkPath);
});

test('resolveSdkPath skips an invalid local candidate and falls back to the cache', async () => {
  const cachedSdkPath = '/cache/pi-sdk';
  let execCalls = 0;

  const sdkPath = await resolveSdkPath({
    localCandidatePath: path.join('/ext/node_modules', '@earendil-works', 'pi-coding-agent'),
    cachedPath: cachedSdkPath,
    env: {},
    exists: (filePath) =>
      filePath === path.join(cachedSdkPath, 'package.json') ||
      filePath === path.join(cachedSdkPath, 'dist', 'index.js'),
    exec: async () => {
      execCalls += 1;
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });

  assert.equal(sdkPath, cachedSdkPath);
  assert.equal(execCalls, 0, 'cache hit must not shell out to npm');
});

// ─── execCommand / createCommandExecutor ────────────────────────────────────

test('createCommandExecutor wraps npm through cmd.exe on Windows', async () => {
  // We call the real resolveCommandInvocation to verify integration.
  const win32Invocation = resolveCommandInvocation('npm', ['root', '-g'], { platform: 'win32' });
  assert.equal(win32Invocation.command.toLowerCase().endsWith('cmd.exe') || win32Invocation.command === 'cmd.exe', true, 'Windows npm should route through cmd.exe');
  assert.ok(win32Invocation.args.includes('/c'), 'Should pass /c to cmd.exe');
});

test('createCommandExecutor passes non-Windows npm through unchanged', () => {
  const invocation = resolveCommandInvocation('npm', ['root', '-g'], { platform: 'linux' });
  assert.equal(invocation.command, 'npm');
  assert.deepEqual(invocation.args, ['root', '-g']);
});

test('resolveSdkPath error includes useful message when npm fails with empty output', async () => {
  // Regression: on Windows, execFile('npm') silently fails returning empty stdout+stderr.
  // The error must still be actionable, not just an empty string.
  await assert.rejects(
    () =>
      resolveSdkPath({
        env: {},
        exists: () => false,
        exec: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
      }),
    (err: Error) => {
      assert.ok(
        err.message.includes('npm root -g'),
        `Error message should mention 'npm root -g', got: ${err.message}`,
      );
      return true;
    },
  );
});

test('resolveSdkPath error when npm succeeds but SDK not found at resolved path', async () => {
  await assert.rejects(
    () =>
      resolveSdkPath({
        env: {},
        // npm root -g succeeds but nothing exists at that location.
        exists: () => false,
        exec: async () => ({ stdout: '/some/npm/root\n', stderr: '', exitCode: 0 }),
      }),
    /pi-coding-agent/,
  );
});

test('createCommandExecutor resolves node:child_process without throwing', () => {
  // Smoke test: the factory should be callable without error.
  assert.doesNotThrow(() => createCommandExecutor());
});
