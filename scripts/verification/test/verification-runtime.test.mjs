import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPiRuntime } from '../../lib/pi-runtime-context.mjs';
import { PI_RUNTIME_PACKAGES, PI_RUNTIME_SDK_RELATIVE_PATH, writePiRuntimeManifest, verifyPiRuntimeArtifact } from '../../lib/pi-runtime-artifact.mjs';
import { extractRuntimeArgs, resolveRuntimeSelection, withVerificationRuntime } from '../verification-runtime.mjs';
import { runChild, runVerification, verificationStages } from '../run-verification.mjs';
import { createGroupTsconfigOverlay, buildTsxArgs, resolveLocalTsx, runGroup } from '../run-test-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
async function put(root, relative, content) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
async function artifact(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pie-verification-fixture-'));
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const directory = path.join(parent, 'pi-runtime');
  for (const name of [...PI_RUNTIME_PACKAGES, 'typebox']) {
    const prefix = `node_modules/${name}`;
    await put(directory, `${prefix}/package.json`, JSON.stringify({ name, version: '0.80.6', type: 'module',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.cjs' } }, dependencies: name === 'typebox' ? {} : { typebox: '0.80.6' } }));
    await put(directory, `${prefix}/dist/index.js`, `export const candidate = ${JSON.stringify(name)};`);
    await put(directory, `${prefix}/dist/index.cjs`, `exports.candidate = ${JSON.stringify(name)};`);
    await put(directory, `${prefix}/dist/index.d.ts`, 'export declare const candidate: string;');
    await put(directory, `${prefix}/LICENSE`, 'MIT License\nCopyright (c) 2025 Mario Zechner\n');
  }
  for (const file of ['dist/cli.js', 'dist/rpc-entry.js', 'dist/modes/interactive/theme/dark.json', 'dist/modes/interactive/theme/light.json',
    'dist/modes/interactive/theme/theme-schema.json', 'dist/modes/interactive/assets/clankolas.png', 'dist/core/export-html/template.html',
    'dist/core/export-html/template.css', 'dist/core/export-html/template.js', 'dist/core/export-html/vendor/marked.min.js', 'dist/core/export-html/vendor/highlight.min.js']) {
    await put(directory, `${PI_RUNTIME_SDK_RELATIVE_PATH}/${file}`, 'fixture');
  }
  await writePiRuntimeManifest(directory, { upstreamVersion: '0.80.6', upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b',
    sourceTreeSha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64), target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules } });
  return verifyPiRuntimeArtifact(directory);
}

test('explicit runtime transport is unambiguous, absolute, and respects --', () => {
  const dir = path.resolve(os.tmpdir(), 'artifact');
  assert.deepEqual(extractRuntimeArgs(['--pi-runtime', dir, '--', '--pi-runtime=x']), { args: ['--', '--pi-runtime=x'], artifactDir: dir, sdkPath: undefined });
  assert.throws(() => extractRuntimeArgs(['--pi-runtime=relative']), /absolute/);
  assert.throws(() => extractRuntimeArgs(['--pi-runtime', dir, '--pi-runtime', dir]), /only one/);
  assert.throws(() => extractRuntimeArgs(['--sdk-path'], { allowSdkPath: true }), /requires/);
});

test('native check/verify dispatch Moon without artifact acquisition or publication', async () => {
  for (const mode of ['check', 'verify']) {
    const calls = [];
    const dependencies = {
      withPiRuntime: () => { throw new Error('Native route acquired an artifact'); },
      run: async (args) => { calls.push(args); return 0; },
    };
    assert.equal(await runVerification(mode, {}, undefined, dependencies), 0);
    assert.deepEqual(calls, [['proto', 'run', 'moon', '--', 'run', 'root:models', ':typecheck', ':test',
      ...(mode === 'check' ? ['--affected', '--include-relations'] : ['vscode:build'])]]);
    assert.doesNotMatch(calls.flat().join(' '), /delivery|publish|artifact|deep/);
    calls.length = 0;
    await assert.rejects(runVerification(mode, { artifactDir: path.resolve(os.tmpdir(), 'missing') }, undefined, dependencies), /not used.*omit it/);
    assert.equal(calls.length, 0);
    assert.equal(await runVerification(mode, {}, undefined, { ...dependencies, run: async () => 7 }), 7);
  }
});

test('release acquires once and reuses the same verified graph in nested children/build', async (t) => {
  const candidate = await artifact(t);
  const before = await readFile(path.join(candidate.artifactDir, 'manifest.json'));
  for (const mode of ['verify:release']) {
    let acquisitions = 0;
    let confirmations = 0;
    const calls = [];
    const code = await runVerification(mode, {}, undefined, {
      withPiRuntime: async (options, run) => {
        assert.equal(options.artifactDir, undefined);
        acquisitions += 1;
        return run({ ...candidate, confirmChildCompletion: () => { confirmations += 1; } });
      },
      run: async (args) => {
        calls.push(args);
        if (args.includes('--pi-runtime')) {
          const selection = extractRuntimeArgs(args);
          assert.equal(selection.artifactDir, candidate.artifactDir);
          // Exercise child and retry selection using the real read-only verifier.
          for (let retry = 0; retry < 2; retry += 1) {
            await withVerificationRuntime(selection, undefined, async (runtime) => {
              assert.equal(runtime.identity, candidate.identity);
            }, { withPiRuntime: (options, run) => withPiRuntime(options, run, {
              buildPiRuntime: () => { throw new Error('Child attempted reacquisition'); },
            }) });
          }
        }
        return 0;
      },
    });
    assert.equal(code, 0);
    assert.equal(acquisitions, 1);
    assert.equal(confirmations, 1);
    assert.deepEqual(calls, verificationStages(mode, candidate));
    assert.ok(calls.some((args) => args[0] === 'scripts/verification/run-tests.mjs' && !args.includes('--fast')),
      'release keeps the coverage-gated legacy runner');
    assert.ok(calls.some((args) => args[0] === 'scripts/build/build.mjs'));
    assert.doesNotMatch(calls.flat().join(' '), /--publish|--delivery/);
  }
  assert.deepEqual(await readFile(path.join(candidate.artifactDir, 'manifest.json')), before);
  assert.equal((await verifyPiRuntimeArtifact(candidate.artifactDir)).identity, candidate.identity);
});

test('failure stops later stages; uncertain teardown never confirms cleanup', async () => {
  let confirmed = 0;
  let dispatched = 0;
  const dependencies = { withPiRuntime: async (_options, run) => run({ artifactDir: path.resolve(os.tmpdir()), confirmChildCompletion: () => { confirmed += 1; } }) };
  assert.equal(await runVerification('verify:release', {}, undefined, { ...dependencies, run: async () => { dispatched += 1; return 7; } }), 7);
  assert.equal(dispatched, 1);
  assert.equal(confirmed, 1);
  await assert.rejects(runVerification('verify:release', {}, undefined, { ...dependencies, run: async () => { throw new Error('uncertain teardown'); } }), /uncertain/);
  assert.equal(confirmed, 1);
  await assert.rejects(runVerification('bad', {}, undefined, dependencies), /Unknown/);
});

test('retained coverage nested status 125 keeps the private runtime even after confirmed outer teardown', async (t) => {
  let owned;
  let confirmations = 0;
  let dispatched = 0;
  const dependencies = {
    withPiRuntime: (options, run) => withPiRuntime(options, (context) => run({ ...context,
      confirmChildCompletion: () => { confirmations += 1; context.confirmChildCompletion(); },
    }), {
      buildPiRuntime: async ({ output }) => {
        owned = path.dirname(output);
        t.after(() => rm(owned, { recursive: true, force: true }));
        return { artifactDir: output };
      },
      verifyPiRuntimeArtifact: async (artifactDir) => ({ artifactDir, sdkPath: '/fixture', identity: 'fixture' }),
    }),
    run: async (args, signal, cwd) => {
      dispatched += 1;
      return runChild(args, signal, cwd, {
        spawnImpl: () => {
          const child = new EventEmitter();
          queueMicrotask(() => child.emit('close', 125));
          return child;
        },
        watchChildProcessImpl: () => ({ settle: async () => ({ gone: true }) }),
      });
    },
  };
  await assert.rejects(runVerification('verify:release', {}, undefined, dependencies),
    (error) => error.teardownUnconfirmed === true);
  assert.equal(dispatched, 1);
  assert.equal(confirmations, 0);
  await access(owned);

  // Injected stage runners must preserve the same reserved status contract.
  await assert.rejects(runVerification('verify:release', {}, undefined, {
    withPiRuntime: async (_options, run) => run({ confirmChildCompletion: () => { confirmations += 1; } }),
    run: async () => 125,
  }), (error) => error.teardownUnconfirmed === true);
  assert.equal(confirmations, 0);
});

test('--sdk-path accepts only a verified materialized artifact, not a workspace/installed-shaped tree', async (t) => {
  const candidate = await artifact(t);
  assert.deepEqual(await resolveRuntimeSelection({ sdkPath: candidate.sdkPath }), { artifactDir: candidate.artifactDir });
  await assert.rejects(resolveRuntimeSelection({ sdkPath: path.dirname(candidate.artifactDir) }), /verified materialized/i);
  await put(candidate.artifactDir, `${PI_RUNTIME_SDK_RELATIVE_PATH}/dist/index.js`, 'tampered');
  await assert.rejects(resolveRuntimeSelection({ sdkPath: candidate.sdkPath }), /hash|size|payload/i);
});

test('disposable TSX child receives candidate aliases for an unconfigured group', async (t) => {
  const candidate = await artifact(t);
  const file = path.join(path.dirname(candidate.artifactDir), 'aliases.test.ts');
  await writeFile(file, `import assert from 'node:assert/strict'; import test from 'node:test';
import { candidate } from '@mariozechner/pi-ai';
import { readFileSync } from 'node:fs';
test('fixture aliases', () => { assert.equal(candidate, '@earendil-works/pi-ai');
const aliases = JSON.parse(readFileSync(process.env.TSX_TSCONFIG_PATH!, 'utf8')).compilerOptions.paths;
assert.ok(aliases.typebox[0].startsWith(${JSON.stringify(candidate.artifactDir)})); });`);
  const overlay = createGroupTsconfigOverlay(root, { id: 'fixture' }, { sdkPath: candidate.sdkPath });
  t.after(() => overlay.dispose());
  const group = { id: 'fixture', tsxBin: resolveLocalTsx(root), cwd: root, files: [file], tsxConfig: overlay.configPath };
  assert.equal(await runGroup(group, buildTsxArgs(group)), 0);
  assert.equal((await verifyPiRuntimeArtifact(candidate.artifactDir)).identity, candidate.identity);
});

test('help/list entrypoints do not acquire or validate a deliberately missing artifact', () => {
  const missing = path.resolve(os.tmpdir(), 'pie-artifact-that-does-not-exist');
  for (const [script, args] of [
    ['run-tests.mjs', ['--list']], ['run-typechecks.mjs', ['--list']], ['run-test-files.mjs', ['--help']],
    ['run-verification.mjs', ['--help']],
    ['run-package-group.mjs', ['tests', 'extensions', '--list']],
  ]) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/verification', script), ...args, '--pi-runtime', missing], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /ENOENT|manifest/);
  }
});
