#!/usr/bin/env node
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statfsSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const extensionRoot = path.resolve(import.meta.dirname, '..');
const outRoot = path.resolve(extensionRoot, 'out');
const workerScript = path.join(outRoot, 'analytics-recorder-worker.js');
const queryWorkerScript = path.join(outRoot, 'analytics-query-worker.js');
const { AnalyticsRecorderSupervisor, AnalyticsCaptureCapacityError } = await import(
  pathToFileURL(path.join(outRoot, 'analytics-recorder-supervisor.js')).href
);
const { SqliteAnalyticsRecorder } = await import(
  pathToFileURL(path.join(outRoot, 'analytics-sqlite-recorder.js')).href
);
const { AnalyticsQueryClient } = await import(
  pathToFileURL(path.join(outRoot, 'analytics-query-client.js')).href
);

const requestedRows = Number.parseInt(process.env.PIE_ANALYTICS_P0_ROWS ?? '10000', 10);
assert.ok(Number.isSafeInteger(requestedRows) && requestedRows >= 10_000, 'PIE_ANALYTICS_P0_ROWS must be an integer >= 10000');
const requestedDetail = Math.floor(requestedRows / 10);
const detailCounts = {
  '2KiB': Math.floor(requestedDetail * 0.95),
  '32KiB': Math.floor(requestedDetail * 0.049),
  '2MiB': requestedDetail - Math.floor(requestedDetail * 0.95) - Math.floor(requestedDetail * 0.049),
};
const matrix = Object.freeze({
  fixtureSeed: 'analytics-p0-v2',
  facts: { rows: requestedRows, producerHosts: [1, 2, 4], measuredHosts: 4, modelsProviders: 12 },
  detail: { total: requestedDetail, sizes: detailCounts, nestedDepth: 2 },
  load: [`${requestedRows} finite burst`, 'four concurrent producer helpers'],
  reads: ['single-session indexed count', 'all-history provider projection x10', 'small/2MiB detail reconstruction'],
  lifecycle: ['clean helper restart x3', 'private delete racing late detail from another helper'],
  bounds: { minUnusedDiskBytes: 20 * 1024 ** 3, maxTemporaryBytes: 16 * 1024 ** 3, maxQueueBytes: 64 * 1024 ** 2 },
  intentionallyNotClaimed: [
    ...(requestedRows < 1_000_000 ? ['1M rows'] : []),
    ...(requestedRows < 10_000_000 ? ['10M rows'] : []),
    'five-minute light load unless PIE_ANALYTICS_P0_ENDURANCE=1',
    'live VS Code UI baseline (no live runtime is activated or disrupted)',
  ],
});

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(values) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: Math.max(...values),
  };
}

function observation(i, host, sourceSequence = Math.floor(i / 4) + 1) {
  const sourceKey = `host-${host}-fact-${i}`;
  const generationId = 'qualification-generation';
  const rootSessionId = `root-${Math.floor(i / 625)}`;
  const variant = i % 4;
  const entityKind = variant === 0 ? 'providerCall' : variant === 1 ? 'toolCall' : variant === 2 ? 'activitySpan' : 'featureObservation';
  const entityKey = variant === 0 ? `invocation-${i}` : variant === 1 ? `tool-${i}` : variant === 2 ? `span-${i}` : `feature-${i}`;
  const observationKind = variant === 0 ? 'providerSettlement' : variant === 3 ? 'observation' : 'end';
  const fields = variant === 0 ? {
    invocationId: `invocation-${i}`,
    provider: `provider-${i % 3}`,
    model: `model-${i % 12}`,
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
    stableOriginId: `qualification-origin-${host}`,
    sourceKey,
    sourceSequence: String(sourceSequence),
    entityKind,
    entityKey,
    observationKind,
    observedAtMs: 1_780_000_000_000 + i,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: `workspace-${i % 4}`,
      rootSessionId,
      ...(variant === 0 ? { invocationId: entityKey } : variant === 1 ? { toolCallId: entityKey } : {}),
    },
    captureSubject: { kind: 'session', rootSessionId },
    producer: { buildId: 'qualification-build', processGeneration: `host-${host}` },
    fields,
    idempotencyKey: JSON.stringify([generationId, observationKind, sourceKey]),
  };
}

function detailCapture(payloadId, rootSessionId, byteLength, valueOverride) {
  const prefix = `${payloadId}:`;
  const body = valueOverride ?? `${prefix}${'d'.repeat(Math.max(0, byteLength - prefix.length))}`;
  const value = typeof body === 'string'
    ? { messages: [{ role: 'assistant', content: [{ type: 'text', text: body }] }] }
    : body;
  return {
    schemaVersion: 1,
    generationId: 'qualification-generation',
    stableOriginId: `qualification-detail:${rootSessionId}`,
    payloadId,
    sourceKey: payloadId,
    observedAtMs: 1_780_100_000_000,
    captureSubject: { kind: 'session', rootSessionId },
    mediaType: 'application/x-pie-subagent-result',
    encoding: 'node-v8',
    complete: true,
    bytes: serialize(value),
    metadata: { childId: payloadId },
  };
}

function supervisor(databasePath, extra = {}) {
  return new AnalyticsRecorderSupervisor({
    enabled: true,
    workerScript,
    databasePath,
    maxBatchSize: 250,
    maxQueueRecords: 20_000,
    maxQueueBytes: matrix.bounds.maxQueueBytes,
    ...extra,
  });
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
  const rateDatabasePath = path.join(parentRoot, `${label}.sqlite`);
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
  await Promise.all(hosts.map((host) => host.shutdown()));
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

function databaseBytes(databasePath) {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { total += statSync(databasePath + suffix).size; } catch { /* optional SQLite sidecar */ }
  }
  return total;
}

const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-p0-qualification-'));
const databasePath = path.join(root, 'analytics.sqlite');
const fsStats = statfsSync(root, { bigint: true });
const initialFreeBytes = Number(fsStats.bavail * fsStats.bsize);
assert.ok(initialFreeBytes - matrix.bounds.minUnusedDiskBytes > 64 * 1024 ** 2, 'insufficient free disk for bounded qualification');

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  matrix,
  environment: {
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    initialFreeBytes,
    sqlite: 'node:sqlite bundled with Node',
  },
  results: {},
  cleanup: false,
};

try {
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

  // Deliberately delayed recorder acknowledgement: submission and simulated
  // agent completion must finish independently of the 300ms recorder delay.
  const delayed = supervisor(databasePath, { rehearsalAcknowledgementDelayMs: 300 });
  await delayed.start();
  const delayedCapture = detailCapture('delayed-2mib', 'root-delay', 2 * 1024 ** 2);
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
  await delayed.shutdown();

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
  await restarting.shutdown();
  report.results.helperRestart = summarize(restartDurationsMs);

  // Terminate a helper while facts and a nested rich result are awaiting a
  // deliberately delayed acknowledgement. The supervisor retains owned bytes
  // and replays stable identities after explicit failover replacement.
  const failoverDatabasePath = path.join(root, 'failover.sqlite');
  const failover = supervisor(failoverDatabasePath, { rehearsalAcknowledgementDelayMs: 500 });
  await failover.start();
  for (let index = 0; index < 250; index++) failover.submit(observation(50_000 + index, 0, index + 1));
  const failoverBody = { childId: 'failover-child', messages: [{ role: 'assistant', content: 'retained across cancellation' }] };
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
  await failover.shutdown();
  const failoverReader = new SqliteAnalyticsRecorder(failoverDatabasePath);
  assert.equal(failoverReader.countObservations(), 250);
  assert.equal(failoverReader.countDetails(), 1);
  assert.equal(failoverReader.reconstructDetail('failover-nested').messages[0].details.results[0].messages[0].content, 'retained across cancellation');
  failoverReader.close();
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

  const factCommitLatencies = [];
  const hosts = Array.from({ length: 4 }, () => supervisor(databasePath, {
    onDeliveryAcknowledged: (measurement) => factCommitLatencies.push(...measurement.latencyMs),
  }));
  await Promise.all(hosts.map((host) => host.start()));
  const factSubmitDurations = [];
  const eventLoopLagMs = [];
  let nextLagSampleAt = performance.now() + 10;
  const lagTimer = setInterval(() => {
    const now = performance.now();
    eventLoopLagMs.push(Math.max(0, now - nextLagSampleAt));
    nextLagSampleAt = now + 10;
  }, 10);
  const producerCpuBefore = process.cpuUsage();
  const activeStartedAt = performance.now();
  const producerRssBefore = process.memoryUsage().rss;
  let producerRssPeak = producerRssBefore;
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
    }
  }
  const factsFlushStarted = performance.now();
  await Promise.all(hosts.map((host) => host.flush()));
  const factsFlushMs = performance.now() - factsFlushStarted;
  const workerStats = await Promise.all(hosts.map((host) => host.workerStats()));
  clearInterval(lagTimer);
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
  };
  await Promise.all(hosts.map((host) => host.shutdown()));

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
  const detailPlan = [
    ...Array.from({ length: detailCounts['2KiB'] }, () => ['2KiB', 2 * 1024]),
    ...Array.from({ length: detailCounts['32KiB'] }, () => ['32KiB', 32 * 1024]),
    ...Array.from({ length: detailCounts['2MiB'] }, () => ['2MiB', 2 * 1024 ** 2]),
  ];
  for (let i = 0; i < detailPlan.length; i++) {
    const [label, size] = detailPlan[i];
    const started = performance.now();
    const capture = detailCapture(`detail-${i}`, `detail-root-${i % 8}`, size);
    detailHost.submitDetail(capture);
    handoffDurationsBySize[label].push(performance.now() - started);
    if (i % 20 === 19) await new Promise((resolve) => setImmediate(resolve));
  }

  const sharedBody = 'shared-child-body '.repeat(65_536);
  const childValue = { childId: 'shared-child', messages: [{ role: 'assistant', content: sharedBody }] };
  const parentValue = {
    childId: 'parent',
    messages: [{ role: 'toolResult', details: { results: [childValue] } }],
  };
  detailHost.submitDetail(detailCapture('shared-child-payload', 'nested-root', 0, childValue));
  detailHost.submitDetail(detailCapture('shared-parent-payload', 'nested-root', 0, parentValue));
  const detailFlushStarted = performance.now();
  await detailHost.flush();
  const detailFlushMs = performance.now() - detailFlushStarted;
  const detailStats = await detailHost.workerStats();
  const peakDetailBacklog = detailHost.backlog;
  await detailHost.shutdown();
  report.results.detailHandoff = Object.fromEntries(
    Object.entries(handoffDurationsBySize).map(([label, values]) => [label, summarize(values)]),
  );
  report.results.detailObservationToCommitted = Object.fromEntries(
    Object.entries(detailCommitLatenciesBySize)
      .filter(([, values]) => values.length > 0)
      .map(([label, values]) => [label, summarize(values)]),
  );
  report.results.detailDrain = { flushMs: detailFlushMs, peakDetailBacklog, storage: detailStats.detailStorage };

  const reader = new SqliteAnalyticsRecorder(databasePath);
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
  const childReconstructed = reader.reconstructDetail('shared-child-payload');
  const parentReconstructed = reader.reconstructDetail('shared-parent-payload');
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
  assert.equal(reader.countObservations('root-3'), 625);
  const indexedMs = performance.now() - indexedStarted;
  const largeDetailStarted = performance.now();
  const largeDetail = reader.reconstructDetail(`detail-${detailPlan.length - 1}`);
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
  reader.close();

  const queryClient = new AnalyticsQueryClient({
    databasePath,
    workerScript: queryWorkerScript,
    timeoutMs: 10_000,
  });
  const boundedQuery = await queryClient.query({ type: 'providerSettlements' });
  assert.equal(boundedQuery.settlements.length, Math.min(200, Math.ceil(matrix.facts.rows / 4)));
  await assert.rejects(
    queryClient.query({ type: 'providerSettlements', maxResultBytes: 1 }),
    /exceeds 1 bytes/,
  );
  const defaultDetailRange = await queryClient.query({
    type: 'detail', payloadId: `detail-${detailPlan.length - 1}`,
  });
  assert.equal(defaultDetailRange.bytes.byteLength, 64 * 1024);
  assert.equal(defaultDetailRange.truncated, true);
  const detailParts = [];
  let detailOffset = 0;
  do {
    const part = await queryClient.query({
      type: 'detail',
      payloadId: `detail-${detailPlan.length - 1}`,
      offset: detailOffset,
      maxBytes: 512 * 1024,
      maxResultBytes: 640 * 1024,
    });
    detailParts.push(Buffer.from(part.bytes));
    detailOffset = part.nextOffset;
  } while (detailOffset !== null);
  const explicitLargeDetail = deserialize(Buffer.concat(detailParts));
  assert.equal(explicitLargeDetail.messages[0].content[0].text.length, 2 * 1024 ** 2);
  const schemaDescription = await queryClient.query({ type: 'schema' });
  assert.equal(schemaDescription.databaseSchemaVersion, 3);
  const logicalQuery = await queryClient.query({
    type: 'query',
    sql: 'SELECT COUNT(*) AS count FROM analytics_provider_usage_v1',
  });
  assert.equal(logicalQuery.rows[0].count, Math.ceil(matrix.facts.rows / 4));
  await assert.rejects(
    queryClient.query({ type: 'query', sql: 'DELETE FROM analytics_observations' }),
    /not authorized/,
  );
  const storageQuery = await queryClient.query({ type: 'storage' });
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
  refreshObservation.scope.rootSessionId = 'cross-host-refresh-root';
  refreshObservation.captureSubject.rootSessionId = 'cross-host-refresh-root';
  const refreshStarted = performance.now();
  refreshWriter.submit(refreshObservation);
  await refreshWriter.flush();
  const refreshVisible = await queryClient.query({ type: 'providerSettlements', rootSessionId: 'cross-host-refresh-root' });
  const crossHostCommitVisibleMs = performance.now() - refreshStarted;
  assert.equal(refreshVisible.settlements.length, 1);
  const deleteStarted = performance.now();
  await refreshWriter.deleteSession('cross-host-refresh-root', 'cross-host-delete', 1_780_300_000_000);
  const refreshDeleted = await queryClient.query({ type: 'providerSettlements', rootSessionId: 'cross-host-refresh-root' });
  const crossHostDeleteVisibleMs = performance.now() - deleteStarted;
  assert.equal(refreshDeleted.settlements.length, 0);
  await refreshWriter.shutdown();
  report.results.crossHostRefresh = { crossHostCommitVisibleMs, crossHostDeleteVisibleMs, replayedHistory: false };

  // Queue overflow is visible and bounded, not silently dropped or converted
  // into a production outage policy.
  const bounded = supervisor(databasePath, { maxQueueBytes: 1 * 1024 ** 2, rehearsalAcknowledgementDelayMs: 300 });
  await bounded.start();
  assert.throws(() => bounded.submitDetail(detailCapture('overflow', 'overflow-root', 2 * 1024 ** 2)), AnalyticsCaptureCapacityError);
  report.results.capacity = bounded.backlog;
  await bounded.shutdown();

  // Race the recorder-owned deletion marker against a late detail in another
  // helper. Either ordering is valid; the final state must be absent and the
  // late writer must be scrubbed or explicitly rejected.
  const privacySentinel = 'PIE-PRIVATE-QUALIFICATION-SENTINEL-fdf9c37e';
  const deletionWriter = supervisor(databasePath);
  const lateWriter = supervisor(databasePath);
  await Promise.all([deletionWriter.start(), lateWriter.start()]);
  const initialPrivateFact = observation(20_000, 0);
  initialPrivateFact.fields.privateQualificationValue = privacySentinel;
  initialPrivateFact.scope.rootSessionId = 'private-race-root';
  initialPrivateFact.captureSubject.rootSessionId = 'private-race-root';
  deletionWriter.submit(initialPrivateFact);
  deletionWriter.submitDetail(detailCapture(
    'private-initial',
    'private-race-root',
    32 * 1024,
    { privateQualificationValue: privacySentinel, body: privacySentinel.repeat(128) },
  ));
  await deletionWriter.flush();
  const raceResults = await Promise.allSettled([
    deletionWriter.deleteSession('private-race-root', 'private-close', 1_780_200_000_000),
    (async () => {
      const lateFact = observation(20_001, 1);
      lateFact.scope.rootSessionId = 'private-race-root';
      lateFact.captureSubject.rootSessionId = 'private-race-root';
      lateWriter.submit(lateFact);
      lateWriter.submitDetail(detailCapture('private-late', 'private-race-root', 32 * 1024));
      await lateWriter.flush();
    })(),
  ]);
  assert.ok(lateWriter.backlog.deliveryFailures >= 1, 'late private delivery rejection must be visible');
  const lateDeliveryError = lateWriter.lastDeliveryError?.message;
  const unrelatedAfterDelete = observation(30_000, 1);
  unrelatedAfterDelete.scope.rootSessionId = 'unrelated-after-private-delete';
  unrelatedAfterDelete.captureSubject.rootSessionId = 'unrelated-after-private-delete';
  lateWriter.submit(unrelatedAfterDelete);
  await lateWriter.flush();
  await Promise.allSettled([deletionWriter.shutdown(), lateWriter.shutdown()]);
  const privacyRecovery = new SqliteAnalyticsRecorder(databasePath);
  const privacyScrubRecovery = privacyRecovery.resumePendingPrivacyScrubs(16);
  privacyRecovery.close();
  assert.equal(privacyScrubRecovery.pending.length, 0);
  const privacyReader = new SqliteAnalyticsRecorder(databasePath);
  assert.equal(privacyReader.countDetails('private-race-root'), 0);
  assert.equal(privacyReader.countObservations('private-race-root'), 0);
  assert.equal(privacyReader.countObservations('unrelated-after-private-delete'), 1);
  const privacyAccounting = privacyReader.readDeliveryAccounting();
  privacyReader.close();
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

  report.results.rateConditions = [
    await runRateCondition(root, 'burst-1000ps-1host', 1_000, 5_000, 1),
    await runRateCondition(root, 'burst-1000ps-2hosts', 1_000, 5_000, 2),
    await runRateCondition(root, 'burst-1000ps-4hosts', 1_000, 5_000, 4),
  ];
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
    await idleHost.shutdown();
  }

  const corruptionPath = path.join(root, 'corrupt.sqlite');
  copyFileSync(databasePath, corruptionPath);
  truncateSync(corruptionPath, 100);
  let corruptionError;
  try {
    new SqliteAnalyticsRecorder(corruptionPath).close();
  } catch (error) {
    corruptionError = error instanceof Error ? error.message : String(error);
  }
  assert.ok(corruptionError, 'truncated database must fail visibly');
  report.results.corruption = { truncatedToBytes: 100, visibleError: corruptionError };

  report.results.physicalBytes = databaseBytes(databasePath);
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
  assert.ok(report.results.physicalBytes < matrix.bounds.maxTemporaryBytes);
  assert.ok(initialFreeBytes - report.results.physicalBytes >= matrix.bounds.minUnusedDiskBytes);
  report.cleanup = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    console.error(`Qualification cleanup failed for ${root}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
