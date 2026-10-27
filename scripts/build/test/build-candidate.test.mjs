import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCandidate, parseCandidateArgs } from '../build-candidate.mjs';
import { stageExtensionForPackaging } from '../../lib/delivery-package.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pie-candidate-test-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const scratch = path.join(base, 'scratch');
  await mkdir(root);
  await mkdir(scratch);
  const output = path.join(base, 'candidate.vsix');
  const calls = [];
  const source = { head: 'fixture-head', status: ' M fixture' };
  const identity = { buildId: 'fixture-build', piRuntimeIdentity: 'fixture-runtime', target: 'win32-x64' };
  const bytes = Buffer.from('fake packaged candidate bytes');
  const deps = {
    root, status() {}, createScratch: async () => scratch,
    sourceIdentity: async () => source,
    verifyRuntime: async artifact => { calls.push(['verify-runtime', artifact]); return { identity: 'fixture-runtime' }; },
    stagePackage: async (...args) => { calls.push(['stage', ...args]); await mkdir(args[2]); },
    verifyIdentity: async (stage, context) => { calls.push(['identity', stage, context]); return identity; },
    resolveVsce: async () => 'fake-vsce',
    runStage: async (stage, options) => {
      calls.push([stage.name, stage, options]);
      if (stage.name === 'candidate-package') await writeFile(stage.args.at(-1), bytes);
      return { code: 0, outerConfirmed: true, innerConfirmed: true };
    },
  };
  return { base, root, scratch, output, calls, source, identity, bytes, deps };
}

async function absent(file) {
  await assert.rejects(lstat(file), { code: 'ENOENT' });
}

test('candidate arguments require explicit absolute VSIX output and reject ambiguous options', () => {
  const output = path.resolve('candidate.vsix');
  const artifactDir = path.resolve('runtime-fixture');
  assert.deepEqual(parseCandidateArgs(['--output', output]), { output });
  assert.deepEqual(parseCandidateArgs([`--output=${output}`, `--pi-runtime=${artifactDir}`]), { output, artifactDir });
  assert.deepEqual(parseCandidateArgs(['--help']), { help: true });
  for (const args of [[], ['--output', 'relative.vsix'], ['--output', path.resolve('bad.zip')],
    ['--output'], ['--output', output, '--output', output], ['--output', output, '--pi-runtime', 'relative'],
    ['--output', output, '--unknown'], ['--output', output, '--pi-runtime', artifactDir, '--pi-runtime', artifactDir]]) {
    assert.throws(() => parseCandidateArgs(args));
  }
});

test('managed candidate CLI requires a paired selection, explicit runtime and no watch', () => {
  const output = path.resolve('candidate.vsix');
  const artifactDir = path.resolve('runtime');
  const stageRoot = path.resolve('private-stage');
  const receiptPath = path.resolve('private-receipt.json');
  const pair = ['--managed-stage', stageRoot, '--managed-qualification-receipt', receiptPath];
  assert.deepEqual(parseCandidateArgs(['--output', output, '--pi-runtime', artifactDir, ...pair]), { output, artifactDir, managedIntegration: { stageRoot, receiptPath } });
  for (const extra of [pair, ['--pi-runtime', artifactDir, '--managed-stage', stageRoot], ['--pi-runtime', artifactDir, ...pair, '--watch'], ['--pi-runtime', artifactDir, ...pair, '--managed-stage', stageRoot]]) {
    assert.throws(() => parseCandidateArgs(['--output', output, ...extra]));
  }
});

for (const valid of [true, false]) {
  test(`managed candidate propagates private inputs and ${valid ? 'publishes public evidence only' : 'rejects extracted identity mismatch'}`, async t => {
    const f = await fixture(t);
    const managedIntegration = { stageRoot: path.join(f.base, 'private-stage'), receiptPath: path.join(f.base, 'private-receipt.json') };
    f.deps.verifyCandidate = async (candidate, extracted, context) => {
      f.calls.push(['verify-candidate', candidate, extracted, context]);
      return valid ? { ...f.identity } : { ...f.identity, piRuntimeIdentity: 'tampered' };
    };
    const operation = buildCandidate({ output: f.output, artifactDir: path.join(f.base, 'runtime'), managedIntegration }, undefined, f.deps);
    if (!valid) {
      await assert.rejects(operation, /Packaged candidate identity/);
      await absent(f.output);
      await absent(`${f.output}.evidence.json`);
      return;
    }
    const result = await operation;
    const delivery = f.calls.find(call => call[0] === 'delivery-build')[1];
    assert.deepEqual(delivery.args.slice(-4), ['--managed-stage', managedIntegration.stageRoot, '--managed-qualification-receipt', managedIntegration.receiptPath]);
    assert.deepEqual(f.calls.map(call => call[0]), ['verify-runtime', 'delivery-build', 'stage', 'identity', 'candidate-package', 'verify-candidate']);
    assert.deepEqual(f.calls.find(call => call[0] === 'identity').slice(1), [path.join(f.scratch, 'stage'), { managedIntegration }]);
    assert.deepEqual(f.calls.at(-1).slice(1), [path.join(f.scratch, 'candidate.vsix'), path.join(f.scratch, 'extracted'), { managedIntegration }]);
    const evidence = await readFile(result.evidencePath, 'utf8');
    for (const privatePath of Object.values(managedIntegration)) assert.equal(evidence.includes(privatePath.replaceAll('\\', '\\\\')), false);
    assert.equal(evidence.includes('managed-qualification-receipt'), false);
  });
}

for (const name of ['candidate', 'evidence']) {
  test(`refuses existing ${name} before invoking build dependencies`, async t => {
    const f = await fixture(t);
    const existing = name === 'candidate' ? f.output : `${f.output}.evidence.json`;
    await writeFile(existing, 'preserve me');
    await assert.rejects(buildCandidate({ output: f.output }, undefined, f.deps), /Refusing to overwrite/);
    assert.equal(await readFile(existing, 'utf8'), 'preserve me');
    assert.deepEqual(f.calls, []);
    await absent(name === 'candidate' ? `${f.output}.evidence.json` : f.output);
  });
}

for (const reuse of [false, true]) {
  test(`candidate ${reuse ? 'verifies explicit runtime reuse without compilation' : 'compiles, builds delivery and packages exactly once'}`, async t => {
    const f = await fixture(t);
    const artifactDir = path.join(f.base, 'runtime');
    const result = await buildCandidate({ output: f.output, ...(reuse ? { artifactDir } : {}) }, undefined, f.deps);
    assert.deepEqual(f.calls.map(call => call[0]), [reuse ? 'verify-runtime' : 'pi-compile', 'delivery-build', 'stage', 'identity', 'candidate-package']);
    const delivery = f.calls.find(call => call[0] === 'delivery-build')[1];
    assert.deepEqual(delivery.args, [path.join(f.root, 'scripts/build/build.mjs'), '--delivery', '--no-sync', '--output-dir', path.join(f.scratch, 'build'), ...(reuse ? ['--pi-runtime', artifactDir] : [])]);
    if (reuse) assert.equal(f.calls[0][1], artifactDir);
    else assert.deepEqual(f.calls[0][1].args, [path.join(f.root, 'scripts/build/pi-workspace.mjs')]);
    assert.deepEqual(f.calls.find(call => call[0] === 'stage').slice(1), [f.root, path.join(f.scratch, 'build'), path.join(f.scratch, 'stage')]);
    const packaging = f.calls.find(call => call[0] === 'candidate-package');
    assert.equal(packaging[2].root, path.join(f.scratch, 'stage'));
    assert.deepEqual(packaging[1].args, ['fake-vsce', 'package', '--no-dependencies', '--allow-missing-repository', '--target', 'win32-x64', '--out', path.join(f.scratch, 'candidate.vsix')]);
    assert.deepEqual(await readFile(f.output), f.bytes);
    const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8'));
    assert.deepEqual(evidence, { schema: 1, purpose: 'local-development-only', qualified: false, licenseQualified: false, cleanMachineQualified: false,
      source: f.source, runtime: { selection: reuse ? artifactDir : 'workspace', identity: f.identity.piRuntimeIdentity },
      build: f.identity, candidate: { path: f.output, target: 'win32-x64', sha256: createHash('sha256').update(f.bytes).digest('hex'), size: f.bytes.length }, scratch: f.scratch });
    assert.deepEqual(result.evidence, evidence);
    assert.deepEqual(await readFile(path.join(f.scratch, 'candidate.vsix')), f.bytes);
    assert.ok((await lstat(path.join(f.scratch, 'stage'))).isDirectory());
  });
}

test('explicit runtime mismatch stops before packaging or final outputs', async t => {
  const f = await fixture(t);
  f.deps.verifyRuntime = async () => ({ identity: 'different-runtime' });
  await assert.rejects(buildCandidate({ output: f.output, artifactDir: path.join(f.base, 'runtime') }, undefined, f.deps), /does not match/);
  assert.equal(f.calls.some(call => call[0] === 'candidate-package'), false);
  await absent(f.output);
  await absent(`${f.output}.evidence.json`);
});

for (const failure of ['outer', 'inner', '125', 'cancel']) {
  test(`${failure} at package stage stops publication and retains scratch`, async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    const run = f.deps.runStage;
    f.deps.runStage = async (stage, options) => {
      const result = await run(stage, options);
      if (stage.name === 'candidate-package') {
        if (failure === 'cancel') controller.abort(new Error('fixture cancellation'));
        if (failure === 'outer') result.outerConfirmed = false;
        if (failure === 'inner') result.innerConfirmed = false;
        if (failure === '125') result.code = 125;
      }
      return result;
    };
    await assert.rejects(buildCandidate({ output: f.output }, controller.signal, f.deps), failure === 'cancel' ? /fixture cancellation/ : /failed or teardown is unconfirmed/);
    await absent(f.output);
    await absent(`${f.output}.evidence.json`);
    assert.deepEqual(await readFile(path.join(f.scratch, 'candidate.vsix')), f.bytes);
  });
}

async function packageFixture(t) {
  const f = await fixture(t);
  const source = path.join(f.root, 'application/hosts/vscode');
  const build = path.join(f.base, 'isolated-build');
  const stage = path.join(f.base, 'package');
  const put = async (file, bytes) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); };
  for (const [name, bytes] of Object.entries({ 'package.json': '{"name":"fixture"}', '.vscodeignore': 'ignored', 'media/icon.svg': 'icon', 'media/nested/full.svg': 'full media', 'runtime/bootstrap.cjs': 'bootstrap', 'runtime/windows-runtime-lock.cjs': 'checkout adapter', 'out/stale.js': 'must not copy' })) await put(path.join(source, name), bytes);
  await put(path.join(f.root, 'LICENSE'), Buffer.from('root license\r\n'));
  await put(path.join(f.root, 'COPYRIGHT'), Buffer.from('root copyright\r\n'));
  await put(path.join(f.root, 'lib/windows-runtime-lock/windows-runtime-lock.cjs'), 'neutral lock owner');
  for (const [name, bytes] of Object.entries({ 'pi-runtime/manifest.json': '{}', 'host.js': 'isolated output', '.cache/secret': 'excluded', 'nested/.cache/secret': 'excluded', 'nested/asset': 'included' })) await put(path.join(build, name), bytes);
  return { ...f, source, build, stage };
}

test('real staging copies root licence notices byte-for-byte with full media, neutral lock and isolated output', async t => {
  const f = await packageFixture(t);
  await stageExtensionForPackaging(f.root, f.build, f.stage);
  for (const [name, bytes] of Object.entries({ 'runtime/windows-runtime-lock.cjs': 'neutral lock owner', 'runtime/bootstrap.cjs': 'bootstrap', 'media/nested/full.svg': 'full media', 'media/icon.svg': 'icon', 'out/host.js': 'isolated output', 'out/nested/asset': 'included', 'out/pi-runtime/manifest.json': '{}', '.vscodeignore': 'ignored' })) assert.equal(await readFile(path.join(f.stage, name), 'utf8'), bytes);
  assert.deepEqual(await readFile(path.join(f.stage, 'LICENSE')), Buffer.from('root license\r\n'));
  assert.deepEqual(await readFile(path.join(f.stage, 'COPYRIGHT')), Buffer.from('root copyright\r\n'));
  for (const name of ['LICENSE', 'COPYRIGHT']) await absent(path.join(f.source, name));
  for (const name of ['out/stale.js', 'out/.cache', 'out/nested/.cache']) await absent(path.join(f.stage, name));
});

for (const name of ['LICENSE', 'COPYRIGHT']) {
  test(`real staging requires a regular root ${name} file`, async t => {
    const f = await packageFixture(t);
    await rm(path.join(f.root, name));
    await assert.rejects(stageExtensionForPackaging(f.root, f.build, f.stage), /requires a regular file/);
    await absent(f.stage);
  });
}

test('real staging refuses prepublish hooks without executing them', async t => {
  const f = await packageFixture(t);
  await writeFile(path.join(f.source, 'package.json'), JSON.stringify({ scripts: { 'vscode:prepublish': 'never execute this' } }));
  await assert.rejects(stageExtensionForPackaging(f.root, f.build, f.stage), /refuses manifest vscode:prepublish/);
  await absent(f.stage);
});

for (const location of ['media', 'runtime', 'build']) {
  test(`real staging rejects ${location} symlinks`, async t => {
    const f = await packageFixture(t);
    const directory = location === 'build' ? f.build : path.join(f.source, location);
    // Directory junctions are available without Windows symlink privileges.
    await symlink(f.scratch, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(stageExtensionForPackaging(f.root, f.build, f.stage), /non-regular/);
  });
}
