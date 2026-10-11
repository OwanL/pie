import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createIsolatedPiWorkspace, validateSnapshotPath } from '../pi-isolated-workspace.mjs';
import { computePiRuntimeInputFingerprint, piRuntimeDeployArguments } from '../pi-runtime.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-isolation-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const put = async (name, bytes = '{}') => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); };
  await put('.gitignore', 'node_modules/\n');
  await put('.prototools', `node = "${process.versions.node}"\npnpm = "10.34.4"\n`);
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
    await put(name, await fs.readFile(new URL(`../../../${name}`, import.meta.url)));
  }
  await put('harness/pi/LICENSE');
  for (const dir of ['tui', 'ai', 'agent', 'coding-agent']) for (const file of ['package.json', 'tsconfig.build.json']) await put(`harness/pi/packages/${dir}/${file}`);
  await put('tracked.txt', 'old'); await put('deleted.txt', 'delete');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '--quiet', '--template='); git('add', '.');
  await put('tracked.txt', 'pending'); await put('new.txt', 'new'); await fs.unlink(path.join(root, 'deleted.txt'));
  const index = await fs.readFile(path.join(root, '.git/index'));
  const install = async (_exe, args, cwd, env) => {
    assert.ok(args.includes('--frozen-lockfile')); assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--package-import-method=copy')); assert.ok(args.includes('--offline'));
    assert.equal(env.SECRET, undefined); assert.ok(env.npm_config_cache.startsWith(path.dirname(cwd)));
    const store = args[args.indexOf('--store-dir') + 1];
    const deployArgs = piRuntimeDeployArguments({ deploy: path.join(path.dirname(cwd), 'deploy'), context: {},
      pnpmCli: args[0], privateStore: path.join(path.dirname(cwd), 'store'), networkPolicy: 'offline' });
    assert.equal(deployArgs[deployArgs.indexOf('--store-dir') + 1], store);
    assert.ok(deployArgs.includes('--offline'));
    for (const [name, manifest, entry] of [['typescript', '{"main":"index.js"}', 'index.js'], ['esbuild', '{"main":"index.js"}', 'index.js']]) {
      const base = path.join(cwd, 'node_modules', name); await fs.mkdir(base, { recursive: true }); await fs.writeFile(path.join(base, 'package.json'), manifest); await fs.writeFile(path.join(base, entry), '');
    }
    await fs.mkdir(path.join(cwd, 'node_modules/typescript/bin')); await fs.writeFile(path.join(cwd, 'node_modules/typescript/bin/tsc'), '');
  };
  const options = { repositoryRoot: root, pnpmCli: path.join(root, 'pnpm.cjs'), networkPolicy: 'offline', env: { ...process.env, SECRET: 'never' } };
  const dependencies = { version: async () => '10.34.4', run: install };
  return { root, put, index, options, dependencies };
}

test('current modified/new/deleted bytes, private index and independent context; primary untouched', async t => {
  const f = await fixture(t);
  const result = await createIsolatedPiWorkspace(f.options, { ...f.dependencies, run: async (...args) => {
    await f.dependencies.run(...args);
    const cwd = args[2];
    await fs.link(path.join(cwd, 'node_modules/typescript/index.js'), path.join(cwd, 'node_modules/typescript/copied.js'));
  } });
  t.after(() => result.cleanup({ teardownConfirmed: true }));
  assert.notEqual(result.context.repositoryRoot, f.root);
  assert.equal((await fs.stat(path.join(result.context.repositoryRoot, 'node_modules/typescript/index.js'))).nlink, 1);
  assert.equal(await fs.readFile(path.join(result.context.repositoryRoot, 'tracked.txt'), 'utf8'), 'pending');
  assert.equal(await fs.readFile(path.join(result.context.repositoryRoot, 'new.txt'), 'utf8'), 'new');
  await assert.rejects(fs.stat(path.join(result.context.repositoryRoot, 'deleted.txt')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(f.root, '.git/index')), f.index);
  await assert.rejects(fs.stat(path.join(f.root, 'node_modules')), { code: 'ENOENT' });
  assert.equal(await result.cleanup({ teardownConfirmed: false }), false);
  assert.equal(await result.cleanup({ teardownConfirmed: true }), true);
});

for (const change of ['bytes', 'inventory']) test(`rejects ${change} race and retains failed evidence`, async t => {
  const f = await fixture(t);
  await assert.rejects(createIsolatedPiWorkspace(f.options, { ...f.dependencies, afterCapture: () => f.put(change === 'bytes' ? 'tracked.txt' : 'another.txt', 'raced') }), error => {
    assert.match(error.message, /changed during snapshot/);
    t.after(() => error.cleanup({ teardownConfirmed: true }));
    return true;
  });
});

test('snapshot lock mutation by mocked installer is rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(createIsolatedPiWorkspace(f.options, { ...f.dependencies, run: async (...args) => {
    await f.dependencies.run(...args);
    await fs.writeFile(path.join(args[2], 'pnpm-lock.yaml'), 'mutated');
  } }), error => {
    assert.match(error.message, /Snapshot source\/lock changed/);
    t.after(() => error.cleanup({ teardownConfirmed: true })); return true;
  });
});

test('exact tracked protected source survives with canonical fingerprint parity; untracked protected trees omitted', async t => {
  const f = await fixture(t);
  const source = ['harness/pi/examples/data/redcircle.png', 'harness/pi/examples/doom/build.js', 'harness/pi/examples/doom/build/doom.wasm', 'scripts/build/support.mjs'];
  for (const name of source) await f.put(name, `original:${name}`);
  execFileSync('git', ['add', '--', ...source], { cwd: f.root });
  const index = await fs.readFile(path.join(f.root, '.git/index'));
  await f.put(source[0], 'current tracked bytes');
  const omitted = ['data/private.txt', 'build/generated.js', 'sessions/private.json', 'logs/private.log', 'node_modules/private.js', 'scripts/build/untracked.mjs'];
  for (const name of omitted) await f.put(name, 'not source');
  const before = await computePiRuntimeInputFingerprint({ repositoryRoot: f.root });
  const result = await createIsolatedPiWorkspace(f.options, f.dependencies);
  t.after(() => result.cleanup({ teardownConfirmed: true }));
  assert.equal(await computePiRuntimeInputFingerprint({ repositoryRoot: result.context.repositoryRoot }), before);
  assert.equal(await computePiRuntimeInputFingerprint({ repositoryRoot: f.root }), before);
  assert.deepEqual(await fs.readFile(path.join(f.root, '.git/index')), index);
  for (const name of source) assert.deepEqual(await fs.readFile(path.join(result.context.repositoryRoot, name)), await fs.readFile(path.join(f.root, name)));
  for (const name of omitted) {
    await assert.rejects(fs.stat(path.join(result.context.repositoryRoot, name)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(f.root, name), 'utf8'), 'not source');
  }
});

test('unsafe path spellings rejected', () => {
  for (const name of ['../x', '/x', 'x\\y', 'C:/x', 'x/NUL.txt', 'x./y', 'a//b']) assert.throws(() => validateSnapshotPath(name));
});

test('unconfirmed descendants retain scratch even on explicit cleanup', async t => {
  const f = await fixture(t);
  let failure;
  try { await createIsolatedPiWorkspace(f.options, { ...f.dependencies, run: async () => { throw Object.assign(new Error('uncertain'), { teardownUnconfirmed: true }); } }); }
  catch (error) { failure = error; }
  assert.equal(await failure.cleanup({ teardownConfirmed: true }), false);
  assert.ok((await fs.stat(failure.scratchRoot)).isDirectory());
  // Mock owns no actual children; remove only this fixture's retained scratch.
  t.after(() => fs.rm(failure.scratchRoot, { recursive: true }));
});
