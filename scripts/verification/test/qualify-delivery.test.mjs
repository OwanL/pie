import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { copyPackageSkeleton, parseQualificationArgs, qualificationStages, qualifyDelivery, runQualificationStage, validateBrowserExecutable } from '../qualify-delivery.mjs';
import { watchChildProcess } from '../../lib/process-watchdog.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const confirmed = { code: 0, outerConfirmed: true, innerConfirmed: true };

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
  await mkdir(destination);
  for (const [name, bytes] of Object.entries({ 'package.json': '{}', 'runtime/bootstrap.cjs': 'bootstrap', 'runtime/helper.cjs': 'helper', 'runtime/ignored.txt': 'ignored', 'media/icon.svg': '<svg/>', 'out/stale.js': 'stale' })) await writeFile(path.join(source, name), bytes);
  await copyPackageSkeleton(sandbox, destination);
  assert.deepEqual((await readdir(destination)).sort(), ['media', 'package.json', 'runtime']);
  assert.deepEqual((await readdir(path.join(destination, 'runtime'))).sort(), ['bootstrap.cjs', 'helper.cjs']);
  assert.equal(await readFile(path.join(destination, 'media/icon.svg'), 'utf8'), '<svg/>');
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
