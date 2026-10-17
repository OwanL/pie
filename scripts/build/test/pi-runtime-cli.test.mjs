import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPiRuntime, assertPrivateOutput, parsePiRuntimeArguments, runPiRuntimeCli, resolvePinnedPnpmCli, piRuntimeDeployArguments } from '../pi-runtime.mjs';

test('runtime reader diagnostics identify only its owned output and a fresh invocation', async () => {
  const owner = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-runtime-reader-'));
  const invocations = [];
  try {
    for (const name of ['first', 'second']) {
      const output = path.join(owner, name);
      await assert.rejects(buildPiRuntime({ output }, {
        async acquireReader(root, { metadata }) {
          assert.equal(root, path.join(process.cwd(), 'harness', 'pi'));
          assert.equal(metadata.operation, 'build-pi-runtime');
          assert.equal(metadata.evidence, output);
          assert.match(metadata.invocation, /^[0-9a-f-]{36}$/u);
          invocations.push(metadata.invocation);
          assert.ok((await fs.stat(output)).isDirectory());
          throw new Error('stop before source reads or children');
        },
      }), /stop before source reads or children/u);
    }
    assert.notEqual(invocations[0], invocations[1]);
  } finally { await fs.rm(owner, { recursive: true, force: true }); }
});

test('private output accepts canonical OS-temp spelling without creating missing parents', async () => {
  const owner = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cli-alias-'));
  const previousTemp = process.env.TEMP;
  try {
    const output = path.join(realpathSync.native(owner), 'missing-parent', 'artifact');
    assert.doesNotThrow(() => assertPrivateOutput(output));
    await assert.rejects(fs.lstat(path.dirname(output)), { code: 'ENOENT' });
    if (process.platform === 'win32') {
      // The native TEMP may be 8.3 while realpath expands it (or vice versa).
      // Exercise both containment directions using the actual filesystem.
      process.env.TEMP = realpathSync.native(os.tmpdir());
      assert.doesNotThrow(() => assertPrivateOutput(path.join(owner, 'missing-parent', 'artifact')));
    }
    await assert.rejects(runPiRuntimeCli(['--isolated', '--allow-network', '--output', output], {
      resolvePinnedPnpmCli: () => { throw new Error('validated before resolution'); },
    }), /validated before resolution/);
    await assert.rejects(fs.lstat(path.dirname(output)), { code: 'ENOENT' });
  } finally {
    if (previousTemp === undefined) delete process.env.TEMP; else process.env.TEMP = previousTemp;
    await fs.rm(owner, { recursive: true, force: true });
  }
});

test('prelaunch keeps new-directory and configured TEMP authority', async () => {
  const owner = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cli-prelaunch-'));
  const canonicalOwner = realpathSync.native(owner);
  const previousTemp = process.env.TEMP;
  const output = path.join(canonicalOwner, 'artifact');
  const stop = { resolvePinnedPnpmCli: () => { throw new Error('prelaunch validated'); } };
  try {
    await assert.rejects(runPiRuntimeCli(['--isolated', '--allow-network', '--output', output], stop), /prelaunch validated/);
    await fs.mkdir(output);
    await assert.rejects(runPiRuntimeCli(['--isolated', '--allow-network', '--output', output], stop), /already exists/);
    await fs.rmdir(output);
    if (process.platform === 'win32') {
      const privateTemp = path.join(canonicalOwner, 'proto-temp');
      await fs.mkdir(privateTemp);
      process.env.TEMP = privateTemp;
      await assert.rejects(runPiRuntimeCli(['--isolated', '--allow-network', '--output', output], stop), /beneath OS temporary/);
      await assert.rejects(runPiRuntimeCli(['--isolated', '--allow-network', '--output', path.join(privateTemp, 'artifact')], stop), /prelaunch validated/);
    }
    if (previousTemp === undefined) delete process.env.TEMP; else process.env.TEMP = previousTemp;
    const escape = path.join(canonicalOwner, 'escape');
    await fs.symlink(process.cwd(), escape, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(runPiRuntimeCli(['--isolated', '--allow-network', '--output', path.join(escape, 'future-artifact')], stop), /protected live|Symlink/);
  } finally {
    if (previousTemp === undefined) delete process.env.TEMP; else process.env.TEMP = previousTemp;
    await fs.rm(owner, { recursive: true, force: true });
  }
});

test('CLI defaults and strict authority', () => {
  assert.deepEqual(parsePiRuntimeArguments(['--isolated', '--output', '/private']), { isolated: true, networkPolicy: 'offline', output: '/private' });
  assert.equal(parsePiRuntimeArguments(['--isolated', '--allow-network', '--output', '/private']).networkPolicy, 'allow');
  for (const args of [[], ['--output', '/private', '--output', '/other'], ['--output', '/private', '--source-root', '/other'], ['--output', '/private', '--allow-network'], ['--isolated', '--offline', '--allow-network', '--output', '/private']]) assert.throws(() => parsePiRuntimeArguments(args));
});

test('tool resolver uses installed pinned local Proto authority without acquisition', async () => {
  const owner = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cli-tool-'));
  try {
    const cli = path.join(owner, 'pnpm.cjs'); await fs.writeFile(cli, '// fixture');
    const root = JSON.parse(await fs.readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
    assert.equal(await resolvePinnedPnpmCli({ execFileSync: (command, args, options) => {
      assert.equal(command, 'proto');
      assert.deepEqual(args, ['bin', 'pnpm', root.packageManager.slice(5), '--config-mode', 'local']);
      assert.equal(options.env, process.env);
      return cli;
    } }), realpathSync(cli));
  } finally { await fs.rm(owner, { recursive: true, force: true }); }
});

test('unsafe output rejected before executable resolution or snapshot mutation', async () => {
  await assert.rejects(runPiRuntimeCli(['--isolated', '--output', process.cwd()], { resolvePinnedPnpmCli: () => assert.fail('must not resolve') }));
  await assert.rejects(runPiRuntimeCli(['--isolated', '--output', path.join(os.tmpdir(), 'pie-isolated-sdk-future', 'artifact')], { resolvePinnedPnpmCli: () => assert.fail('must not resolve') }), /overlap/);
});

for (const failure of [undefined, 'install', 'compile', 'pack', 'uncertain']) test(`isolated ordering and retention: ${failure ?? 'success'}`, async () => {
  const owner = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cli-test-'));
  const scratchRoot = path.join(owner, 'scratch'); await fs.mkdir(scratchRoot);
  const output = path.join(owner, 'artifact');
  const calls = [];
  const context = { repositoryRoot: path.join(scratchRoot, 'repository') };
  const deps = {
    log: () => {},
    resolvePinnedPnpmCli: () => { calls.push('resolve'); return '/installed/pnpm.cjs'; },
    createIsolatedPiWorkspace: async options => {
      calls.push('install'); assert.equal(options.networkPolicy, 'offline'); assert.equal(options.pnpmCli, '/installed/pnpm.cjs');
      assert.notEqual(options.repositoryRoot, context.repositoryRoot);
      if (failure === 'install') throw Object.assign(new Error('install failed'), { scratchRoot });
      return { scratchRoot, context, provenance: { schema: 1 }, cleanup: async options => { assert.deepEqual(options, { teardownConfirmed: true }); calls.push('cleanup'); } };
    },
    buildPiWorkspace: async options => { calls.push('compile'); assert.equal(options.context, context); if (failure === 'compile') throw new Error('compile failed'); },
    buildPiRuntime: async options => {
      calls.push('pack'); assert.equal(options.context, context); assert.equal(options.pnpmCli, '/installed/pnpm.cjs');
      assert.equal(options.privateStore, path.join(scratchRoot, 'store'));
      assert.equal(options.networkPolicy, 'offline');
      const deployArgs = piRuntimeDeployArguments({ ...options, deploy: path.join(output, 'work', 'deploy-staging') });
      assert.equal(deployArgs.filter(arg => arg === '--package-import-method=copy').length, 1);
      assert.equal(deployArgs[deployArgs.indexOf('--store-dir') + 1], options.privateStore);
      assert.ok(deployArgs.includes('--offline'));
      if (failure === 'pack' || failure === 'uncertain') throw Object.assign(new Error('pack failed'), { teardownUnconfirmed: failure === 'uncertain' });
      await fs.mkdir(output); await fs.writeFile(path.join(output, 'role-proof'), 'retained'); return { identity: 'verified' };
    },
  };
  try {
    const invocation = runPiRuntimeCli(['--isolated', '--output', output], deps);
    if (failure) await assert.rejects(invocation, /failed/);
    else { assert.deepEqual(await invocation, { identity: 'verified' }); assert.equal(await fs.readFile(path.join(output, 'role-proof'), 'utf8'), 'retained'); assert.equal(JSON.parse(await fs.readFile(path.join(output, 'isolated-provenance.json'))).schema, 1); }
    assert.deepEqual(calls, failure === 'install' ? ['resolve', 'install'] : failure === 'compile' ? ['resolve', 'install', 'compile'] : failure ? ['resolve', 'install', 'compile', 'pack'] : ['resolve', 'install', 'compile', 'pack', 'cleanup']);
    if (failure !== 'install') assert.equal(JSON.parse(await fs.readFile(path.join(scratchRoot, 'provenance.json'))).schema, 1);
  } finally { await fs.rm(owner, { recursive: true, force: true }); }
});

for (const networkPolicy of ['offline', 'allow']) test(`deploy preserves explicit ${networkPolicy} policy`, () => {
  const privateStore = path.join(os.tmpdir(), 'owned', 'store');
  const pnpmCli = path.join(os.tmpdir(), 'pnpm.cjs');
  const args = piRuntimeDeployArguments({ deploy: '/deploy', context: {}, pnpmCli, privateStore, networkPolicy });
  assert.equal(args[args.indexOf('--store-dir') + 1], privateStore);
  assert.equal(args.includes('--offline'), networkPolicy === 'offline');
  assert.equal(args.filter(arg => arg === '--package-import-method=copy').length, 1);
  assert.throws(() => piRuntimeDeployArguments({ deploy: '/deploy', context: {}, pnpmCli, privateStore }), /explicit network policy/);
});

test('nonisolated deploy retains Proto arguments', () => {
  assert.deepEqual(piRuntimeDeployArguments({ deploy: '/deploy' }), ['run', 'pnpm', '--', '--filter', 'pi-config', 'deploy', '--prod', '/deploy']);
});

test('nonisolated route remains the existing builder only', async () => {
  const owner = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cli-default-'));
  try {
    const output = path.join(owner, 'artifact');
    await runPiRuntimeCli(['--output', output], { buildPiRuntime: options => assert.deepEqual(options, { output }), resolvePinnedPnpmCli: () => assert.fail('no isolated tool resolution') });
  } finally { await fs.rm(owner, { recursive: true, force: true }); }
});
