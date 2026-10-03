import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { buildCommandPlan, parseBootstrapArgs, runBootstrap } from '../bootstrap.mjs';
import { repoRoot } from '../toolchain.mjs';

const fixtureArtifactDir = path.resolve(repoRoot, 'fixture-pi-runtime');
const packageSources = ['npm:fixture-package', 'git:fixture-repository'];
const selectedArtifactDir = path.resolve(repoRoot, 'explicit-failure-fixture');

test('bootstrap command plan uses the verified source CLI and explicitly pins the host build', () => {
  const plan = buildCommandPlan({ packageSources, artifactDir: fixtureArtifactDir });
  const nodeSteps = plan.filter(({ command }) => command === process.execPath);

  assert.deepEqual(plan[0], {
    command: 'npm', args: ['ci', '--include=dev'], cwd: repoRoot,
  });
  assert.deepEqual(nodeSteps.map(({ args }) => args), [
    ['scripts/model-config/sync-models.mjs', '--check'],
    ['scripts/diagnostics/doctor.mjs', '--skip-model-check', '--pi-runtime', fixtureArtifactDir],
  ]);
  for (const { args, cwd } of nodeSteps) {
    assert.ok(existsSync(path.resolve(cwd, args[0])), `missing bootstrap script: ${args[0]}`);
  }

  assert.deepEqual(plan.filter(({ operation }) => operation === 'source-pi-cli').map(({ args }) => args), [
    ['install', 'npm:fixture-package'],
    ['install', 'git:fixture-repository'],
  ]);
  assert.ok(!plan.some(({ command }) => command === 'pi'));
  assert.ok(!plan.some(({ command, args }) => command === 'npm' && args[0] === 'install' && args.includes('-g')));
  assert.ok(plan.some(({ command, args, cwd }) =>
    command === 'npm'
    && args.slice(0, 4).join(' ') === 'run build -- --pi-runtime'
    && args[4] === fixtureArtifactDir
    && cwd === path.join(repoRoot, 'application', 'hosts', 'vscode')));
  assert.equal(plan.at(-1).cwd, repoRoot);
});

test('bootstrap package plan runs pinned host-local vsce between build and doctor', () => {
  const plan = buildCommandPlan({ packageSources: [], artifactDir: fixtureArtifactDir, package: true });
  const hostRoot = path.join(repoRoot, 'application', 'hosts', 'vscode');
  const buildIndex = plan.findIndex(({ command, args }) => command === 'npm' && args[0] === 'run' && args[1] === 'build');
  const packageIndex = plan.findIndex(({ args }) => args[0] === 'node_modules/@vscode/vsce/vsce');
  const doctorIndex = plan.findIndex(({ args }) => args[0] === 'scripts/diagnostics/doctor.mjs');

  assert.ok(buildIndex < packageIndex && packageIndex < doctorIndex);
  assert.deepEqual(plan[packageIndex], {
    command: process.execPath,
    args: ['node_modules/@vscode/vsce/vsce', 'package', '--no-dependencies', '--allow-missing-repository', '--skip-license'],
    cwd: hostRoot,
  });
  assert.ok(!plan.some(({ command, args }) => command === 'npm' && args[0] === 'run' && args[1] === 'package'),
    'packaging bypasses npm prepackage so it cannot rebuild');
});

test('bootstrap acquires once after root npm ci, reuses the verified CLI and confirms only after children close', async () => {
  const events = [];
  let activeCliChildren = 0;
  let acquisitions = 0;
  let cliCreations = 0;
  let confirmations = 0;
  const selectedArtifactDir = path.resolve(repoRoot, 'explicit-reuse-fixture');

  await runBootstrap({
    root: repoRoot,
    artifactDir: selectedArtifactDir,
    packageSources,
    spawn(command, args, options) {
      events.push({ type: 'sync', command, args, cwd: options.cwd });
      return { status: 0 };
    },
    acquireRuntime(options, callback) {
      events.push({ type: 'acquire', options });
      acquisitions += 1;
      assert.equal(events[0].args[0], 'ci', 'root npm ci completed before artifact acquisition');
      assert.equal(options.artifactDir, selectedArtifactDir, 'explicit artifact reuse is forwarded');
      return callback({
        artifactDir: selectedArtifactDir,
        confirmChildCompletion() {
          assert.equal(activeCliChildren, 0, 'confirmation follows all Pi CLI close events');
          confirmations += 1;
          events.push({ type: 'confirm' });
        },
      });
    },
    async createPiCli(options) {
      cliCreations += 1;
      assert.equal(options.artifactDir, selectedArtifactDir);
      assert.equal(options.nodeExecutable, process.execPath);
      assert.deepEqual(options.target, {
        platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules,
      });
      return {
        run(args, options) {
          assert.deepEqual(options, { cwd: repoRoot, stdio: 'inherit' });
          events.push({ type: 'pi-start', args });
          activeCliChildren += 1;
          const child = new EventEmitter();
          setTimeout(() => {
            activeCliChildren -= 1;
            events.push({ type: 'pi-close', args });
            child.emit('close', 0, null);
          }, 5);
          return child;
        },
      };
    },
  });

  assert.equal(acquisitions, 1);
  assert.equal(cliCreations, 1, 'one verified launcher is reused for all package sources');
  assert.equal(confirmations, 1);
  assert.equal(events.filter(({ type }) => type === 'pi-start').length, packageSources.length);
  assert.ok(events.findIndex(({ type }) => type === 'sync') < events.findIndex(({ type }) => type === 'acquire'));
  assert.equal(events.at(-1).type, 'confirm');
  assert.ok(events.some(({ type, args }) => type === 'sync' && args.includes(selectedArtifactDir)),
    'downstream host build receives the selected artifact directory');
  assert.ok(events.some(({ type, args }) =>
    type === 'sync' && args.at(-1) === selectedArtifactDir && args.includes('--pi-runtime')),
    'downstream doctor receives the selected artifact directory');
});

test('failed root npm ci does not acquire or install a Pi artifact', async () => {
  let acquisitions = 0;
  await assert.rejects(runBootstrap({
    artifactDir: fixtureArtifactDir,
    spawn() { return { status: 17 }; },
    acquireRuntime() { acquisitions += 1; throw new Error('must not acquire'); },
    createPiCli() { assert.fail('must not create a Pi CLI'); },
  }), (error) => { assert.equal(error.exitCode, 17); return true; });
  assert.equal(acquisitions, 0);
});

const postAcquisitionCliFailures = [
  {
    name: 'pi CLI closes with a nonzero code',
    fail(child) { child.emit('close', 5, null); },
    expectedError: /exit code 5/,
  },
  {
    name: 'pi CLI emits a spawn error before close',
    fail(child) { child.emit('error', new Error('launch failed')); child.emit('close', null, 'SIGKILL'); },
    expectedError: /launch failed/,
  },
];

for (const { name, fail, expectedError } of postAcquisitionCliFailures) {
  test(`post-acquisition CLI failure stops later steps and confirms only after close: ${name}`, async () => {
    const events = [];
    let confirmations = 0;
    await assert.rejects(runBootstrap({
      artifactDir: selectedArtifactDir,
      packageSources,
      spawn(command, args) {
        assert.equal(command, 'npm', 'only the root npm ci runs');
        events.push({ type: 'sync', args });
        return { status: 0 };
      },
      acquireRuntime(options, callback) {
        return callback({
          artifactDir: options.artifactDir,
          confirmChildCompletion() {
            assert.ok(events.some(({ type }) => type === 'pi-close'), 'confirmation follows the child close event');
            assert.equal(events.filter(({ type }) => type === 'pi-start').length, 1,
              'children stop at the first failed CLI step');
            confirmations += 1;
            events.push({ type: 'confirm' });
          },
        });
      },
      createPiCli: async () => ({
        run(args) {
          events.push({ type: 'pi-start', args });
          const child = new EventEmitter();
          setTimeout(() => {
            events.push({ type: 'pi-close', args });
            fail(child);
          }, 5);
          return child;
        },
      }),
    }), expectedError);
    assert.equal(confirmations, 1);
    assert.deepEqual(events.filter(({ type }) => type === 'sync'), [{ type: 'sync', args: ['ci', '--include=dev'] }],
      'model sync, host build and doctor are skipped after the CLI failure');
  });
}

test('thrown Pi CLI launch skips later steps and retains the artifact without confirmation', async () => {
  let confirmations = 0;
  let acquisitions = 0;
  let syncSteps = 0;
  await assert.rejects(runBootstrap({
    artifactDir: fixtureArtifactDir,
    packageSources,
    spawn() { syncSteps += 1; return { status: 0 }; },
    acquireRuntime(options, callback) {
      acquisitions += 1;
      return callback({
        artifactDir: options.artifactDir,
        confirmChildCompletion() { confirmations += 1; },
      });
    },
    createPiCli: async () => ({ run() { throw new Error('launcher exploded'); } }),
  }), /launcher exploded/);
  assert.equal(acquisitions, 1, 'the artifact is still held by the failed acquisition');
  assert.equal(confirmations, 0, 'a launch that never closes never confirms teardown');
  assert.equal(syncSteps, 1, 'root npm ci is the only executed step');
});

test('downstream synchronous command failure confirms teardown once all children have closed', async () => {
  const events = [];
  let confirmations = 0;
  await assert.rejects(runBootstrap({
    artifactDir: fixtureArtifactDir,
    packageSources: ['npm:fixture-package'],
    spawn(command, args) {
      events.push({ type: 'sync', args });
      return args[0] === 'scripts/model-config/sync-models.mjs' ? { status: 9 } : { status: 0 };
    },
    acquireRuntime(options, callback) {
      return callback({
        artifactDir: options.artifactDir,
        confirmChildCompletion() {
          assert.ok(events.some(({ type }) => type === 'pi-close'), 'confirmation follows the completed children');
          assert.ok(!events.some(({ type, args }) => type === 'sync' && args[0] === 'scripts/diagnostics/doctor.mjs'),
            'doctor does not run after a failed sync step');
          confirmations += 1;
          events.push({ type: 'confirm' });
        },
      });
    },
    createPiCli: async () => ({
      run(args) {
        events.push({ type: 'pi-start', args });
        const child = new EventEmitter();
        setTimeout(() => {
          events.push({ type: 'pi-close', args });
          child.emit('close', 0, null);
        }, 5);
        return child;
      },
    }),
  }), (error) => { assert.equal(error.exitCode, 9); return true; });
  assert.equal(confirmations, 1);
  assert.equal(events.at(-1).type, 'confirm');
});

test('packaging failure stops before doctor and confirms artifact teardown', async () => {
  const events = [];
  let confirmations = 0;
  await assert.rejects(runBootstrap({
    artifactDir: selectedArtifactDir,
    packageSources: [],
    package: true,
    spawn(command, args) {
      events.push({ command, args });
      return args[0] === 'node_modules/@vscode/vsce/vsce' ? { status: 23 } : { status: 0 };
    },
    acquireRuntime(options, callback) {
      return callback({
        artifactDir: options.artifactDir,
        confirmChildCompletion() { confirmations += 1; },
      });
    },
    createPiCli: async () => ({ run() { assert.fail('no configured packages should invoke the Pi CLI'); } }),
  }), (error) => { assert.equal(error.exitCode, 23); return true; });

  const buildIndex = events.findIndex(({ command, args }) => command === 'npm' && args[0] === 'run' && args[1] === 'build');
  const packageIndex = events.findIndex(({ args }) => args[0] === 'node_modules/@vscode/vsce/vsce');
  assert.ok(buildIndex < packageIndex, 'packaging follows the artifact-pinned build');
  assert.ok(!events.some(({ args }) => args[0] === 'scripts/diagnostics/doctor.mjs'),
    'doctor is skipped when packaging fails');
  assert.equal(confirmations, 1, 'artifact teardown is confirmed after packaging failure');
});

test('bootstrap accepts explicit absolute artifact reuse, optional packaging and rejects malformed selections', () => {
  assert.deepEqual(parseBootstrapArgs(['--pi-runtime', fixtureArtifactDir]), { artifactDir: fixtureArtifactDir, package: false });
  assert.deepEqual(parseBootstrapArgs([`--pi-runtime=${fixtureArtifactDir}`, '--package']), { artifactDir: fixtureArtifactDir, package: true });
  assert.deepEqual(parseBootstrapArgs([]), { artifactDir: undefined, package: false });
  assert.throws(() => parseBootstrapArgs(['--pi-runtime', 'relative/path']), /absolute artifact root/);
  assert.throws(() => parseBootstrapArgs(['--pi-runtime']), /requires an artifact path/);
  assert.throws(() => parseBootstrapArgs(['--pi-runtime', fixtureArtifactDir, '--pi-runtime', fixtureArtifactDir]), /only once/);
});
