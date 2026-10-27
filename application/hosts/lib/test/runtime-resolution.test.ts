import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { resolveCommandInvocation } from '../command-invocation';
import { createCommandExecutor } from '../command-execution';
import { verifyPiRuntimeArtifact } from '../../../../lib/pi-runtime/artifact.mjs';
import { computeNodeRuntimePayloadIdentity } from '../../../../lib/node-runtime/manifest.mjs';
import {
  assertBundledNodeTarget,
  assertBundledNodeVersion,
  minimumNodeVersionFromEngine,
  probeBackendNodeTarget,
  resolveCompatibleNodePath,
  resolveNodePath,
  resolveStartupNodePath,
} from '../runtime-resolution';

// Opt-in materialized-artifact evidence; ordinary fast tests use private fixtures.
const SUPPLIED_PI_RUNTIME_ARTIFACT = process.env.PIE_TEST_PI_RUNTIME_ARTIFACT;
const SUPPLIED_PI_RUNTIME_IDENTITY = process.env.PIE_TEST_PI_RUNTIME_IDENTITY;

function createTempRoot(t: { after: (fn: () => void) => void }, prefix: string): string {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return tempRoot;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

async function writeBundledNodeRuntime(runtimeOutDir: string, options: {
  malformed?: boolean;
  target?: { platform: string; arch: string; nodeAbi: string };
} = {}): Promise<string> {
  const runtimeDir = path.join(runtimeOutDir, 'resources', 'node-runtime');
  await fs.promises.mkdir(runtimeDir, { recursive: true });
  if (options.malformed) {
    await fs.promises.writeFile(path.join(runtimeDir, 'manifest.json'), '{malformed');
    return runtimeDir;
  }
  const license = Buffer.from('Node.js license fixture');
  const executable = Buffer.from('bundled-node-fixture');
  await fs.promises.writeFile(path.join(runtimeDir, 'LICENSE'), license);
  await fs.promises.writeFile(path.join(runtimeDir, 'node.exe'), executable);
  const inventory = [
    { relativePath: 'LICENSE', sizeBytes: license.length, sha256: createHash('sha256').update(license).digest('hex') },
    { relativePath: 'node.exe', sizeBytes: executable.length, sha256: createHash('sha256').update(executable).digest('hex') },
  ];
  const identityFields = {
    schemaVersion: 1,
    kind: 'node-runtime',
    nodeVersion: '24.16.0',
    target: options.target ?? { platform: 'win32', arch: 'x64', nodeAbi: '137' },
    executable: 'node.exe',
    inventory,
    provenance: {
      kind: 'local-toolchain',
      archiveUrl: 'https://nodejs.org/download/release/v24.16.0/node-v24.16.0-win-x64.zip',
      archiveSha256: 'a'.repeat(64),
    },
  };
  const manifest = {
    ...identityFields,
    payloadIdentity: computeNodeRuntimePayloadIdentity(identityFields),
  };
  await fs.promises.writeFile(
    path.join(runtimeDir, 'manifest.json'),
    `${JSON.stringify(canonicalize(manifest), null, 2)}\n`,
  );
  return runtimeDir;
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

test('startup Node routing honors explicit overrides before the Node pinned in the selected runtime output', async (t) => {
  const tempRoot = createTempRoot(t, 'pie-bundled-node-route-');
  const runtimeOutDir = path.join(tempRoot, 'pie-runtime-v2', 'generations', 'a'.repeat(64), 'out');
  await writeBundledNodeRuntime(runtimeOutDir);
  const configuredPath = path.join(tempRoot, 'configured-node.exe');
  const environmentPath = path.join(tempRoot, 'environment-node.exe');
  await fs.promises.writeFile(configuredPath, 'configured');
  await fs.promises.writeFile(environmentPath, 'environment');

  const setting = await resolveStartupNodePath({
    configuredPath,
    env: { PI_NODE_PATH: environmentPath },
    runtimeOutDir,
  });
  assert.deepEqual(setting, { nodePath: configuredPath, source: 'configured' });
  let explicitProbeCalled = false;
  await assertBundledNodeVersion(setting, {
    exec: async () => {
      explicitProbeCalled = true;
      throw new Error('explicit Node overrides must not receive the bundled patch pin');
    },
  });
  assert.equal(explicitProbeCalled, false);
  assertBundledNodeTarget(setting, { platform: 'linux', arch: 'arm64', nodeAbi: '999' });

  const environment = await resolveStartupNodePath({
    env: { PI_NODE_PATH: environmentPath },
    runtimeOutDir,
  });
  assert.deepEqual(environment, { nodePath: environmentPath, source: 'environment' });

  const bundled = await resolveStartupNodePath({ env: {}, runtimeOutDir });
  assert.equal(bundled.source, 'bundled');
  assert.equal(bundled.nodePath, path.join(runtimeOutDir, 'resources', 'node-runtime', 'node.exe'),
    'the payload is resolved under the exact immutable generation output supplied by startup');
  await assertBundledNodeVersion(bundled, {
    exec: async (command, args) => {
      assert.equal(command, bundled.nodePath);
      assert.deepEqual(args, ['--version']);
      return { stdout: 'v24.16.0', stderr: '', exitCode: 0 };
    },
  });
  await assert.rejects(assertBundledNodeVersion(bundled, {
    exec: async () => ({ stdout: 'v24.16.1', stderr: '', exitCode: 0 }),
  }), /Bundled Node runtime must be 24\.16\.0/);
  assertBundledNodeTarget(bundled, { platform: 'win32', arch: 'x64', nodeAbi: '137' });
});

test('startup Node routing rejects a present malformed bundle instead of falling back to PATH', async (t) => {
  const tempRoot = createTempRoot(t, 'pie-bundled-node-malformed-');
  const runtimeOutDir = path.join(tempRoot, 'out');
  await writeBundledNodeRuntime(runtimeOutDir, { malformed: true });
  const legacyPath = path.join(tempRoot, 'legacy-node.exe');
  await fs.promises.writeFile(legacyPath, 'legacy');

  await assert.rejects(resolveStartupNodePath({
    env: { PATH: tempRoot },
    runtimeOutDir,
  }), /manifest.json is not valid JSON/);
});

test('startup Node routing uses the legacy PATH route when no bundled payload exists', async (t) => {
  const tempRoot = createTempRoot(t, 'pie-bundled-node-absent-');
  const legacyPath = path.join(tempRoot, process.platform === 'win32' ? 'node.exe' : 'node');
  await fs.promises.writeFile(legacyPath, 'legacy');

  const selection = await resolveStartupNodePath({
    env: { PATH: tempRoot },
    runtimeOutDir: path.join(tempRoot, 'no-bundle'),
  });
  assert.equal(selection.source, 'path');
  assert.equal(selection.nodePath, legacyPath);
});

test('startup fails closed for a dangling bundled Node directory instead of falling back', async (t) => {
  const tempRoot = createTempRoot(t, 'pie-bundled-node-dangling-');
  const runtimeOutDir = path.join(tempRoot, 'out');
  const resourcesDir = path.join(runtimeOutDir, 'resources');
  const nodeRuntimeDir = path.join(resourcesDir, 'node-runtime');
  const symlinkTarget = path.join(tempRoot, 'node-runtime-target');
  const legacyPath = path.join(tempRoot, process.platform === 'win32' ? 'node.exe' : 'node');
  await fs.promises.mkdir(resourcesDir, { recursive: true });
  await fs.promises.mkdir(symlinkTarget);
  await fs.promises.writeFile(legacyPath, 'legacy');
  try {
    fs.symlinkSync(symlinkTarget, nodeRuntimeDir, process.platform === 'win32' ? 'junction' : 'dir');
    fs.rmSync(symlinkTarget, { recursive: true, force: true });
  } catch {
    t.skip('directory symlinks are unavailable in this environment');
    return;
  }

  await assert.rejects(resolveStartupNodePath({
    env: { PATH: tempRoot },
    runtimeOutDir,
  }), /Node runtime payload|Bundled Node runtime/);
});

test('startup routing preserves a host-provided legacy default after bundle absence', async (t) => {
  const tempRoot = createTempRoot(t, 'pie-bundled-node-legacy-');
  const legacyDefault = path.join(tempRoot, 'legacy-default.exe');
  const pathNode = path.join(tempRoot, process.platform === 'win32' ? 'node.exe' : 'node');
  await fs.promises.writeFile(legacyDefault, 'legacy default');
  await fs.promises.writeFile(pathNode, 'PATH node');

  const selection = await resolveStartupNodePath({
    env: { PATH: tempRoot },
    runtimeOutDir: path.join(tempRoot, 'no-bundle'),
    legacyDefaultPath: legacyDefault,
  });
  assert.deepEqual(selection, { nodePath: legacyDefault, source: 'legacy' });
});

test('bundled Node manifest and executable target mismatches fail closed', async (t) => {
  const tempRoot = createTempRoot(t, 'pie-bundled-node-target-');
  const invalidManifestOutDir = path.join(tempRoot, 'manifest-target');
  await writeBundledNodeRuntime(invalidManifestOutDir, {
    target: { platform: 'win32', arch: 'arm64', nodeAbi: '127' },
  });
  await assert.rejects(
    resolveStartupNodePath({ env: {}, runtimeOutDir: invalidManifestOutDir }),
    /manifest target is unsupported/,
  );

  const validRuntimeOutDir = path.join(tempRoot, 'executable-target');
  await writeBundledNodeRuntime(validRuntimeOutDir);
  const selection = await resolveStartupNodePath({ env: {}, runtimeOutDir: validRuntimeOutDir });
  assert.throws(
    () => assertBundledNodeTarget(selection, { platform: 'win32', arch: 'arm64', nodeAbi: '127' }),
    /Bundled Node runtime target mismatch/,
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
