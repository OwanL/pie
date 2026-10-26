import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { copyPackageSkeleton, parseQualificationArgs, qualificationStages, qualifyDelivery, runQualificationStage, validateBrowserExecutable } from '../qualify-delivery.mjs';
import { watchChildProcess } from '../../lib/process-watchdog.mjs';
import { createOwnerRequire } from '../../lib/package-resolution.mjs';
import { extractCandidate, fingerprintCandidate, verifyCandidateIdentity } from '../lib/vsix-candidate.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const confirmed = { code: 0, outerConfirmed: true, innerConfirmed: true };

const candidateFingerprint = { sha256: 'a'.repeat(64), size: 123 };
const candidateIdentity = { extensionId: 'pie.pie', version: '1.2.3', buildId: 'b'.repeat(20), piRuntimeIdentity: 'fixture-runtime' };

async function candidateFixture(t, overrides = {}) {
  return fixture(t, {
    fingerprintCandidate: async () => ({ ...candidateFingerprint }),
    extractCandidate: async () => {},
    verifyCandidateIdentity: async () => ({ ...candidateIdentity }),
    ...overrides,
  });
}

async function assertNoSuccessEvidence(f) {
  assert.equal((await readdir(f.packageRoot)).includes('qualification-evidence.json'), false);
  assert.equal(f.events.some(event => event.startsWith('qualified:')), false);
  assert.equal(f.events.includes('remove'), false);
  assert.ok(f.events.some(event => event.includes(`RETAINED ${f.packageRoot}`)));
}

test('VSIX parser requires absolute paths, rejects duplicates and runtime combinations', () => {
  const vsix = path.join(os.tmpdir(), 'candidate.vsix');
  assert.deepEqual(parseQualificationArgs(['--vsix', vsix]), { vsix });
  assert.deepEqual(parseQualificationArgs([`--vsix=${vsix}`]), { vsix });
  for (const args of [['--vsix'], ['--vsix='], ['--vsix', 'relative.vsix'],
    ['--vsix', vsix, `--vsix=${vsix}`], ['--vsix', vsix, '--pi-runtime', os.tmpdir()],
    ['--pi-runtime', os.tmpdir(), '--vsix', vsix]]) assert.throws(() => parseQualificationArgs(args));
});

test('exact candidate runs only delivered hosts and retains identity/fingerprint evidence', async t => {
  const vsix = path.join(os.tmpdir(), 'candidate.vsix');
  const f = await candidateFixture(t, {
    copySkeleton: async () => assert.fail('candidate must not copy skeleton'),
    verifyRuntime: async () => assert.fail('candidate must not use checkout runtime'),
    extractCandidate: async (file, destination) => { assert.equal(file, vsix); assert.equal(destination, f.packageRoot); },
  });
  const result = await qualifyDelivery({ vsix }, undefined, f.dependencies);
  assert.equal(result.code, 0);
  assert.deepEqual(f.stages.map(item => item.stage.name), ['delivered-hosts']);
  assert.equal(f.stages[0].stage.env.PIE_DELIVERED_HOST_ROOT, f.packageRoot);
  assert.equal(f.stages[0].stage.env.PIE_DELIVERED_BROWSER_EXECUTABLE, process.execPath);
  assert.deepEqual(result.candidate, { path: vsix, ...candidateFingerprint, ...candidateIdentity });
  assert.deepEqual(JSON.parse(await readFile(result.evidencePath, 'utf8')), { candidate: result.candidate, packageRoot: f.packageRoot, qualification: 'passed: private standalone and mocked VS Code adapters plus headless browser first paint', installed: false, published: false });
  assert.equal(f.events.includes('remove'), false);
  assert.ok(f.events.some(event => event.includes(`RETAINED ${f.packageRoot}`)));
});

test('candidate hash or size mutation rejects without success evidence', async t => {
  for (const mutation of [{ sha256: 'c'.repeat(64) }, { size: 124 }]) {
    let fingerprints = 0;
    const f = await candidateFixture(t, { fingerprintCandidate: async () => ({ ...candidateFingerprint, ...(fingerprints++ ? mutation : {}) }) });
    await assert.rejects(qualifyDelivery({ vsix: path.join(os.tmpdir(), 'candidate.vsix') }, undefined, f.dependencies), /changed during qualification/u);
    assert.equal(fingerprints, 2);
    await assertNoSuccessEvidence(f);
  }
});

test('candidate uncertain completion, nested 125 and cancellation retain without success evidence', async t => {
  for (const mode of ['outer', 'inner', '125', 'cancel']) {
    const controller = new AbortController();
    const f = await candidateFixture(t, { runStage: async () => {
      if (mode === 'cancel') controller.abort();
      return { ...confirmed, ...(mode === 'outer' ? { outerConfirmed: false } : mode === 'inner' ? { innerConfirmed: false } : mode === '125' ? { code: 125 } : {}) };
    } });
    await assert.rejects(qualifyDelivery({ vsix: path.join(os.tmpdir(), 'candidate.vsix') }, controller.signal, f.dependencies));
    await assertNoSuccessEvidence(f);
  }
});

async function zipFixture(directory, entries, rewrite) {
  const yazl = createRequire(createOwnerRequire().resolve('@vscode/vsce/package.json'))('yazl');
  const zip = new yazl.ZipFile();
  const chunks = [];
  const bytes = new Promise((resolve, reject) => {
    zip.outputStream.on('data', chunk => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
  for (const [name, content, options] of entries) zip.addBuffer(Buffer.from(content), name, options);
  zip.end();
  const file = path.join(directory, 'candidate.vsix');
  const buffer = await bytes;
  await writeFile(file, rewrite ? rewrite(buffer) : buffer);
  return file;
}

test('real VSIX extraction excludes metadata and rejects duplicate, symlink and traversal entries', async t => {
  for (const mode of ['good', 'duplicate', 'symlink', 'traversal', 'unsafe-metadata']) {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pie-vsix-extract-'));
    t.after(() => rm(sandbox, { recursive: true, force: true }));
    const entries = [['extension/package.json', '{"name":"pie"}'], ['extension.vsixmanifest', 'metadata'], ['[Content_Types].xml', 'metadata']];
    if (mode === 'duplicate') entries.push(['extension/package.json', 'duplicate']);
    if (mode === 'symlink') entries.push(['extension/link', 'target', { mode: 0o120777 }]);
    if (mode === 'traversal') entries.push(['extension/xx/file', 'escape']);
    if (mode === 'unsafe-metadata') entries.push(['metadata/CON', 'unsafe']);
    const file = await zipFixture(sandbox, entries, mode === 'traversal'
      ? buffer => Buffer.from(buffer.toString('latin1').replaceAll('extension/xx/file', 'extension/../file'), 'latin1') : undefined);
    const destination = path.join(sandbox, 'extracted');
    if (mode === 'good') {
      await extractCandidate(file, destination);
      assert.deepEqual(await readdir(destination), ['package.json']);
      assert.equal(await readFile(path.join(destination, 'package.json'), 'utf8'), '{"name":"pie"}');
    } else await assert.rejects(extractCandidate(file, destination), /Duplicate|Nonregular|Unsafe|invalid relative path/u);
  }
});

test('candidate helper fingerprints bytes and rejects malformed package/build identity', async t => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pie-vsix-identity-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const file = path.join(sandbox, 'candidate.vsix');
  await writeFile(file, 'candidate bytes');
  assert.deepEqual(await fingerprintCandidate(file), { sha256: createHash('sha256').update('candidate bytes').digest('hex'), size: 15 });
  await assert.rejects(fingerprintCandidate(sandbox), /regular nonsymlink/u);
  await mkdir(path.join(sandbox, 'out/webview/panel'), { recursive: true });
  const valid = { publisher: 'pie', name: 'pie', main: './runtime/bootstrap.cjs', version: '1.0.0' };
  for (const patch of [{ publisher: 'other' }, { name: 'other' }, { main: './out/main.js' }, { version: '' }]) {
    await writeFile(path.join(sandbox, 'package.json'), JSON.stringify({ ...valid, ...patch }));
    await assert.rejects(verifyCandidateIdentity(sandbox), /Invalid candidate package identity/u);
  }
  await writeFile(path.join(sandbox, 'package.json'), JSON.stringify(valid));
  for (const [build, panel] of [['malformed', 'malformed'], ['a'.repeat(20), 'b'.repeat(20)]]) {
    await writeFile(path.join(sandbox, 'out/pie-build-id.txt'), build);
    await writeFile(path.join(sandbox, 'out/webview/panel/pie-build-id.txt'), panel);
    await assert.rejects(verifyCandidateIdentity(sandbox), /matching 20-hex/u);
  }
});

async function fixture(t, overrides = {}) {
  const packageRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pie-qualification-unit-')));
  // Unit doubles launch no children, so their temp files are always safe to remove.
  t.after(() => rm(packageRoot, { recursive: true, force: true }));
  const events = [];
  const stages = [];
  const dependencies = {
    root,
    env: { NODE_TEST_CONTEXT: 'child-v8', PIE_AGENT_PROCESS_ID: 'parent' },
    status: message => events.push(message),
    resolveBrowserExecutable: async () => { events.push('browser-resolve'); return process.execPath; },
    createPackage: async () => { events.push('create'); return packageRoot; },
    verifyRuntime: async artifact => { events.push(`verify:${artifact}`); },
    copySkeleton: async () => { events.push('copy'); },
    remove: async directory => { assert.equal(directory, packageRoot); events.push('remove'); },
    runStage: async (stage, options) => { stages.push({ stage, options }); events.push(stage.name); return confirmed; },
    ...overrides,
  };
  return { packageRoot, dependencies, events, stages };
}

test('strict options: help, absolute runtime, duplicate/missing/unknown rejection', () => {
  assert.deepEqual(parseQualificationArgs([]), { artifactDir: undefined });
  assert.deepEqual(parseQualificationArgs(['--help']), { help: true });
  assert.deepEqual(parseQualificationArgs(['-h']), { help: true });
  const artifact = path.join(os.tmpdir(), 'caller-runtime');
  assert.deepEqual(parseQualificationArgs([`--pi-runtime=${artifact}`]), { artifactDir: path.resolve(artifact) });
  assert.deepEqual(parseQualificationArgs(['--pi-runtime', artifact]), { artifactDir: path.resolve(artifact) });
  for (const args of [['--pi-runtime'], ['--pi-runtime='], ['--pi-runtime', 'relative'], ['--publish'], ['--help', '--publish'], ['--pi-runtime', artifact, '--pi-runtime', artifact]]) {
    assert.throws(() => parseQualificationArgs(args));
  }
});

test('stage plan delegates build and native tests without publishing/installing or SDK override', () => {
  const packageRoot = path.join(os.tmpdir(), 'qualification-package');
  const artifact = path.join(os.tmpdir(), 'caller-runtime');
  const stages = qualificationStages(root, packageRoot, artifact, process.execPath);
  assert.equal(stages.length, 2);
  assert.deepEqual(stages[0].args, [path.join(root, 'scripts/build/build.mjs'), '--delivery', '--no-sync', '--output-dir', path.join(packageRoot, 'out'), '--pi-runtime', artifact]);
  assert.deepEqual(stages[1].args, [path.join(root, 'scripts/verification/test-node.mjs'), 'scripts/verification/test/delivered-hosts.test.mjs']);
  assert.deepEqual(stages[1].env, { PIE_RUN_DELIVERED_HOST_TESTS: '1', PIE_RUN_DELIVERED_BROWSER_TESTS: '1', PIE_DELIVERED_HOST_ROOT: packageRoot, PIE_DELIVERED_BROWSER_EXECUTABLE: process.execPath });
});

test('default compilation precedes new package, build, host/browser lane and confirmed cleanup', async t => {
  const f = await fixture(t);
  const result = await qualifyDelivery({}, undefined, f.dependencies);
  assert.equal(result.code, 0);
  assert.deepEqual(f.events.filter(event => ['pi-compile', 'create', 'copy', 'delivery-build', 'delivered-hosts', 'remove'].includes(event)), ['pi-compile', 'create', 'copy', 'delivery-build', 'delivered-hosts', 'remove']);
  assert.equal(f.stages[0].stage.args[0], path.join(root, 'scripts/build/pi-workspace.mjs'));
  assert.equal(f.stages[1].stage.args.includes('--pi-runtime'), false);
  assert.equal(f.stages[2].options.env.NODE_TEST_CONTEXT, undefined);
  assert.equal(f.stages[2].stage.env.PIE_DELIVERED_BROWSER_EXECUTABLE, process.execPath);
  assert.equal(f.stages[0].stage.env?.PIE_DELIVERED_BROWSER_EXECUTABLE, undefined);
  assert.ok(f.events.indexOf('browser-resolve') < f.events.indexOf('pi-compile'));
  assert.ok(f.events.some(event => event.includes('NOT installed/published')));
});

test('explicit runtime is verified/reused without compilation or caller deletion', async t => {
  const f = await fixture(t);
  const artifactDir = path.join(os.tmpdir(), 'caller-artifact');
  await qualifyDelivery({ artifactDir }, undefined, f.dependencies);
  assert.ok(f.events.includes(`verify:${artifactDir}`));
  assert.ok(f.events.indexOf('browser-resolve') < f.events.indexOf(`verify:${artifactDir}`));
  assert.equal(f.stages[1].stage.env.PIE_DELIVERED_BROWSER_EXECUTABLE, process.execPath);
  assert.deepEqual(f.stages.map(item => item.stage.name), ['delivery-build', 'delivered-hosts']);
  assert.deepEqual(f.stages[0].stage.args.slice(-2), ['--pi-runtime', artifactDir]);
  assert.equal(f.events.filter(event => event === 'remove').length, 1);
});

test('missing or invalid browser fails before compilation, artifact verification or package creation', async t => {
  for (const explicit of [false, true]) {
    for (const executable of ['relative-chromium', path.join(os.tmpdir(), 'pie-missing-browser', 'chrome.exe'), os.tmpdir()]) {
      const f = await fixture(t, { resolveBrowserExecutable: async () => executable });
      await assert.rejects(qualifyDelivery(explicit ? { artifactDir: path.join(os.tmpdir(), 'runtime') } : {}, undefined, f.dependencies), /Delivered-browser blocker/u);
      assert.equal(f.stages.length, 0);
      assert.equal(f.events.includes('create'), false);
      assert.equal(f.events.some(event => event.startsWith('verify:')), false);
      assert.equal(f.events.includes('remove'), false);
    }
  }
  assert.equal(await validateBrowserExecutable(process.execPath), process.execPath);
});

test('failed verification or compilation never creates a delivery package', async t => {
  for (const explicit of [false, true]) {
    const f = await fixture(t, {
      verifyRuntime: async () => { throw new Error('bad artifact'); },
      runStage: async () => ({ ...confirmed, code: 1 }),
    });
    await assert.rejects(qualifyDelivery(explicit ? { artifactDir: path.join(os.tmpdir(), 'runtime') } : {}, undefined, f.dependencies));
    assert.equal(f.events.includes('create'), false);
    assert.equal(f.events.includes('remove'), false);
  }
});

test('build failure/uncertainty and nested tests 125/failure retain package and stop sequencing', async t => {
  for (const [failedStage, result] of [
    ['delivery-build', { ...confirmed, code: 1 }],
    ['delivery-build', { ...confirmed, outerConfirmed: false }],
    ['delivery-build', { ...confirmed, innerConfirmed: false }],
    ['delivered-hosts', { ...confirmed, code: 125 }],
    ['delivered-hosts', { ...confirmed, code: 1 }],
    ['delivered-hosts', { ...confirmed, innerConfirmed: false }],
  ]) {
    const names = [];
    const f = await fixture(t, { runStage: async stage => { names.push(stage.name); return stage.name === failedStage ? result : confirmed; } });
    await assert.rejects(qualifyDelivery({}, undefined, f.dependencies), /retained/u);
    assert.equal(f.events.includes('remove'), false);
    assert.ok(f.events.some(event => event.includes(`RETAINED ${f.packageRoot}`)));
    assert.equal(names.at(-1), failedStage);
  }
});

test('launcher exception or cancellation during a stage retain even after outer extinction', async t => {
  for (const mode of ['throw', 'abort']) {
    const controller = new AbortController();
    const f = await fixture(t, { runStage: async stage => {
      if (stage.name === 'delivery-build') {
        if (mode === 'throw') throw new Error('watchdog failed');
        controller.abort();
      }
      return confirmed;
    } });
    await assert.rejects(qualifyDelivery({}, controller.signal, f.dependencies));
    assert.equal(f.events.includes('remove'), false);
    assert.ok(f.events.some(event => event.includes('RETAINED')));
  }
});

test('pre-aborted invocation creates no package; skeleton failure before child safely removes owned package', async t => {
  const controller = new AbortController();
  controller.abort();
  const f = await fixture(t);
  await assert.rejects(qualifyDelivery({}, controller.signal, f.dependencies));
  assert.equal(f.events.includes('create'), false);
  const failed = await fixture(t, { copySkeleton: async () => { throw new Error('copy failed'); } });
  await assert.rejects(qualifyDelivery({}, undefined, failed.dependencies), /copy failed/u);
  assert.equal(failed.events.includes('remove'), true);
});

test('skeleton copies only manifest, runtime CJS and icon, never an existing out', async t => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pie-skeleton-unit-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const source = path.join(sandbox, 'application/hosts/vscode');
  const destination = path.join(sandbox, 'package');
  for (const directory of ['runtime', 'media', 'out']) await mkdir(path.join(source, directory), { recursive: true });
  await mkdir(path.join(sandbox, 'lib/windows-runtime-lock'), { recursive: true });
  await mkdir(destination);
  for (const [name, bytes] of Object.entries({ 'package.json': '{}', 'runtime/bootstrap.cjs': 'bootstrap', 'runtime/helper.cjs': 'helper', 'runtime/ignored.txt': 'ignored', 'runtime/windows-runtime-lock.cjs': 'checkout adapter', 'media/icon.svg': '<svg/>', 'out/stale.js': 'stale' })) await writeFile(path.join(source, name), bytes);
  await writeFile(path.join(sandbox, 'lib/windows-runtime-lock/windows-runtime-lock.cjs'), 'neutral primitive');
  await copyPackageSkeleton(sandbox, destination);
  assert.deepEqual((await readdir(destination)).sort(), ['media', 'package.json', 'runtime']);
  assert.deepEqual((await readdir(path.join(destination, 'runtime'))).sort(), ['bootstrap.cjs', 'helper.cjs', 'windows-runtime-lock.cjs']);
  assert.equal(await readFile(path.join(destination, 'media/icon.svg'), 'utf8'), '<svg/>');
  assert.equal(await readFile(path.join(destination, 'runtime/windows-runtime-lock.cjs'), 'utf8'), 'neutral primitive');
});

// Regression: the checkout-relative forwarding adapter cannot satisfy its
// require once the runtime CJS files are relocated outside the repository.
// The packaged startup loader must load the standalone neutral lock owner
// bytes so every relative require resolves inside the delivery package.
test('relocated packaged runtime requires stay in the package via the neutral lock primitive', async t => {
  const destination = await mkdtemp(path.join(os.tmpdir(), 'pie-skeleton-relocated-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  await copyPackageSkeleton(root, destination);
  const packagedRuntime = path.join(destination, 'runtime');
  assert.deepEqual(await readFile(path.join(packagedRuntime, 'windows-runtime-lock.cjs')),
    await readFile(path.join(root, 'lib/windows-runtime-lock/windows-runtime-lock.cjs')));
  assert.notDeepEqual(await readFile(path.join(packagedRuntime, 'windows-runtime-lock.cjs')),
    await readFile(path.join(root, 'application/hosts/vscode/runtime/windows-runtime-lock.cjs')));
  // Relative requires in the packaged runtime CJS must resolve within the
  // package; the checkout wrapper resolves outside and fails relocated.
  for (const name of ['bootstrap.cjs', 'runtime-generations.cjs', 'windows-runtime-lock.cjs']) {
    const packaged = await readFile(path.join(packagedRuntime, name), 'utf8');
    for (const [, request] of packaged.matchAll(/require\('([^']+)'\)/gu)) {
      if (!request.startsWith('./')) continue;
      const resolved = path.resolve(packagedRuntime, request);
      assert.ok(resolved.startsWith(packagedRuntime + path.sep), `packaged ${name} require ${request} stays in the package`);
      await assert.ok((await readFile(resolved)).length > 0);
    }
  }
  // End-to-end relocated require, without the checkout: the packaged startup
  // helper loads and exports its lock API (exactly the qualification fixture path).
  const relocated = createRequire(path.join(packagedRuntime, 'relocated-require.cjs'))('./runtime-generations.cjs');
  assert.equal(typeof relocated.resolveRuntimeGeneration, 'function');
});

test('no-close abort/timeout awaits identity-safe watchdog settlement, unreferences child and retains package', { timeout: 3_000 }, async t => {
  for (const reason of ['abort', 'timeout']) {
    const controller = new AbortController();
    let terminated = false;
    let settled = false;
    let unreferenced = false;
    let watchdog;
    const child = new EventEmitter();
    child.unref = () => { assert.equal(settled, true); unreferenced = true; };
    child.kill = () => assert.fail('qualifier must not add a PID-based kill fallback');
    const f = await fixture(t, { runStage: async (stage, options) => {
      if (stage.name !== 'delivery-build') return confirmed;
      const result = await runQualificationStage(stage, options, {
        spawn: (_command, _args, spawnOptions) => {
          assert.equal(spawnOptions.stdio, 'inherit');
          if (reason === 'abort') setTimeout(() => controller.abort(), 10);
          return child; // intentionally never emits close
        },
        watchChildProcess: (owned, watchOptions) => {
          watchdog = watchChildProcess(owned, {
            ...watchOptions, timeoutMs: reason === 'timeout' ? 10 : 0,
            killTree: async captured => {
              assert.equal(captured, child);
              terminated = true;
              await new Promise(resolve => setTimeout(resolve, 20));
              settled = true;
              return { gone: false, survivors: [42], diagnostics: ['creation identity unavailable; kill skipped'] };
            },
          });
          return watchdog;
        },
      });
      assert.deepEqual(result, { code: 1, outerConfirmed: false, innerConfirmed: false });
      return result;
    } });
    await assert.rejects(qualifyDelivery({}, controller.signal, f.dependencies), /retained/u);
    assert.equal(terminated, true);
    assert.equal(settled, true);
    assert.equal(unreferenced, true);
    assert.equal(watchdog.aborted, reason === 'abort');
    assert.equal(watchdog.timedOut, reason === 'timeout');
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(f.events.includes('remove'), false);
    assert.ok(f.events.some(event => event.includes(`RETAINED ${f.packageRoot}`)));
  }
});

test('stage watchdog: isolated spawn, settle required, nested 125 and interruption cannot confirm inner completion', async () => {
  for (const scenario of [
    { code: 0, gone: true, safe: true },
    { code: 125, gone: true, safe: false },
    { code: 1, gone: true, safe: false },
    { code: 0, gone: false, safe: false },
    { code: 0, gone: true, aborted: true, safe: false },
    { code: 0, gone: true, timedOut: true, safe: false },
    { code: null, gone: true, childSignal: 'SIGTERM', safe: false },
  ]) {
    let settled = false;
    const result = await runQualificationStage({ name: 'delivered-hosts', args: ['authority.mjs'], env: { TEST: '1' } }, { root, env: {} }, {
      spawn: (command, args, options) => {
        assert.equal(command, process.execPath);
        assert.deepEqual(args, ['authority.mjs']);
        assert.equal(options.detached, process.platform !== 'win32');
        assert.equal(options.env.TEST, '1');
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('close', scenario.code, scenario.childSignal));
        return child;
      },
      watchChildProcess: () => ({ aborted: scenario.aborted, timedOut: scenario.timedOut, settle: async () => { settled = true; return { gone: scenario.gone, survivors: [] }; } }),
    });
    assert.equal(settled, true);
    assert.equal(result.code === 0 && result.outerConfirmed && result.innerConfirmed, scenario.safe);
  }
});
