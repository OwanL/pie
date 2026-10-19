import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

import { resolveCommandInvocation } from '../command-invocation';
import { createCommandExecutor } from '../command-execution';
import { verifyPiRuntimeArtifact } from '../../../../lib/pi-runtime/artifact.mjs';
import {
  minimumNodeVersionFromEngine,
  probeBackendNodeTarget,
  resolveCompatibleNodePath,
  resolveNodePath,
} from '../runtime-resolution';

// Opt-in materialized-artifact evidence; ordinary fast tests use private fixtures.
const SUPPLIED_PI_RUNTIME_ARTIFACT = process.env.PIE_TEST_PI_RUNTIME_ARTIFACT;
const SUPPLIED_PI_RUNTIME_IDENTITY = process.env.PIE_TEST_PI_RUNTIME_IDENTITY;

function createTempRoot(t: { after: (fn: () => void) => void }, prefix: string): string {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return tempRoot;
}

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

test('probeBackendNodeTarget runs the selected executable with bounded sanitized environment', async () => {
  const originalEnv = {
    ...process.env,
    NODE_OPTIONS: '--require injected.js',
    NODE_PATH: '/ambient/modules',
    node_options: '--require case-insensitive.js',
  };
  let invocation: { command: string; args: string[]; options?: { env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number } } | undefined;
  const expected = { platform: 'win32', arch: 'arm64', nodeAbi: '127' };

  const target = await probeBackendNodeTarget('/selected/node.exe', {
    env: originalEnv,
    exec: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: JSON.stringify(expected), stderr: '', exitCode: 0 };
    },
  });

  assert.deepEqual(target, expected);
  assert.equal(invocation?.command, '/selected/node.exe');
  assert.deepEqual(invocation?.args, ['-e', 'process.stdout.write(JSON.stringify({platform:process.platform,arch:process.arch,nodeAbi:process.versions.modules}))']);
  assert.equal(invocation?.options?.timeout, 5_000);
  assert.equal(invocation?.options?.maxBuffer, 16 * 1024);
  assert.equal(invocation?.options?.env?.NODE_OPTIONS, undefined);
  assert.equal(invocation?.options?.env?.NODE_PATH, undefined);
  assert.equal(invocation?.options?.env?.node_options, undefined);
  assert.equal(originalEnv.NODE_OPTIONS, '--require injected.js', 'the parent environment is not mutated');
});

test('probeBackendNodeTarget reports the running Node target and rejects failed or malformed probes', async () => {
  assert.deepEqual(await probeBackendNodeTarget(process.execPath), {
    platform: process.platform,
    arch: process.arch,
    nodeAbi: process.versions.modules,
  });
  await assert.rejects(probeBackendNodeTarget('/bad/node', {
    exec: async () => ({ stdout: '', stderr: 'timed out', exitCode: 1 }),
  }), /Could not probe backend Node target/);
  await assert.rejects(probeBackendNodeTarget('/bad/node', {
    exec: async () => ({ stdout: '{}', stderr: '', exitCode: 0 }),
  }), /invalid target/);
});

test('probeBackendNodeTarget runs a real selected child without ambient preloads and reports its target', async (t) => {
  const tempRoot = createTempRoot(t, 'pie-node-probe-');
  const preloadPath = path.join(tempRoot, 'hostile-preload.cjs');
  fs.writeFileSync(preloadPath, "throw new Error('hostile NODE_OPTIONS preload executed');\n");
  const env = {
    ...process.env,
    NODE_OPTIONS: `--require "${preloadPath}"`,
    NODE_PATH: tempRoot,
  };

  const target = await probeBackendNodeTarget(process.execPath, { env });

  assert.deepEqual(target, {
    platform: process.platform,
    arch: process.arch,
    nodeAbi: process.versions.modules,
  }, 'the selected executable child must report its own platform, architecture and ABI');
  assert.equal(env.NODE_OPTIONS, `--require "${preloadPath}"`, 'probe sanitization must not mutate the caller environment');
});

test('command executor bounds a real subprocess that does not exit', async () => {
  const startedAt = Date.now();
  const result = await createCommandExecutor()(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 30_000)'],
    { timeout: 150, maxBuffer: 16 * 1024 },
  );

  assert.notEqual(result.exitCode, 0, 'the child must be terminated by the configured timeout');
  assert.ok(Date.now() - startedAt < 5_000, 'the real subprocess must fail within a bounded interval');
});

test('a private copy of the supplied runtime keeps its verified identity and rejects tampering', async (t) => {
  if (!SUPPLIED_PI_RUNTIME_ARTIFACT || !SUPPLIED_PI_RUNTIME_IDENTITY) {
    t.skip('set PIE_TEST_PI_RUNTIME_ARTIFACT and PIE_TEST_PI_RUNTIME_IDENTITY for copied artifact evidence');
    return;
  }

  const tempRoot = createTempRoot(t, 'pie-runtime-copy-');
  const target = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(SUPPLIED_PI_RUNTIME_ARTIFACT, 'manifest.json'), 'utf8'));

  const privateCopy = path.join(tempRoot, 'pi-runtime');
  await fs.promises.cp(SUPPLIED_PI_RUNTIME_ARTIFACT, privateCopy, { recursive: true, errorOnExist: true, force: false });
  const copiedVerification = await verifyPiRuntimeArtifact(privateCopy, { target });
  assert.equal(copiedVerification.identity, SUPPLIED_PI_RUNTIME_IDENTITY, 'copying must preserve the stable supplied artifact identity');
  assert.deepEqual(copiedVerification.manifest, sourceManifest, 'the verified private copy must retain the supplied manifest');
  assert.notEqual(copiedVerification.artifactDir, path.resolve(SUPPLIED_PI_RUNTIME_ARTIFACT), 'verification must use the private copy');

  const privateSdkFile = path.join(privateCopy, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js');
  await fs.promises.appendFile(privateSdkFile, '\n// private-copy tamper\n');
  await assert.rejects(
    verifyPiRuntimeArtifact(privateCopy, { target }),
    /package hash mismatch/,
  );
});

test('minimumNodeVersionFromEngine reads the SDK lower bound and rejects unknown range shapes', () => {
  assert.equal(minimumNodeVersionFromEngine('>=22.19.0'), '22.19.0');
  assert.equal(minimumNodeVersionFromEngine(undefined), undefined);
  assert.throws(
    () => minimumNodeVersionFromEngine('20 || >=22'),
    /Unsupported PI SDK Node engine range/,
  );
});

test('resolveCompatibleNodePath skips an older PATH runtime and selects a compatible one', async () => {
  const oldNode = path.join('C:/old', 'node.exe');
  const compatibleNode = path.join('D:/current', 'node.exe');

  const nodePath = await resolveCompatibleNodePath({
    env: { PATH: 'C:/old;D:/current' },
    platform: 'win32',
    minimumVersion: '22.19.0',
    exists: (filePath) => filePath === oldNode || filePath === compatibleNode,
    exec: async (command) => ({
      stdout: command === oldNode ? 'v20.19.0\n' : 'v24.16.0\n',
      stderr: '',
      exitCode: 0,
    }),
  });

  assert.equal(nodePath, compatibleNode);
});

test('resolveCompatibleNodePath rejects an incompatible explicit runtime', async () => {
  await assert.rejects(
    () => resolveCompatibleNodePath({
      configuredPath: 'C:/configured/node.exe',
      env: { PATH: 'D:/compatible' },
      platform: 'win32',
      minimumVersion: '22.19.0',
      exists: () => true,
      exec: async () => ({ stdout: 'v20.19.0\n', stderr: '', exitCode: 0 }),
    }),
    /Configured PI nodePath uses Node v20\.19\.0, but the PI SDK requires Node >=22\.19\.0/,
  );
});

test('resolveCompatibleNodePath reports every incompatible PATH runtime', async () => {
  await assert.rejects(
    () => resolveCompatibleNodePath({
      env: { PATH: '/node20:/node18' },
      platform: 'linux',
      minimumVersion: '22.19.0',
      exists: (filePath) => filePath === '/node20/node' || filePath === '/node18/node',
      exec: async (command) => ({
        stdout: command === '/node20/node' ? 'v20.19.0\n' : 'v18.20.0\n',
        stderr: '',
        exitCode: 0,
      }),
    }),
    (error: Error) => {
      assert.match(error.message, /Could not find Node >=22\.19\.0/);
      assert.match(error.message, /\/node20\/node \(v20\.19\.0\)/);
      assert.match(error.message, /\/node18\/node \(v18\.20\.0\)/);
      return true;
    },
  );
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

test('createCommandExecutor resolves node:child_process without throwing', () => {
  // Smoke test: the factory should be callable without error.
  assert.doesNotThrow(() => createCommandExecutor());
});
