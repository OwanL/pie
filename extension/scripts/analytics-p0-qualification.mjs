#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  buildCapacityCalibration,
  projectCapacityFromCalibration,
  validateTerminalWorkerEvidence,
  validateTerminalWorkerSummaries,
  validateCapacityCalibration,
  validateCapacitySnapshotInventory,
  validateMemoryTopologySamples,
  buildExpectedTopologySamplePlan,
  summarizeTimingSamples,
  planBoundedLoadBatches,
} from './analytics-p0-capacity.mjs';

const extensionRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const outRoot = path.resolve(extensionRoot, 'out');
const workerScript = path.join(outRoot, 'analytics-recorder-worker.js');
const queryWorkerScript = path.join(outRoot, 'analytics-query-worker.js');
const REPORT_SCHEMA_VERSION = 5;
const HARNESS_VERSION = 'p0-baseline-scale-v4-sampled-memory';
let AnalyticsRecorderSupervisor;
let AnalyticsCaptureCapacityError;
let SqliteAnalyticsRecorder;
let AnalyticsQueryClient;

function parseArguments(argv) {
  const options = { scenario: 'baseline', rows: undefined, seed: undefined, report: undefined, baselineReport: undefined, validate: false };
  const allowedScenarios = new Set(['baseline', 'scale']);
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--validate') {
      if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`);
      seen.add(argument);
      options.validate = true;
      continue;
    }
    if (argument === '--scenario' || argument === '--rows' || argument === '--seed' || argument === '--report' || argument === '--baseline-report') {
      if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`);
      seen.add(argument);
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      if (argument === '--scenario') options.scenario = value;
      if (argument === '--rows') options.rows = value;
      if (argument === '--seed') options.seed = value;
      if (argument === '--report') options.report = value;
      if (argument === '--baseline-report') options.baselineReport = value;
      continue;
    }
    throw new Error(`Unsupported or ambiguous option: ${argument}`);
  }
  if (!allowedScenarios.has(options.scenario)) throw new Error(`Unsupported P0 scenario: ${options.scenario}; only baseline and scale are implemented`);
  const environmentRows = process.env.PIE_ANALYTICS_P0_ROWS;
  const rowText = options.rows ?? environmentRows ?? (options.scenario === 'scale' ? '1000000' : '10000');
  if (!/^\d+$/.test(rowText)) throw new Error('--rows must be a decimal integer');
  const rows = Number(rowText);
  if (!Number.isSafeInteger(rows) || rows < 10_000) throw new Error('--rows must be a safe integer >= 10000');
  const expectedRows = options.scenario === 'scale' ? 1_000_000 : 10_000;
  if (rows !== expectedRows) throw new Error(`${options.scenario} requires exactly ${expectedRows} rows; larger tiers need a separately reviewed harness`);
  if (options.seed === undefined) throw new Error('--seed is required for reproducible qualification evidence');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.seed)) {
    throw new Error('--seed must be 1-128 characters using letters, digits, dot, underscore or hyphen, starting with a letter or digit');
  }
  if (!options.report || !path.isAbsolute(options.report)) throw new Error('--report must be an absolute JSON report path');
  if (!options.report.toLowerCase().endsWith('.json')) throw new Error('--report must name a .json file');
  if (existsSync(options.report)) throw new Error('--report must name a new file so prior evidence is never overwritten');
  if (options.baselineReport !== undefined) {
    if (!path.isAbsolute(options.baselineReport) || !options.baselineReport.toLowerCase().endsWith('.json')) {
      throw new Error('--baseline-report must be an absolute JSON report path');
    }
    options.baselineReport = path.resolve(options.baselineReport);
  }
  if (options.scenario === 'scale' && !options.baselineReport && !options.validate) {
    throw new Error('scale requires --baseline-report from a fresh accepted baseline run');
  }
  if (options.scenario === 'baseline' && options.baselineReport) {
    throw new Error('--baseline-report is valid only for the scale scenario');
  }
  if (process.env.PIE_ANALYTICS_P0_ENDURANCE === '1') throw new Error('PIE_ANALYTICS_P0_ENDURANCE is unsupported; use the separately reviewed endurance qualification');
  return {
    scenario: options.scenario,
    rows,
    seed: options.seed,
    report: path.resolve(options.report),
    baselineReport: options.baselineReport,
    validate: options.validate,
  };
}

const configuration = parseArguments(process.argv.slice(2));
const requestedRows = configuration.rows;
const scopedId = (value) => `${configuration.seed}-${value}`;
const requestedDetail = Math.floor(requestedRows / 10);
const detailCounts = {
  '2KiB': Math.floor(requestedDetail * 0.95),
  '32KiB': Math.floor(requestedDetail * 0.049),
  '2MiB': requestedDetail - Math.floor(requestedDetail * 0.95) - Math.floor(requestedDetail * 0.049),
};
const matrix = {
  scenario: configuration.scenario,
  fixtureSeed: configuration.seed,
  facts: { rows: requestedRows, producerHosts: [1, 2, 4], measuredHosts: 4, modelsProviders: 12 },
  detail: { total: requestedDetail, sizes: detailCounts, nestedDepth: 2 },
  load: [`${requestedRows} finite burst`, 'four concurrent producer helpers'],
  reads: ['single-session indexed count', 'all-history provider projection x10', 'small/2MiB detail reconstruction'],
  lifecycle: ['clean helper restart x3', 'private delete racing late detail from another helper'],
  bounds: { minUnusedDiskBytes: 20 * 1024 ** 3, maxTemporaryBytes: 16 * 1024 ** 3, maxQueueBytes: 64 * 1024 ** 2 },
  intentionallyNotClaimed: [
    ...(configuration.scenario !== 'scale' ? ['1M rows'] : []),
    '10M rows; this bounded harness rejects that input',
    'five-minute light load and repeated sustained-load processes',
    'mixed load, schema-v2/partial-write, and the broader fault matrix',
    'matched analytics-disabled/enabled agent and live VS Code UI baseline',
  ],
};

function summarize(values) {
  return summarizeTimingSamples(values);
}

function observation(i, host, sourceSequence = Math.floor(i / 4) + 1) {
  const sourceKey = `${configuration.seed}-host-${host}-fact-${i}`;
  const generationId = `${configuration.seed}-generation`;
  const rootSessionId = scopedId(`root-${Math.floor(i / 625)}`);
  const variant = i % 4;
  const entityKind = variant === 0 ? 'providerCall' : variant === 1 ? 'toolCall' : variant === 2 ? 'activitySpan' : 'featureObservation';
  const entityKey = variant === 0 ? scopedId(`invocation-${i}`) : variant === 1 ? scopedId(`tool-${i}`) : variant === 2 ? scopedId(`span-${i}`) : scopedId(`feature-${i}`);
  const observationKind = variant === 0 ? 'providerSettlement' : variant === 3 ? 'observation' : 'end';
  const fields = variant === 0 ? {
    invocationId: scopedId(`invocation-${i}`),
    provider: scopedId(`provider-${i % 3}`),
    model: scopedId(`model-${i % 12}`),
    inputTokens: i % 17 === 0 ? null : 100 + i,
    outputTokens: i % 19 === 0 ? null : 20,
    inputIncludesCache: false,
    outputIncludesReasoning: true,
    cacheChannelsOmittedAsZero: true,
    reportedCostUsd: i % 23 === 0 ? null : 0.001,
    outcome: i % 29 === 0 ? 'failed' : 'success',
  } : variant === 1 ? {
    toolCallId: entityKey,
    toolDefinitionId: i % 8 === 1 ? 'mcp' : 'bash',
    outcome: i % 29 === 0 ? 'failed' : 'completed',
    startedAtMs: 1_780_000_000_000 + i - 5,
    executionEndedAtMs: 1_780_000_000_000 + i,
  } : variant === 2 ? {
    spanId: entityKey,
    kind: i % 8 === 2 ? 'retryWait' : 'tool',
    startedAtMs: 1_780_000_000_000 + i - 5,
    endedAtMs: 1_780_000_000_000 + i,
    durationMs: 5,
    coverage: 'observed',
  } : {
    feature: i % 8 === 3 ? 'pruning' : 'contextTreatment',
    decision: i % 29 === 0 ? 'failed' : 'applied',
    ruleVersion: `config-${i % 5}`,
    measuredSizeEffect: i % 11,
  };
  return {
    schemaVersion: 1,
    generationId,
    producerKind: variant === 0 ? 'provider' : variant === 1 ? 'tool' : variant === 2 ? 'span' : 'capability',
    stableOriginId: scopedId(`origin-${host}`),
    sourceKey,
    sourceSequence: String(sourceSequence),
    entityKind,
    entityKey,
    observationKind,
    observedAtMs: 1_780_000_000_000 + i,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: scopedId(`workspace-${i % 4}`),
      rootSessionId,
      ...(variant === 0 ? { invocationId: entityKey } : variant === 1 ? { toolCallId: entityKey } : {}),
    },
    captureSubject: { kind: 'session', rootSessionId },
    producer: { buildId: scopedId('qualification-build'), processGeneration: scopedId(`host-${host}`) },
    fields,
    idempotencyKey: JSON.stringify([generationId, observationKind, sourceKey]),
  };
}

function detailCapture(payloadId, rootSessionId, byteLength, valueOverride) {
  const namespacedPayloadId = scopedId(payloadId);
  const namespacedRootSessionId = scopedId(rootSessionId);
  const prefix = `${namespacedPayloadId}:`;
  const body = valueOverride ?? `${prefix}${'d'.repeat(Math.max(0, byteLength - prefix.length))}`;
  const value = typeof body === 'string'
    ? { messages: [{ role: 'assistant', content: [{ type: 'text', text: body }] }] }
    : body;
  return {
    schemaVersion: 1,
    generationId: `${configuration.seed}-generation`,
    stableOriginId: scopedId(`detail:${rootSessionId}`),
    payloadId: namespacedPayloadId,
    sourceKey: namespacedPayloadId,
    observedAtMs: 1_780_100_000_000,
    captureSubject: { kind: 'session', rootSessionId: namespacedRootSessionId },
    mediaType: 'application/x-pie-subagent-result',
    encoding: 'node-v8',
    complete: true,
    bytes: serialize(value),
    metadata: { childId: namespacedPayloadId },
  };
}

function supervisor(databasePath, extra = {}) {
  const callerLifecycle = extra.onWorkerLifecycle;
  const helper = new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript,
    databasePath,
    maxBatchSize: 250,
    maxQueueRecords: 20_000,
    maxQueueBytes: matrix.bounds.maxQueueBytes,
    ...extra,
    onWorkerLifecycle: (event) => {
      recorderWorkerLifecycle.push(structuredClone(event));
      callerLifecycle?.(event);
    },
  });
  activeHelpers.add(helper);
  return helper;
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for qualification condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function summarizeLight(values) {
  const summary = summarize(values);
  return { samples: summary.samples, p50Ms: summary.p50Ms, p95Ms: summary.p95Ms, maxMs: summary.maxMs };
}

async function runRateCondition(parentRoot, label, ratePerSecond, sampleCount, hostCount) {
  const rateDatabasePath = path.join(parentRoot, `${configuration.seed}-${label}.sqlite`);
  const commitLatency = [];
  const hosts = Array.from({ length: hostCount }, () => supervisor(rateDatabasePath, {
    maxBatchSize: 100,
    onDeliveryAcknowledged: (measurement) => commitLatency.push(...measurement.latencyMs),
  }));
  await Promise.all(hosts.map((host) => host.start()));
  const workerBefore = await Promise.all(hosts.map((host) => host.workerStats()));
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  const handoff = [];
  let peakBacklogBytes = 0;
  for (let index = 0; index < sampleCount; index++) {
    const targetAt = startedAt + (index * 1_000 / ratePerSecond);
    const delay = targetAt - performance.now();
    if (delay > 1) await new Promise((resolve) => setTimeout(resolve, delay));
    const host = index % hostCount;
    const started = performance.now();
    hosts[host].submit(observation(1_000_000_000 + index, host, Math.floor(index / hostCount) + 1));
    handoff.push(performance.now() - started);
    peakBacklogBytes = Math.max(peakBacklogBytes, ...hosts.map((entry) => entry.backlog.queuedBytes + entry.backlog.inFlightBytes));
    if (index % 1_000 === 999) checkResourceEnvelope(`${label}-after-${index + 1}`);
  }
  const submissionElapsedMs = performance.now() - startedAt;
  const drainStarted = performance.now();
  await Promise.all(hosts.map((host) => host.flush()));
  const drainMs = performance.now() - drainStarted;
  const elapsedMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuBefore);
  const workerAfter = await Promise.all(hosts.map((host) => host.workerStats()));
  const workerCpuMicros = workerAfter.reduce((total, entry, index) => {
    const before = workerBefore[index].process.cpuUsage;
    return total + entry.process.cpuUsage.user + entry.process.cpuUsage.system - before.user - before.system;
  }, 0);
  await shutdownHelpers(hosts);
  return {
    label,
    ratePerSecond,
    sampleCount,
    hostCount,
    submissionElapsedMs,
    offeredRatePerSecond: sampleCount / (submissionElapsedMs / 1_000),
    drainMs,
    elapsedMs,
    deliveredRateIncludingDrainPerSecond: sampleCount / (elapsedMs / 1_000),
    handoff: ratePerSecond === 1 ? summarizeLight(handoff) : summarize(handoff),
    observationToCommitted: ratePerSecond === 1 ? summarizeLight(commitLatency) : summarize(commitLatency),
    peakBacklogBytes,
    producerCpuOneCorePercent: ((cpu.user + cpu.system) / (elapsedMs * 1_000)) * 100,
    workerCpuOneCorePercent: (workerCpuMicros / (elapsedMs * 1_000)) * 100,
  };
}

function proofTreeBytes(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += proofTreeBytes(entryPath);
    else if (entry.isFile()) {
      try { total += statSync(entryPath).size; } catch { /* a concurrently removed sidecar is zero */ }
    }
  }
  return total;
}

function proofTreeInventory(directory, relativeDirectory = '') {
  const files = [];
  for (const entry of readdirSync(path.join(directory, relativeDirectory), { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const entryPath = path.join(directory, relativePath);
    if (entry.isDirectory()) files.push(...proofTreeInventory(directory, relativePath));
    else if (entry.isFile()) {
      files.push({ path: relativePath.replaceAll('\\', '/'), bytes: statSync(entryPath).size });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function captureCapacitySnapshot(name, label) {
  const files = proofTreeInventory(root);
  const mainName = path.basename(databasePath).replaceAll('\\', '/');
  const mainFiles = files.filter((entry) => entry.path === mainName || entry.path === `${mainName}-wal` || entry.path === `${mainName}-shm`);
  const snapshot = {
    label,
    treeBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    mainDatabaseBytes: mainFiles.reduce((sum, entry) => sum + entry.bytes, 0),
    mainFileBytes: mainFiles.find((entry) => entry.path === mainName)?.bytes ?? 0,
    files,
  };
  capacityComponentSnapshots[name] = snapshot;
  return snapshot;
}

function nearestExistingDirectory(target) {
  let candidate = path.resolve(target);
  while (!existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return process.cwd();
    candidate = parent;
  }
  return candidate;
}

function fixtureCapacityEstimate() {
  const factSamples = [0, 1, 17, 101].map((index) => serialize(observation(index, index % 4)).byteLength);
  const detailSamples = [2 * 1024, 32 * 1024, 2 * 1024 ** 2]
    .map((size) => detailCapture(`capacity-detail-${size}`, 'capacity-root', size).bytes.byteLength);
  const averageFactBytes = factSamples.reduce((sum, bytes) => sum + bytes, 0) / factSamples.length;
  const weightedDetailBytes = detailSamples[0] * detailCounts['2KiB']
    + detailSamples[1] * detailCounts['32KiB']
    + detailSamples[2] * detailCounts['2MiB'];
  const generatedFactRows = requestedRows + 25_253;
  const generatedDetailRows = matrix.detail.total + 3 + 1 + 1 + 2;
  const fixtureBytes = Math.ceil(generatedFactRows * averageFactBytes + weightedDetailBytes
    + generatedDetailRows * detailSamples[0]);
  return {
    generatedFactRows,
    generatedDetailRows,
    sampleFactBytes: factSamples,
    sampleDetailBytes: detailSamples,
    fixtureBytes,
  };
}

function artifactProvenance() {
  const ownedFiles = [
    ['extension/out/analytics-recorder-supervisor.js', path.join(outRoot, 'analytics-recorder-supervisor.js')],
    ['extension/out/analytics-sqlite-recorder.js', path.join(outRoot, 'analytics-sqlite-recorder.js')],
    ['extension/out/analytics-query-client.js', path.join(outRoot, 'analytics-query-client.js')],
    ['extension/out/analytics-recorder-worker.js', workerScript],
    ['extension/out/analytics-query-worker.js', queryWorkerScript],
    ['extension/scripts/analytics-p0-qualification.mjs', path.join(extensionRoot, 'scripts', 'analytics-p0-qualification.mjs')],
    ['extension/scripts/analytics-p0-capacity.mjs', path.join(extensionRoot, 'scripts', 'analytics-p0-capacity.mjs')],
    ['extension/scripts/analytics-real-producer-probe.ts', path.join(extensionRoot, 'scripts', 'analytics-real-producer-probe.ts')],
    ['extensions/subagent/src/analytics-capture.ts', path.join(repositoryRoot, 'extensions', 'subagent', 'src', 'analytics-capture.ts')],
    ['extensions/subagent/src/runtime-trace.ts', path.join(repositoryRoot, 'extensions', 'subagent', 'src', 'runtime-trace.ts')],
    ['extensions/subagent/types.ts', path.join(repositoryRoot, 'extensions', 'subagent', 'types.ts')],
    ['shared/analytics/contracts.ts', path.join(repositoryRoot, 'shared', 'analytics', 'contracts.ts')],
    ['shared/sensitive-redaction.ts', path.join(repositoryRoot, 'shared', 'sensitive-redaction.ts')],
  ];
  const files = Object.fromEntries(ownedFiles.map(([relativePath, filePath]) => {
    try {
      return [relativePath, {
        sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
        bytes: statSync(filePath).size,
      }];
    } catch (error) {
      return [relativePath, { error: error instanceof Error ? error.message : String(error) }];
    }
  }));
  let gitHead = null;
  try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: extensionRoot, encoding: 'utf8' }).trim(); } catch { /* source may be exported without Git */ }
  let hostBuildId = null;
  let rendererBuildId = null;
  try { hostBuildId = readFileSync(path.join(outRoot, 'pie-build-id.txt'), 'utf8').trim(); } catch { /* reported below */ }
  try { rendererBuildId = readFileSync(path.join(outRoot, 'webview', 'panel', 'pie-build-id.txt'), 'utf8').trim(); } catch { /* reported below */ }
  const fileErrors = Object.entries(files)
    .filter(([, value]) => value.error)
    .map(([name, value]) => `${name}: ${value.error}`);
  const errors = [
    ...fileErrors,
    ...(!hostBuildId ? ['host build identity is missing'] : []),
    ...(!rendererBuildId ? ['renderer build identity is missing'] : []),
    ...(hostBuildId && rendererBuildId && hostBuildId !== rendererBuildId
      ? [`host/renderer build identity mismatch (${hostBuildId} != ${rendererBuildId})`]
      : []),
  ];
  const fingerprintInput = {
    harnessVersion: HARNESS_VERSION,
    hostBuildId,
    rendererBuildId,
    files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, value.sha256 ?? null])),
  };
  return {
    gitHead,
    hostBuildId,
    rendererBuildId,
    coordinatedBuildId: hostBuildId && hostBuildId === rendererBuildId ? hostBuildId : null,
    fingerprint: createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex'),
    valid: errors.length === 0,
    errors,
    files,
  };
}

function readBaselineEvidence(currentProvenance) {
  if (!configuration.baselineReport) return null;
  if (path.resolve(configuration.baselineReport) === path.resolve(configuration.report)) {
    return { accepted: false, reason: 'Baseline and output report paths must be distinct.' };
  }
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(configuration.baselineReport, 'utf8'));
  } catch (error) {
    return { accepted: false, reason: `Unable to read baseline report: ${error instanceof Error ? error.message : String(error)}` };
  }
  const fixtureBytes = baseline.results?.capacityProjection?.fixtureBytes;
  const finalEnvelope = baseline.results?.resourceEnvelope?.samples?.at(-1);
  const physicalBytes = finalEnvelope?.physicalBytes;
  const memory = baseline.results?.memory;
  let topologyPeakBytes;
  const capacityCalibration = baseline.results?.capacityCalibration;
  const calibrationValidation = validateCapacityCalibration(capacityCalibration, {
    baselineRows: 10_000,
    detailRows: 1_000,
  });
  const rawCapacitySnapshots = baseline.results?.capacityComponentSnapshots;
  const resourceSamples = baseline.results?.resourceEnvelope?.samples;
  const prewriteChecks = baseline.results?.resourceEnvelope?.prewriteChecks;
  const destructiveFault = baseline.results?.destructiveFault;
  const calibrationReportConsistencyErrors = [];
  if (baseline.configuration?.rows !== 10_000) {
    calibrationReportConsistencyErrors.push('memory topology baseline row count must be exactly 10000');
  } else {
    try {
      const expectedTopologyPlan = buildExpectedTopologySamplePlan({
        rows: 10_000,
        maxQueueBytes: 64 * 1024 ** 2,
      });
      const topologyValidation = validateMemoryTopologySamples(memory?.topologySamples, {
        expectedPlan: expectedTopologyPlan,
        recorderWorkers: destructiveFault?.recorderWorkers,
      });
      if (!topologyValidation.valid) {
        calibrationReportConsistencyErrors.push(`memory topology evidence is invalid: ${topologyValidation.errors.join('; ')}`);
      } else {
        topologyPeakBytes = topologyValidation.maxTotalTopologyRssBytes;
        if (memory?.maxWorkerRssBytes !== topologyValidation.maxWorkerRssBytes) {
          calibrationReportConsistencyErrors.push('memory topology evidence does not match the reported worker RSS maximum');
        }
        if (memory?.totalTopologyRssBytes !== topologyValidation.maxTotalTopologyRssBytes) {
          calibrationReportConsistencyErrors.push('memory topology evidence does not match the reported topology RSS maximum');
        }
      }
    } catch (error) {
      calibrationReportConsistencyErrors.push(`memory topology sample plan is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const capacitySnapshotLabels = {
    beforePrimaryFacts: 'before-primary-facts',
    afterPrimaryFacts: 'after-primary-facts',
    afterVariableDetails: 'after-variable-details',
    finalBeforeFault: 'final-before-fault',
  };
  for (const [name, sampleLabel] of Object.entries(capacitySnapshotLabels)) {
    const raw = rawCapacitySnapshots?.[name];
    const calibrated = capacityCalibration?.snapshots?.[name];
    const inventoryValidation = validateCapacitySnapshotInventory(raw, {
      mainDatabaseFile: 'analytics.sqlite',
      expectedLabel: sampleLabel,
    });
    if (!inventoryValidation.valid) {
      calibrationReportConsistencyErrors.push(`capacity snapshot ${name} inventory is invalid: ${inventoryValidation.errors.join('; ')}`);
    }
    if (!raw || !calibrated
      || raw.treeBytes !== calibrated.treeBytes
      || raw.mainDatabaseBytes !== calibrated.mainDatabaseBytes
      || raw.mainFileBytes !== calibrated.mainFileBytes) {
      calibrationReportConsistencyErrors.push(`capacity snapshot ${name} does not match its calibrated values`);
    }
    const matchingSample = Array.isArray(resourceSamples)
      ? resourceSamples.find((sample) => sample.label === sampleLabel)
      : undefined;
    if (!matchingSample || matchingSample.physicalBytes !== raw?.treeBytes) {
      calibrationReportConsistencyErrors.push(`capacity snapshot ${name} does not match its resource sample`);
    }
  }
  const sampledHighWaterBytes = Array.isArray(resourceSamples) && resourceSamples.length > 0
    ? Math.max(...resourceSamples.map((sample) => sample.physicalBytes))
    : undefined;
  if (sampledHighWaterBytes !== capacityCalibration?.observedHighWaterBytes) {
    calibrationReportConsistencyErrors.push('capacity calibration does not match the sampled proof-tree high-water');
  }
  const reportedPrewrites = Array.isArray(prewriteChecks)
    ? prewriteChecks.map((entry) => entry.projectedTreeBytes)
    : [];
  if (reportedPrewrites.length === 0
    || JSON.stringify(reportedPrewrites) !== JSON.stringify(capacityCalibration?.prewriteProjectedTreeBytes)) {
    calibrationReportConsistencyErrors.push('capacity calibration does not match every prewrite projection');
  }
  try {
    requireTerminalWorkerSummaries(destructiveFault?.recorderWorkers ?? [], 'baseline recorder');
    requireTerminalWorkerSummaries(destructiveFault?.queryWorkers ?? [], 'baseline query');
    requireTerminalWorkerSummaries(destructiveFault?.corruptionQueryWorkers ?? [], 'baseline corruption query', { requireReady: false });
  } catch (error) {
    calibrationReportConsistencyErrors.push(`destructive fault lifecycle evidence is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (destructiveFault?.phase !== 'completed'
    || destructiveFault?.containmentVerified !== true
    || destructiveFault?.checkpointedOutsideProofRoot !== true
    || destructiveFault?.corruptionWorkerTerminal !== true
    || destructiveFault?.walBytes !== 0
    || destructiveFault?.shmBytes !== 0
    || JSON.stringify(destructiveFault?.preFaultInventory) !== JSON.stringify(rawCapacitySnapshots?.finalBeforeFault?.files)) {
    calibrationReportConsistencyErrors.push('destructive in-place fault evidence is incomplete or inconsistent');
  }
  if (typeof destructiveFault?.proofRootRealPath !== 'string'
    || typeof destructiveFault?.databaseRealPath !== 'string'
    || typeof destructiveFault?.reportRealPath !== 'string'
    || path.dirname(destructiveFault.databaseRealPath) !== destructiveFault.proofRootRealPath
    || !path.relative(destructiveFault.proofRootRealPath, destructiveFault.reportRealPath).startsWith('..')) {
    calibrationReportConsistencyErrors.push('destructive fault path containment evidence is invalid');
  }
  const exactCounts = baseline.results?.tableRows?.primaryFacts === 10_000
    && baseline.results?.tableRows?.detailPayloads === 1_003
    && baseline.gates?.exactPrimaryRows?.decision === 'passed'
    && baseline.gates?.exactDetailRows?.decision === 'passed';
  const matchingFixture = baseline.matrix?.detail?.total === 1_000
    && baseline.matrix?.detail?.sizes?.['2KiB'] === 950
    && baseline.matrix?.detail?.sizes?.['32KiB'] === 49
    && baseline.matrix?.detail?.sizes?.['2MiB'] === 1
    && baseline.matrix?.bounds?.maxQueueBytes === 64 * 1024 ** 2;
  const accepted = baseline.schemaVersion === REPORT_SCHEMA_VERSION
    && baseline.harnessVersion === HARNESS_VERSION
    && baseline.configuration?.scenario === 'baseline'
    && baseline.configuration?.rows === 10_000
    && baseline.measurement?.completed === true
    && baseline.cleanup?.completed === true
    && baseline.cleanup?.rootRemoved === true
    && baseline.qualification?.overallP0 === 'unqualified'
    && baseline.provenance?.valid === true
    && baseline.provenance?.fingerprint === currentProvenance.fingerprint
    && exactCounts
    && matchingFixture
    && baseline.gates?.inPlaceCorruption?.decision === 'passed'
    && baseline.results?.capacityProjection?.units === 'bytes'
    && finalEnvelope?.label === 'final'
    && Number.isFinite(fixtureBytes) && fixtureBytes > 0
    && Number.isFinite(physicalBytes) && physicalBytes > 0
    && Number.isFinite(topologyPeakBytes) && topologyPeakBytes > 0
    && calibrationValidation.valid
    && calibrationReportConsistencyErrors.length === 0;
  return {
    accepted,
    reason: accepted ? undefined : 'Baseline must be a completed, cleaned 10,000-row measurement from this exact harness/build/probe fingerprint with exact counts, byte units, peak-memory evidence and internally consistent component calibration.',
    fixtureBytes,
    physicalBytes,
    topologyPeakBytes,
    capacityCalibration,
    calibrationValidation,
    calibrationReportConsistencyErrors,
    scenarioStatus: baseline.status,
    scenarioDecision: baseline.qualification?.decision,
    failedGates: baseline.qualification?.failedGates ?? [],
    reportPath: configuration.baselineReport,
  };
}

const activeHelpers = new Set();
const activeReaders = new Set();
const recorderWorkerLifecycle = [];
let lagTimer;

async function shutdownHelper(helper) {
  await helper.shutdown();
  activeHelpers.delete(helper);
}

async function shutdownHelpers(helpers) {
  const results = await Promise.allSettled(helpers.map((helper) => shutdownHelper(helper)));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function openReader(databasePath) {
  const reader = new SqliteAnalyticsRecorder(databasePath);
  activeReaders.add(reader);
  return reader;
}

function closeReader(reader) {
  reader.close();
  activeReaders.delete(reader);
}

function requireTerminalWorkerEvidence(events, label, { requireReady = true } = {}) {
  const validation = validateTerminalWorkerEvidence(events, { requireReady });
  assert.equal(validation.valid, true, `${label} worker lifecycle is invalid: ${validation.errors.join('; ')}`);
  return validation.workers;
}

function requireTerminalWorkerSummaries(workers, label, { requireReady = true } = {}) {
  const validation = validateTerminalWorkerSummaries(workers, { requireReady });
  assert.equal(validation.valid, true, `${label} worker lifecycle is invalid: ${validation.errors.join('; ')}`);
  return validation.workers;
}
let root = null;
let databasePath;
let envelopePath;
let initialFreeBytes;
let capacityFixture;
let provenance;
let baselineEvidence;
let baselineRowScale;
let projectedPeakBytes;
let calibratedCapacityProjection;
let initialAvailableMemoryBytes;
let projectedPeakMemoryBytes;
let effectiveMemoryLimitBytes;
const capacityComponentSnapshots = {};
const prewriteCapacityChecks = [];
const report = {
  schemaVersion: REPORT_SCHEMA_VERSION,
  harnessVersion: HARNESS_VERSION,
  status: 'running',
  generatedAt: new Date().toISOString(),
  configuration: {
    scenario: configuration.scenario,
    rows: requestedRows,
    seed: configuration.seed,
    reportPath: configuration.report,
    resolvedRowsFrom: process.env.PIE_ANALYTICS_P0_ROWS !== undefined && process.argv.includes('--rows') === false ? 'environment' : 'arguments/default',
  },
  matrix,
  provenance: { valid: false, errors: ['initialization did not complete'] },
  environment: {},
  results: {},
  gates: {},
  measurement: { completed: false },
  cleanup: { completed: false },
};

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Windows can transiently deny renaming over a report file that an external
 * reader (for example an operator inspecting progress) currently has open.
 * A long qualification run must not be failed by that transient condition, so
 * retry the atomic publish for a bounded time and only then surface the error.
 * The temporary file is always removed so a failed publish leaves no debris. */
function publishReportAtomically(temporary, destination) {
  const deadline = Date.now() + 30_000;
  let delay = 25;
  for (;;) {
    try {
      renameSync(temporary, destination);
      return;
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || Date.now() >= deadline) {
        try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
        throw error;
      }
      sleepSync(delay);
      delay = Math.min(delay * 2, 500);
    }
  }
}

function writeReportAtomically() {
  mkdirSync(path.dirname(configuration.report), { recursive: true });
  const temporary = `${configuration.report}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  publishReportAtomically(temporary, configuration.report);
}

function checkpoint(phase, details = {}) {
  report.progress = { phase, ...details, updatedAt: new Date().toISOString() };
  writeReportAtomically();
}

function recordGate(name, actual, threshold, predicate, evidence = {}) {
  const measured = typeof actual === 'number' ? Number.isFinite(actual) : actual !== undefined && actual !== null;
  const passed = measured && predicate(actual);
  report.gates[name] = { actual: actual ?? null, threshold, decision: passed ? 'passed' : 'failed', evidence };
  return passed;
}

function recordUnqualified(name, reason) {
  report.gates[name] = { actual: null, threshold: null, decision: 'unqualified', reason };
}

try {
  root = configuration.validate ? null : mkdtempSync(path.join(tmpdir(), 'pie-analytics-p0-qualification-'));
  databasePath = root ? path.join(root, 'analytics.sqlite') : undefined;
  envelopePath = nearestExistingDirectory(configuration.validate ? configuration.report : root);
  const fsStats = statfsSync(envelopePath, { bigint: true });
  initialFreeBytes = Number(fsStats.bavail * fsStats.bsize);
  matrix.bounds.minUnusedDiskBytes = Math.max(20 * 1024 ** 3, initialFreeBytes * 0.20);
  matrix.bounds.maxTemporaryBytes = Math.min(16 * 1024 ** 3, initialFreeBytes * 0.25);
  matrix.bounds.effectiveTemporaryLimitBytes = Math.max(0, Math.min(
    matrix.bounds.maxTemporaryBytes,
    initialFreeBytes - matrix.bounds.minUnusedDiskBytes,
  ));
  Object.freeze(matrix.bounds);
  Object.freeze(matrix);
  capacityFixture = fixtureCapacityEstimate();
  provenance = artifactProvenance();
  baselineEvidence = readBaselineEvidence(provenance);
  baselineRowScale = baselineEvidence?.accepted
    ? requestedRows / 10_000
    : undefined;
  calibratedCapacityProjection = configuration.scenario === 'scale' && baselineRowScale !== undefined
    ? projectCapacityFromCalibration(baselineEvidence.capacityCalibration, {
      targetRows: requestedRows,
      safetyFactor: 1.25,
    })
    : undefined;
  projectedPeakBytes = calibratedCapacityProjection?.projectedPeakBytes
    ?? Math.ceil(capacityFixture.fixtureBytes * 2);
  initialAvailableMemoryBytes = os.freemem();
  projectedPeakMemoryBytes = configuration.scenario === 'scale' && baselineEvidence?.accepted
    ? Math.ceil(Math.max(baselineEvidence.topologyPeakBytes * 1.25, process.memoryUsage().rss + 512 * 1024 ** 2))
    : Math.ceil(process.memoryUsage().rss + (4 * 256 + 512) * 1024 ** 2);
  effectiveMemoryLimitBytes = Math.floor(initialAvailableMemoryBytes * 0.75);
  report.provenance = provenance;
  report.environment = {
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    initialAvailableMemoryBytes,
    effectiveMemoryLimitBytes,
    initialFreeBytes,
    sqlite: 'node:sqlite bundled with Node',
  };
  report.results.capacityProjection = {
    fixtureBytes: capacityFixture.fixtureBytes,
    generatedFactRows: capacityFixture.generatedFactRows,
    generatedDetailRows: capacityFixture.generatedDetailRows,
    sampleFactBytes: capacityFixture.sampleFactBytes,
    sampleDetailBytes: capacityFixture.sampleDetailBytes,
    projectedPeakBytes,
    units: 'bytes',
    projectionMethod: calibratedCapacityProjection
      ? 'versioned baseline component calibration: fact and variable-detail database-family increments scaled by row ratio and 1.25, fixed tree once, with the contained main database family as a separate maximum'
      : 'serialized fixture bytes multiplied by 2',
    overheadFactor: calibratedCapacityProjection ? 1.25 : 2,
    baselineReport: baselineEvidence,
    calibratedProjection: calibratedCapacityProjection,
    projectedPeakMemoryBytes,
    decision: projectedPeakBytes <= matrix.bounds.effectiveTemporaryLimitBytes
      && projectedPeakMemoryBytes <= effectiveMemoryLimitBytes
      && provenance.valid
      && (configuration.scenario !== 'scale' || baselineEvidence?.accepted)
      ? 'within-envelope'
      : 'blocked-capacity',
  };
  writeReportAtomically();
} catch (error) {
  report.status = 'failed';
  report.failure = {
    name: error instanceof Error ? error.name : 'QualificationInitializationError',
    message: error instanceof Error ? error.message : String(error),
  };
  let cleanupError;
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (cleanupFailure) {
      cleanupError = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
    }
  }
  report.cleanup = {
    completed: cleanupError === undefined,
    rootCreated: root !== null,
    rootRemoved: root === null || cleanupError === undefined,
    ...(cleanupError ? { error: cleanupError } : {}),
  };
  report.qualification = {
    scenario: configuration.scenario,
    decision: 'scenario-failed',
    failedGates: ['initialization'],
    overallP0: 'unqualified',
    reason: 'Qualification initialization did not complete.',
  };
  report.finishedAt = new Date().toISOString();
  try {
    writeReportAtomically();
  } catch (reportError) {
    console.error(`Qualification initialization report write failed: ${reportError instanceof Error ? reportError.message : String(reportError)}`);
  }
  throw error;
}

function ensureGateEvidence() {
  const tableRows = report.results.tableRows;
  const peakPhysicalBytes = report.results.resourceEnvelope?.samples?.length > 0
    ? Math.max(...report.results.resourceEnvelope.samples.map((sample) => sample.physicalBytes))
    : undefined;
  const minimumFreeBytes = report.results.resourceEnvelope?.samples?.length > 0
    ? Math.min(...report.results.resourceEnvelope.samples.map((sample) => sample.freeBytes))
    : undefined;
  const required = [
    ['exactPrimaryRows', tableRows?.primaryFacts, requestedRows, (value) => value === requestedRows],
    ['exactDetailRows', tableRows?.detailPayloads, matrix.detail.total + 3, (value) => value === matrix.detail.total + 3],
    ['handoffP99', report.results.factHandoff?.p99Ms, '<= 9 ms', (value) => value <= 9],
    ['responsivenessProxyP95', report.results.responsivenessProxy?.lag?.p95Ms, '<= 25 ms declared proxy gate', (value) => value <= 25],
    ['indexedQuery', report.results.queries?.indexedSessionMs, '<= 250 ms', (value) => value <= 250],
    ['largeDetailQuery', report.results.queries?.twoMiBDetailMs, '<= 9000 ms', (value) => value <= 9000],
    ['temporaryFootprint', peakPhysicalBytes, `<= ${matrix.bounds.effectiveTemporaryLimitBytes} bytes`, (value) => value <= matrix.bounds.effectiveTemporaryLimitBytes],
    ['reservedFreeDisk', minimumFreeBytes, `>= ${matrix.bounds.minUnusedDiskBytes} bytes`, (value) => value >= matrix.bounds.minUnusedDiskBytes],
    ['recorderWorkerRss', report.results.memory?.maxWorkerRssBytes, '<= 268435456 bytes per recorder/helper during ordinary ingestion', (value) => value <= 256 * 1024 ** 2],
  ];
  for (const [name, actual, threshold, predicate] of required) {
    if (!report.gates[name]) recordGate(name, actual, threshold, predicate);
  }
  if (!report.gates.inPlaceCorruption) {
    recordGate(
      'inPlaceCorruption',
      report.results.destructiveFault?.phase,
      'completed with a terminal fresh read-only helper',
      (value) => value === 'completed' && report.results.destructiveFault?.corruptionWorkerTerminal === true,
    );
  }
  if (!report.gates.scaleHistoryRows) {
    configuration.scenario === 'scale'
      ? recordGate('scaleHistoryRows', tableRows?.primaryFacts, '>= 1000000 exact rows', (value) => value >= 1_000_000)
      : recordUnqualified('scaleHistoryRows', 'Scale scenario was not selected.');
  }
  for (const [name, reason] of [
    ['tenMillionHistory', 'Not executed; capacity tier remains unqualified.'],
    ['enduranceLightLoad', 'Not executed by this bounded baseline/scale harness.'],
    ['mixedLoad', 'Not executed by this bounded baseline/scale harness.'],
    ['schemaV2AndFaults', 'Not executed by this bounded baseline/scale harness.'],
    ['matchedAgentUi', 'The standalone proxy is not a UI or agent baseline.'],
    ['incrementalHostMemory', 'No matched analytics-disabled host baseline was executed.'],
    ['queryPeakMemory', 'The bounded query helper reports process behavior, but this unit does not isolate an additional-RSS baseline.'],
  ]) {
    if (!report.gates[name]) recordUnqualified(name, reason);
  }
}

function checkResourceEnvelope(label) {
  const physicalBytes = proofTreeBytes(root);
  const stats = statfsSync(root, { bigint: true });
  const freeBytes = Number(stats.bavail * stats.bsize);
  report.results.resourceEnvelope ??= { samples: [] };
  report.results.resourceEnvelope.samples.push({ label, physicalBytes, freeBytes });
  if (physicalBytes > matrix.bounds.effectiveTemporaryLimitBytes) throw new Error(`${label}: temporary proof tree exceeded ${matrix.bounds.effectiveTemporaryLimitBytes} bytes`);
  if (freeBytes < matrix.bounds.minUnusedDiskBytes) throw new Error(`${label}: free disk fell below reserved ${matrix.bounds.minUnusedDiskBytes} bytes`);
  checkpoint(label, { temporaryBytes: physicalBytes, freeBytes });
}

function ensureAdditionalCapacity(label, additionalBytes) {
  assert.ok(Number.isFinite(additionalBytes) && additionalBytes >= 0, `${label}: invalid planned byte count`);
  const physicalBytes = proofTreeBytes(root);
  const stats = statfsSync(root, { bigint: true });
  const freeBytes = Number(stats.bavail * stats.bsize);
  const projectedTreeBytes = physicalBytes + additionalBytes;
  const projectedFreeBytes = freeBytes - additionalBytes;
  report.results.resourceEnvelope ??= { samples: [] };
  report.results.resourceEnvelope.lastPrewrite = {
    label,
    physicalBytes,
    additionalBytes,
    projectedTreeBytes,
    freeBytes,
    projectedFreeBytes,
  };
  prewriteCapacityChecks.push({
    label,
    physicalBytes,
    additionalBytes,
    projectedTreeBytes,
    freeBytes,
    projectedFreeBytes,
  });
  report.results.resourceEnvelope.prewriteChecks = prewriteCapacityChecks;
  if (projectedTreeBytes > matrix.bounds.effectiveTemporaryLimitBytes) {
    throw new Error(`${label}: planned write would exceed temporary proof-tree limit ${matrix.bounds.effectiveTemporaryLimitBytes} bytes`);
  }
  if (projectedFreeBytes < matrix.bounds.minUnusedDiskBytes) {
    throw new Error(`${label}: planned write would cross reserved free disk ${matrix.bounds.minUnusedDiskBytes} bytes`);
  }
}

if (configuration.validate) {
  const blocked = (configuration.scenario === 'scale' && !baselineEvidence?.accepted)
    || !provenance.valid
    || matrix.bounds.effectiveTemporaryLimitBytes <= 0
    || projectedPeakBytes > matrix.bounds.effectiveTemporaryLimitBytes
    || projectedPeakMemoryBytes > effectiveMemoryLimitBytes;
  report.status = blocked ? 'blocked' : 'validated';
  report.progress = {
    phase: 'validation-complete',
    updatedAt: new Date().toISOString(),
    helpersCreated: false,
    databaseCreated: false,
  };
  report.validation = {
    decision: blocked ? 'blocked' : 'validated',
    reasons: [
      ...(configuration.scenario === 'scale' && !baselineEvidence?.accepted ? [baselineEvidence?.reason ?? 'Scale requires a completed matching baseline measurement.'] : []),
      ...(!provenance.valid ? provenance.errors : []),
      ...(matrix.bounds.effectiveTemporaryLimitBytes <= 0 ? ['Free-space reserve leaves no temporary capacity.'] : []),
      ...(projectedPeakBytes > matrix.bounds.effectiveTemporaryLimitBytes ? ['Projected proof tree exceeds the effective temporary-data/free-reserve limit.'] : []),
      ...(projectedPeakMemoryBytes > effectiveMemoryLimitBytes ? ['Projected peak memory exceeds 75% of currently available memory.'] : []),
    ],
    envelopePath,
  };
  recordGate('provenanceComplete', provenance.valid, true, (value) => value === true, { errors: provenance.errors });
  recordGate('projectedCapacity', projectedPeakBytes, `<= ${matrix.bounds.effectiveTemporaryLimitBytes} bytes`, (value) => value <= matrix.bounds.effectiveTemporaryLimitBytes, {
    fixtureDerived: !calibratedCapacityProjection,
    componentCalibrationDerived: Boolean(calibratedCapacityProjection),
    baselineRequiredForScale: configuration.scenario === 'scale',
  });
  recordGate('projectedPeakMemory', projectedPeakMemoryBytes, `<= ${effectiveMemoryLimitBytes} bytes (75% of currently available memory)`, (value) => value <= effectiveMemoryLimitBytes);
  recordGate('reservedFreeDisk', initialFreeBytes, `>= ${matrix.bounds.minUnusedDiskBytes} bytes`, (value) => value >= matrix.bounds.minUnusedDiskBytes);
  report.qualification = {
    scenario: configuration.scenario,
    decision: 'unqualified',
    overallP0: 'unqualified',
    reason: 'Validation-only mode performs no code or workload qualification.',
  };
  report.cleanup = { completed: true, rootRemoved: true, rootCreated: false };
  report.finishedAt = new Date().toISOString();
  writeReportAtomically();
  if (blocked) process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
} else {
try {
  checkpoint('preflight');
  ({ AnalyticsRecorderSupervisor, AnalyticsCaptureCapacityError } = await import(
    pathToFileURL(path.join(outRoot, 'analytics-recorder-supervisor.js')).href
  ));
  ({ SqliteAnalyticsRecorder } = await import(
    pathToFileURL(path.join(outRoot, 'analytics-sqlite-recorder.js')).href
  ));
  ({ AnalyticsQueryClient } = await import(
    pathToFileURL(path.join(outRoot, 'analytics-query-client.js')).href
  ));
  if (initialFreeBytes - matrix.bounds.minUnusedDiskBytes <= 64 * 1024 ** 2) {
    throw new Error(`insufficient free disk for reserved ${matrix.bounds.minUnusedDiskBytes} bytes`);
  }
  if (!provenance.valid) throw new Error(`artifact provenance is incomplete: ${provenance.errors.join('; ')}`);
  if (!baselineEvidence?.accepted && configuration.scenario === 'scale') throw new Error(baselineEvidence?.reason ?? 'Scale requires a completed matching baseline measurement.');
  if (projectedPeakBytes > matrix.bounds.effectiveTemporaryLimitBytes) throw new Error(`projected proof tree ${projectedPeakBytes} exceeds effective temporary limit ${matrix.bounds.effectiveTemporaryLimitBytes}`);
  if (projectedPeakMemoryBytes > effectiveMemoryLimitBytes) throw new Error(`projected peak memory ${projectedPeakMemoryBytes} exceeds safe available-memory limit ${effectiveMemoryLimitBytes}`);
  checkResourceEnvelope('preflight');
  const realProducerProbe = execFileSync(process.execPath, [
    path.join(extensionRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(extensionRoot, 'scripts', 'analytics-real-producer-probe.ts'),
  ], { encoding: 'utf8', timeout: 30_000 });
  report.results.realProducerBoundary = JSON.parse(realProducerProbe.trim());

  const disabled = new AnalyticsRecorderSupervisor({
    enabled: false,
    workerScript,
    databasePath,
  });
  activeHelpers.add(disabled);
  await disabled.start();
  disabled.submitDetail(detailCapture('disabled-capture', 'disabled-root', 2 * 1024));
  assert.equal(disabled.workerPid, undefined);
  report.results.disabledIngress = { enabled: disabled.enabled, workerStarted: false, backlog: disabled.backlog };
  const disabledHandoff = [];
  for (let index = 0; index < 10_000; index++) {
    const started = performance.now();
    disabled.submit(observation(index, index % 4, Math.floor(index / 4) + 1));
    disabledHandoff.push(performance.now() - started);
  }
  report.results.disabledBaselineHandoff = summarize(disabledHandoff);
  await shutdownHelper(disabled);

  // Deliberately delayed recorder acknowledgement: submission and simulated
  // agent completion must finish independently of the 300ms recorder delay.
  const delayed = supervisor(databasePath, { rehearsalAcknowledgementDelayMs: 300 });
  await delayed.start();
  const delayedCapture = detailCapture('delayed-2mib', 'root-delay', 2 * 1024 ** 2);
  ensureAdditionalCapacity('before-delayed-2mib', delayedCapture.bytes.byteLength * 2);
  const handoffStarted = performance.now();
  delayed.submitDetail(delayedCapture);
  const handoffMs = performance.now() - handoffStarted;
  const completionStarted = performance.now();
  await Promise.resolve();
  const simulatedAgentCompletionMs = performance.now() - completionStarted;
  const flushStarted = performance.now();
  await delayed.flush();
  const delayedFlushMs = performance.now() - flushStarted;
  assert.ok(delayedFlushMs >= 250, 'deliberate recorder delay was not observed');
  report.results.delayedAcknowledgement = { handoffMs, simulatedAgentCompletionMs, delayedFlushMs };
  await shutdownHelper(delayed);

  // Clean helper restart is intentionally separate from VS Code/runtime
  // activation. No live host is touched or armed.
  const restarting = supervisor(databasePath);
  await restarting.start();
  const restartDurationsMs = [];
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    await restarting.restart();
    restartDurationsMs.push(performance.now() - started);
  }
  await shutdownHelper(restarting);
  report.results.helperRestart = summarize(restartDurationsMs);

  // Terminate a helper while facts and a nested rich result are awaiting a
  // deliberately delayed acknowledgement. The supervisor retains owned bytes
  // and replays stable identities after explicit failover replacement.
  const failoverDatabasePath = path.join(root, `${configuration.seed}-failover.sqlite`);
  const failover = supervisor(failoverDatabasePath, { rehearsalAcknowledgementDelayMs: 500 });
  await failover.start();
  for (let index = 0; index < 250; index++) failover.submit(observation(50_000 + index, 0, index + 1));
  const failoverBody = { childId: scopedId('failover-child'), messages: [{ role: 'assistant', content: 'retained across cancellation' }] };
  failover.submitDetail(detailCapture('failover-nested', 'failover-root', 0, {
    messages: [{ role: 'toolResult', details: { results: [failoverBody] } }],
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const terminatedPid = failover.workerPid;
  assert.ok(terminatedPid);
  const failoverStarted = performance.now();
  process.kill(terminatedPid, 'SIGKILL');
  await waitFor(() => failover.workerPid !== undefined && failover.workerPid !== terminatedPid);
  const replayedBeforeRestart = failover.backlog.replayedRecords;
  await failover.flush();
  const failoverRecoveryMs = performance.now() - failoverStarted;
  const failoverBacklog = failover.backlog;
  await shutdownHelper(failover);
  const failoverReader = openReader(failoverDatabasePath);
  assert.equal(failoverReader.countObservations(), 250);
  assert.equal(failoverReader.countDetails(), 1);
  assert.equal(failoverReader.reconstructDetail(scopedId('failover-nested')).messages[0].details.results[0].messages[0].content, 'retained across cancellation');
  closeReader(failoverReader);
  report.results.crashFailover = {
    terminatedPid,
    replayedBeforeRestart,
    replayedRecords: failoverBacklog.replayedRecords,
    deliveryFailures: failoverBacklog.deliveryFailures,
    recoveryMs: failoverRecoveryMs,
    automaticReplacement: true,
    finalFacts: 250,
    nestedDetailReconstructed: true,
  };

  checkResourceEnvelope('before-primary-facts');
  captureCapacitySnapshot('beforePrimaryFacts', 'before-primary-facts');

  const factCommitLatencies = [];
  const hosts = Array.from({ length: 4 }, () => supervisor(databasePath, {
    onDeliveryAcknowledged: (measurement) => factCommitLatencies.push(...measurement.latencyMs),
  }));
  await Promise.all(hosts.map((host) => host.start()));
  const factSubmitDurations = [];
  const eventLoopLagMs = [];
  let nextLagSampleAt = performance.now() + 10;
  lagTimer = setInterval(() => {
    const now = performance.now();
    eventLoopLagMs.push(Math.max(0, now - nextLagSampleAt));
    nextLagSampleAt = now + 10;
  }, 10);
  const producerCpuBefore = process.cpuUsage();
  const activeStartedAt = performance.now();
  const producerRssBefore = process.memoryUsage().rss;
  let producerRssPeak = producerRssBefore;
  const topologySamples = [];
  const captureTopologySample = async (label, phase, activeHosts) => {
    producerRssPeak = Math.max(producerRssPeak, process.memoryUsage().rss);
    const stats = await Promise.all(activeHosts.map((host) => host.workerStats()));
    producerRssPeak = Math.max(producerRssPeak, process.memoryUsage().rss);
    const workers = stats.map((entry) => ({
      identity: {
        pid: entry.process.workerIdentity.pid,
        spawnedAtMs: entry.process.workerIdentity.spawnedAtMs,
        instanceId: entry.process.workerIdentity.instanceId,
      },
      rssBytes: entry.process.rss,
    }));
    const totalWorkerRssBytes = workers.reduce((sum, worker) => sum + worker.rssBytes, 0);
    const maxWorkerRssBytes = Math.max(...workers.map((worker) => worker.rssBytes));
    topologySamples.push({
      label,
      phase,
      observedAt: new Date().toISOString(),
      producerRssBytes: producerRssPeak,
      workers,
      totalWorkerRssBytes,
      maxWorkerRssBytes,
      totalTopologyRssBytes: producerRssPeak + totalWorkerRssBytes,
    });
    return stats;
  };
  for (let i = 0; i < matrix.facts.rows; i++) {
    const hostIndex = i % hosts.length;
    const started = performance.now();
    hosts[hostIndex].submit(observation(i, hostIndex));
    factSubmitDurations.push(performance.now() - started);
    if (i % 250 === 249) {
      await new Promise((resolve) => setImmediate(resolve));
      producerRssPeak = Math.max(producerRssPeak, process.memoryUsage().rss);
    }
    if (i % 10_000 === 9_999 && i + 1 < matrix.facts.rows) {
      await Promise.all(hosts.map((host) => host.flush()));
      checkResourceEnvelope(`after-fact-batch-${i + 1}`);
      await captureTopologySample(`after-fact-batch-${i + 1}`, 'facts', hosts);
    }
  }
  const factsFlushStarted = performance.now();
  await Promise.all(hosts.map((host) => host.flush()));
  const factsFlushMs = performance.now() - factsFlushStarted;
  checkResourceEnvelope('after-fact-flush');
  const workerStats = await captureTopologySample('after-fact-flush', 'facts', hosts);
  clearInterval(lagTimer);
  lagTimer = undefined;
  const activeElapsedMs = performance.now() - activeStartedAt;
  const producerCpu = process.cpuUsage(producerCpuBefore);
  report.results.factHandoff = summarize(factSubmitDurations);
  report.results.factDrain = {
    rows: matrix.facts.rows,
    flushMs: factsFlushMs,
    observationToCommitted: summarize(factCommitLatencies),
    finalFlushMs: factsFlushMs,
    historyElapsedMs: activeElapsedMs,
    rowsPerSecond: matrix.facts.rows / (activeElapsedMs / 1_000),
    backlog: hosts.map((host) => host.backlog),
  };
  report.results.responsivenessProxy = {
    label: 'standalone Node event-loop delay; not a live VS Code UI claim',
    intervalMs: 10,
    lag: summarize(eventLoopLagMs),
    producerCpuOneCorePercent: ((producerCpu.user + producerCpu.system) / (activeElapsedMs * 1_000)) * 100,
  };
  report.results.memory = {
    producerRssBefore,
    producerRssPeak,
    producerRssGrowthBytes: producerRssPeak - producerRssBefore,
    workerRssBytes: workerStats.map((entry) => entry.process.rss),
    totalWorkerRssBytes: workerStats.reduce((sum, entry) => sum + entry.process.rss, 0),
    maxWorkerRssBytes: Math.max(...topologySamples.flatMap((sample) => sample.workers.map((worker) => worker.rssBytes))),
    totalTopologyRssBytes: Math.max(...topologySamples.map((sample) => sample.totalTopologyRssBytes)),
    topologySamples,
    topologyMetric: 'conservative maximum of observed post-drain boundaries; producer RSS is the maximum from finite producer samples accumulated through each drain',
  };
  await shutdownHelpers(hosts);
  checkResourceEnvelope('after-primary-facts');
  captureCapacitySnapshot('afterPrimaryFacts', 'after-primary-facts');

  const detailCommitLatenciesBySize = { '2KiB': [], '32KiB': [], '2MiB': [] };
  const detailHost = supervisor(databasePath, {
    onDeliveryAcknowledged: (measurement) => {
      measurement.recordBytes.forEach((bytes, index) => {
        const label = bytes > 1024 ** 2 ? '2MiB' : bytes > 16 * 1024 ? '32KiB' : '2KiB';
        detailCommitLatenciesBySize[label].push(measurement.latencyMs[index]);
      });
    },
  });
  await detailHost.start();
  const handoffDurationsBySize = { '2KiB': [], '32KiB': [], '2MiB': [] };
  const detailBatchFlushDurations = [];
  const detailPlan = [
    ...Array.from({ length: detailCounts['2KiB'] }, () => ['2KiB', 2 * 1024]),
    ...Array.from({ length: detailCounts['32KiB'] }, () => ['32KiB', 32 * 1024]),
    ...Array.from({ length: detailCounts['2MiB'] }, () => ['2MiB', 2 * 1024 ** 2]),
  ];
  // Keep nominal fixture bytes below one quarter of the unchanged 64 MiB
  // queue, leaving a conservative allowance for framing and retained queue
  // ownership. Each flush is outside the measured synchronous submit interval.
  const detailBatches = planBoundedLoadBatches(detailPlan.map(([, size]) => size), {
    maxRecords: 1_000,
    maxBytes: matrix.bounds.maxQueueBytes / 4,
  });
  for (const batch of detailBatches) {
    ensureAdditionalCapacity(`before-detail-batch-${batch.start + 1}`, batch.bytes * 2);
    for (let i = batch.start; i < batch.end; i++) {
      const [label, size] = detailPlan[i];
      const started = performance.now();
      const capture = detailCapture(`detail-${i}`, `detail-root-${i % 8}`, size);
      detailHost.submitDetail(capture);
      handoffDurationsBySize[label].push(performance.now() - started);
      if (i % 20 === 19) await new Promise((resolve) => setImmediate(resolve));
    }
    const batchFlushStarted = performance.now();
    await detailHost.flush();
    detailBatchFlushDurations.push(performance.now() - batchFlushStarted);
    checkResourceEnvelope(`after-detail-batch-${batch.end}`);
    await captureTopologySample(`after-detail-batch-${batch.end}`, 'variable-details', [detailHost]);
  }
  const detailStats = await detailHost.workerStats();
  const peakDetailBacklog = detailHost.backlog;
  await shutdownHelper(detailHost);
  checkResourceEnvelope('after-variable-details');
  captureCapacitySnapshot('afterVariableDetails', 'after-variable-details');

  const sharedBody = 'shared-child-body '.repeat(65_536);
  const childValue = { childId: scopedId('shared-child'), messages: [{ role: 'assistant', content: sharedBody }] };
  const parentValue = {
    childId: scopedId('parent'),
    messages: [{ role: 'toolResult', details: { results: [childValue] } }],
  };
  const sharedChildCapture = detailCapture('shared-child-payload', 'nested-root', 0, childValue);
  const sharedParentCapture = detailCapture('shared-parent-payload', 'nested-root', 0, parentValue);
  ensureAdditionalCapacity('before-shared-nested-detail', (sharedChildCapture.bytes.byteLength + sharedParentCapture.bytes.byteLength) * 2);
  const nestedDetailHost = supervisor(databasePath);
  await nestedDetailHost.start();
  nestedDetailHost.submitDetail(sharedChildCapture);
  nestedDetailHost.submitDetail(sharedParentCapture);
  await nestedDetailHost.flush();
  await captureTopologySample('after-nested-detail-drain', 'nested-details', [nestedDetailHost]);
  await shutdownHelper(nestedDetailHost);
  checkResourceEnvelope('after-detail-drain');
  report.results.detailHandoff = Object.fromEntries(
    Object.entries(handoffDurationsBySize).map(([label, values]) => [label, summarize(values)]),
  );
  report.results.detailObservationToCommitted = Object.fromEntries(
    Object.entries(detailCommitLatenciesBySize)
      .filter(([, values]) => values.length > 0)
      .map(([label, values]) => [label, summarize(values)]),
  );
  report.results.detailDrain = {
    flushMs: detailBatchFlushDurations.reduce((sum, duration) => sum + duration, 0),
    batchCount: detailBatchFlushDurations.length,
    batchFlush: summarize(detailBatchFlushDurations),
    peakDetailBacklog,
    storage: detailStats.detailStorage,
  };
  report.results.memory.producerRssPeak = producerRssPeak;
  report.results.memory.producerRssGrowthBytes = producerRssPeak - producerRssBefore;
  report.results.memory.maxWorkerRssBytes = Math.max(...topologySamples.flatMap((sample) => sample.workers.map((worker) => worker.rssBytes)));
  report.results.memory.totalTopologyRssBytes = Math.max(...topologySamples.map((sample) => sample.totalTopologyRssBytes));

  const reader = openReader(databasePath);
  assert.equal(reader.countObservations(), matrix.facts.rows);
  assert.equal(reader.countDetails(), matrix.detail.total + 3); // delayed + selected 10% mix + nested pair
  const tableRows = {
    primaryFacts: reader.countObservations(),
    providerSettlements: reader.countProviderSettlements(),
    toolObservations: reader.countTypedEntityObservations('toolCall'),
    activityObservations: reader.countTypedEntityObservations('activitySpan'),
    featureObservations: reader.countTypedEntityObservations('featureObservation'),
    detailPayloads: reader.countDetails(),
  };
  assert.equal(tableRows.providerSettlements + tableRows.toolObservations + tableRows.activityObservations + tableRows.featureObservations, matrix.facts.rows);
  report.results.tableRows = tableRows;
  const beforeRedeliveryCount = reader.countObservations();
  reader.submit(observation(0, 0, 1));
  assert.equal(reader.countObservations(), beforeRedeliveryCount);
  const conflicting = observation(0, 0, 1);
  conflicting.fields = { ...conflicting.fields, outcome: 'identity-conflict' };
  assert.throws(() => reader.submit(conflicting), /Conflicting analytics/);
  const accountingOracle = { occurrences: 0, inputKnown: 0, inputUnknown: 0, inputTotal: 0, reportedKnown: 0 };
  for (let index = 0; index < matrix.facts.rows; index += 4) {
    accountingOracle.occurrences += 1;
    if (index % 17 === 0) accountingOracle.inputUnknown += 1;
    else {
      accountingOracle.inputKnown += 1;
      accountingOracle.inputTotal += 100 + index;
    }
    if (index % 23 !== 0) accountingOracle.reportedKnown += 1;
  }
  const accountingSummary = reader.readProviderAccountingSummary();
  assert.equal(accountingSummary.invocationCount, accountingOracle.occurrences);
  assert.equal(accountingSummary.inputTokens.knownCount, accountingOracle.inputKnown);
  assert.equal(accountingSummary.inputTokens.unknownCount, accountingOracle.inputUnknown);
  assert.equal(accountingSummary.inputTokens.knownTotal, accountingOracle.inputTotal);
  assert.equal(accountingSummary.effectiveCostUsd.knownCount, accountingOracle.reportedKnown);
  assert.equal(accountingSummary.effectiveCostUsd.complete, false);
  report.results.correctnessOracle = {
    ...accountingOracle,
    exactRedelivery: 'duplicate',
    conflictingIdentity: 'rejected',
    effectiveCostComplete: accountingSummary.effectiveCostUsd.complete,
  };
  const childReconstructed = reader.reconstructDetail(scopedId('shared-child-payload'));
  const parentReconstructed = reader.reconstructDetail(scopedId('shared-parent-payload'));
  assert.equal(childReconstructed.messages[0].content, sharedBody);
  assert.equal(parentReconstructed.messages[0].details.results[0].messages[0].content, sharedBody);
  assert.ok(reader.detailStorageStats().storedContentBytes < reader.detailStorageStats().logicalBytes);
  const queryDurations = [];
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    assert.equal(reader.projectProviderUsage().length, Math.ceil(matrix.facts.rows / 4));
    queryDurations.push(performance.now() - started);
  }
  const dimensionQueryDurations = [];
  let dimensionSummary;
  for (let index = 0; index < 10; index++) {
    const started = performance.now();
    dimensionSummary = reader.readHistoricalDimensionSummary();
    dimensionQueryDurations.push(performance.now() - started);
  }
  assert.ok(dimensionSummary.providers.length > 0 && dimensionSummary.tools.length > 0
    && dimensionSummary.activities.length > 0 && dimensionSummary.features.length > 0);
  const indexedStarted = performance.now();
  assert.equal(reader.countObservations(`${configuration.seed}-root-3`), 625);
  const indexedMs = performance.now() - indexedStarted;
  const largeDetailStarted = performance.now();
  const largeDetailId = scopedId(`detail-${detailPlan.length - 1}`);
  const largeDetail = reader.reconstructDetail(largeDetailId);
  const largeDetailMs = performance.now() - largeDetailStarted;
  assert.equal(largeDetail.messages[0].content[0].text.length, 2 * 1024 ** 2);
  report.results.queries = {
    allHistoryProjection: summarize(queryDurations),
    historicalDimensions: summarize(dimensionQueryDurations),
    historicalDimensionGroups: {
      providers: dimensionSummary.providers.length,
      tools: dimensionSummary.tools.length,
      activities: dimensionSummary.activities.length,
      features: dimensionSummary.features.length,
    },
    indexedSessionMs: indexedMs,
    twoMiBDetailMs: largeDetailMs,
  };
  closeReader(reader);

  const queryWorkerLifecycle = [];
  const queryClient = new AnalyticsQueryClient({
    databasePath,
    workerScript: queryWorkerScript,
    timeoutMs: 10_000,
    onWorkerLifecycle: (event) => queryWorkerLifecycle.push(structuredClone(event)),
  });
  // Attribute each worker-query duration so a timeout names its own request
  // instead of leaving the failing step to inference. A rejected request is
  // recorded before it propagates.
  const workerQueryTimings = [];
  // Attach the live array to the report immediately: if a query rejects, the
  // failure path still publishes every timing recorded up to and including the
  // failing request, so a timeout names its own step.
  report.results.workerQueryTimings = workerQueryTimings;
  const timedWorkerQuery = async (label, request) => {
    const started = performance.now();
    try {
      const result = await queryClient.query(request);
      workerQueryTimings.push({ label, ms: performance.now() - started, outcome: 'resolved' });
      return result;
    } catch (error) {
      workerQueryTimings.push({
        label,
        ms: performance.now() - started,
        outcome: 'rejected',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  const boundedQuery = await timedWorkerQuery('boundedProviderSettlements', { type: 'providerSettlements' });
  assert.equal(boundedQuery.settlements.length, Math.min(200, Math.ceil(matrix.facts.rows / 4)));
  await assert.rejects(
    timedWorkerQuery('oversizeResultRejection', { type: 'providerSettlements', maxResultBytes: 1 }),
    /exceeds 1 bytes/,
  );
  const defaultDetailRange = await timedWorkerQuery('detailDefaultRange', {
    type: 'detail', payloadId: largeDetailId,
  });
  assert.equal(defaultDetailRange.bytes.byteLength, 64 * 1024);
  assert.equal(defaultDetailRange.truncated, true);
  const detailParts = [];
  let detailOffset = 0;
  do {
    const part = await timedWorkerQuery(`detailChunkWalk:${detailOffset}`, {
      type: 'detail',
      payloadId: largeDetailId,
      offset: detailOffset,
      maxBytes: 512 * 1024,
      maxResultBytes: 640 * 1024,
    });
    detailParts.push(Buffer.from(part.bytes));
    detailOffset = part.nextOffset;
  } while (detailOffset !== null);
  const explicitLargeDetail = deserialize(Buffer.concat(detailParts));
  assert.equal(explicitLargeDetail.messages[0].content[0].text.length, 2 * 1024 ** 2);
  const schemaDescription = await timedWorkerQuery('schema', { type: 'schema' });
  assert.equal(schemaDescription.databaseSchemaVersion, 6);
  const logicalQuery = await timedWorkerQuery('logicalCount', {
    type: 'query',
    sql: 'SELECT COUNT(*) AS count FROM analytics_provider_usage_v1',
  });
  assert.equal(logicalQuery.rows[0].count, Math.ceil(matrix.facts.rows / 4));
  await assert.rejects(
    timedWorkerQuery('mutationRejection', { type: 'query', sql: 'DELETE FROM analytics_observations' }),
    /not authorized/,
  );
  const storageQuery = await timedWorkerQuery('storage', { type: 'storage' });
  assert.equal(storageQuery.storage.payloadCount, matrix.detail.total + 3);
  const cancelController = new AbortController();
  const cancelStarted = performance.now();
  const cancelledQuery = queryClient.query({ type: 'qualificationSpin', iterations: 2_000_000_000 }, cancelController.signal);
  setTimeout(() => cancelController.abort(new Error('qualification cancellation')), 50);
  await assert.rejects(cancelledQuery, /qualification cancellation/);
  const cancellationMs = performance.now() - cancelStarted;
  const saturationControllers = Array.from({ length: 4 }, () => new AbortController());
  const saturationStarted = performance.now();
  const saturatedQueries = saturationControllers.map((controller) => queryClient.query(
    { type: 'qualificationSpin', iterations: 2_000_000_000 },
    controller.signal,
  ));
  setTimeout(() => saturationControllers.forEach((controller) => controller.abort(new Error('saturation cancellation'))), 100);
  const saturationResults = await Promise.allSettled(saturatedQueries);
  assert.ok(saturationResults.every((result) => result.status === 'rejected'));
  report.results.queryIsolation = {
    defaultRowLimit: boundedQuery.settlements.length,
    defaultResultBytes: 256 * 1024,
    defaultDetailRangeBytes: defaultDetailRange.bytes.byteLength,
    workerQueryTimings,
    logicalCommands: schemaDescription.logicalCommands,
    nativeReadOnlyMutationDenied: true,
    snapshotWatermark: logicalQuery.snapshotWatermark,
    storage: storageQuery.storage,
    delivery: storageQuery.delivery,
    cancellationMs,
    saturationQueries: saturationResults.length,
    saturationCancellationMs: performance.now() - saturationStarted,
    processModel: 'one disposable read-only helper per historical query',
  };

  // A non-writing query helper observes another helper's commit and deletion
  // without replaying primary facts.
  const refreshWriter = supervisor(databasePath);
  await refreshWriter.start();
  const refreshObservation = observation(90_000_000, 9, 1);
  refreshObservation.scope.rootSessionId = scopedId('cross-host-refresh-root');
  refreshObservation.captureSubject.rootSessionId = scopedId('cross-host-refresh-root');
  const refreshStarted = performance.now();
  refreshWriter.submit(refreshObservation);
  await refreshWriter.flush();
  const refreshVisible = await queryClient.query({ type: 'providerSettlements', rootSessionId: scopedId('cross-host-refresh-root') });
  const crossHostCommitVisibleMs = performance.now() - refreshStarted;
  assert.equal(refreshVisible.settlements.length, 1);
  const deleteStarted = performance.now();
  await refreshWriter.deleteSession(scopedId('cross-host-refresh-root'), scopedId('cross-host-delete'), 1_780_300_000_000);
  const refreshDeleted = await queryClient.query({ type: 'providerSettlements', rootSessionId: scopedId('cross-host-refresh-root') });
  const crossHostDeleteVisibleMs = performance.now() - deleteStarted;
  assert.equal(refreshDeleted.settlements.length, 0);
  await shutdownHelper(refreshWriter);
  report.results.crossHostRefresh = { crossHostCommitVisibleMs, crossHostDeleteVisibleMs, replayedHistory: false };

  // Queue overflow is visible and bounded, not silently dropped or converted
  // into a production outage policy.
  const bounded = supervisor(databasePath, { maxQueueBytes: 1 * 1024 ** 2, rehearsalAcknowledgementDelayMs: 300 });
  await bounded.start();
  assert.throws(() => bounded.submitDetail(detailCapture('overflow', 'overflow-root', 2 * 1024 ** 2)), AnalyticsCaptureCapacityError);
  report.results.capacity = bounded.backlog;
  await shutdownHelper(bounded);

  // Race the recorder-owned deletion marker against a late detail in another
  // helper. Either ordering is valid; the final state must be absent and the
  // late writer must be scrubbed or explicitly rejected.
  const privacySentinel = 'PIE-PRIVATE-QUALIFICATION-SENTINEL-fdf9c37e';
  const deletionWriter = supervisor(databasePath);
  const lateWriter = supervisor(databasePath);
  await Promise.all([deletionWriter.start(), lateWriter.start()]);
  const initialPrivateFact = observation(20_000, 0);
  initialPrivateFact.fields.privateQualificationValue = privacySentinel;
  initialPrivateFact.scope.rootSessionId = scopedId('private-race-root');
  initialPrivateFact.captureSubject.rootSessionId = scopedId('private-race-root');
  deletionWriter.submit(initialPrivateFact);
  deletionWriter.submitDetail(detailCapture(
    'private-initial',
    'private-race-root',
    32 * 1024,
    { privateQualificationValue: privacySentinel, body: privacySentinel.repeat(128) },
  ));
  await deletionWriter.flush();
  const raceResults = await Promise.allSettled([
    deletionWriter.deleteSession(scopedId('private-race-root'), scopedId('private-close'), 1_780_200_000_000),
    (async () => {
      const lateFact = observation(20_001, 1);
      lateFact.scope.rootSessionId = scopedId('private-race-root');
      lateFact.captureSubject.rootSessionId = scopedId('private-race-root');
      lateWriter.submit(lateFact);
      lateWriter.submitDetail(detailCapture('private-late', 'private-race-root', 32 * 1024));
      await lateWriter.flush();
    })(),
  ]);
  assert.ok(lateWriter.backlog.deliveryFailures >= 1, 'late private delivery rejection must be visible');
  const lateDeliveryError = lateWriter.lastDeliveryError?.message;
  const unrelatedAfterDelete = observation(30_000, 1);
  unrelatedAfterDelete.scope.rootSessionId = scopedId('unrelated-after-private-delete');
  unrelatedAfterDelete.captureSubject.rootSessionId = scopedId('unrelated-after-private-delete');
  lateWriter.submit(unrelatedAfterDelete);
  await lateWriter.flush();
  await Promise.allSettled([shutdownHelper(deletionWriter), shutdownHelper(lateWriter)]);
  const privacyRecovery = openReader(databasePath);
  const privacyScrubRecovery = privacyRecovery.resumePendingPrivacyScrubs(16);
  closeReader(privacyRecovery);
  assert.equal(privacyScrubRecovery.pending.length, 0);
  const privacyReader = openReader(databasePath);
  assert.equal(privacyReader.countDetails(scopedId('private-race-root')), 0);
  assert.equal(privacyReader.countObservations(scopedId('private-race-root')), 0);
  assert.equal(privacyReader.countObservations(scopedId('unrelated-after-private-delete')), 1);
  const privacyAccounting = privacyReader.readDeliveryAccounting();
  closeReader(privacyReader);
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${databasePath}${suffix}`;
    if (existsSync(candidate)) {
      assert.equal(readFileSync(candidate).includes(Buffer.from(privacySentinel)), false, `${suffix || 'main'} retained private bytes`);
    }
  }
  report.results.privateDeleteRace = {
    outcomes: raceResults.map((result) => result.status),
    lateDeliveryFailures: lateWriter.backlog.deliveryFailures,
    lateDeliveryError,
    finalFactCount: 0,
    finalDetailCount: 0,
    physicalMainWalShmScrubbed: true,
    durableDeliveryAccounting: privacyAccounting,
    scrubRecovery: privacyScrubRecovery,
  };

  // The rate conditions spawn up to four concurrent recorder helpers. On this
  // machine (15.3 GB RAM, measured ~3.5 GB available, effective limit 2.6 GB)
  // stacking them behind the resident 1M producer exhausts host memory and the
  // OS terminates a worker with SIGTERM, which is an environment failure rather
  // than a qualification result. They therefore run in their own bounded pass
  // once the scale workload has released its producer, unless explicitly
  // coupled with PIE_ANALYTICS_P0_RATE_CONDITIONS=inline.
  const runRateConditionsHere = process.env.PIE_ANALYTICS_P0_RATE_CONDITIONS !== 'deferred';
  if (runRateConditionsHere) {
    report.results.rateConditions = [
      await runRateCondition(root, 'burst-1000ps-1host', 1_000, 5_000, 1),
      await runRateCondition(root, 'burst-1000ps-2hosts', 1_000, 5_000, 2),
      await runRateCondition(root, 'burst-1000ps-4hosts', 1_000, 5_000, 4),
    ];
  } else {
    report.results.rateConditions = null;
    report.results.rateConditionsDeferred = {
      reason: 'host memory: four concurrent recorder helpers cannot share the machine with the resident 1M producer',
      conditions: ['burst-1000ps-1host', 'burst-1000ps-2hosts', 'burst-1000ps-4hosts'],
      measuredAvailableMemoryBytes: report.environment.initialAvailableMemoryBytes,
      effectiveMemoryLimitBytes: report.environment.effectiveMemoryLimitBytes,
    };
  }
  if (process.env.PIE_ANALYTICS_P0_ENDURANCE === '1') {
    report.results.rateConditions.push(
      await runRateCondition(root, 'sustained-50ps-repeat-a', 50, 10_000, 1),
      await runRateCondition(root, 'sustained-50ps-repeat-b', 50, 10_000, 4),
      await runRateCondition(root, 'light-1ps-repeat-a', 1, 300, 1),
      await runRateCondition(root, 'light-1ps-repeat-b', 1, 300, 1),
    );
    const idleDatabasePath = path.join(root, 'idle.sqlite');
    const idleHost = supervisor(idleDatabasePath);
    await idleHost.start();
    const idleBefore = await idleHost.workerStats();
    const idleStarted = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    const idleAfter = await idleHost.workerStats();
    const idleElapsedMs = performance.now() - idleStarted;
    const idleCpuMicros = idleAfter.process.cpuUsage.user + idleAfter.process.cpuUsage.system
      - idleBefore.process.cpuUsage.user - idleBefore.process.cpuUsage.system;
    report.results.idle = {
      elapsedMs: idleElapsedMs,
      workerCpuOneCorePercent: (idleCpuMicros / (idleElapsedMs * 1_000)) * 100,
      rssBefore: idleBefore.process.rss,
      rssAfter: idleAfter.process.rss,
      historyPollingOrReplay: false,
    };
    await shutdownHelper(idleHost);
  }

  assert.equal(activeHelpers.size, 0, 'all recorder helpers must be stopped before the destructive fault');
  assert.equal(activeReaders.size, 0, 'all in-process readers must be closed before the destructive fault');
  const recorderTerminalEvidence = requireTerminalWorkerEvidence(recorderWorkerLifecycle, 'recorder');
  const queryTerminalEvidence = requireTerminalWorkerEvidence(queryWorkerLifecycle, 'query');
  const topologyValidation = validateMemoryTopologySamples(topologySamples, {
    expectedPlan: buildExpectedTopologySamplePlan({
      rows: matrix.facts.rows,
      maxQueueBytes: matrix.bounds.maxQueueBytes,
    }),
    recorderWorkers: recorderTerminalEvidence,
  });
  assert.equal(topologyValidation.valid, true, `memory topology evidence is invalid: ${topologyValidation.errors.join('; ')}`);
  report.results.memory.maxWorkerRssBytes = topologyValidation.maxWorkerRssBytes;
  report.results.memory.totalTopologyRssBytes = topologyValidation.maxTotalTopologyRssBytes;
  report.results.memory.sampledWorkerCount = topologyValidation.sampledWorkerCount;
  const proofRootStat = lstatSync(root);
  const databaseStat = lstatSync(databasePath);
  assert.equal(proofRootStat.isSymbolicLink(), false, 'proof root must not be a symbolic link');
  assert.equal(databaseStat.isSymbolicLink(), false, 'analytics database must not be a symbolic link');
  const proofRootRealPath = realpathSync(root);
  const databaseRealPath = realpathSync(databasePath);
  const reportRealPath = realpathSync(configuration.report);
  assert.equal(path.dirname(databaseRealPath), proofRootRealPath, 'analytics database must be directly contained by the owned proof root');
  const reportRelativeToProofRoot = path.relative(proofRootRealPath, reportRealPath);
  assert.ok(reportRelativeToProofRoot.startsWith('..') && !path.isAbsolute(reportRelativeToProofRoot), 'qualification report must remain outside the destructive proof root');
  checkResourceEnvelope('final-before-fault');
  const finalBeforeFault = captureCapacitySnapshot('finalBeforeFault', 'final-before-fault');
  const stableInventory = proofTreeInventory(root);
  assert.deepEqual(stableInventory, finalBeforeFault.files, 'pre-fault inventory must be stable after every helper exits');
  const wal = stableInventory.find((entry) => entry.path === 'analytics.sqlite-wal');
  const shm = stableInventory.find((entry) => entry.path === 'analytics.sqlite-shm');
  assert.ok(!wal || wal.bytes === 0, 'analytics WAL must be absent or empty before the destructive fault');
  assert.ok(!shm || shm.bytes === 0, 'analytics shared-memory file must be absent or empty before the destructive fault');
  report.results.capacityComponentSnapshots = capacityComponentSnapshots;
  report.results.capacityCalibration = buildCapacityCalibration({
    baselineRows: matrix.facts.rows,
    detailRows: matrix.detail.total,
    snapshots: capacityComponentSnapshots,
    observedTreeBytes: report.results.resourceEnvelope.samples.map((sample) => sample.physicalBytes),
    prewriteProjectedTreeBytes: prewriteCapacityChecks.map((sample) => sample.projectedTreeBytes),
  });
  report.results.capacityProjection.calibration = report.results.capacityCalibration;
  report.results.capacityProjection.measuredObservedHighWaterBytes = report.results.capacityCalibration.observedHighWaterBytes;
  report.results.capacityProjection.measuredPrewriteHighWaterBytes = report.results.capacityCalibration.prewriteHighWaterBytes;
  if (configuration.scenario === 'baseline') {
    const measuredBaselineProjection = projectCapacityFromCalibration(report.results.capacityCalibration, {
      targetRows: matrix.facts.rows,
      safetyFactor: 1.25,
    });
    report.results.capacityProjection.calibratedProjection = measuredBaselineProjection;
    report.results.capacityProjection.projectedPeakBytes = measuredBaselineProjection.projectedPeakBytes;
    report.results.capacityProjection.projectionMethod = 'versioned in-place-fault calibration reconciled with observed and prewrite proof-tree high-water measurements';
  }
  report.results.destructiveFault = {
    phase: 'prepared',
    proofRootRealPath,
    databaseRealPath,
    reportRealPath,
    containmentVerified: true,
    proofRootSymbolicLink: false,
    databaseSymbolicLink: false,
    walBytes: wal?.bytes ?? 0,
    shmBytes: shm?.bytes ?? 0,
    recorderWorkers: recorderTerminalEvidence,
    queryWorkers: queryTerminalEvidence,
    preFaultInventory: stableInventory,
    checkpointedOutsideProofRoot: true,
  };
  checkpoint('pre-fault-checkpoint', {
    databaseRealPath,
    terminalRecorderWorkers: recorderTerminalEvidence.length,
    terminalQueryWorkers: queryTerminalEvidence.length,
  });
  truncateSync(databasePath, 100);
  const corruptionWorkerLifecycle = [];
  const corruptionQueryClient = new AnalyticsQueryClient({
    databasePath,
    workerScript: queryWorkerScript,
    timeoutMs: 10_000,
    onWorkerLifecycle: (event) => corruptionWorkerLifecycle.push(structuredClone(event)),
  });
  let corruptionError;
  try {
    await corruptionQueryClient.query({ type: 'schema' });
  } catch (error) {
    corruptionError = error instanceof Error ? error.message : String(error);
  }
  assert.match(corruptionError ?? '', /database|sqlite|malform|corrupt|file is not/i, 'truncated database must fail visibly as corruption');
  const corruptionTerminalEvidence = requireTerminalWorkerEvidence(corruptionWorkerLifecycle, 'corruption query', { requireReady: false });
  report.results.destructiveFault = {
    ...report.results.destructiveFault,
    phase: 'completed',
    truncatedToBytes: 100,
    visibleError: corruptionError,
    corruptionQueryWorkers: corruptionTerminalEvidence,
    corruptionWorkerTerminal: true,
  };

  report.results.physicalBytes = finalBeforeFault.treeBytes;
  const bytesPerPrimaryFact = report.results.physicalBytes / matrix.facts.rows;
  const estimatedTenMillionBytes = bytesPerPrimaryFact * 10_000_000;
  report.results.largeTierDecision = {
    measuredRows: matrix.facts.rows,
    measuredBytesPerPrimaryFact: bytesPerPrimaryFact,
    estimatedTenMillionBytes,
    tenMillionExecuted: matrix.facts.rows >= 10_000_000,
    tenMillionSkipReason: matrix.facts.rows >= 10_000_000
      ? null
      : estimatedTenMillionBytes > matrix.bounds.maxTemporaryBytes
        ? 'Estimated footprint exceeds the predeclared 16 GiB temporary-data bound.'
        : 'Not requested by PIE_ANALYTICS_P0_ROWS; tier is not claimed.',
  };
  checkResourceEnvelope('final');
  report.measurement = {
    completed: true,
    completedAt: new Date().toISOString(),
    exactPrimaryRows: report.results.tableRows?.primaryFacts,
    exactDetailRows: report.results.tableRows?.detailPayloads,
  };
  const finalTableRows = report.results.tableRows;
  const failedGates = [];
  if (!recordGate('exactPrimaryRows', finalTableRows?.primaryFacts, requestedRows, (value) => value === requestedRows)) failedGates.push('exactPrimaryRows');
  if (!recordGate('exactDetailRows', finalTableRows?.detailPayloads, matrix.detail.total + 3, (value) => value === matrix.detail.total + 3)) failedGates.push('exactDetailRows');
  if (!recordGate('handoffP99', report.results.factHandoff?.p99Ms, '<= 9 ms', (value) => value <= 9)) failedGates.push('handoffP99');
  if (!recordGate('responsivenessProxyP95', report.results.responsivenessProxy?.lag?.p95Ms, '<= 25 ms declared proxy gate', (value) => value <= 25, { interpretation: 'standalone event-loop proxy; not UI or agent evidence' })) failedGates.push('responsivenessProxyP95');
  if (!recordGate('indexedQuery', report.results.queries?.indexedSessionMs, '<= 250 ms', (value) => value <= 250)) failedGates.push('indexedQuery');
  if (!recordGate('largeDetailQuery', report.results.queries?.twoMiBDetailMs, '<= 9000 ms', (value) => value <= 9000)) failedGates.push('largeDetailQuery');
  const envelope = report.results.resourceEnvelope?.samples?.at(-1);
  const peakPhysicalBytes = Math.max(...(report.results.resourceEnvelope?.samples ?? []).map((sample) => sample.physicalBytes));
  const minimumFreeBytes = Math.min(...(report.results.resourceEnvelope?.samples ?? []).map((sample) => sample.freeBytes));
  if (!recordGate('temporaryFootprint', peakPhysicalBytes, `<= ${matrix.bounds.effectiveTemporaryLimitBytes} bytes`, (value) => value <= matrix.bounds.effectiveTemporaryLimitBytes, { finalSampleBytes: envelope?.physicalBytes })) failedGates.push('temporaryFootprint');
  if (!recordGate('inPlaceCorruption', report.results.destructiveFault?.phase, 'completed with a terminal fresh read-only helper', (value) => value === 'completed' && report.results.destructiveFault?.corruptionWorkerTerminal === true)) failedGates.push('inPlaceCorruption');
  if (!recordGate('capacityCalibration', report.results.capacityCalibration?.eligible, true, (value) => value === true, {
    errors: report.results.capacityCalibration?.errors ?? ['capacity calibration missing'],
  })) failedGates.push('capacityCalibration');
  if (!recordGate('reservedFreeDisk', minimumFreeBytes, `>= ${matrix.bounds.minUnusedDiskBytes} bytes`, (value) => value >= matrix.bounds.minUnusedDiskBytes, { finalSampleBytes: envelope?.freeBytes })) failedGates.push('reservedFreeDisk');
  if (!recordGate('recorderWorkerRss', report.results.memory?.maxWorkerRssBytes, '<= 268435456 bytes per recorder/helper during ordinary ingestion', (value) => value <= 256 * 1024 ** 2)) failedGates.push('recorderWorkerRss');
  if (configuration.scenario === 'scale') {
    if (!recordGate('scaleHistoryRows', finalTableRows?.primaryFacts, '>= 1000000 exact rows', (value) => value >= 1_000_000)) failedGates.push('scaleHistoryRows');
  } else {
    recordUnqualified('scaleHistoryRows', 'Scale scenario was not selected.');
  }
  for (const [name, reason] of [
    ['tenMillionHistory', 'Not executed; capacity tier remains unqualified.'],
    ['enduranceLightLoad', 'Not executed by this bounded baseline/scale harness.'],
    ['mixedLoad', 'Not executed by this bounded baseline/scale harness.'],
    ['schemaV2AndFaults', 'Not executed by this bounded baseline/scale harness.'],
    ['matchedAgentUi', 'The standalone proxy is not a UI or agent baseline.'],
    ['incrementalHostMemory', 'No matched analytics-disabled host baseline was executed.'],
    ['queryPeakMemory', 'The bounded query helper reports process behavior, but this unit does not isolate an additional-RSS baseline.'],
    ['rateConditions', report.results.rateConditionsDeferred
      ? 'Deferred in this pass: four concurrent recorder helpers cannot share this host with the resident 1M producer.'
      : 'Executed in-line; no deferral was requested.'],
  ]) recordUnqualified(name, reason);
  report.qualification = { scenario: configuration.scenario, decision: failedGates.length === 0 ? 'scenario-passed' : 'scenario-failed', failedGates, overallP0: 'unqualified' };
  if (failedGates.length > 0) throw new Error(`numeric qualification gates failed: ${failedGates.join(', ')}`);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = {
    name: error instanceof Error ? error.name : 'QualificationError',
    message: error instanceof Error ? error.message : String(error),
  };
} finally {
  let cleanupError = null;
  let helperFailures = [];
  let allHelperExitsConfirmed = true;
  let helperCleanup = {
    tracked: activeHelpers.size,
    shutdownAttempted: 0,
    remaining: activeHelpers.size,
    forcedTerminations: [],
    readerCloseAttempted: 0,
    failures: helperFailures,
  };
  if (lagTimer) {
    clearInterval(lagTimer);
    lagTimer = undefined;
  }
  try {
    const trackedHelpers = [...activeHelpers];
    const helperResults = await Promise.allSettled(trackedHelpers.map((helper) => shutdownHelper(helper)));
    helperFailures = helperResults
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    const forcedTerminations = [];
    for (const [index, result] of helperResults.entries()) {
      if (result.status === 'rejected') {
        const pid = trackedHelpers[index]?.workerPid;
        if (!pid) {
          allHelperExitsConfirmed = false;
          helperFailures.push(`Helper ${index} shutdown failed without a worker PID; terminal exit could not be confirmed.`);
          forcedTerminations.push({ helperIndex: index, pid: null, confirmed: false });
          continue;
        }
        try {
          if (processIsAlive(pid)) process.kill(pid, 'SIGKILL');
          await waitFor(() => !processIsAlive(pid), 5_000);
          forcedTerminations.push({ helperIndex: index, pid, confirmed: true });
        } catch (error) {
          allHelperExitsConfirmed = false;
          const message = error instanceof Error ? error.message : String(error);
          helperFailures.push(`Helper ${index} worker ${pid} terminal exit was not confirmed: ${message}`);
          forcedTerminations.push({ helperIndex: index, pid, confirmed: false, error: message });
        }
      }
    }
    helperCleanup = {
      tracked: trackedHelpers.length,
      shutdownAttempted: helperResults.length,
      remaining: activeHelpers.size,
      forcedTerminations,
      readerCloseAttempted: activeReaders.size,
      failures: helperFailures,
    };
  } catch (error) {
    helperFailures.push(error instanceof Error ? error.message : String(error));
  }
  for (const reader of activeReaders) {
    try {
      reader.close();
    } catch (error) {
      helperFailures.push(error instanceof Error ? error.message : String(error));
    }
  }
  activeReaders.clear();
  helperCleanup.failures = helperFailures;
  if (!allHelperExitsConfirmed) {
    cleanupError = 'One or more recorder helper exits could not be confirmed; the proof root was retained.';
    report.cleanup = { completed: false, rootRemoved: false, helpers: helperCleanup, error: cleanupError };
    report.status = 'failed';
  } else {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      report.cleanup = { completed: helperFailures.length === 0, rootRemoved: true, helpers: helperCleanup };
      if (helperFailures.length > 0) report.status = 'failed';
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
      report.cleanup = { completed: false, rootRemoved: false, helpers: helperCleanup, error: cleanupError };
      report.status = 'failed';
    }
  }
  ensureGateEvidence();
  const recordedFailedGates = Object.entries(report.gates)
    .filter(([, gate]) => gate.decision === 'failed')
    .map(([name]) => name);
  if (!report.qualification) {
    report.qualification = {
      scenario: configuration.scenario,
      decision: 'scenario-failed',
      failedGates: recordedFailedGates,
      overallP0: 'unqualified',
      reason: 'The scenario did not reach complete gate evaluation.',
    };
  } else if (report.status === 'failed' && report.qualification.decision === 'scenario-passed') {
    report.qualification = {
      ...report.qualification,
      decision: 'scenario-failed',
      failedGates: [...new Set([...(report.qualification.failedGates ?? []), 'cleanup'])],
      reason: 'Measurement gates passed, but required cleanup did not complete.',
    };
  }
  report.finishedAt = new Date().toISOString();
  if (cleanupError && !report.failure) report.failure = { name: 'CleanupError', message: cleanupError };
  try {
    writeReportAtomically();
  } catch (error) {
    report.status = 'failed';
    console.error(`Qualification report write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (report.status === 'failed') {
    process.exitCode = 1;
    console.error(JSON.stringify(report, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}
}
