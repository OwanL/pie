import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withPiRuntime } from '../pi-runtime-context.mjs';
import {
  PI_RUNTIME_PACKAGES,
  PI_RUNTIME_SDK_RELATIVE_PATH,
  verifyPiRuntimeArtifact,
  writePiRuntimeManifest,
} from '../pi-runtime-artifact.mjs';

const target = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
const provenance = {
  upstreamVersion: '0.80.6',
  upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b',
  sourceTreeSha256: 'a'.repeat(64),
  lockSha256: 'b'.repeat(64),
  target,
};
const sdkAssets = [
  'dist/cli.js', 'dist/rpc-entry.js',
  'dist/modes/interactive/theme/dark.json',
  'dist/modes/interactive/theme/light.json',
  'dist/modes/interactive/theme/theme-schema.json',
  'dist/modes/interactive/assets/clankolas.png',
  'dist/core/export-html/template.html',
  'dist/core/export-html/template.css',
  'dist/core/export-html/template.js',
  'dist/core/export-html/vendor/marked.min.js',
  'dist/core/export-html/vendor/highlight.min.js',
];

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function trackCleanup(t, parent) {
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
}

function fakeDependencies(t, { onBuild, onVerify } = {}) {
  const calls = { builds: [], verifications: [], parents: [], outputWasPresent: [] };
  return {
    calls,
    dependencies: {
      async buildPiRuntime(args) {
        calls.builds.push(args);
        calls.outputWasPresent.push(await exists(args.output));
        const parent = path.dirname(args.output);
        calls.parents.push(parent);
        trackCleanup(t, parent);
        if (onBuild) return onBuild(args, calls);
        const artifactDir = path.join(args.output, 'pi-runtime');
        await mkdir(artifactDir, { recursive: true });
        return { artifactDir, sdkPath: 'builder-sdk', identity: 'builder-identity' };
      },
      async verifyPiRuntimeArtifact(artifactDir) {
        calls.verifications.push(artifactDir);
        if (onVerify) return onVerify(artifactDir, calls);
        return {
          artifactDir,
          sdkPath: path.join(artifactDir, 'verified-sdk'),
          identity: 'verified-identity',
        };
      },
    },
  };
}

async function put(root, relative, text) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function validArtifactFixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pie-pi-runtime-context-test-'));
  trackCleanup(t, parent);
  const root = path.join(parent, 'pi-runtime');
  const files = [];
  for (const name of PI_RUNTIME_PACKAGES) {
    const prefix = `node_modules/${name}/`;
    files.push([`${prefix}package.json`, JSON.stringify({
      name, version: '0.80.6', type: 'module', main: './dist/index.js',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      dependencies: { typebox: '1.1.38' },
    })]);
    files.push([`${prefix}dist/index.js`, "export { Type } from 'typebox';\n"]);
    files.push([`${prefix}LICENSE`, 'MIT License\nCopyright (c) 2025 Mario Zechner\n']);
  }
  for (const file of sdkAssets) files.push([`${PI_RUNTIME_SDK_RELATIVE_PATH}/${file}`, `fixture:${file}\n`]);
  files.push(['node_modules/typebox/package.json', JSON.stringify({
    name: 'typebox', version: '1.1.38', type: 'module', exports: './index.js',
  })]);
  files.push(['node_modules/typebox/index.js', 'export const Type = {};\n']);
  files.push(['node_modules/typebox/LICENSE', 'MIT third-party fixture\n']);
  for (const [file, text] of files) await put(root, file, text);
  return root;
}

function assertFrozenContext(context) {
  assert.equal(Object.isFrozen(context), true);
  assert.deepEqual(Object.keys(context).sort(), [
    'artifactDir', 'confirmChildCompletion', 'identity', 'sdkPath',
  ].sort());
  assert.equal(typeof context.confirmChildCompletion, 'function');
}

test('one acquired runtime is shared by callback children and cleaned after confirmed callback settlement', async (t) => {
  const { calls, dependencies } = fakeDependencies(t);
  let notifyConfirmed;
  const confirmed = new Promise((resolve) => { notifyConfirmed = resolve; });
  let releaseCallback;
  const delayedCallback = new Promise((resolve) => { releaseCallback = resolve; });
  const result = { arbitrary: 'callback result' };
  let acquiredParent;

  const execution = withPiRuntime({}, async (context) => {
    assertFrozenContext(context);
    acquiredParent = calls.parents[0];
    assert.equal(context.artifactDir, path.join(calls.builds[0].output, 'pi-runtime'));
    assert.equal(context.sdkPath, path.join(context.artifactDir, 'verified-sdk'));
    assert.equal(context.identity, 'verified-identity');

    const childResults = await Promise.all(['first', 'second', 'third'].map(async (name) => {
      await Promise.resolve();
      return { name, artifactDir: context.artifactDir, sdkPath: context.sdkPath, identity: context.identity };
    }));
    assert.deepEqual(childResults.map((child) => child.artifactDir), Array(3).fill(context.artifactDir));
    assert.deepEqual(childResults.map((child) => child.identity), Array(3).fill(context.identity));

    await context.confirmChildCompletion();
    notifyConfirmed();
    await delayedCallback;
    assert.equal(await exists(acquiredParent), true, 'confirmation does not remove files while the callback is still running');
    return result;
  }, dependencies);

  await confirmed;
  assert.equal(calls.builds.length, 1);
  assert.deepEqual(calls.builds[0], { output: path.join(acquiredParent, 'build') });
  assert.deepEqual(calls.outputWasPresent, [false], 'builder output must be nonexistent when acquired');
  assert.deepEqual(calls.verifications, [path.join(calls.builds[0].output, 'pi-runtime')]);
  assert.equal(await exists(acquiredParent), true);

  releaseCallback();
  assert.equal(await execution, result);
  assert.equal(await exists(acquiredParent), false);
});

test('confirmed owned runtime is removed even when the callback subsequently throws', async (t) => {
  const { calls, dependencies } = fakeDependencies(t);
  await assert.rejects(withPiRuntime({}, async (context) => {
    await context.confirmChildCompletion();
    throw new Error('callback failed after child completion');
  }, dependencies), /callback failed after child completion/);
  assert.equal(calls.builds.length, 1);
  assert.equal(await exists(calls.parents[0]), false);
});

test('unconfirmed callback completion and callback errors retain the owned runtime', async (t) => {
  const cases = [
    { callback: async () => 'completed without confirmation', result: 'completed without confirmation' },
    { callback: async () => { throw new Error('callback failed without confirmation'); }, error: /callback failed without confirmation/ },
  ];
  for (const { callback, result, error } of cases) {
    const { calls, dependencies } = fakeDependencies(t);
    const operation = withPiRuntime({}, callback, dependencies);
    if (error) await assert.rejects(operation, error);
    else assert.equal(await operation, result);
    assert.equal(await exists(calls.parents[0]), true);
  }
});

test('builder and verifier acquisition failures retain the temporary parent', async (t) => {
  {
    const { calls, dependencies } = fakeDependencies(t, {
      onBuild: async ({ output }) => {
        await writeFile(path.join(path.dirname(output), 'build-started'), 'yes');
        throw new Error('builder failed');
      },
    });
    await assert.rejects(withPiRuntime({}, async () => assert.fail('callback must not run'), dependencies), /builder failed/);
    assert.equal(calls.verifications.length, 0);
    assert.equal(await exists(path.join(calls.parents[0], 'build-started')), true);
  }
  {
    const { calls, dependencies } = fakeDependencies(t, {
      onVerify: async () => { throw new Error('verification failed'); },
    });
    await assert.rejects(withPiRuntime({}, async () => assert.fail('callback must not run'), dependencies), /verification failed/);
    assert.equal(calls.verifications.length, 1);
    assert.equal(await exists(calls.parents[0]), true);
  }
});

test('aborted signal prevents cleanup even after child completion is confirmed', async (t) => {
  const { calls, dependencies } = fakeDependencies(t);
  const controller = new AbortController();
  await withPiRuntime({ signal: controller.signal }, async (context) => {
    await context.confirmChildCompletion();
    controller.abort();
    return 'cancelled';
  }, dependencies);
  assert.equal(controller.signal.aborted, true);
  assert.equal(await exists(calls.parents[0]), true);
});

test('pre-aborted invocation acquires nothing', async (t) => {
  const { calls, dependencies } = fakeDependencies(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(withPiRuntime({ signal: controller.signal }, () => assert.fail('callback must not run'), dependencies), { name: 'AbortError' });
  assert.equal(calls.builds.length, 0);
  assert.equal(calls.verifications.length, 0);
});

test('abort during acquisition retains the artifact and does not invoke the callback', async (t) => {
  const controller = new AbortController();
  const { calls, dependencies } = fakeDependencies(t, {
    onVerify: async (artifactDir) => {
      controller.abort();
      return { artifactDir, sdkPath: 'sdk', identity: 'identity' };
    },
  });
  await assert.rejects(withPiRuntime({ signal: controller.signal }, () => assert.fail('callback must not run'), dependencies), { name: 'AbortError' });
  assert.equal(calls.builds.length, 1);
  assert.equal(await exists(calls.parents[0]), true);
});

test('invalid reuse paths and missing callbacks fail before acquisition', async (t) => {
  const { calls, dependencies } = fakeDependencies(t);
  await assert.rejects(withPiRuntime({ artifactDir: 'relative' }, () => {}, dependencies), /absolute artifact root/);
  await assert.rejects(withPiRuntime({}, undefined, dependencies), /requires a callback/);
  assert.equal(calls.builds.length, 0);
  assert.equal(calls.verifications.length, 0);
});

test('explicit artifact reuse verifies once, never builds, and never deletes the artifact', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pie-pi-runtime-reuse-test-'));
  trackCleanup(t, parent);
  const artifactDir = path.join(parent, 'existing-runtime');
  await mkdir(artifactDir);
  const { calls, dependencies } = fakeDependencies(t);
  const result = await withPiRuntime({ artifactDir }, async (context) => {
    assertFrozenContext(context);
    assert.equal(context.artifactDir, artifactDir);
    assert.equal(await exists(artifactDir), true);
    await context.confirmChildCompletion();
    return context.identity;
  }, dependencies);
  assert.equal(result, 'verified-identity');
  assert.equal(calls.builds.length, 0);
  assert.deepEqual(calls.verifications, [artifactDir]);
  assert.equal(await exists(artifactDir), true);
});

test('real verifier accepts and reuses a valid manifest-backed artifact without deleting it', async (t) => {
  const artifactDir = await validArtifactFixture(t);
  const verified = await writePiRuntimeManifest(artifactDir, provenance);
  const result = await withPiRuntime({ artifactDir }, async (context) => {
    assertFrozenContext(context);
    assert.equal(context.artifactDir, verified.artifactDir);
    assert.equal(context.sdkPath, verified.sdkPath);
    assert.equal(context.identity, verified.identity);
    await context.confirmChildCompletion();
    return { identity: context.identity };
  });
  assert.deepEqual(result, { identity: verified.identity });
  assert.deepEqual(await verifyPiRuntimeArtifact(artifactDir), verified);
  assert.equal(await exists(artifactDir), true);
});
