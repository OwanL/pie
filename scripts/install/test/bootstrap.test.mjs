import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { buildCommandPlan, parseBootstrapArgs, runBootstrap } from '../bootstrap.mjs';
import { repoRoot } from '../toolchain.mjs';
import { acquireDevelopmentReader } from '../../../lib/development-runtime/lifetime.mjs';

const fixtureArtifactDir = path.resolve(repoRoot, 'fixture-pi-runtime');
const packageSources = ['npm:fixture-package', 'git:fixture-repository'];

async function createBootstrapFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pie-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'harness', 'pi'), { recursive: true });
  // Only the gate uses the filesystem: every command and runtime boundary is mocked.
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true }));
  await writeFile(path.join(root, 'harness', 'pi', 'package.json'), JSON.stringify({ private: true }));
  return { root, artifactDir: path.join(root, 'fixture-pi-runtime') };
}

test('bootstrap command plan uses the verified source CLI and explicitly pins the host build', () => {
  const plan = buildCommandPlan({ packageSources, artifactDir: fixtureArtifactDir });
  const nodeSteps = plan.filter(({ command }) => command === process.execPath);

  assert.deepEqual(plan[0], { operation: 'root-install', cwd: repoRoot },
    'the shared gated installer owns the root dependency mutation');
  assert.ok(!plan.some(({ command, args }) =>
    command === 'proto' && args?.[0] === 'run' && args.includes('install')),
  'the command plan must not bypass the gated root installer with a raw Proto/pnpm command');
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
  assert.ok(!plan.some(({ command }) => command === 'npm'), 'bootstrap bypasses global npm entirely');
  assert.ok(plan.some(({ command, args, cwd }) =>
    command === 'proto'
    && args.join(' ') === `run node -- scripts/build/build.mjs --delivery --pi-runtime ${fixtureArtifactDir}`
    && cwd === repoRoot),
  'bootstrap selects the explicit nonpublishing delivery build');
  assert.equal(plan.at(-1).cwd, repoRoot);
});

test('bootstrap package plan uses shared staging between build and doctor', () => {
  const plan = buildCommandPlan({ packageSources: [], artifactDir: fixtureArtifactDir, package: true });
  const hostRoot = path.join(repoRoot, 'application', 'hosts', 'vscode');
  const buildIndex = plan.findIndex(({ command, args }) => command === 'proto' && args?.includes('scripts/build/build.mjs'));
  const packageIndex = plan.findIndex(({ operation }) => operation === 'package-extension');
  const doctorIndex = plan.findIndex(({ args }) => args?.[0] === 'scripts/diagnostics/doctor.mjs');

  assert.ok(buildIndex < packageIndex && packageIndex < doctorIndex);
  assert.deepEqual(plan[packageIndex], { operation: 'package-extension', cwd: repoRoot, hostRoot });
  assert.ok(!plan.some(({ args }) => args?.includes('prepackage')),
    'packaging bypasses the prepackage script so it cannot rebuild');
});

test('bootstrap packages an externally staged host with license validation enabled', async (t) => {
  const { root, artifactDir } = await createBootstrapFixture(t);
  const hostRoot = path.join(root, 'application', 'hosts', 'vscode');
  const events = [];
  let stagedRoot;

  await runBootstrap({
    root, artifactDir, packageSources: [], package: true,
    compilePiWorkspace() { assert.fail('explicit artifact reuse must skip source compilation'); },
    spawn(command, args, options) {
      events.push({ type: 'command', command, args, cwd: options.cwd });
      return { status: 0 };
    },
    stagePackage(stageRoot, outputBuildDir, destination) {
      events.push({ type: 'stage', stageRoot, outputBuildDir, destination });
      stagedRoot = destination;
      assert.ok(!destination.startsWith(root), 'the package stage is not copied into the checkout');
      return mkdir(destination).then(() => writeFile(path.join(destination, 'package.json'), JSON.stringify({ name: 'pie', version: '0.3.0' })));
    },
    resolveVscePath(selectedRoot) {
      assert.equal(selectedRoot, root);
      return 'fixture-vsce';
    },
    acquireRuntime(options, callback) {
      return callback({ artifactDir, confirmChildCompletion() {} });
    },
    async createPiCli() {
      return { run() { assert.fail('no package sources require Pi CLI execution'); } };
    },
  });

  const stageIndex = events.findIndex(({ type }) => type === 'stage');
  const packageIndex = events.findIndex(({ command, args }) => command === process.execPath && args?.[0] === 'fixture-vsce');
  const doctorIndex = events.findIndex(({ args }) => args?.[0] === 'scripts/diagnostics/doctor.mjs');
  assert.ok(stageIndex < packageIndex && packageIndex < doctorIndex);
  assert.deepEqual(events[stageIndex], {
    type: 'stage', stageRoot: root, outputBuildDir: path.join(hostRoot, 'out'), destination: stagedRoot,
  });
  assert.deepEqual(events[packageIndex].args, [
    'fixture-vsce', 'package', '--no-dependencies', '--allow-missing-repository',
    '--out', path.join(hostRoot, 'pie-0.3.0.vsix'),
  ]);
  assert.ok(!events[packageIndex].args.includes('--skip-license'));
  assert.notEqual(events[packageIndex].cwd, hostRoot);
  assert.equal(existsSync(path.dirname(stagedRoot)), false, 'temporary package staging is removed after synchronous packaging');
});

test('bootstrap acquires once after the frozen root pnpm install, reuses the verified CLI and confirms only after children close', async (t) => {
  const { root, artifactDir: selectedArtifactDir } = await createBootstrapFixture(t);
  const events = [];
  let activeCliChildren = 0;
  let acquisitions = 0;
  let cliCreations = 0;
  let confirmations = 0;

  await runBootstrap({
    root,
    artifactDir: selectedArtifactDir,
    packageSources,
    compilePiWorkspace() { assert.fail('explicit artifact reuse must skip source compilation'); },
    spawn(command, args, options) {
      events.push({ type: 'sync', command, args, cwd: options.cwd });
      return { status: 0 };
    },
    acquireRuntime(options, callback) {
      events.push({ type: 'acquire', options });
      acquisitions += 1;
      assert.ok(events[0].args.includes('install'), 'root pnpm install completed before artifact acquisition');
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
          assert.deepEqual(options, { cwd: root, stdio: 'inherit' });
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
    'downstream delivery build receives the selected artifact directory');
  assert.ok(events.some(({ type, args }) =>
    type === 'sync' && args.at(-1) === selectedArtifactDir && args.includes('--pi-runtime')),
    'downstream doctor receives the selected artifact directory');
});

test('source-default bootstrap compiles after install, then uses one acquired artifact through CLI, delivery build and doctor', async (t) => {
  const { root, artifactDir } = await createBootstrapFixture(t);
  const events = [];

  await runBootstrap({
    root,
    packageSources: ['npm:fixture-package'],
    spawn(command, args) {
      const type = args.includes('install') ? 'root-install'
        : args[0] === 'scripts/model-config/sync-models.mjs' ? 'model-check'
          : args.includes('scripts/build/build.mjs') ? 'delivery-build'
            : args[0] === 'scripts/diagnostics/doctor.mjs' ? 'doctor' : 'unexpected';
      assert.notEqual(type, 'unexpected', `unexpected synchronous step: ${command} ${args.join(' ')}`);
      events.push({ type, command, args });
      return { status: 0 };
    },
    async compilePiWorkspace() {
      assert.equal(events.at(-1).type, 'root-install', 'fresh source compilation follows the gated install');
      events.push({ type: 'compile' });
    },
    acquireRuntime(options, callback) {
      assert.equal(options.artifactDir, undefined, 'default selection asks the runtime owner to build/acquire');
      events.push({ type: 'acquire' });
      return callback({
        artifactDir,
        confirmChildCompletion() { events.push({ type: 'confirm' }); },
      });
    },
    async createPiCli(options) {
      assert.equal(options.artifactDir, artifactDir);
      events.push({ type: 'cli-create' });
      return {
        run(args) {
          events.push({ type: 'cli-install', args });
          const child = new EventEmitter();
          setTimeout(() => child.emit('close', 0, null), 0);
          return child;
        },
      };
    },
  });

  const index = (type) => events.findIndex((event) => event.type === type);
  assert.ok(index('root-install') < index('compile'));
  assert.ok(index('compile') < index('acquire'));
  assert.ok(index('acquire') < index('cli-install'));
  assert.ok(index('cli-install') < index('model-check'));
  assert.ok(index('model-check') < index('delivery-build'));
  assert.ok(index('delivery-build') < index('doctor'));
  assert.equal(events.at(-1).type, 'confirm');
  const delivery = events.find(({ type }) => type === 'delivery-build');
  const doctor = events.find(({ type }) => type === 'doctor');
  assert.deepEqual(delivery.args, [
    'run', 'node', '--', 'scripts/build/build.mjs', '--delivery', '--pi-runtime', artifactDir,
  ]);
  assert.deepEqual(doctor.args.slice(-2), ['--pi-runtime', artifactDir]);
  assert.ok(!delivery.args.includes('--activate') && !delivery.args.includes('--publish'));
});

test('failed root pnpm install does not acquire or install a Pi artifact', async (t) => {
  const { root, artifactDir } = await createBootstrapFixture(t);
  let acquisitions = 0;
  await assert.rejects(runBootstrap({
    root,
    artifactDir,
    packageSources: [],
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
  test(`post-acquisition CLI failure stops later steps and confirms only after close: ${name}`, async (t) => {
    const { root, artifactDir } = await createBootstrapFixture(t);
    const events = [];
    let confirmations = 0;
    await assert.rejects(runBootstrap({
      root,
      artifactDir,
      packageSources,
      spawn(command, args) {
        assert.equal(command, 'proto', 'only the root Proto/pnpm install runs');
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
    assert.deepEqual(events.filter(({ type }) => type === 'sync'), [{ type: 'sync', args: ['run', 'pnpm', '--', 'install', '--frozen-lockfile', '--ignore-scripts'] }],
      'model sync, host build and doctor are skipped after the CLI failure');
  });
}

test('thrown Pi CLI launch skips later steps and retains the artifact without confirmation', async (t) => {
  const { root, artifactDir } = await createBootstrapFixture(t);
  let confirmations = 0;
  let acquisitions = 0;
  let syncSteps = 0;
  await assert.rejects(runBootstrap({
    root,
    artifactDir,
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
  assert.equal(syncSteps, 1, 'root pnpm install is the only executed step');
});

test('downstream synchronous command failure confirms teardown once all children have closed', async (t) => {
  const { root, artifactDir } = await createBootstrapFixture(t);
  const events = [];
  let confirmations = 0;
  await assert.rejects(runBootstrap({
    root,
    artifactDir,
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

test('packaging failure stops before doctor and confirms artifact teardown', async (t) => {
  const { root, artifactDir } = await createBootstrapFixture(t);
  const events = [];
  let confirmations = 0;
  await assert.rejects(runBootstrap({
    root,
    artifactDir,
    packageSources: [],
    package: true,
    spawn(command, args) {
      events.push({ command, args });
      return args.includes('fixture-vsce') ? { status: 23 } : { status: 0 };
    },
    stagePackage(_root, _outputBuildDir, destination) {
      return mkdir(destination).then(() => writeFile(path.join(destination, 'package.json'), JSON.stringify({ name: 'pie', version: '0.3.0' })));
    },
    resolveVscePath() { return 'fixture-vsce'; },
    acquireRuntime(options, callback) {
      return callback({
        artifactDir: options.artifactDir,
        confirmChildCompletion() { confirmations += 1; },
      });
    },
    createPiCli: async () => ({ run() { assert.fail('no configured packages should invoke the Pi CLI'); } }),
  }), (error) => { assert.equal(error.exitCode, 23); return true; });

  const buildIndex = events.findIndex(({ command, args }) => command === 'proto' && args.includes('build'));
  const packageIndex = events.findIndex(({ args }) => args.includes('fixture-vsce'));
  assert.ok(buildIndex < packageIndex, 'packaging follows the artifact-pinned build');
  assert.ok(!events.some(({ args }) => args[0] === 'scripts/diagnostics/doctor.mjs'),
    'doctor is skipped when packaging fails');
  assert.equal(confirmations, 1, 'artifact teardown is confirmed after packaging failure');
});

test('mocked bootstrap owns a private writer gate while an independent workspace reader remains live', async (t) => {
  const { root, artifactDir } = await createBootstrapFixture(t);
  // Model a separate canonical workspace without registering against the real
  // checkout, where Moon may concurrently own the Pi compilation writer.
  const { root: readerRoot } = await createBootstrapFixture(t);
  const reader = await acquireDevelopmentReader(path.join(readerRoot, 'harness', 'pi'));
  const calls = [];
  let confirmations = 0;
  try {
    await runBootstrap({
      root,
      artifactDir,
      packageSources: [],
      spawn(command, args, options) {
        assert.equal(options.cwd, root);
        assert.ok(existsSync(path.join(root, 'harness', 'pi', '.cache', 'development-runtime', 'writer.json'))
          === args.includes('install'), 'only the root install holds the fixture writer gate');
        calls.push({ command, args });
        return { status: 0 };
      },
      compilePiWorkspace() { assert.fail('explicit reuse must not compile the SDK'); },
      acquireRuntime(options, callback) {
        assert.equal(options.artifactDir, artifactDir);
        return callback({
          artifactDir,
          confirmChildCompletion() { confirmations += 1; },
        });
      },
      createPiCli: async () => ({ run() { assert.fail('no package sources should launch children'); } }),
    });
    assert.equal(calls.length, 4, 'root install, model check, delivery build and doctor all complete');
    assert.equal(confirmations, 1);
  } finally {
    await reader.release({ teardownConfirmed: true });
  }
});

test('bootstrap accepts explicit absolute artifact reuse, optional packaging and rejects malformed selections', () => {
  assert.deepEqual(parseBootstrapArgs(['--pi-runtime', fixtureArtifactDir]), { artifactDir: fixtureArtifactDir, package: false });
  assert.deepEqual(parseBootstrapArgs([`--pi-runtime=${fixtureArtifactDir}`, '--package']), { artifactDir: fixtureArtifactDir, package: true });
  assert.deepEqual(parseBootstrapArgs([]), { artifactDir: undefined, package: false });
  assert.throws(() => parseBootstrapArgs(['--pi-runtime', 'relative/path']), /absolute artifact root/);
  assert.throws(() => parseBootstrapArgs(['--pi-runtime']), /requires an artifact path/);
  assert.throws(() => parseBootstrapArgs(['--pi-runtime', fixtureArtifactDir, '--pi-runtime', fixtureArtifactDir]), /only once/);
});
