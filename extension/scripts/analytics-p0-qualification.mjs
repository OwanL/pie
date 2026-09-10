#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statfsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serialize } from 'node:v8';
import { performance } from 'node:perf_hooks';

const extensionRoot = path.resolve(import.meta.dirname, '..');
const outRoot = path.resolve(extensionRoot, 'out');
const workerScript = path.join(outRoot, 'analytics-recorder-worker.js');
const { AnalyticsRecorderSupervisor, AnalyticsCaptureCapacityError } = await import(
  pathToFileURL(path.join(outRoot, 'analytics-recorder-supervisor.js')).href
);
const { SqliteAnalyticsRecorder } = await import(
  pathToFileURL(path.join(outRoot, 'analytics-sqlite-recorder.js')).href
);

const matrix = Object.freeze({
  fixtureSeed: 'analytics-p0-v1',
  facts: { rows: 10_000, producerHosts: [1, 2, 4], measuredHosts: 4, modelsProviders: 12 },
  detail: { total: 1_000, sizes: { '2KiB': 950, '32KiB': 49, '2MiB': 1 }, nestedDepth: 2 },
  load: ['10k finite burst', 'four concurrent producer helpers'],
  reads: ['single-session indexed count', 'all-history provider projection x10', 'small/2MiB detail reconstruction'],
  lifecycle: ['clean helper restart x3', 'private delete racing late detail from another helper'],
  bounds: { minUnusedDiskBytes: 20 * 1024 ** 3, maxTemporaryBytes: 16 * 1024 ** 3, maxQueueBytes: 64 * 1024 ** 2 },
  intentionallyNotClaimed: ['1M rows', '10M rows', '10k-sample sustained 50 fact/s', 'five-minute light load', 'UI baseline', 'query cancellation'],
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

function observation(i, host) {
  const sourceKey = `host-${host}-fact-${i}`;
  const observationKind = 'providerSettlement';
  const generationId = 'qualification-generation';
  const rootSessionId = `root-${Math.floor(i / 625)}`;
  return {
    schemaVersion: 1,
    generationId,
    producerKind: i % 4 === 0 ? 'tool' : i % 4 === 1 ? 'provider' : i % 4 === 2 ? 'span' : 'capability',
    sourceKey,
    entityKind: 'providerCall',
    entityKey: `invocation-${i}`,
    observationKind,
    observedAtMs: 1_780_000_000_000 + i,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: `workspace-${i % 4}`,
      rootSessionId,
      invocationId: `invocation-${i}`,
    },
    captureSubject: { kind: 'session', rootSessionId },
    producer: { buildId: 'qualification-build', processGeneration: `host-${host}` },
    fields: {
      invocationId: `invocation-${i}`,
      provider: `provider-${i % 3}`,
      model: `model-${i % 12}`,
      inputTokens: i % 17 === 0 ? null : 100 + i,
      outputTokens: i % 19 === 0 ? null : 20,
      reportedCostUsd: i % 23 === 0 ? null : 0.001,
      outcome: i % 29 === 0 ? 'failed' : 'success',
    },
    idempotencyKey: JSON.stringify([generationId, observationKind, sourceKey]),
  };
}

function detailCapture(payloadId, rootSessionId, byteLength, valueOverride) {
  const body = valueOverride ?? 'd'.repeat(byteLength);
  const value = typeof body === 'string'
    ? { messages: [{ role: 'assistant', content: [{ type: 'text', text: body }] }] }
    : body;
  return {
    schemaVersion: 1,
    generationId: 'qualification-generation',
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
  const disabled = new AnalyticsRecorderSupervisor({
    enabled: false,
    workerScript,
    databasePath,
  });
  await disabled.start();
  disabled.submitDetail(detailCapture('disabled-capture', 'disabled-root', 2 * 1024));
  assert.equal(disabled.workerPid, undefined);
  report.results.disabledIngress = { enabled: disabled.enabled, workerStarted: false, backlog: disabled.backlog };

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

  const hosts = Array.from({ length: 4 }, () => supervisor(databasePath));
  await Promise.all(hosts.map((host) => host.start()));
  const factSubmitDurations = [];
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
  }
  const factsFlushStarted = performance.now();
  await Promise.all(hosts.map((host) => host.flush()));
  const factsFlushMs = performance.now() - factsFlushStarted;
  const workerStats = await Promise.all(hosts.map((host) => host.workerStats()));
  report.results.factHandoff = summarize(factSubmitDurations);
  report.results.factDrain = {
    rows: matrix.facts.rows,
    flushMs: factsFlushMs,
    rowsPerSecond: matrix.facts.rows / (factsFlushMs / 1_000),
    backlog: hosts.map((host) => host.backlog),
  };
  report.results.memory = {
    producerRssBefore,
    producerRssPeak,
    producerRssGrowthBytes: producerRssPeak - producerRssBefore,
    workerRssBytes: workerStats.map((entry) => entry.process.rss),
    totalWorkerRssBytes: workerStats.reduce((sum, entry) => sum + entry.process.rss, 0),
  };
  await Promise.all(hosts.map((host) => host.shutdown()));

  const detailHost = supervisor(databasePath);
  await detailHost.start();
  const handoffDurationsBySize = { '2KiB': [], '32KiB': [], '2MiB': [] };
  const detailPlan = [
    ...Array.from({ length: 950 }, () => ['2KiB', 2 * 1024]),
    ...Array.from({ length: 49 }, () => ['32KiB', 32 * 1024]),
    ['2MiB', 2 * 1024 ** 2],
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
  report.results.detailDrain = { flushMs: detailFlushMs, peakDetailBacklog, storage: detailStats.detailStorage };

  const reader = new SqliteAnalyticsRecorder(databasePath);
  assert.equal(reader.countObservations(), matrix.facts.rows);
  assert.equal(reader.countDetails(), matrix.detail.total + 3); // delayed + 1,000 mix + nested pair
  const childReconstructed = reader.reconstructDetail('shared-child-payload');
  const parentReconstructed = reader.reconstructDetail('shared-parent-payload');
  assert.equal(childReconstructed.messages[0].content, sharedBody);
  assert.equal(parentReconstructed.messages[0].details.results[0].messages[0].content, sharedBody);
  assert.ok(reader.detailStorageStats().storedContentBytes < reader.detailStorageStats().logicalBytes);
  const queryDurations = [];
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    assert.equal(reader.projectProviderUsage().length, matrix.facts.rows);
    queryDurations.push(performance.now() - started);
  }
  const indexedStarted = performance.now();
  assert.equal(reader.countObservations('root-3'), 625);
  const indexedMs = performance.now() - indexedStarted;
  const largeDetailStarted = performance.now();
  const largeDetail = reader.reconstructDetail('detail-999');
  const largeDetailMs = performance.now() - largeDetailStarted;
  assert.equal(largeDetail.messages[0].content[0].text.length, 2 * 1024 ** 2);
  report.results.queries = { allHistoryProjection: summarize(queryDurations), indexedSessionMs: indexedMs, twoMiBDetailMs: largeDetailMs };
  reader.close();

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
  const deletionWriter = supervisor(databasePath);
  const lateWriter = supervisor(databasePath);
  await Promise.all([deletionWriter.start(), lateWriter.start()]);
  const initialPrivateFact = observation(20_000, 0);
  initialPrivateFact.scope.rootSessionId = 'private-race-root';
  initialPrivateFact.captureSubject.rootSessionId = 'private-race-root';
  deletionWriter.submit(initialPrivateFact);
  deletionWriter.submitDetail(detailCapture('private-initial', 'private-race-root', 32 * 1024));
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
  const privacyReader = new SqliteAnalyticsRecorder(databasePath);
  assert.equal(privacyReader.countDetails('private-race-root'), 0);
  assert.equal(privacyReader.countObservations('private-race-root'), 0);
  assert.equal(privacyReader.countObservations('unrelated-after-private-delete'), 1);
  privacyReader.close();
  report.results.privateDeleteRace = {
    outcomes: raceResults.map((result) => result.status),
    lateDeliveryFailures: lateWriter.backlog.deliveryFailures,
    lateDeliveryError,
    finalFactCount: 0,
    finalDetailCount: 0,
  };

  report.results.physicalBytes = databaseBytes(databasePath);
  assert.ok(report.results.physicalBytes < matrix.bounds.maxTemporaryBytes);
  assert.ok(initialFreeBytes - report.results.physicalBytes >= matrix.bounds.minUnusedDiskBytes);
  report.cleanup = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
