import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BootstrapLauncherError,
  atomicWriteJson,
  bootstrapKeyPath,
  parseArguments,
  runLauncher,
} from '../analytics-bootstrap-launcher.mjs';

const PRODUCTION_WORKSPACE_ID = '{"folders":["file:c:/dev"]}';
const MINTED_AT = '2026-09-16T04:51:43.492Z';
// The durable lifecycle store encodes epoch milliseconds as a digit string;
// the fixtures mirror that real record shape.
const MINTED_AT_MS = 1_789_534_303_492;
const FRESH_REGISTERED_AT = '1789534310994';
const BEFORE_MINT_REGISTERED_AT = '1789534299000';
const BOOTSTRAP_KEY = 'test-bootstrap-key-value';

function temporaryRoot(label) {
  return mkdtempSync(path.join(tmpdir(), `pie-bootstrap-launcher-${label}-`));
}

function hostRow(overrides = {}) {
  const hostInstanceId = overrides.hostInstanceId ?? 'fresh-host';
  return {
    hostInstanceId,
    workspaceId: overrides.workspaceId ?? PRODUCTION_WORKSPACE_ID,
    generationId: overrides.generationId ?? hostInstanceId,
    buildId: overrides.buildId ?? '67dc8288f6a19b1b65e8',
    processId: overrides.processId ?? 7740,
    endpointName: overrides.endpointName ?? 'pie-analytics-endpoint',
    capabilities: overrides.capabilities ?? ['controlled-restart'],
    state: overrides.state ?? 'registered',
    registeredAtMs: overrides.registeredAtMs ?? FRESH_REGISTERED_AT,
    heartbeatAtMs: overrides.heartbeatAtMs ?? FRESH_REGISTERED_AT,
    stoppedAtMs: overrides.stoppedAtMs,
    updatedAtMs: overrides.updatedAtMs ?? FRESH_REGISTERED_AT,
  };
}

function censusSnapshot(processIds, backendOwnerIds = processIds) {
  return {
    processes: processIds.map((processId) => ({ processId })),
    backendOwners: backendOwnerIds.map((hostProcessId) => ({ hostProcessId })),
  };
}

/** Real lease files under the fake runtime root so settlement removal is
 * observable; lease entries mirror the discovery record shape. */
function leaseEntry(processId, runtimeRootPath) {
  const runtimeGeneration = `runtime-generation-${processId}`;
  const leaseFileName = `${runtimeGeneration}-${processId}-lease.json`;
  mkdirSync(path.join(runtimeRootPath, 'leases'), { recursive: true });
  writeFileSync(path.join(runtimeRootPath, 'leases', leaseFileName), '{}\n');
  return { processId, runtimeGeneration, leaseFileName };
}

/** Fake production modules with a queue of census snapshots (the last one
 * repeats), mutable registry rows/leases, and a discovery outcome driven by
 * `expectedKey`. Records every store settlement and adapter configuration. */
function createFakeModules(options) {
  const calls = { markAnalyticsHostState: [], adapterConfigs: [] };
  class FakeSessionLifecycleStore {
    listAnalyticsHosts(workspaceId) {
      return {
        hosts: options.rows.filter((row) => row.workspaceId === workspaceId).map((row) => ({ ...row })),
        truncated: false,
      };
    }
    markAnalyticsHostState(hostInstanceId, processId, generationId, state, settledAtMs) {
      calls.markAnalyticsHostState.push({ hostInstanceId, processId, generationId, state, settledAtMs });
      const row = options.rows.find((entry) => entry.hostInstanceId === hostInstanceId);
      if (row) {
        row.state = state;
        row.stoppedAtMs = new Date(settledAtMs).toISOString();
      }
    }
    close() {}
  }
  const readCensusSnapshot = async () => {
    const snapshot = options.censusQueue.length > 1 ? options.censusQueue.shift() : options.censusQueue[0];
    return {
      complete: true,
      processes: snapshot.processes.map((entry) => ({ ...entry })),
      backendOwners: snapshot.backendOwners.map((entry) => ({ ...entry })),
      reasons: [],
    };
  };
  return {
    calls,
    modules: {
      SessionLifecycleStore: FakeSessionLifecycleStore,
      createProductionAnalyticsHostAdapters: (config) => {
        calls.adapterConfigs.push(config);
        return {
          discover: async () => {
            const livePids = new Set(options.censusQueue[0].processes.map((entry) => entry.processId));
            const hosts = options.rows
              .filter((row) => row.state === 'registered' && livePids.has(row.processId))
              .map((row) => ({ ...row }));
            const authenticated = hosts.length > 0
              && hosts.every((host) => config.keyForHost(host) === options.expectedKey());
            if (authenticated) {
              return {
                complete: true, hosts, reasons: [],
                unregisteredRuntimeLeases: [], unregisteredBackendOwners: [],
              };
            }
            return {
              complete: false, hosts: [],
              reasons: hosts.length === 0
                ? [{ code: 'host-census-empty' }]
                : [{ code: 'host-authentication-failed', hostInstanceId: hosts[0].hostInstanceId }],
              unregisteredRuntimeLeases: [], unregisteredBackendOwners: [],
            };
          },
        };
      },
      readProcessCensus: readCensusSnapshot,
      readRuntimeLeaseEvidence: async () => ({
        complete: true,
        leases: options.leases.map((entry) => ({ ...entry })),
        reasons: [],
      }),
    },
  };
}

/** Injectable launcher dependencies: fake clock (one minute per poll), fake
 * process lists, and a per-poll hook for driving the observed race. */
function fakeDependencies(modules, options, hooks = {}) {
  let clock = 1_000_000;
  const state = { launched: [], sleepCount: 0 };
  const dependencies = {
    loadModules: async () => modules,
    readLiveCodePids: async () => [...options.codePids],
    resolveCodeExecutable: () => 'C:/fake/Code.exe',
    launchCode: (executable, key) => {
      state.launched.push({ executable, key });
      return 424242;
    },
    now: () => clock,
    sleep: async () => {
      clock += 60_000;
      const index = state.sleepCount;
      state.sleepCount += 1;
      await hooks.onSleep?.(index);
    },
  };
  return { dependencies, state };
}

function planFixture(root) {
  const runtimeRootPath = path.join(root, 'runtime');
  mkdirSync(runtimeRootPath, { recursive: true });
  const planPath = path.join(root, 'plan.json');
  const plan = {
    schemaVersion: 1,
    workspaceId: PRODUCTION_WORKSPACE_ID,
    stateDir: path.join(root, 'state'),
    runtimeRootPath,
    runtimeIdentity: { publisher: 'pie', name: 'pie', version: '0.3.0' },
    lifecycleStorePath: path.join(root, 'state', 'session-lifecycle.sqlite'),
    keyChannel: { ownerControlledMapPath: path.join(root, 'owner-keys', 'host-handoff-keys-v1.json') },
  };
  writeFileSync(planPath, JSON.stringify(plan));
  return { planPath, runtimeRootPath, keysPath: plan.keyChannel.ownerControlledMapPath };
}

function readKeyMap(keysPath) {
  return JSON.parse(readFileSync(keysPath, 'utf8'));
}

function writeBootstrapKeyFile(keysPath, bootstrapKey = BOOTSTRAP_KEY, mintedAt = MINTED_AT) {
  atomicWriteJson(bootstrapKeyPath(keysPath), {
    schemaVersion: 1,
    kind: 'pie-analytics-bootstrap-handoff-key-v1',
    bootstrapKey,
    mintedAt,
    note: 'Test fixture bootstrap key.',
  });
}

test('register wait ignores stale registered rows of dead pids and binds only the live fresh registration', async () => {
  const root = temporaryRoot('race');
  const { planPath, runtimeRootPath, keysPath } = planFixture(root);
  const options = {
    rows: [
      hostRow({ hostInstanceId: 'pre-relaunch-host', processId: 21276, registeredAtMs: BEFORE_MINT_REGISTERED_AT }),
      hostRow({ hostInstanceId: 'stale-row-1', processId: 111, registeredAtMs: BEFORE_MINT_REGISTERED_AT }),
      hostRow({ hostInstanceId: 'stale-row-2', processId: 222, registeredAtMs: BEFORE_MINT_REGISTERED_AT }),
      hostRow({ hostInstanceId: 'already-stopped', processId: 333, state: 'stopped', stoppedAtMs: BEFORE_MINT_REGISTERED_AT }),
    ],
    censusQueue: [
      censusSnapshot([21276]),
      censusSnapshot([]),
      censusSnapshot([]),
      censusSnapshot([7740]),
      censusSnapshot([7740]),
      censusSnapshot([7740]),
    ],
    leases: [leaseEntry(21276, runtimeRootPath), leaseEntry(111, runtimeRootPath), leaseEntry(222, runtimeRootPath)],
    codePids: [900],
  };
  const { modules, calls } = createFakeModules(options);
  const { dependencies, state } = fakeDependencies(modules, options, {
    onSleep: (index) => {
      if (index === 0) options.codePids.length = 0; // the owner closed VS Code normally
      if (index === 1) {
        options.rows.push(hostRow());
        options.leases.push(leaseEntry(7740, runtimeRootPath));
      }
    },
  });
  options.expectedKey = () => state.launched[0].key;

  const exitCode = await runLauncher(
    ['--plan', planPath, '--keys-path', keysPath, '--wait-close-ms', '600000', '--wait-register-ms', '600000'],
    dependencies,
  );

  assert.equal(exitCode, 0);
  assert.equal(state.launched.length, 1);
  const settledHosts = calls.markAnalyticsHostState.map((entry) => entry.hostInstanceId);
  assert.deepEqual([...settledHosts].sort(), ['pre-relaunch-host', 'stale-row-1', 'stale-row-2']);
  assert.ok(calls.markAnalyticsHostState.every((entry) => entry.state === 'stopped'));
  const keyMap = readKeyMap(keysPath);
  assert.deepEqual(Object.keys(keyMap), ['fresh-host']);
  assert.equal(keyMap['fresh-host'], state.launched[0].key);
  const bootstrapRecord = JSON.parse(readFileSync(bootstrapKeyPath(keysPath), 'utf8'));
  assert.equal(bootstrapRecord.kind, 'pie-analytics-bootstrap-handoff-key-v1');
  const freshLease = options.leases.find((entry) => entry.processId === 7740);
  assert.equal(existsSync(path.join(runtimeRootPath, 'leases', freshLease.leaseFileName)), true);
  for (const deadLease of options.leases.filter((entry) => entry.processId !== 7740)) {
    assert.equal(existsSync(path.join(runtimeRootPath, 'leases', deadLease.leaseFileName)), false);
  }
  assert.equal(calls.adapterConfigs.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test('binding fails closed without writing the key map when no live host registers', async () => {
  const root = temporaryRoot('no-live-registration');
  const { planPath, runtimeRootPath, keysPath } = planFixture(root);
  const options = {
    rows: [
      hostRow({ hostInstanceId: 'stale-row-1', processId: 111, registeredAtMs: BEFORE_MINT_REGISTERED_AT }),
      hostRow({ hostInstanceId: 'stale-row-2', processId: 222, registeredAtMs: BEFORE_MINT_REGISTERED_AT }),
    ],
    censusQueue: [censusSnapshot([]), censusSnapshot([])],
    leases: [leaseEntry(111, runtimeRootPath), leaseEntry(222, runtimeRootPath)],
    codePids: [],
    expectedKey: () => BOOTSTRAP_KEY,
  };
  const { modules, calls } = createFakeModules(options);
  const { dependencies, state } = fakeDependencies(modules, options);

  await assert.rejects(
    runLauncher(['--plan', planPath, '--keys-path', keysPath, '--wait-register-ms', '5000'], dependencies),
    (error) => error instanceof BootstrapLauncherError && /no live pie host registered/.test(error.message),
  );
  assert.equal(state.launched.length, 1);
  assert.equal(existsSync(bootstrapKeyPath(keysPath)), true);
  assert.equal(existsSync(keysPath), false);
  assert.deepEqual(calls.markAnalyticsHostState, []);
  rmSync(root, { recursive: true, force: true });
});

test('binding fails closed without writing the key map when the registered host dies after settlement', async () => {
  const root = temporaryRoot('churn');
  const { planPath, runtimeRootPath, keysPath } = planFixture(root);
  const options = {
    rows: [hostRow({ hostInstanceId: 'stale-row', processId: 111, registeredAtMs: BEFORE_MINT_REGISTERED_AT })],
    censusQueue: [
      censusSnapshot([]),
      censusSnapshot([]),
      censusSnapshot([7740]),
      censusSnapshot([]),
    ],
    leases: [leaseEntry(111, runtimeRootPath)],
    codePids: [],
    expectedKey: () => BOOTSTRAP_KEY,
  };
  const { modules, calls } = createFakeModules(options);
  const { dependencies, state } = fakeDependencies(modules, options, {
    onSleep: (index) => {
      if (index === 0) {
        options.rows.push(hostRow());
        options.leases.push(leaseEntry(7740, runtimeRootPath));
      }
    },
  });

  await assert.rejects(
    runLauncher(['--plan', planPath, '--keys-path', keysPath, '--wait-register-ms', '5000'], dependencies),
    (error) => error instanceof BootstrapLauncherError && /no live registered host remains/.test(error.message),
  );
  assert.equal(state.launched.length, 1);
  assert.deepEqual(
    calls.markAnalyticsHostState.map((entry) => entry.hostInstanceId).sort(),
    ['fresh-host', 'stale-row'],
  );
  assert.equal(existsSync(keysPath), false);
  rmSync(root, { recursive: true, force: true });
});

test('recover-key-binding binds the existing minted bootstrap key to the live registered host without re-minting', async () => {
  const root = temporaryRoot('recovery');
  const { planPath, runtimeRootPath, keysPath } = planFixture(root);
  writeBootstrapKeyFile(keysPath);
  assert.ok(Number(FRESH_REGISTERED_AT) > MINTED_AT_MS);
  const bootstrapBytesBefore = readFileSync(bootstrapKeyPath(keysPath), 'utf8');
  const options = {
    rows: [hostRow()],
    censusQueue: [censusSnapshot([7740])],
    leases: [leaseEntry(7740, runtimeRootPath)],
    codePids: [],
    expectedKey: () => BOOTSTRAP_KEY,
  };
  const { modules, calls } = createFakeModules(options);
  const { dependencies, state } = fakeDependencies(modules, options);

  const exitCode = await runLauncher(
    ['--plan', planPath, '--keys-path', keysPath, '--recover-key-binding'],
    dependencies,
  );

  assert.equal(exitCode, 0);
  assert.equal(state.launched.length, 0);
  assert.equal(readFileSync(bootstrapKeyPath(keysPath), 'utf8'), bootstrapBytesBefore);
  assert.deepEqual(readKeyMap(keysPath), { 'fresh-host': BOOTSTRAP_KEY });
  assert.equal(calls.adapterConfigs[0].keyForHost(hostRow()), BOOTSTRAP_KEY);
  rmSync(root, { recursive: true, force: true });
});

test('recover-key-binding refuses live registered hosts that predate the bootstrap key mint', async () => {
  const root = temporaryRoot('recovery-provenance');
  const { planPath, runtimeRootPath, keysPath } = planFixture(root);
  writeBootstrapKeyFile(keysPath);
  const options = {
    rows: [hostRow({ registeredAtMs: BEFORE_MINT_REGISTERED_AT })],
    censusQueue: [censusSnapshot([7740])],
    leases: [leaseEntry(7740, runtimeRootPath)],
    codePids: [],
    expectedKey: () => BOOTSTRAP_KEY,
  };
  const { modules } = createFakeModules(options);
  const { dependencies } = fakeDependencies(modules, options);

  await assert.rejects(
    runLauncher(['--plan', planPath, '--keys-path', keysPath, '--recover-key-binding'], dependencies),
    (error) => error instanceof BootstrapLauncherError && /predates the bootstrap key mint/.test(error.message),
  );
  assert.equal(existsSync(keysPath), false);
  rmSync(root, { recursive: true, force: true });
});

test('recover-key-binding fails closed when the bootstrap handoff key file is missing', async () => {
  const root = temporaryRoot('recovery-missing-key');
  const { planPath, runtimeRootPath, keysPath } = planFixture(root);
  const options = {
    rows: [hostRow()],
    censusQueue: [censusSnapshot([7740])],
    leases: [leaseEntry(7740, runtimeRootPath)],
    codePids: [],
    expectedKey: () => BOOTSTRAP_KEY,
  };
  const { modules } = createFakeModules(options);
  const { dependencies } = fakeDependencies(modules, options);

  await assert.rejects(
    runLauncher(['--plan', planPath, '--keys-path', keysPath, '--recover-key-binding'], dependencies),
    (error) => error instanceof BootstrapLauncherError && /bootstrap handoff key file is unavailable/.test(error.message),
  );
  assert.equal(existsSync(keysPath), false);
  rmSync(root, { recursive: true, force: true });
});

test('recover-key-binding reports incomplete census without throwing when authentication fails', async () => {
  const root = temporaryRoot('recovery-unauthenticated');
  const { planPath, runtimeRootPath, keysPath } = planFixture(root);
  writeBootstrapKeyFile(keysPath);
  const options = {
    rows: [hostRow()],
    censusQueue: [censusSnapshot([7740])],
    leases: [leaseEntry(7740, runtimeRootPath)],
    codePids: [],
    expectedKey: () => 'a-different-key-the-host-does-not-hold',
  };
  const { modules } = createFakeModules(options);
  const { dependencies } = fakeDependencies(modules, options);

  const exitCode = await runLauncher(
    ['--plan', planPath, '--keys-path', keysPath, '--recover-key-binding'],
    dependencies,
  );

  assert.equal(exitCode, 2);
  assert.deepEqual(readKeyMap(keysPath), { 'fresh-host': BOOTSTRAP_KEY });
  rmSync(root, { recursive: true, force: true });
});

test('parseArguments accepts the recovery flag without a value', () => {
  assert.equal(parseArguments(['--plan', 'plan.json', '--recover-key-binding']).get('recover-key-binding'), 'true');
});