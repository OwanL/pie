import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AnalyticsCutoverOrchestrator,
  ANALYTICS_CUTOVER_JOURNAL_FILENAME,
  analyticsCutoverInventorySha256,
  analyticsCutoverStorageRequestSha256,
} from '../../extension/src/host/analytics-cutover-orchestrator.ts';
import {
  assertFreshAnalyticsWriterFenceRequest,
  createSignedAnalyticsWriterFenceAcknowledgement,
  verifyAnalyticsWriterFenceRequest,
} from '../../extension/src/host/analytics-all-host-handoff.ts';
import { createProductionAnalyticsHostAdapters } from '../../extension/src/host/analytics-production-adapters.ts';
import {
  createSessionLifecycleWriterAdmission,
  SessionLifecycleStore,
  storageCutoffRootCapability,
} from '../../extension/src/backend/session-lifecycle-store.ts';
import { filesystemArtifactIdentity, verifyFilesystemArtifactIdentity } from '../../extension/src/backend/session-filesystem-lifecycle.ts';
import { createProductionStorageCutoffLifecycle } from '../../extension/src/backend/storage-cutoff-production.ts';
import { SqliteAnalyticsRecorder } from '../../extension/src/analytics/sqlite-recorder.ts';
import { ActivationStore } from '../../extension/src/analytics/activation-store.ts';
import { activateGeneration } from '../../extension/src/analytics/activation-sequence.ts';
import {
  assertFreshAnalyticsHandoffRequest,
  createSignedAnalyticsHandoffResponse,
  verifyAnalyticsHandoffRequest,
} from '../../shared/analytics/handoff.ts';

import {
  loadPlan,
  productionCutoverPrerequisites,
  runProductionCutover,
} from '../analytics-activation-helper.mjs';

// The helper refuses to run unless it owns the detached terminal context.
process.env.PIE_ANALYTICS_HELPER_DETACHED = '1';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const lifecycleStoreEntryPath = path.join(repositoryRoot, 'extension', 'out', 'session-lifecycle-store.js');
if (!existsSync(lifecycleStoreEntryPath)) {
  throw new Error('extension/out/session-lifecycle-store.js is missing; run the extension build first');
}

const commitSha = 'a'.repeat(40);
const sourceHead = 'b'.repeat(40);
const sourceFingerprint = createHash('sha256').update('test-source-fingerprint').digest('hex');
const runtimeGeneration = 'c'.repeat(64);
const runtimeIdentity = { publisher: 'pie-test', name: 'pie', version: '1.0.0-test' };

/**
 * The authoritative candidate-trial validator does not exist yet (the real
 * admission fail-closes on it), so tests inject this stand-in for that one
 * missing upstream authority. It performs the same bounded byte hashing and
 * identity bindings the real admission performs. Production keeps refusing:
 * this does not weaken any census, restart, or journal gate exercised here.
 */
function injectedActivationAdmission(options) {
  const read = (filePath, label) => {
    if (!existsSync(filePath)) throw new Error(`${label} is missing`);
    const bytes = readFileSync(filePath);
    if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) {
      throw new Error(`${label} is empty or unbounded`);
    }
    return { value: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const qualification = read(options.qualificationPath, 'qualification report');
  if (qualification.value?.qualification?.overallP0 !== 'qualified') {
    throw new Error(`P0 qualification is ${qualification.value?.qualification?.overallP0 ?? 'missing'}; overallP0 must be qualified`);
  }
  if (qualification.value?.provenance?.gitHead !== options.sourceHead
    || qualification.value?.provenance?.sourceFingerprint !== options.sourceFingerprint) {
    throw new Error('qualification provenance does not match the plan');
  }
  if (qualification.value?.build?.buildId !== options.buildId) {
    throw new Error('qualification buildId does not match the plan');
  }
  const trial = read(options.trialPath, 'candidate trial report');
  if (trial.value?.generationId !== options.generationId || trial.value?.buildId !== options.buildId) {
    throw new Error('candidate trial identity does not match the plan');
  }
  return {
    qualificationSha256: qualification.sha256,
    trialSha256: trial.sha256,
    sourceHead: options.sourceHead,
    sourceFingerprint: options.sourceFingerprint,
    buildId: options.buildId,
    qualificationMode: 'qualified',
  };
}

test('production prerequisites derive an honest provisional status and exact hashes from admitted evidence', () => {
  const admitted = {
    qualificationMode: 'provisional',
    qualificationSha256: '1'.repeat(64),
    trialSha256: '2'.repeat(64),
  };
  const result = productionCutoverPrerequisites({
    qualificationMode: 'provisional',
    prerequisites: {
      p0: {
        status: 'qualified',
        commitSha,
        qualificationSha256: '3'.repeat(64),
        trialSha256: '4'.repeat(64),
      },
      p7a: { analyticsReady: true },
      terminalHandoff: { status: 'pending' },
    },
  }, admitted);
  assert.deepEqual(result.p0, {
    status: 'provisional-qualified',
    provisionalAuthorization: 'approved-provisional-p0-envelope-v1',
    commitSha,
    qualificationSha256: admitted.qualificationSha256,
    trialSha256: admitted.trialSha256,
  });
  assert.equal(result.p7a.analyticsReady, true);
});

test('production prerequisites refuse provisional evidence without explicit provisional activation mode', () => {
  assert.throws(() => productionCutoverPrerequisites({
    prerequisites: { p0: { commitSha } },
  }, {
    qualificationMode: 'provisional',
    qualificationSha256: '1'.repeat(64),
    trialSha256: '2'.repeat(64),
  }), /requires explicit provisional activation mode/u);
});

test('production prerequisites preserve the fully qualified path without provisional authorization', () => {
  const result = productionCutoverPrerequisites({
    prerequisites: { p0: { commitSha } },
  }, {
    qualificationMode: 'qualified',
    qualificationSha256: '1'.repeat(64),
    trialSha256: '2'.repeat(64),
  });
  assert.deepEqual(result.p0, {
    status: 'qualified',
    commitSha,
    qualificationSha256: '1'.repeat(64),
    trialSha256: '2'.repeat(64),
  });
});

function toStatusHost(record) {
  return {
    hostInstanceId: record.hostInstanceId,
    workspaceId: record.workspaceId,
    generationId: record.generationId,
    buildId: record.buildId,
    processId: record.processId,
    endpointName: record.endpointName,
    capabilities: [...record.capabilities],
    state: record.state,
    registeredAtMs: record.registeredAtMs,
    heartbeatAtMs: record.heartbeatAtMs,
    updatedAtMs: record.updatedAtMs,
  };
}

const restartScriptSource = `
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [configPath] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const require = createRequire(import.meta.url);
const { SessionLifecycleStore } = require(process.env.PIE_TEST_LIFECYCLE_STORE_ENTRY);
const nonce = process.env.PIE_ANALYTICS_RESTART_NONCE ?? \`nonce-\${Date.now()}\`;
const counter = (existsSync(config.counterPath)
  ? JSON.parse(readFileSync(config.counterPath, 'utf8')).boot
  : 0) + 1;
const boot = config.boots[String(counter)];
if (!boot) {
  process.stderr.write(\`restart fixture has no boot \${counter}\\n\`);
  process.exit(3);
}
writeFileSync(config.counterPath, \`\${JSON.stringify({ schemaVersion: 1, boot: counter })}\\n\`);
const now = Date.now();
const store = new SessionLifecycleStore(config.lifecycleStorePath);
try {
  const hosts = store.listAnalyticsHosts(config.workspaceId, { limit: 64 }).hosts;
  for (const host of hosts) {
    if (host.state !== 'stopped') {
      store.markAnalyticsHostState(host.hostInstanceId, host.processId, host.generationId, 'stopped', now);
    }
  }
  store.registerAnalyticsHost({
    hostInstanceId: boot.hostInstanceId,
    workspaceId: config.workspaceId,
    generationId: boot.hostGenerationId,
    buildId: config.buildId,
    processId: boot.hostPid,
    endpointName: boot.endpoint,
    capabilities: [
      'authenticated-control',
      'writer-fence',
      ...(config.storageRootCapability ? [config.storageRootCapability] : []),
    ],
    registeredAtMs: now,
  });
} finally {
  store.close();
}
if (config.refreshKeyChannel !== false) {
  if (config.keyChannel === 'file') {
    const keys = existsSync(config.keysPath) ? JSON.parse(readFileSync(config.keysPath, 'utf8')) : {};
    keys[boot.hostInstanceId] = boot.key;
    writeFileSync(config.keysPath, \`\${JSON.stringify(keys, null, 2)}\\n\`);
  } else {
    const plan = JSON.parse(readFileSync(config.planPath, 'utf8'));
    plan.hostHandoffKeys = { ...plan.hostHandoffKeys, [boot.hostInstanceId]: boot.key };
    writeFileSync(config.planPath, \`\${JSON.stringify(plan, null, 2)}\\n\`);
  }
}
const loadedAt = new Date().toISOString();
writeFileSync(process.env.PIE_TEST_LOADED_MARKER_PATH, \`\${JSON.stringify({
  schemaVersion: 1,
  generationId: config.generationId,
  buildId: config.buildId,
  restartNonce: nonce,
  hostInstanceId: boot.hostInstanceId,
  loadedAt,
}, null, 2)}\\n\`);
const receipt = {
  schemaVersion: 1,
  kind: 'pie-p7-terminal-restart-v1',
  status: 'ready',
  generationId: config.generationId,
  buildId: config.buildId,
  restartNonce: nonce,
  hostInstanceId: boot.hostInstanceId,
  processId: boot.hostPid,
  loadedAt,
  verifiedAt: new Date().toISOString(),
};
writeFileSync(process.env.PIE_TEST_RECEIPT_PATH, \`\${JSON.stringify(receipt, null, 2)}\\n\`);
`;

function makeBoot(index, overrides = {}) {
  return {
    hostInstanceId: `boot-${index}`,
    hostGenerationId: `host-process-generation-${index}`,
    key: createHash('sha256').update(`per-boot-key-${index}`).digest('hex'),
    descriptorGeneration: null,
    hostPid: 9_000 + index * 10 + 1,
    backendPid: 9_000 + index * 10 + 2,
    backendGeneration: 40 + index,
    endpoint: `pipe-analytics-cutover-${index}`,
    ...overrides,
  };
}

/**
 * Build a complete hermetic cutover world: a real lifecycle registry with
 * boot 1 pre-registered, evidence reports, an activation plan, and a restart
 * fixture that performs the controlled restart exactly like the production
 * owner would (stop old rows, register the successor, refresh the
 * owner-controlled key channel, write the loaded marker and the signed
 * terminal receipt). Census evidence is served for the boot named by the
 * fixture's boot counter, so each restart genuinely changes the world.
 */
function buildCutoverWorld({ generationId, boots, keyChannel = 'plan', refreshKeyChannel = true, storageRootCapability }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-analytics-cutover-'));
  const stateDir = path.join(root, 'state');
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const lifecycleStorePath = path.join(root, 'lifecycle.sqlite');
  const workspaceId = 'cutover-workspace';
  const buildId = 'cutover-build';
  const registry = new SessionLifecycleStore(lifecycleStorePath);
  try {
    registry.registerAnalyticsHost({
      hostInstanceId: boots['1'].hostInstanceId,
      workspaceId,
      generationId: boots['1'].hostGenerationId,
      buildId,
      processId: boots['1'].hostPid,
      endpointName: boots['1'].endpoint,
      capabilities: ['authenticated-control', 'writer-fence'],
      registeredAtMs: '10',
    });
  } finally {
    registry.close();
  }
  writeFileSync(path.join(root, 'boot-counter.json'), `${JSON.stringify({ schemaVersion: 1, boot: 1 })}\n`);
  const keysPath = path.join(root, 'host-keys.json');
  const planPath = path.join(root, 'plan.json');
  writeFileSync(keysPath, `${JSON.stringify(keyChannel === 'file' ? { [boots['1'].hostInstanceId]: boots['1'].key } : {}, null, 2)}\n`);
  const loadedMarkerPath = path.join(stateDir, 'analytics-loaded-generation-v1.json');
  writeFileSync(loadedMarkerPath, `${JSON.stringify({
    schemaVersion: 1,
    generationId: 'legacy-loaded-generation',
    buildId,
    restartNonce: 'seed-nonce',
    hostInstanceId: boots['1'].hostInstanceId,
    loadedAt: new Date(Date.now() - 60_000).toISOString(),
  }, null, 2)}\n`);
  const qualificationPath = path.join(root, 'qualification-report.json');
  const trialPath = path.join(root, 'candidate-trial.json');
  writeFileSync(qualificationPath, `${JSON.stringify({
    provenance: { gitHead: sourceHead, sourceFingerprint },
    build: { buildId },
    qualification: { overallP0: 'qualified' },
  }, null, 2)}\n`);
  writeFileSync(trialPath, `${JSON.stringify({ generationId, buildId }, null, 2)}\n`);
  const qualificationSha256 = createHash('sha256').update(readFileSync(qualificationPath)).digest('hex');
  const trialSha256 = createHash('sha256').update(readFileSync(trialPath)).digest('hex');
  const restartScriptPath = path.join(root, 'controlled-restart-fixture.mjs');
  writeFileSync(restartScriptPath, restartScriptSource);
  const receiptPath = path.join(root, 'terminal-restart-receipt.json');
  // The restart fixture child inherits this process's environment; point it at
  // this world's store entry, loaded marker, and receipt paths.
  process.env.PIE_TEST_LIFECYCLE_STORE_ENTRY = lifecycleStoreEntryPath;
  process.env.PIE_TEST_LOADED_MARKER_PATH = loadedMarkerPath;
  process.env.PIE_TEST_RECEIPT_PATH = receiptPath;
  const configPath = path.join(root, 'restart-config.json');
  writeFileSync(configPath, JSON.stringify({
    workspaceId,
    generationId,
    buildId,
    lifecycleStorePath,
    counterPath: path.join(root, 'boot-counter.json'),
    keysPath,
    planPath,
    keyChannel,
    refreshKeyChannel,
    storageRootCapability,
    boots,
  }, null, 2));
  const plan = {
    stateDir,
    qualificationReport: qualificationPath,
    trialReport: trialPath,
    generationId,
    buildId,
    sourceHead,
    sourceFingerprint,
    reportPath: path.join(root, 'activation-report.json'),
    workspaceId,
    runtimeRootPath: path.join(root, 'runtime'),
    runtimeIdentity,
    ...(keyChannel === 'file'
      ? { hostHandoffKeysPath: keysPath }
      : { hostHandoffKeys: { [boots['1'].hostInstanceId]: boots['1'].key } }),
    terminalRestartReceiptPath: receiptPath,
    restartCommand: `"${process.execPath}" "${restartScriptPath}" "${configPath}"`,
    lifecycleStorePath,
    operationId: randomUUID(),
    cutoverMode: 'analytics-activation',
    authorization: { schemaVersion: 1, plan: 'analytics-rework-plan-17', approved: true, commitSha },
    prerequisites: {
      p0: { status: 'qualified', commitSha, qualificationSha256, trialSha256 },
      p7a: { analyticsReady: true, privacyDeleteReady: true, queryReady: true, selectedDesignQualified: true },
      terminalHandoff: { status: 'pending' },
    },
    hostProbeTimeoutMs: 1_000,
  };
  // loadPlan validates the plan file and attaches the non-enumerable planPath
  // the in-plan key channel needs; production loads plans the same way.
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const loadedPlan = loadPlan(planPath, { preflight: false });
  return {
    root,
    boots,
    plan: loadedPlan,
    planPath,
    qualificationSha256,
    trialSha256,
    receiptPath,
    keysPath,
    workspaceId,
    stateDir,
    lifecycleStorePath,
    cleanup() {
      if (process.env.PIE_DEBUG_KEEP_WORLD !== '1') rmSync(root, { recursive: true, force: true });
    },
  };
}

function createCutoverDependencies(world, censusSeams) {
  const createdAdapterOptions = [];
  /** The factory construction census (what the coordinator will consume). */
  const preFenceDiscoveries = [];
  /** The helper's explicit post-restart census calls. */
  const discoveries = [];
  const dependencies = {
    admitActivationEvidence: injectedActivationAdmission,
    ActivationStore,
    activateGeneration,
    AnalyticsCutoverOrchestrator,
    analyticsCutoverInventorySha256,
    analyticsCutoverJournalFilename: ANALYTICS_CUTOVER_JOURNAL_FILENAME,
    createProductionAnalyticsHostAdapters: (options) => {
      createdAdapterOptions.push(options);
      const adapters = createProductionAnalyticsHostAdapters({
        ...options,
        readProcessOwners: censusSeams.readProcessOwners,
        readRuntimeLeases: censusSeams.readRuntimeLeases,
        send: censusSeams.send,
      });
      // Capture the read-only construction census (the exact evidence the
      // coordinator consumes); discovery never mutates state.
      preFenceDiscoveries.push(adapters.discover({ ignoreStoppedHosts: true }));
      return {
        ...adapters,
        discover: async (overrides) => {
          const result = await adapters.discover(overrides);
          discoveries.push(result);
          return result;
        },
      };
    },
    SessionLifecycleStore,
    storageCutoffRootCapability,
    verifyFilesystemArtifactIdentity,
    createProductionStorageCutoffLifecycle,
    SqliteAnalyticsRecorder,
  };
  return { dependencies, createdAdapterOptions, preFenceDiscoveries, discoveries };
}

/**
 * Census seams served for the boot named by the fixture counter. Every call
 * re-reads the counter file, so restarts genuinely change the world. The
 * socket seam verifies MACs against the CURRENT boot's per-boot key and
 * returns signed status/freeze responses for the live registry row.
 */
function createCensusSeams(world) {
  const readBootState = () => {
    const boot = world.boots[String(JSON.parse(readFileSync(path.join(world.root, 'boot-counter.json'), 'utf8')).boot)];
    if (!boot) throw new Error('test world census has no boot for the current counter');
    return boot;
  };
  const registry = new SessionLifecycleStore(world.lifecycleStorePath);
  const close = () => registry.close();
  return {
    registry,
    close,
    readProcessOwners: async () => {
      const boot = readBootState();
      return {
        processes: [
          { processId: boot.hostPid, processCreatedAtMs: 1_000 },
          { processId: boot.backendPid, processCreatedAtMs: 1_100 },
        ],
        backendOwners: [{
          backendProcessId: boot.backendPid,
          hostProcessId: boot.hostPid,
          backendCreatedAtMs: 1_100,
          hostCreatedAtMs: 1_000,
          backendGeneration: boot.backendGeneration,
          ...(boot.descriptorGeneration
            ? { analyticsGenerationId: boot.descriptorGeneration, analyticsHostInstanceId: boot.hostInstanceId }
            : {}),
        }],
        complete: true,
        reasons: [],
      };
    },
    readRuntimeLeases: async () => {
      const boot = readBootState();
      return {
        leases: [{
          leaseFileName: `${runtimeGeneration}-${boot.hostPid}-${'ab'.repeat(16)}.json`,
          runtimeGeneration,
          processId: boot.hostPid,
          leaseCreatedAtMs: 1_500,
          identity: runtimeIdentity,
        }],
        complete: true,
        reasons: [],
      };
    },
    send: async (endpointName, request) => {
      const boot = readBootState();
      if (endpointName !== boot.endpoint) {
        throw new Error(`no live authenticated endpoint for ${endpointName}`);
      }
      const host = registry.getAnalyticsHost(boot.hostInstanceId);
      if (!host) throw new Error(`test world has no registry row for ${boot.hostInstanceId}`);
      if (request && request.protocol === 'pie-analytics-writer-fence-v1') {
        const verified = verifyAnalyticsWriterFenceRequest(request, boot.key);
        assertFreshAnalyticsWriterFenceRequest(verified, Date.now());
        return createSignedAnalyticsWriterFenceAcknowledgement(verified, {
          hostInstanceId: host.hostInstanceId,
          workspaceId: host.workspaceId,
          generationId: host.generationId,
          buildId: host.buildId,
          processId: host.processId,
        }, { admissionRevoked: true, writersDrained: true, activeWriterCount: 0 }, boot.key);
      }
      const verified = verifyAnalyticsHandoffRequest(request, boot.key);
      assertFreshAnalyticsHandoffRequest(verified, Date.now());
      const statusHost = toStatusHost(host);
      return createSignedAnalyticsHandoffResponse(verified.requestId, boot.key, {
        ok: true,
        result: {
          host: statusHost,
          hosts: [statusHost],
          truncated: false,
          inventoryProof: {
            kind: 'registered-hosts-only',
            complete: false,
            reason: 'runtime-generation-and-process-reconciliation-unwired',
          },
          allHostsHandoffAvailable: false,
        },
      });
    },
  };
}

/**
 * Read-only census probe built from the helper's exact recorded adapter
 * options plus the live seams. `discoverAnalyticsHostWriters` never mutates
 * state, so failed runs can be re-probed to pin the exact census reasons.
 */
function probeCensus(world, seams, createdOptions, overrides = {}) {
  const adapters = createProductionAnalyticsHostAdapters({
    ...createdOptions,
    // The helper closes its own registry connection when its run returns;
    // probes always read through the live seam registry.
    registry: seams.registry,
    readProcessOwners: seams.readProcessOwners,
    readRuntimeLeases: seams.readRuntimeLeases,
    send: seams.send,
  });
  return adapters.discover(overrides);
}

function withCutoverWorld(world, testBody) {
  process.env.PIE_TEST_LIFECYCLE_STORE_ENTRY = lifecycleStoreEntryPath;
  process.env.PIE_TEST_LOADED_MARKER_PATH = path.join(world.stateDir, 'analytics-loaded-generation-v1.json');
  process.env.PIE_TEST_RECEIPT_PATH = world.receiptPath;
  const seams = createCensusSeams(world);
  const { dependencies, createdAdapterOptions, preFenceDiscoveries, discoveries } = createCutoverDependencies(world, seams);
  return Promise.resolve(testBody({ seams, dependencies, createdAdapterOptions, preFenceDiscoveries, discoveries }))
    .finally(async () => {
      // Drain the read-only construction censuses before closing the seam
      // registry so their in-flight reads never race the teardown.
      await Promise.allSettled(preFenceDiscoveries);
      seams.close();
    })
    .finally(() => world.cleanup());
}

function fenceOperationId(world) {
  return `${world.plan.operationId}:analytics-activation`;
}

function readJournal(world) {
  return JSON.parse(readFileSync(path.join(world.stateDir, ANALYTICS_CUTOVER_JOURNAL_FILENAME), 'utf8'));
}

function readJournalOrNull(world) {
  const journalPath = path.join(world.stateDir, ANALYTICS_CUTOVER_JOURNAL_FILENAME);
  return existsSync(journalPath) ? readJournal(world) : null;
}

test('PRODUCTION cutover G1->G2 first activation: census proves the loaded world, restart census requires the new generation', async () => {
  const generationId = randomUUID();
  const world = buildCutoverWorld({
    generationId,
    boots: { '1': makeBoot(1), '2': makeBoot(2, { descriptorGeneration: generationId }) },
    keyChannel: 'plan',
  });
  return withCutoverWorld(world, async ({ seams, dependencies, createdAdapterOptions, preFenceDiscoveries, discoveries }) => {
    const result = await runProductionCutover(world.plan, dependencies);

    assert.equal(result.status, 'complete');
    assert.equal(result.activation.manifest.activeGeneration.identity.generationId, generationId);
    assert.equal(result.loadedGeneration.hosts.map((host) => host.hostInstanceId).join(','), 'boot-2');
    assert.equal(
      result.loadedGeneration.terminalEvidenceSha256,
      createHash('sha256').update(readFileSync(world.receiptPath, 'utf8')).digest('hex'),
    );

    // B1: the pre-fence census proved the loaded (descriptor-less) world with
    // no generation expectation, and the post-restart census completed while
    // explicitly naming the committed generation.
    assert.equal(createdAdapterOptions.length, 1);
    assert.equal(createdAdapterOptions[0].analyticsGenerationId, undefined);
    assert.equal(createdAdapterOptions[0].allowAbsentAnalyticsDescriptor, true);
    const preFenceCensus = await preFenceDiscoveries[0];
    assert.equal(preFenceCensus.complete, true);
    assert.equal(discoveries.length, 1);
    assert.equal(discoveries[0].complete, true);

    const store = new ActivationStore({ stateDir: world.stateDir });
    const manifest = store.read();
    assert.equal(manifest.authority, 'canonical');
    assert.equal(manifest.manifest.activeGeneration.identity.generationId, generationId);

    const hosts = seams.registry.listAnalyticsHosts(world.workspaceId, { limit: 64 }).hosts;
    assert.deepEqual(hosts.map((host) => ({ id: host.hostInstanceId, state: host.state })), [
      { id: 'boot-1', state: 'stopped' },
      { id: 'boot-2', state: 'registered' },
    ]);
    const fence = seams.registry.getAnalyticsWriterFence(world.workspaceId);
    // A completed cutover reopens writer admission, which advances the fence
    // to the post-activation 'open' state.
    assert.equal(fence.state, 'open');
    assert.equal(seams.registry.getAnalyticsWriterAdmissionState(world.workspaceId).state, 'open');

    const journal = readJournal(world);
    assert.equal(journal.phase, 'complete');
    // B3: a first run writes a fresh timestamp and nothing rewrote it.
    assert.equal(journal.activationRequest.generationId, generationId);
    assert.equal(result.activation.alreadyActive, false);
  });
});

test('PRODUCTION upgrade census binds the active generation; committing a replacement stays refused', async () => {
  const previousGenerationId = randomUUID();
  const generationId = randomUUID();
  const world = buildCutoverWorld({
    generationId,
    boots: {
      '1': makeBoot(1, { descriptorGeneration: previousGenerationId }),
      '2': makeBoot(2, { descriptorGeneration: generationId }),
    },
    keyChannel: 'file',
  });
  return withCutoverWorld(world, async ({ seams, dependencies, createdAdapterOptions, discoveries }) => {
    const store = new ActivationStore({ stateDir: world.stateDir });
    await activateGeneration(store, {
      generationId: previousGenerationId,
      buildId: world.plan.buildId,
      qualificationSha256: world.qualificationSha256,
      trialSha256: world.trialSha256,
      activatedAt: new Date(Date.now() - 120_000).toISOString(),
    });

    await assert.rejects(
      () => runProductionCutover(world.plan, dependencies),
      /would require retiring it first/,
    );

    // B1: the pre-fence census was constructed with the ACTIVE generation and
    // reconciles the currently loaded G1 world; the fence completed.
    assert.equal(createdAdapterOptions[0].analyticsGenerationId, previousGenerationId);
    assert.equal(createdAdapterOptions[0].allowAbsentAnalyticsDescriptor, undefined);
    const preFenceCensus = await probeCensus(world, seams, createdAdapterOptions[0], { ignoreStoppedHosts: true });
    assert.equal(preFenceCensus.complete, true);
    assert.equal(seams.registry.getAnalyticsWriterFence(world.workspaceId).state, 'fenced');
    assert.equal(readJournal(world).phase, 'analytics-fenced');

    // The unresolved retirement boundary: the manifest still names G1 and no
    // replacement was written behind the refusal.
    const manifest = store.read();
    assert.equal(manifest.manifest.activeGeneration.identity.generationId, previousGenerationId);
  });
});

test('PRODUCTION first activation keeps a present descriptor unreconcilable before the fence', async () => {
  const generationId = randomUUID();
  const world = buildCutoverWorld({
    generationId,
    boots: { '1': makeBoot(1, { descriptorGeneration: 'legacy-generation-without-authority' }) },
    keyChannel: 'file',
  });
  return withCutoverWorld(world, async ({ seams, dependencies, createdAdapterOptions }) => {
    await assert.rejects(
      () => runProductionCutover(world.plan, dependencies),
      /All-host writer census is incomplete/,
    );

    const preFenceCensus = await probeCensus(world, seams, createdAdapterOptions[0], { ignoreStoppedHosts: true });
    assert.equal(preFenceCensus.complete, false);
    assert.ok(preFenceCensus.reasons.some((entry) => entry.code === 'backend-analytics-generation-unavailable'));
    assert.equal(seams.registry.getAnalyticsWriterFence(world.workspaceId), undefined);
    assert.equal(readJournalOrNull(world), null);
    const store = new ActivationStore({ stateDir: world.stateDir });
    assert.equal(store.read().authority, 'legacy');
  });
});

test('PRODUCTION post-restart census explicitly requires the new generation descriptor', async () => {
  const generationId = randomUUID();
  const world = buildCutoverWorld({
    generationId,
    boots: { '1': makeBoot(1), '2': makeBoot(2, { descriptorGeneration: null }) },
    keyChannel: 'file',
  });
  return withCutoverWorld(world, async ({ seams, dependencies, createdAdapterOptions, discoveries }) => {
    await assert.rejects(
      () => runProductionCutover(world.plan, dependencies),
      /backend-analytics-descriptor-missing/,
    );

    // The fence and activation committed before the restarted world failed to
    // prove the new generation; nothing silently adopted the old authority.
    assert.equal(seams.registry.getAnalyticsWriterFence(world.workspaceId).state, 'fenced');
    assert.equal(readJournal(world).phase, 'analytics-committed');
    const store = new ActivationStore({ stateDir: world.stateDir });
    assert.equal(store.read().manifest.activeGeneration.identity.generationId, generationId);
    assert.equal(discoveries.length, 1);
    assert.equal(discoveries[0].complete, false);
    assert.ok(discoveries[0].reasons.some((entry) => entry.code === 'backend-analytics-descriptor-missing'));
    // The exact post-restart census contract: the committed generation named
    // explicitly and the descriptor absence not waived.
    const postRestartCensus = await probeCensus(world, seams, createdAdapterOptions[0], {
      ignoreStoppedHosts: true,
      analyticsGenerationId: generationId,
      allowAbsentAnalyticsDescriptor: false,
    });
    assert.ok(postRestartCensus.reasons.some((entry) => entry.code === 'backend-analytics-descriptor-missing'));
  });
});

test('PRODUCTION post-restart authentication requires the refreshed per-boot key channel', async () => {
  const generationId = randomUUID();
  const world = buildCutoverWorld({
    generationId,
    boots: { '1': makeBoot(1), '2': makeBoot(2, { descriptorGeneration: generationId }) },
    keyChannel: 'file',
    refreshKeyChannel: false,
  });
  return withCutoverWorld(world, async ({ seams, dependencies, discoveries }) => {
    await assert.rejects(
      () => runProductionCutover(world.plan, dependencies),
      /host-authentication-key-missing/,
    );

    assert.equal(seams.registry.getAnalyticsWriterFence(world.workspaceId).state, 'fenced');
    assert.equal(readJournal(world).phase, 'analytics-committed');
    const store = new ActivationStore({ stateDir: world.stateDir });
    assert.equal(store.read().manifest.activeGeneration.identity.generationId, generationId);
    assert.equal(discoveries.length, 1);
    assert.ok(discoveries[0].reasons.some((entry) => entry.code === 'host-authentication-key-missing'));
  });
});

test('PRODUCTION interrupted analytics-committed resume recovers the journaled activatedAt and completes', async () => {
  const generationId = randomUUID();
  const staleGenerationId = randomUUID();
  const world = buildCutoverWorld({
    generationId,
    boots: {
      '1': makeBoot(1),
      '2': makeBoot(2, { descriptorGeneration: staleGenerationId }),
      '3': makeBoot(3, { descriptorGeneration: generationId }),
    },
    keyChannel: 'plan',
  });
  return withCutoverWorld(world, async ({ seams, dependencies, discoveries }) => {
    await assert.rejects(
      () => runProductionCutover(world.plan, dependencies),
      /backend-analytics-generation-mismatch/,
    );
    const interrupted = readJournal(world);
    assert.equal(interrupted.phase, 'analytics-committed');
    const recordedActivatedAt = interrupted.activationRequest.activatedAt;
    assert.ok(recordedActivatedAt);

    const result = await runProductionCutover(world.plan, dependencies);
    assert.equal(result.status, 'complete');
    assert.equal(result.activation.alreadyActive, true);

    // B3: the rerun reused the journaled activation instant and the manifest
    // revision is unchanged; the resumed run did not re-fence or re-activate.
    const journal = readJournal(world);
    assert.equal(journal.phase, 'complete');
    assert.equal(journal.activationRequest.activatedAt, recordedActivatedAt);
    assert.equal(discoveries.length, 2);
    assert.equal(discoveries[0].complete, false);
    assert.equal(discoveries[1].complete, true);
  });
});

test('PRODUCTION rerun with changed activation evidence is rejected, never silently adopted', async () => {
  const generationId = randomUUID();
  const world = buildCutoverWorld({
    generationId,
    boots: { '1': makeBoot(1), '2': makeBoot(2, { descriptorGeneration: generationId }) },
    keyChannel: 'plan',
  });
  return withCutoverWorld(world, async ({ dependencies }) => {
    const first = await runProductionCutover(world.plan, dependencies);
    assert.equal(first.status, 'complete');

    // Change the candidate-trial evidence bytes and admit them again.
    const changedTrial = path.join(world.root, 'changed-trial.json');
    // Keep the trial's identity fields matching the plan so admission accepts
    // it; only the bytes (and therefore the admitted hash) change.
    writeFileSync(changedTrial, `${JSON.stringify({ generationId, buildId: world.plan.buildId, changedMarker: 'evidence-changed' }, null, 2)}\n`);
    const changedPlan = {
      ...world.plan,
      trialReport: changedTrial,
      prerequisites: {
        ...world.plan.prerequisites,
        p0: {
          ...world.plan.prerequisites.p0,
          trialSha256: createHash('sha256').update(readFileSync(changedTrial)).digest('hex'),
        },
      },
    };
    await assert.rejects(
      () => runProductionCutover(changedPlan, dependencies),
      /Analytics cutover activation evidence changed during recovery/,
    );

    const store = new ActivationStore({ stateDir: world.stateDir });
    const manifest = store.read();
    assert.equal(manifest.manifest.activeGeneration.identity.generationId, generationId);
    assert.equal(readJournal(world).phase, 'complete');
  });
});

test('PRODUCTION interrupted analytics-fenced resume completes with the journaled activatedAt', async () => {
  const generationId = randomUUID();
  const world = buildCutoverWorld({
    generationId,
    boots: { '1': makeBoot(1), '2': makeBoot(2, { descriptorGeneration: generationId }) },
    keyChannel: 'plan',
  });
  return withCutoverWorld(world, async ({ seams, dependencies }) => {
    // Hand-craft the interrupted state exactly as the orchestrator leaves it:
    // the fence is durably fenced and the journal stops before activation.
    const fence = seams.registry.beginAnalyticsWriterFence({
      workspaceId: world.workspaceId,
      operationId: fenceOperationId(world),
      purpose: 'analytics-activation',
      expectedHosts: [{
        hostInstanceId: world.boots['1'].hostInstanceId,
        workspaceId: world.workspaceId,
        generationId: world.boots['1'].hostGenerationId,
        buildId: world.plan.buildId,
        processId: world.boots['1'].hostPid,
      }],
      nowMs: Date.now(),
    });
    seams.registry.acknowledgeAnalyticsWriterFence({
      workspaceId: world.workspaceId,
      operationId: fenceOperationId(world),
      fenceEpoch: fence.fenceEpoch,
      identity: {
        hostInstanceId: world.boots['1'].hostInstanceId,
        workspaceId: world.workspaceId,
        generationId: world.boots['1'].hostGenerationId,
        buildId: world.plan.buildId,
        processId: world.boots['1'].hostPid,
      },
      activeWriterCount: 0,
      nowMs: Date.now(),
    });
    seams.registry.completeAnalyticsWriterFence(world.workspaceId, fenceOperationId(world), Date.now());
    const fixedActivatedAt = new Date(Date.now() - 30_000).toISOString();
    const journal = {
      schemaVersion: 1,
      operationId: world.plan.operationId,
      workspaceId: world.workspaceId,
      mode: 'analytics-activation',
      plan: 'analytics-rework-plan-17',
      authorizationCommitSha: commitSha,
      activationRequest: {
        generationId,
        buildId: world.plan.buildId,
        qualificationSha256: world.qualificationSha256,
        trialSha256: world.trialSha256,
        activatedAt: fixedActivatedAt,
        cutoffReceiptSha256: null,
      },
      phase: 'analytics-fenced',
      startedAt: new Date(Date.now() - 31_000).toISOString(),
      updatedAt: new Date(Date.now() - 31_000).toISOString(),
      analyticsFence: {
        schemaVersion: 1,
        workspaceId: world.workspaceId,
        operationId: fenceOperationId(world),
        purpose: 'analytics-activation',
        fenceEpoch: fence.fenceEpoch,
        status: 'fenced',
        hostInstanceIds: [world.boots['1'].hostInstanceId],
        acknowledgedHostInstanceIds: [world.boots['1'].hostInstanceId],
      },
    };
    writeFileSync(path.join(world.stateDir, ANALYTICS_CUTOVER_JOURNAL_FILENAME), `${JSON.stringify(journal, null, 2)}\n`);

    const result = await runProductionCutover(world.plan, dependencies);
    assert.equal(result.status, 'complete');
    assert.equal(result.activation.alreadyActive, false);

    // B3: the committed activation reused the journaled instant exactly.
    assert.equal(readJournal(world).activationRequest.activatedAt, fixedActivatedAt);
    assert.equal(seams.registry.getAnalyticsWriterAdmissionState(world.workspaceId).state, 'open');
  });
});

test('PRODUCTION P7b closes the explicit inventory and admits only a new-root successor', async () => {
  const generationId = randomUUID();
  const world = buildCutoverWorld({
    generationId,
    boots: {
      '1': makeBoot(1, { descriptorGeneration: generationId }),
      '2': makeBoot(2, { descriptorGeneration: generationId }),
    },
    keyChannel: 'file',
  });
  const priorAuthorization = process.env.PIE_STORAGE_CUTOFF_AUTHORIZATION;
  process.env.PIE_STORAGE_CUTOFF_AUTHORIZATION = 'p7b-authorized-v1';
  const sessionsDir = path.join(world.root, 'new-sessions');
  const artifactsDir = path.join(world.root, 'new-artifacts');
  const transcriptPath = path.join(world.root, 'legacy-sessions', 'session-cutoff.jsonl');
  const privateTranscriptPath = path.join(world.root, 'legacy-sessions', 'session-private.jsonl');
  const analyticsDatabasePath = path.join(world.root, 'analytics', 'analytics.sqlite');
  mkdirSync(path.dirname(transcriptPath), { recursive: true });
  writeFileSync(transcriptPath, `${JSON.stringify({ type: 'session', id: 'session-cutoff' })}\n`);
  writeFileSync(privateTranscriptPath, `${JSON.stringify({ type: 'session', id: 'session-private' })}\n`);
  const analytics = new SqliteAnalyticsRecorder(analyticsDatabasePath);
  analytics.close();
  const registry = new SessionLifecycleStore(world.lifecycleStorePath);
  try {
    registry.registerArtifact({
      sessionId: 'session-cutoff', artifactId: 'transcript', kind: 'transcript',
      locationKind: 'fixed_absolute', location: transcriptPath,
      identityJson: filesystemArtifactIdentity(transcriptPath),
    }, Date.now());
    registry.registerArtifact({
      sessionId: 'session-private', artifactId: 'transcript', kind: 'transcript',
      locationKind: 'fixed_absolute', location: privateTranscriptPath,
      identityJson: filesystemArtifactIdentity(privateTranscriptPath),
    }, Date.now());
    registry.setPrivacyMode('session-private', 'on', Date.now());
  } finally {
    registry.close();
  }
  const capability = storageCutoffRootCapability(sessionsDir);
  const configPath = path.join(world.root, 'restart-config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, storageRootCapability: capability }, null, 2));
  const activationStore = new ActivationStore({ stateDir: world.stateDir });
  await activateGeneration(activationStore, {
    generationId,
    buildId: world.plan.buildId,
    qualificationSha256: world.qualificationSha256,
    trialSha256: world.trialSha256,
    activatedAt: new Date().toISOString(),
  });
  const storagePlan = {
    ...world.plan,
    cutoverMode: 'storage-cutoff',
    operationId: randomUUID(),
    expectedActiveGenerationId: generationId,
    cutoffInventory: ['session-cutoff', 'session-private'],
    cutoffInventoryValidated: true,
    cutoffRoots: { sessions: sessionsDir, artifacts: artifactsDir },
    analyticsDatabasePath,
    prerequisites: {
      ...world.plan.prerequisites,
      p7b: {
        lifecycleOwnerReady: true,
        legacyScrubBoundaryReady: true,
        rootSwitchReady: true,
        expiryInPlaceReady: true,
      },
    },
  };
  try {
    return await withCutoverWorld({ ...world, plan: storagePlan }, async ({ seams, dependencies }) => {
      const result = await runProductionCutover(storagePlan, dependencies);
      assert.equal(result.status, 'complete');
      assert.deepEqual(result.storage.closedSessionIds, ['session-cutoff', 'session-private']);
      assert.deepEqual(result.storage.deletedSessionIds, ['session-private']);
      assert.equal(result.storageVerification.admissionReopened, true);
      assert.deepEqual(result.storageVerification.hosts.map((host) => host.hostInstanceId), ['boot-2']);
      const closed = seams.registry.get('session-cutoff');
      assert.equal(closed.cleanupState, 'retained');
      assert.equal(BigInt(closed.expiresAtMs) - BigInt(closed.closedAtMs), 24n * 60n * 60n * 1_000n);
      assert.equal(existsSync(transcriptPath), true);
      assert.equal(existsSync(privateTranscriptPath), false);
      assert.equal(seams.registry.get('session-private').cleanupState, 'deleted');
      assert.equal(seams.registry.getAnalyticsWriterAdmissionState(world.workspaceId).state, 'fenced');
      const successor = seams.registry.getAnalyticsHost('boot-2');
      assert.ok(successor);
      const admission = createSessionLifecycleWriterAdmission(seams.registry, successor, Date.now);
      admission.assertAdmitted();
      admission.acquire()();
      const rerun = await runProductionCutover(storagePlan, dependencies);
      assert.equal(rerun.status, 'complete');
      assert.equal(JSON.parse(readFileSync(path.join(world.root, 'boot-counter.json'), 'utf8')).boot, 2);
    });
  } finally {
    if (priorAuthorization === undefined) delete process.env.PIE_STORAGE_CUTOFF_AUTHORIZATION;
    else process.env.PIE_STORAGE_CUTOFF_AUTHORIZATION = priorAuthorization;
  }
});

/** Shared P7b interrupted-resume world: explicit deduplicated inventory, a
 * canonical analytics database, and the already-active generation the cutoff
 * binds to. Returns the exact digests the orchestrator must journal. */
async function prepareStorageCutoffWorld(world, generationId) {
  const sessionsDir = path.join(world.root, 'new-sessions');
  const artifactsDir = path.join(world.root, 'new-artifacts');
  const transcriptPath = path.join(world.root, 'legacy-sessions', 'session-cutoff.jsonl');
  const privateTranscriptPath = path.join(world.root, 'legacy-sessions', 'session-private.jsonl');
  const analyticsDatabasePath = path.join(world.root, 'analytics', 'analytics.sqlite');
  mkdirSync(path.dirname(transcriptPath), { recursive: true });
  writeFileSync(transcriptPath, `${JSON.stringify({ type: 'session', id: 'session-cutoff' })}\n`);
  writeFileSync(privateTranscriptPath, `${JSON.stringify({ type: 'session', id: 'session-private' })}\n`);
  const analytics = new SqliteAnalyticsRecorder(analyticsDatabasePath);
  analytics.close();
  const registry = new SessionLifecycleStore(world.lifecycleStorePath);
  try {
    registry.registerArtifact({
      sessionId: 'session-cutoff', artifactId: 'transcript', kind: 'transcript',
      locationKind: 'fixed_absolute', location: transcriptPath,
      identityJson: filesystemArtifactIdentity(transcriptPath),
    }, Date.now());
    registry.registerArtifact({
      sessionId: 'session-private', artifactId: 'transcript', kind: 'transcript',
      locationKind: 'fixed_absolute', location: privateTranscriptPath,
      identityJson: filesystemArtifactIdentity(privateTranscriptPath),
    }, Date.now());
    registry.setPrivacyMode('session-private', 'on', Date.now());
  } finally {
    registry.close();
  }
  const capability = storageCutoffRootCapability(sessionsDir);
  const configPath = path.join(world.root, 'restart-config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, storageRootCapability: capability }, null, 2));
  await activateGeneration(new ActivationStore({ stateDir: world.stateDir }), {
    generationId,
    buildId: world.plan.buildId,
    qualificationSha256: world.qualificationSha256,
    trialSha256: world.trialSha256,
    activatedAt: new Date().toISOString(),
  });
  const storagePlan = {
    ...world.plan,
    cutoverMode: 'storage-cutoff',
    operationId: randomUUID(),
    expectedActiveGenerationId: generationId,
    cutoffInventory: ['session-cutoff', 'session-private'],
    cutoffInventoryValidated: true,
    cutoffRoots: { sessions: sessionsDir, artifacts: artifactsDir },
    analyticsDatabasePath,
    prerequisites: {
      ...world.plan.prerequisites,
      p7b: {
        lifecycleOwnerReady: true,
        legacyScrubBoundaryReady: true,
        rootSwitchReady: true,
        expiryInPlaceReady: true,
      },
    },
  };
  const expectedInventorySha256 = analyticsCutoverInventorySha256(['session-cutoff', 'session-private']);
  const expectedRequestSha256 = analyticsCutoverStorageRequestSha256({
    inventorySha256: expectedInventorySha256,
    cutoffRoots: { sessions: sessionsDir, artifacts: artifactsDir },
    analyticsDatabasePath,
  });
  return {
    storagePlan, sessionsDir, artifactsDir, transcriptPath, privateTranscriptPath,
    analyticsDatabasePath, expectedInventorySha256, expectedRequestSha256,
  };
}

/** Freeze the durable interrupted state exactly as the orchestrator leaves it
 * before its first private cleanup: a completed durable storage fence plus the
 * storage-fenced journal carrying the canonical inventory and the immutable
 * storage request. */
function freezeInterruptedStorageCutover(world, storagePlan) {
  const registry = new SessionLifecycleStore(world.lifecycleStorePath);
  try {
    const identity = {
      hostInstanceId: world.boots['1'].hostInstanceId,
      workspaceId: world.workspaceId,
      generationId: world.boots['1'].hostGenerationId,
      buildId: world.plan.buildId,
      processId: world.boots['1'].hostPid,
    };
    const begun = registry.beginAnalyticsWriterFence({
      workspaceId: world.workspaceId,
      operationId: storagePlan.operationId,
      purpose: 'storage-cutoff',
      expectedHosts: [identity],
      nowMs: Date.now(),
    });
    registry.acknowledgeAnalyticsWriterFence({
      workspaceId: world.workspaceId,
      operationId: storagePlan.operationId,
      fenceEpoch: begun.fenceEpoch,
      identity,
      activeWriterCount: 0,
      nowMs: Date.now(),
    });
    const completed = registry.completeAnalyticsWriterFence(world.workspaceId, storagePlan.operationId, Date.now());
    const inventorySha256 = analyticsCutoverInventorySha256(['session-cutoff', 'session-private']);
    const cutoffRoots = {
      sessions: storagePlan.cutoffRoots.sessions,
      artifacts: storagePlan.cutoffRoots.artifacts,
    };
    const journal = {
      schemaVersion: 1,
      operationId: storagePlan.operationId,
      workspaceId: world.workspaceId,
      mode: 'storage-cutoff',
      plan: 'analytics-rework-plan-17',
      authorizationCommitSha: commitSha,
      phase: 'storage-fenced',
      startedAt: new Date(Date.now() - 2_000).toISOString(),
      updatedAt: new Date(Date.now() - 1_000).toISOString(),
      storageFence: {
        schemaVersion: 1,
        workspaceId: world.workspaceId,
        operationId: storagePlan.operationId,
        purpose: 'storage-cutoff',
        fenceEpoch: completed.fenceEpoch,
        status: 'fenced',
        hostInstanceIds: [identity.hostInstanceId],
        acknowledgedHostInstanceIds: [identity.hostInstanceId],
      },
      inventory: {
        source: 'explicit-lifecycle-registry-v1',
        sessionIds: ['session-cutoff', 'session-private'],
        fenceOperationId: storagePlan.operationId,
        fenceEpoch: completed.fenceEpoch,
        inventorySha256,
      },
      storageRequest: {
        inventorySha256,
        cutoffRoots,
        analyticsDatabasePath: storagePlan.analyticsDatabasePath,
        requestSha256: analyticsCutoverStorageRequestSha256({
          inventorySha256,
          cutoffRoots,
          analyticsDatabasePath: storagePlan.analyticsDatabasePath,
        }),
      },
    };
    writeFileSync(path.join(world.stateDir, ANALYTICS_CUTOVER_JOURNAL_FILENAME), `${JSON.stringify(journal, null, 2)}\n`);
  } finally {
    registry.close();
  }
}

async function runWithStorageCutoffAuthorization(world, generationId, testBody) {
  const priorAuthorization = process.env.PIE_STORAGE_CUTOFF_AUTHORIZATION;
  process.env.PIE_STORAGE_CUTOFF_AUTHORIZATION = 'p7b-authorized-v1';
  try {
    const setup = await prepareStorageCutoffWorld(world, generationId);
    return await withCutoverWorld({ ...world, plan: setup.storagePlan }, (context) => testBody(context, setup));
  } finally {
    if (priorAuthorization === undefined) delete process.env.PIE_STORAGE_CUTOFF_AUTHORIZATION;
    else process.env.PIE_STORAGE_CUTOFF_AUTHORIZATION = priorAuthorization;
  }
}

test('PRODUCTION interrupted storage-fenced resume reuses the journaled inventory and immutable request', async () => {
  const generationId = randomUUID();
  const world = buildCutoverWorld({
    generationId,
    boots: {
      '1': makeBoot(1, { descriptorGeneration: generationId }),
      '2': makeBoot(2, { descriptorGeneration: generationId }),
    },
    keyChannel: 'file',
  });
  return runWithStorageCutoffAuthorization(world, generationId, async ({ seams, dependencies }, setup) => {
    freezeInterruptedStorageCutover(world, setup.storagePlan);
    const result = await runProductionCutover(setup.storagePlan, dependencies);
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.storage.closedSessionIds, ['session-cutoff', 'session-private']);
    assert.deepEqual(result.storage.deletedSessionIds, ['session-private']);
    assert.equal(result.storageVerification.admissionReopened, true);

    // Genuine resumability: the journaled canonical inventory and storage
    // request are adopted unchanged; the private cleanup ran exactly once,
    // against the plan's canonical database.
    const journal = readJournal(world);
    assert.equal(journal.phase, 'complete');
    assert.deepEqual(journal.inventory.sessionIds, ['session-cutoff', 'session-private']);
    assert.equal(journal.inventory.inventorySha256, setup.expectedInventorySha256);
    assert.equal(journal.storageRequest.requestSha256, setup.expectedRequestSha256);
    assert.equal(existsSync(setup.privateTranscriptPath), false);
    assert.equal(seams.registry.get('session-private').cleanupState, 'deleted');
    assert.equal(JSON.parse(readFileSync(path.join(world.root, 'boot-counter.json'), 'utf8')).boot, 2);
  });
});

test('PRODUCTION interrupted resume with a changed analytics database is refused before any cleanup', async () => {
  const generationId = randomUUID();
  const world = buildCutoverWorld({
    generationId,
    boots: {
      '1': makeBoot(1, { descriptorGeneration: generationId }),
      '2': makeBoot(2, { descriptorGeneration: generationId }),
    },
    keyChannel: 'file',
  });
  return runWithStorageCutoffAuthorization(world, generationId, async ({ seams, dependencies }, setup) => {
    freezeInterruptedStorageCutover(world, setup.storagePlan);
    const changedDatabasePath = path.join(world.root, 'analytics', 'decoy-analytics.sqlite');
    const decoy = new SqliteAnalyticsRecorder(changedDatabasePath);
    decoy.close();
    const canonicalBytes = readFileSync(setup.analyticsDatabasePath);
    const decoyBytes = readFileSync(changedDatabasePath);
    const changedPlan = {
      ...setup.storagePlan,
      analyticsDatabasePath: changedDatabasePath,
    };
    await assert.rejects(
      () => runProductionCutover(changedPlan, dependencies),
      /Analytics cutover storage request changed during recovery/,
    );

    // The canonical private fact and both databases are untouched; no storage
    // cutoff receipt exists, so the resumed run never reached private cleanup.
    assert.equal(existsSync(setup.privateTranscriptPath), true);
    assert.equal(seams.registry.get('session-private').cleanupState, 'open');
    assert.equal((seams.registry.get('session-cutoff')?.closedAtMs ?? null), null);
    assert.ok(readFileSync(setup.analyticsDatabasePath).equals(canonicalBytes));
    assert.ok(readFileSync(changedDatabasePath).equals(decoyBytes));
    assert.equal(existsSync(path.join(world.stateDir, 'storage-cutoff-receipt-v1.json')), false);
    assert.equal(readJournal(world).phase, 'storage-fenced');
  });
});

test('PRODUCTION interrupted resume with changed cutoff roots is refused before any cleanup', async () => {
  const generationId = randomUUID();
  const world = buildCutoverWorld({
    generationId,
    boots: {
      '1': makeBoot(1, { descriptorGeneration: generationId }),
      '2': makeBoot(2, { descriptorGeneration: generationId }),
    },
    keyChannel: 'file',
  });
  return runWithStorageCutoffAuthorization(world, generationId, async ({ seams, dependencies }, setup) => {
    freezeInterruptedStorageCutover(world, setup.storagePlan);
    const changedPlan = {
      ...setup.storagePlan,
      cutoffRoots: {
        sessions: path.join(world.root, 'other-sessions'),
        artifacts: path.join(world.root, 'other-artifacts'),
      },
    };
    await assert.rejects(
      () => runProductionCutover(changedPlan, dependencies),
      /Analytics cutover storage request changed during recovery/,
    );
    assert.equal(existsSync(setup.transcriptPath), true);
    assert.equal(existsSync(setup.privateTranscriptPath), true);
    assert.equal(existsSync(path.join(world.stateDir, 'storage-cutoff-receipt-v1.json')), false);
    assert.equal(readJournal(world).phase, 'storage-fenced');
  });
});

test('PRODUCTION interrupted resume with a changed explicit inventory is refused before any cleanup', async () => {
  const generationId = randomUUID();
  const world = buildCutoverWorld({
    generationId,
    boots: {
      '1': makeBoot(1, { descriptorGeneration: generationId }),
      '2': makeBoot(2, { descriptorGeneration: generationId }),
    },
    keyChannel: 'file',
  });
  return runWithStorageCutoffAuthorization(world, generationId, async ({ seams, dependencies }, setup) => {
    freezeInterruptedStorageCutover(world, setup.storagePlan);
    const changedPlan = {
      ...setup.storagePlan,
      cutoffInventory: ['session-cutoff'],
    };
    await assert.rejects(
      () => runProductionCutover(changedPlan, dependencies),
      /Analytics cutover storage request changed during recovery/,
    );
    // Dropping the private session from the resumed inventory must not scrub
    // it: the journaled canonical inventory remains the only authority.
    assert.equal(existsSync(setup.privateTranscriptPath), true);
    assert.equal(seams.registry.get('session-private').cleanupState, 'open');
    assert.equal(existsSync(path.join(world.stateDir, 'storage-cutoff-receipt-v1.json')), false);
    assert.equal(readJournal(world).phase, 'storage-fenced');
  });
});