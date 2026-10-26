import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { qualificationInputs, verifyManagedIntegrationQualification } from '../managed-qualification-receipt.mjs';
import path from 'node:path';
import test from 'node:test';
import { parseQualificationArgs, qualifyManagedIntegrations } from '../qualify-managed-integrations.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const completion = { code: 0, outerConfirmed: true, innerConfirmed: true };
const fixtureUrls = ['https://fixture.example/article', 'https://fixture.example/static.pdf', 'https://fixture.example/static.png'];

export async function fixture(t) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'managed-qualification-test-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const selection = { stageRoot: path.join(temp, 'stage'), artifactDir: path.join(temp, 'artifact'), evidenceParent: path.join(temp, 'evidence') };
  const checkout = path.join(temp, 'checkout');
  for (const dir of [...Object.values(selection), checkout]) await mkdir(dir);
  const recipeRoot = fileURLToPath(new URL('../../../', import.meta.url));
  for (const name of Object.keys(await qualificationInputs(recipeRoot))) {
    const destination = path.join(checkout, 'scripts', 'verification', name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(recipeRoot, 'scripts', 'verification', name)));
  }
  const files = {
    'closure-receipt.json': '{"immutable":true}',
    'node_modules/@napi-rs/keyring/index.js': '// fake, never imported',
    'node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node': 'fake native, never loaded',
    'node_modules/recheck-windows-x64/recheck.exe': 'fake executable, never launched',
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(selection.stageRoot, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const sdkPath = path.join(selection.artifactDir, 'sdk');
  await mkdir(path.join(sdkPath, 'dist'), { recursive: true });
  await writeFile(path.join(sdkPath, 'dist/index.js'), '// fake SDK, never imported');
  const receipt = { disposition: { name: 'omit-optional-canvas-3.2.3' }, pendingOptionalBuilds: [], inventorySha256: 'inventory-before', inventory: Object.keys(files).map(path => ({ path })) };
  const runtime = { artifactDir: selection.artifactDir, sdkPath, identity: 'runtime-before', manifest: { target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules } } };
  const calls = [];
  const f = { selection, receipt, runtime, calls, files };
  f.deps = {
    root: checkout,
    env: { PATH: 'must-not-leak', NODE_OPTIONS: 'must-not-leak', PROVIDER_API_KEY: 'must-not-leak' },
    verifyStage: async (root, options) => {
      assert.equal(root, selection.stageRoot);
      assert.deepEqual(options, { requireReady: false });
      return { root, receipt, packages: { 'pi-web-access': root, 'pi-mcp-adapter': root } };
    },
    verifyRuntime: async root => { assert.equal(root, selection.artifactDir); return runtime; },
    runStage: async (stage, options) => {
      const config = stage.name === 'managed-integrations' ? JSON.parse(await readFile(stage.args[1], 'utf8')) : JSON.parse(stage.args[1]);
      calls.push({ stage, options, config });
      const report = stage.name === 'managed-integrations'
        ? { ok: true, denied: [], errors: [], identity: true, moduleExportLoad: { esmWrapper: true, cjsWrapper: true, cjsNative: true }, facadeBinding: { esmDefault: true, esmNamed: true, cjsWrapper: true, cjsNative: true }, denyDiagnostics: [], extensions: [{ path: path.join(selection.stageRoot, 'index.ts'), tools: ['web_search', 'source_check', 'fetch_content', 'get_search_content'] }, { path: path.join(selection.stageRoot, 'index.ts'), tools: ['mcpScript', 'mcp'] }, { path: path.join(config.workDir, 'probe.ts'), tools: [] }], requests: fixtureUrls, results: [{ url: fixtureUrls[0], content: 'Qualification paragraph' }, { url: fixtureUrls[1], content: 'saved to: fake' }, { url: fixtureUrls[2], thumbnail: 'fake' }], imageWorker: [{ messages: 1, results: 1, exitCode: 0, exited: true, errors: [] }], legacySmoke: [false, true].map(disabled => ({ disabled, scope: 'project', suppressed: true, errors: [] })) }
        : { ok: true, denied: [], result: { status: 'safe', source: '^a+$', flags: '', checker: 'automaton', complexity: { type: 'linear' } }, observed: [{ executable: path.join(selection.stageRoot, 'node_modules/recheck-windows-x64/recheck.exe'), sha256: digest(files['node_modules/recheck-windows-x64/recheck.exe']) }] };
      await f.onReport?.(report, stage, config);
      await writeFile(config.resultPath, JSON.stringify(report));
      return f.onComplete ? f.onComplete(stage) : { ...completion };
    },
  };
  f.assertImmutable = async () => {
    for (const [name, content] of Object.entries(files)) assert.equal(await readFile(path.join(selection.stageRoot, name), 'utf8'), content);
    assert.deepEqual((await readdir(selection.stageRoot)).sort(), ['closure-receipt.json', 'node_modules']);
  };
  f.failure = async () => {
    const dirs = await readdir(selection.evidenceParent);
    assert.equal(dirs.length, 1);
    const evidence = path.join(selection.evidenceParent, dirs[0]);
    assert.equal((await readdir(evidence)).includes('qualification-receipt.json'), false);
    return JSON.parse(await readFile(path.join(evidence, 'failure.json'), 'utf8'));
  };
  return f;
}

async function consumerFixture(t) {
  const f = await fixture(t);
  const result = await qualifyManagedIntegrations(f.selection, undefined, f.deps);
  f.receiptPath = result.receiptPath;
  f.proof = JSON.parse(await readFile(f.receiptPath, 'utf8'));
  f.verify = () => verifyManagedIntegrationQualification({ ...f.selection, receiptPath: f.receiptPath }, f.deps);
  f.save = () => writeFile(f.receiptPath, JSON.stringify(f.proof));
  // Keep all three representations consistent so forged facts reach semantic validation.
  f.forgeReport = async (index, mutate) => {
    const child = f.proof.children[index];
    mutate(child.report);
    const bytes = JSON.stringify(child.report);
    await writeFile(child.resultPath, bytes);
    child.resultSha256 = digest(bytes);
    await f.save();
  };
  return f;
}

test('consumer accepts valid evidence without writing stage, runtime, or evidence', async t => {
  const f = await consumerFixture(t);
  const paths = [f.receiptPath, ...f.proof.children.map(child => child.resultPath), path.join(f.runtime.sdkPath, 'dist/index.js')];
  const before = await Promise.all(paths.map(file => readFile(file)));
  const evidenceBefore = await readdir(path.dirname(f.receiptPath));
  const verified = await f.verify();
  assert.deepEqual(verified.receipt, f.proof);
  assert.deepEqual(await Promise.all(paths.map(file => readFile(file))), before);
  assert.deepEqual(await readdir(path.dirname(f.receiptPath)), evidenceBefore);
  await f.assertImmutable();
});

test('consumer rejects forged and missing report facts with consistent report hashes', async t => {
  const cases = [
    [0, r => { delete r.identity; }],
    [0, r => { delete r.moduleExportLoad; }],
    [0, r => { r.facadeBinding.esmNamed = false; }],
    [0, r => { r.extensions.reverse(); }],
    [0, r => { r.extensions[0].tools.pop(); }],
    [0, r => { r.extensions.push({ path: 'extra', tools: [] }); }],
    [0, r => { r.requests[0] = 'https://other.example/'; }],
    [0, r => { r.results[0].url = r.results[1].url; }],
    [0, r => { delete r.results[0].content; }],
    [0, r => { r.imageWorker[0].messages = 0; }],
    [0, r => { r.imageWorker[0].results = 2; }],
    [0, r => { r.imageWorker[0].exitCode = 1; }],
    [0, r => { r.imageWorker[0].exited = false; }],
    [0, r => { r.imageWorker[0].errors.push('error'); }],
    [0, r => { r.denyDiagnostics.push({ kind: 'network' }); }],
    [0, r => { delete r.denyDiagnostics; }],
    [0, r => { r.legacySmoke[0].errors.push('error'); }],
    [1, r => { r.result.source = '.*'; }],
    [1, r => { r.result.flags = 'i'; }],
    [1, r => { r.result.checker = 'fuzz'; }],
    [1, r => { r.result.complexity.type = 'exponential'; }],
    [1, r => { r.observed[0].sha256 = '0'.repeat(64); }],
  ];
  for (const [index, mutate] of cases) await t.test(`${index}: ${mutate}`, async t => {
    const f = await consumerFixture(t);
    await f.forgeReport(index, mutate);
    await assert.rejects(f.verify(), /Incomplete|identity mismatch/);
  });
});

test('consumer rejects child order, names, failures, and unconfirmed teardown', async t => {
  const mutations = [
    r => r.children.reverse(),
    r => { r.children[0].name = 'other'; },
    r => { r.children[0].completion.code = 1; },
    r => { r.children[1].completion.outerConfirmed = false; },
    r => { r.children[0].completion.innerConfirmed = false; },
    r => { r.teardown.outerConfirmed = false; },
    r => { r.teardown.innerConfirmed = false; },
  ];
  for (const mutate of mutations) {
    const f = await consumerFixture(t);
    mutate(f.proof);
    await f.save();
    await assert.rejects(f.verify(), /completion|teardown/);
  }
});

test('consumer rejects altered bytes, hashes, and embedded report correspondence', async t => {
  for (const mode of ['bytes', 'hash', 'correspondence']) {
    const f = await consumerFixture(t);
    const child = f.proof.children[0];
    if (mode === 'bytes') await writeFile(child.resultPath, '{}');
    if (mode === 'hash') child.resultSha256 = '0'.repeat(64);
    if (mode === 'correspondence') child.report.identity = false;
    await f.save();
    await assert.rejects(f.verify(), mode === 'correspondence' ? /correspondence/ : /hash mismatch/);
  }
});

test('consumer rejects recipe drift and stage/runtime binding mismatches', async t => {
  for (const mode of ['recipe', 'stage-root', 'receipt', 'inventory', 'runtime', 'target']) {
    const f = await consumerFixture(t);
    if (mode === 'recipe') await writeFile(path.join(f.deps.root, 'scripts/verification/fixtures/managed-integrations-static.mjs'), '// drift');
    if (mode === 'stage-root') f.proof.stage.root = f.runtime.artifactDir;
    if (mode === 'receipt') await writeFile(path.join(f.selection.stageRoot, 'closure-receipt.json'), '{}');
    if (mode === 'inventory') f.receipt.inventorySha256 = 'changed';
    if (mode === 'runtime') f.runtime.identity = 'changed';
    if (mode === 'target') f.proof.runtime.target.arch = 'other';
    await f.save();
    await assert.rejects(f.verify(), /recipe mismatch|binding mismatch/);
  }
});

test('consumer accepts relocated runtime with the same identity and target', async t => {
  const f = await consumerFixture(t);
  const artifactDir = path.join(path.dirname(f.selection.artifactDir), 'relocated-runtime');
  await mkdir(artifactDir);
  const runtime = { ...f.runtime, artifactDir };
  const verified = await verifyManagedIntegrationQualification({ ...f.selection, artifactDir, receiptPath: f.receiptPath }, {
    ...f.deps,
    verifyRuntime: async root => { assert.equal(root, artifactDir); return runtime; },
  });
  assert.equal(verified.runtime.artifactDir, artifactDir);
  assert.equal(verified.runtime.identity, f.proof.runtime.identity);
});

test('CLI accepts only complete explicit absolute paths and strict unique options', () => {
  const absolute = os.tmpdir();
  assert.deepEqual(parseQualificationArgs(['--stage', absolute, `--pi-runtime=${absolute}`, '--evidence-parent', absolute]), { stageRoot: path.resolve(absolute), artifactDir: path.resolve(absolute), evidenceParent: path.resolve(absolute) });
  assert.deepEqual(parseQualificationArgs(['--help']), { help: true });
  for (const args of [[], ['--stage'], ['--stage='], ['--stage', 'relative'], ['--unknown', absolute], ['--stage', absolute, '--stage', absolute], ['--help', '--stage', absolute], ['--stage', absolute, '--pi-runtime', absolute]]) assert.throws(() => parseQualificationArgs(args));
});

test('omitted disposition and zero pending builds are required before launching children', async t => {
  for (const mode of ['missing', 'wrong', 'pending']) {
    const f = await fixture(t);
    if (mode === 'missing') delete f.receipt.disposition;
    if (mode === 'wrong') f.receipt.disposition.name = 'other';
    if (mode === 'pending') f.receipt.pendingOptionalBuilds.push('canvas');
    await assert.rejects(qualifyManagedIntegrations(f.selection, undefined, f.deps), /omitted canvas disposition/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await readdir(f.selection.evidenceParent), []);
    await f.assertImmutable();
  }
});

test('two injected child reports bind success evidence outside the immutable stage', async t => {
  const f = await fixture(t);
  const result = await qualifyManagedIntegrations(f.selection, undefined, f.deps);
  assert.equal(result.code, 0);
  assert.deepEqual(f.calls.map(x => x.stage.name), ['managed-integrations', 'managed-recheck']);
  assert.ok(result.receiptPath.startsWith(f.selection.evidenceParent + path.sep));
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.equal(receipt.passed, true);
  assert.equal(receipt.recipe, 'managed-integrations-provider-free-v1');
  assert.equal(receipt.stage.receiptSha256, digest(f.files['closure-receipt.json']));
  assert.equal(receipt.stage.inventorySha256, f.receipt.inventorySha256);
  assert.equal(receipt.runtime.identity, f.runtime.identity);
  assert.deepEqual(Object.keys(receipt.inputs).sort(), ['fixtures/image-worker-guard.mjs', 'fixtures/image-worker-preload.mjs', 'fixtures/keyring-denied-facade.mjs', 'fixtures/managed-integrations-child.mjs', 'fixtures/managed-integrations-static.mjs', 'fixtures/managed-recheck-child.mjs', 'managed-qualification-receipt.mjs', 'qualify-managed-integrations.mjs'].sort());
  for (const hash of Object.values(receipt.inputs)) assert.match(hash, /^[a-f0-9]{64}$/);
  for (const child of receipt.children) assert.equal(child.resultSha256, digest(await readFile(child.resultPath)));
  for (const { options, config } of f.calls) {
    assert.equal(options.root, config.workDir);
    for (const key of ['PATH', 'NODE_OPTIONS', 'PROVIDER_API_KEY']) assert.equal(options.env[key], undefined);
    assert.ok(config.privateRoot.startsWith(result.evidenceDir + path.sep));
  }
  await f.assertImmutable();
});

test('stage receipt, inventory, and runtime identity drift after children reject success', async t => {
  for (const mode of ['receipt', 'inventory', 'runtime']) {
    const f = await fixture(t);
    f.onComplete = async stage => {
      if (stage.name === 'managed-recheck') {
        if (mode === 'receipt') await writeFile(path.join(f.selection.stageRoot, 'closure-receipt.json'), 'changed');
        if (mode === 'inventory') f.receipt.inventorySha256 = 'inventory-after';
        if (mode === 'runtime') f.runtime.identity = 'runtime-after';
      }
      return { ...completion };
    };
    await assert.rejects(qualifyManagedIntegrations(f.selection, undefined, f.deps), /changed during qualification/);
    assert.equal((await f.failure()).revalidation.unchanged, false);
  }
});

test('denial, child failures, uncertain teardown, and cancellation retain failure without success', async t => {
  for (const mode of ['denied', 'nonzero', '125', 'outer', 'inner', 'cancel']) {
    const f = await fixture(t);
    const controller = new AbortController();
    f.onReport = report => { if (mode === 'denied') report.denied.push('network'); };
    f.onComplete = () => {
      if (mode === 'cancel') controller.abort();
      return { ...completion, ...(mode === 'nonzero' ? { code: 1 } : mode === '125' ? { code: 125 } : mode === 'outer' ? { outerConfirmed: false } : mode === 'inner' ? { innerConfirmed: false } : {}) };
    };
    await assert.rejects(qualifyManagedIntegrations(f.selection, controller.signal, f.deps));
    const failure = await f.failure();
    assert.equal(failure.confirmed, !['outer', 'inner'].includes(mode));
    assert.equal(f.calls.length, 1);
    await f.assertImmutable();
  }
});
