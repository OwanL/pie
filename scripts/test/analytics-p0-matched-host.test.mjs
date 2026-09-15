import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildOverallQualificationReport, computeQualificationSourceFingerprint } from '../../extension/scripts/analytics-p0-overall-qualification.mjs';
import {
  HARNESS_VERSION,
  MATCHED_HOST_HARNESS_FILE,
  MATCHED_HOST_PORTS,
  MATCHED_HOST_RESOURCE_GUARDS,
  MATCHED_HOST_THRESHOLDS,
  REPORT_KIND,
  REPORT_SCHEMA_VERSION,
  collectArtifactProvenance,
  evaluateMatchedHostGates,
  summarizeMatchedTelemetry,
  validateArmReceipt,
  validateMatchedHostEnvelope,
} from '../../extension/scripts/analytics-p0-matched-host.mjs';
import { collectArtifactProvenance as collectSchemaFaultsProvenance } from '../../extension/scripts/analytics-p0-schema-faults.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const producers = {
  qualification: path.join(repositoryRoot, 'extension', 'scripts', 'analytics-p0-qualification.mjs'),
  schemaFaults: path.join(repositoryRoot, 'extension', 'scripts', 'analytics-p0-schema-faults.mjs'),
  matchedHost: path.join(repositoryRoot, 'extension', 'scripts', 'analytics-p0-matched-host.mjs'),
};

/** Extract the frozen common-source-manifest entries from each producer's
 * source so the coordinated-manifest invariant is asserted against the real
 * files rather than a copy. */
function readSourceManifestEntries(file) {
  const source = readFileSync(file, 'utf8');
  const marker = file === producers.qualification
    ? source.indexOf('const ownedFiles = [')
    : source.indexOf('const COMMON_SOURCE_FILES = Object.freeze([');
  assert.ok(marker >= 0, `source manifest list marker is missing in ${path.basename(file)}`);
  let depth = 0;
  let end = -1;
  for (let index = source.indexOf('[', marker); index < source.length; index += 1) {
    const character = source[index];
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) { end = index; break; }
    }
  }
  assert.ok(end > marker, `source manifest list end not found in ${path.basename(file)}`);
  const block = source.slice(marker, end + 1);
  return [...block.matchAll(/\[\s*'([^']+)'\s*,/gu)].map((match) => match[1]).sort();
}

test('every P0 producer binds the same coordinated source manifest', () => {
  const manifests = Object.fromEntries(Object.entries(producers)
    .map(([name, file]) => [name, readSourceManifestEntries(file)]));
  const qualification = manifests.qualification;
  for (const [name, entries] of Object.entries(manifests)) {
    assert.deepEqual(manifests[name], qualification, `${name} source manifest must match the qualification producer`);
  }
  assert.ok(qualification.includes('extension/scripts/analytics-p0-matched-host.mjs'),
    'the matched-host authoritative producer must be in the common manifest');
  assert.equal(qualification.length, 21);
});

test('matched-host and schema-faults provenance share one fingerprint', () => {
  const matchedHost = collectArtifactProvenance();
  const schemaFaults = collectSchemaFaultsProvenance();
  assert.equal(matchedHost.valid, true, `matched-host provenance: ${matchedHost.errors.join('; ')}`);
  assert.equal(schemaFaults.valid, true, `schema-faults provenance: ${schemaFaults.errors.join('; ')}`);
  assert.equal(matchedHost.fingerprint, schemaFaults.fingerprint);
  assert.equal(matchedHost.gitHead, schemaFaults.gitHead);
  assert.equal(matchedHost.coordinatedBuildId, schemaFaults.coordinatedBuildId);
  assert.equal(matchedHost.coordinatedBuildId, matchedHost.hostBuildId);
  assert.equal(matchedHost.rendererBuildId, matchedHost.hostBuildId);
  assert.equal(matchedHost.files[MATCHED_HOST_HARNESS_FILE[0]].sha256, matchedHost.scenarioHarness.sha256);
});

function passingMatchedHostValue(overrides = {}) {
  const base = {
    sampleCount: MATCHED_HOST_THRESHOLDS.minMatchedSampleCount,
    agentTurnaroundP95Ms: 1_000,
    cancellationP95Ms: 500,
    failoverP95Ms: 2_000,
    uiInteractionP95Ms: 300,
    streamPaintP95Ms: 200,
    activeCaptureCpuOneCorePercent: 5,
  };
  return {
    disabled: { ...base, sampleCount: MATCHED_HOST_THRESHOLDS.minMatchedSampleCount },
    enabled: {
      ...base,
      sampleCount: MATCHED_HOST_THRESHOLDS.minMatchedSampleCount,
      localSummaryFreshnessP95Ms: 200,
      localSummaryFreshnessP99Ms: 400,
      crossHostSummaryFreshnessMs: 800,
      idleAnalyticsCpuOneCorePercent: 0.3,
      incrementalRetainedHostBytes: 8 * 1024 * 1024,
    },
    sameWorkload: true,
    sameHostBuildConfig: true,
    nativeTelemetryComplete: true,
    ...overrides,
  };
}

test('matched-host gates pass on a qualifying paired measurement', () => {
  const gates = evaluateMatchedHostGates(passingMatchedHostValue());
  assert.equal(gates.passed, true);
  assert.deepEqual(gates.failedGates, []);
});

test('matched-host gates fail closed on every violated predicate', () => {
  const cases = [
    ['low sample count', (value) => { value.disabled.sampleCount = MATCHED_HOST_THRESHOLDS.minMatchedSampleCount - 1; }],
    ['sample count mismatch', (value) => { value.enabled.sampleCount = value.disabled.sampleCount + 1; }],
    ['turnaround regression', (value) => { value.enabled.agentTurnaroundP95Ms = value.disabled.agentTurnaroundP95Ms + 1; }],
    ['stream paint regression', (value) => { value.enabled.streamPaintP95Ms = value.disabled.streamPaintP95Ms + 1; }],
    ['local freshness over budget', (value) => { value.enabled.localSummaryFreshnessP95Ms = MATCHED_HOST_THRESHOLDS.localSummaryFreshnessP95Ms + 1; }],
    ['cross-host freshness over budget', (value) => { value.enabled.crossHostSummaryFreshnessMs = MATCHED_HOST_THRESHOLDS.crossHostSummaryFreshnessMs + 1; }],
    ['idle analytics CPU over budget', (value) => { value.enabled.idleAnalyticsCpuOneCorePercent = MATCHED_HOST_THRESHOLDS.idleAnalyticsCpuOneCorePercent + 0.1; }],
    ['active capture CPU delta over budget', (value) => { value.enabled.activeCaptureCpuOneCorePercent = value.disabled.activeCaptureCpuOneCorePercent + MATCHED_HOST_THRESHOLDS.activeCaptureCpuDeltaOneCorePercent + 1; }],
    ['workload not identical', (value) => { value.sameWorkload = false; }],
    ['host build config not identical', (value) => { value.sameHostBuildConfig = false; }],
  ];
  for (const [label, mutate] of cases) {
    const value = passingMatchedHostValue();
    mutate(value);
    const gates = evaluateMatchedHostGates(value);
    assert.equal(gates.passed, false, `${label} must fail the gates`);
    assert.deepEqual(gates.failedGates, ['matchedAgentUi'], `${label} must fail matchedAgentUi`);
  }
  const memoryValue = passingMatchedHostValue();
  memoryValue.enabled.incrementalRetainedHostBytes = MATCHED_HOST_THRESHOLDS.incrementalRetainedHostBytes + 1;
  assert.deepEqual(evaluateMatchedHostGates(memoryValue).failedGates, ['incrementalHostMemory']);

  const telemetryValue = passingMatchedHostValue();
  telemetryValue.nativeTelemetryComplete = false;
  assert.deepEqual(evaluateMatchedHostGates(telemetryValue).failedGates, ['nativeTelemetry']);
});

function syntheticProvenance() {
  const files = {
    'extension/out/analytics-recorder-worker.js': { sha256: 'b'.repeat(64), bytes: 123 },
    'extension/scripts/analytics-p0-matched-host.mjs': { sha256: 'd'.repeat(64), bytes: 789 },
  };
  const bindings = {
    gitHead: 'a'.repeat(40),
    hostBuildId: 'envelope-test-build',
    rendererBuildId: 'envelope-test-build',
    files,
  };
  return {
    valid: true,
    gitHead: bindings.gitHead,
    hostBuildId: bindings.hostBuildId,
    rendererBuildId: bindings.rendererBuildId,
    coordinatedBuildId: bindings.hostBuildId,
    fingerprint: computeQualificationSourceFingerprint(bindings),
    files,
    scenarioHarness: files['extension/scripts/analytics-p0-matched-host.mjs'],
  };
}

function syntheticReport(provenance, matchedHost) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: REPORT_KIND,
    harnessVersion: HARNESS_VERSION,
    status: 'passed',
    configuration: { scenario: 'matched-host', rows: null, seed: 'envelope-test', reportPath: '/tmp/pie-matched-host-test.json' },
    provenance,
    results: { matchedHost },
    measurement: { completed: true },
    cleanup: { completed: true, rootCreated: true, rootRemoved: true, rootPath: 'C:\\temp\\pie-p0-matched-host-root' },
    qualification: { scenario: 'matched-host', decision: 'scenario-passed', failedGates: [], overallP0: 'unqualified' },
  };
}

test('component envelope accepts a clean synthetic report and rejects violations', () => {
  const provenance = syntheticProvenance();
  const report = syntheticReport(provenance, passingMatchedHostValue());
  assert.deepEqual(validateMatchedHostEnvelope(report), []);

  const incomplete = syntheticReport(provenance, passingMatchedHostValue());
  incomplete.measurement.completed = false;
  assert.ok(validateMatchedHostEnvelope(incomplete).includes('measurement is incomplete'));

  const wrongKind = syntheticReport(provenance, passingMatchedHostValue());
  wrongKind.kind = 'pie-p0-other-v1';
  assert.ok(validateMatchedHostEnvelope(wrongKind).some((error) => error.includes('kind')));

  const uncleanQualification = syntheticReport(provenance, passingMatchedHostValue());
  uncleanQualification.qualification.failedGates = ['matchedAgentUi'];
  assert.ok(validateMatchedHostEnvelope(uncleanQualification)
    .some((error) => error.includes('clean scenario-passed')));

  const missingReceipt = syntheticReport(provenance, passingMatchedHostValue());
  missingReceipt.provenance = { ...provenance, files: { 'extension/out/analytics-recorder-worker.js': provenance.files['extension/out/analytics-recorder-worker.js'] } };
  assert.ok(validateMatchedHostEnvelope(missingReceipt)
    .some((error) => error.includes('authoritative producer receipt')));

  const staleFingerprint = syntheticReport(provenance, passingMatchedHostValue());
  staleFingerprint.provenance = { ...provenance, fingerprint: 'f'.repeat(64) };
  assert.ok(validateMatchedHostEnvelope(staleFingerprint)
    .some((error) => error.includes('fingerprint')));
});

test('arm receipt validation fails closed on missing arm evidence', () => {
  const expected = {
    arm: 'disabled',
    buildId: 'arm-test-build',
    copiedTreeSha256: 'tree-hash',
    sampleCountPerScenario: 12,
    scenarios: ['turnaround'],
    idleWindowMs: 60_000,
    telemetryIntervalMs: 1_000,
  };
  const samples = { turnaround: Array.from({ length: 12 }, () => ({})) };
  const passing = {
    arm: 'disabled',
    status: 'passed',
    buildId: expected.buildId,
    rendererBuildId: expected.buildId,
    copiedTreeSha256: expected.copiedTreeSha256,
    driver: { evidence: { status: 'passed', samples } },
    idle: { windowMs: expected.idleWindowMs - 1_000, sampleCount: 58, cpuOneCorePercentMean: 1, rssMedianBytes: 1024 },
    processes: { verifiedGone: true },
    analytics: { canonicalDatabasePresent: false, loadedGenerationReceiptPresent: false },
  };
  assert.deepEqual(validateArmReceipt(passing, expected), []);

  const disabledWithDatabase = { ...passing, analytics: { canonicalDatabasePresent: true, loadedGenerationReceiptPresent: false } };
  assert.ok(validateArmReceipt(disabledWithDatabase, expected).some((error) => error.includes('disabled arm unexpectedly created')));

  const missingIdle = { ...passing, idle: { windowMs: expected.idleWindowMs - 1_000, sampleCount: 10, cpuOneCorePercentMean: 1, rssMedianBytes: 1024 } };
  assert.ok(validateArmReceipt(missingIdle, expected).some((error) => error.includes('idle telemetry')));

  const shortIdleWindow = { ...passing, idle: { windowMs: expected.idleWindowMs - 3_000, sampleCount: 58, cpuOneCorePercentMean: 1, rssMedianBytes: 1024 } };
  assert.ok(validateArmReceipt(shortIdleWindow, expected).some((error) => error.includes('idle telemetry')));

  const enabledWithoutActivation = {
    ...passing,
    arm: 'enabled',
  };
  delete enabledWithoutActivation.activation;
  const enabledExpected = { ...expected, arm: 'enabled' };
  assert.ok(validateArmReceipt(enabledWithoutActivation, enabledExpected)
    .some((error) => error.includes('synthetic canonical activation')));

  const hostAlive = { ...passing, processes: { verifiedGone: false, remaining: [1234] } };
  assert.ok(validateArmReceipt(hostAlive, expected).some((error) => error.includes('verified gone')));
});

test('matched telemetry aggregation derives matched idle deltas and completeness', () => {
  const idle = (cpu, rss, samples = 60) => ({
    sampleCount: samples,
    cpuOneCorePercentMean: cpu,
    helperCpuOneCorePercentMean: cpu / 4,
    rssMedianBytes: rss,
  });
  const arms = {
    disabled: {
      idle: { sampleCount: 60, cpuOneCorePercentMean: 1.0, helperCpuOneCorePercentMean: null, rssMedianBytes: 4 * 1024 ** 3 },
      telemetry: { active: { sampleCount: 30, cpuOneCorePercentMean: 5.0 } },
    },
    enabled: {
      idle: { sampleCount: 60, cpuOneCorePercentMean: 1.5, helperCpuOneCorePercentMean: 0.3, rssMedianBytes: 4 * 1024 ** 3 + 8 * 1024 * 1024 },
      telemetry: { active: { sampleCount: 30, cpuOneCorePercentMean: 7.0 } },
    },
  };
  const dual = { telemetry: { producer: { sampleCount: 5 }, observer: { sampleCount: 5 } } };
  const telemetry = summarizeMatchedTelemetry({ arms, dual, idleMinimumSamples: 58, logicalCores: 16 });
  assert.equal(telemetry.idleAnalyticsCpuOneCorePercent, 0.5);
  assert.equal(telemetry.incrementalRetainedHostBytes, 8 * 1024 * 1024);
  assert.equal(telemetry.nativeTelemetryComplete, true);

  const clamped = summarizeMatchedTelemetry({
    arms: {
      disabled: { idle: { sampleCount: 60, cpuOneCorePercentMean: 2.0, rssMedianBytes: 1024 }, telemetry: { active: { sampleCount: 1, cpuOneCorePercentMean: 1 } } },
      enabled: { idle: { sampleCount: 60, cpuOneCorePercentMean: 1.5, rssMedianBytes: 512 }, telemetry: { active: { sampleCount: 1, cpuOneCorePercentMean: 1 } } },
    },
    dual,
    idleMinimumSamples: 58,
    logicalCores: 16,
  });
  assert.equal(clamped.idleAnalyticsCpuOneCorePercent, 0);
  assert.equal(clamped.incrementalRetainedHostBytes, 0);
  assert.equal(clamped.nativeTelemetryComplete, true);

  const incomplete = summarizeMatchedTelemetry({
    arms: {
      disabled: arms.disabled,
      enabled: { ...arms.enabled, idle: { ...arms.enabled.idle, sampleCount: 10 } },
    },
    dual,
    idleMinimumSamples: 58,
    logicalCores: 16,
  });
  assert.equal(incomplete.nativeTelemetryComplete, false);
});

test('resource guards are predeclared and honest', () => {
  assert.equal(MATCHED_HOST_RESOURCE_GUARDS.entryFreePhysicalBytes, 4 * 1024 ** 3);
  assert.ok(MATCHED_HOST_RESOURCE_GUARDS.dualHostFreePhysicalBytes > MATCHED_HOST_RESOURCE_GUARDS.singleHostFreePhysicalBytes);
  assert.equal(MATCHED_HOST_THRESHOLDS.minMatchedSampleCount, 10);
  assert.equal(Object.keys(MATCHED_HOST_PORTS).length, 4);
  assert.equal(new Set(Object.values(MATCHED_HOST_PORTS)).size, 4);
});

test('CLI argument validation refuses malformed runs without launching anything', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-p0-matched-host-cli-'));
  try {
    const producer = path.join(repositoryRoot, 'extension', 'scripts', 'analytics-p0-matched-host.mjs');
    const missing = spawnSync(process.execPath, [producer], { encoding: 'utf8', timeout: 30_000 });
    assert.notEqual(missing.status, 0);
    assert.ok(missing.stderr.includes('--seed is required'));

    const badSeed = spawnSync(process.execPath, [producer, '--seed', 'bad seed!', '--report', path.join(root, 'out.json')], { encoding: 'utf8', timeout: 30_000 });
    assert.notEqual(badSeed.status, 0);
    assert.ok(badSeed.stderr.includes('--seed is required'));

    const relativeReport = spawnSync(process.execPath, [producer, '--seed', 'cli-test', '--report', 'relative.json'], { encoding: 'utf8', timeout: 30_000, cwd: root });
    assert.notEqual(relativeReport.status, 0);
    assert.ok(relativeReport.stderr.includes('absolute'));

    const missingCode = spawnSync(process.execPath, [producer, '--seed', 'cli-test', '--report', path.join(root, 'out.json'), '--code-path', 'C:/definitely/missing/Code.exe'], { encoding: 'utf8', timeout: 30_000 });
    assert.notEqual(missingCode.status, 0);
    assert.ok(missingCode.stderr.includes('--code-path does not exist'));

    const unsupported = spawnSync(process.execPath, [producer, '--seed', 'cli-test', '--report', path.join(root, 'out.json'), '--rows', '5'], { encoding: 'utf8', timeout: 30_000 });
    assert.notEqual(unsupported.status, 0);
    assert.ok(unsupported.stderr.includes('Unsupported option'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('overall qualification accepts a matched-host component bound by the shared fingerprint', () => {
  const sourceFiles = {
    'extension/out/analytics-recorder-worker.js': Object.freeze({ sha256: 'b'.repeat(64), bytes: 123 }),
    'extension/scripts/analytics-p0-matched-host.mjs': Object.freeze({ sha256: 'd'.repeat(64), bytes: 789 }),
    'extension/scripts/analytics-p0-schema-faults.mjs': Object.freeze({ sha256: 'c'.repeat(64), bytes: 456 }),
  };
  const bindings = {
    gitHead: 'a'.repeat(40),
    hostBuildId: 'matched-aggregate-test-build',
    rendererBuildId: 'matched-aggregate-test-build',
    files: sourceFiles,
  };
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-p0-matched-host-overall-'));
  try {
    const provenance = {
      valid: true,
      gitHead: bindings.gitHead,
      hostBuildId: bindings.hostBuildId,
      rendererBuildId: bindings.rendererBuildId,
      coordinatedBuildId: bindings.hostBuildId,
      fingerprint: computeQualificationSourceFingerprint(bindings),
      files: sourceFiles,
    };
    const schemaPath = path.join(root, 'schema-faults.json');
    const schemaReport = syntheticReport(provenance, {});
    schemaReport.kind = 'pie-p0-schema-faults-v1';
    schemaReport.configuration.scenario = 'schema-faults';
    schemaReport.configuration.reportPath = schemaPath;
    schemaReport.results = { schemaFaults: { upgrade: {}, partialWrite: {}, corruption: {} } };
    const hostPath = path.join(root, 'matched-host.json');
    const hostReport = syntheticReport(provenance, passingMatchedHostValue());
    hostReport.configuration.reportPath = hostPath;
    writeFileSync(schemaPath, `${JSON.stringify(schemaReport, null, 2)}\n`, 'utf8');
    writeFileSync(hostPath, `${JSON.stringify(hostReport, null, 2)}\n`, 'utf8');

    const report = buildOverallQualificationReport({
      reportPath: path.join(root, 'overall.json'),
      seed: 'matched-aggregate-test',
      sourceHead: bindings.gitHead,
      buildId: bindings.hostBuildId,
      sourceFingerprint: provenance.fingerprint,
      evidenceReports: { schemaFaults: schemaPath, matchedHost: hostPath },
    });
    assert.equal(report.gates.matchedAgentUi.decision, 'passed');
    assert.equal(report.gates.incrementalHostMemory.decision, 'passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The workload driver's source is embedded in the harness as one template.
 * These assertions lock the real-run ordering and cleanup contracts against
 * the shipped file rather than a copy. */
function readHarnessSource() {
  return readFileSync(producers.matchedHost, 'utf8');
}

function readDriverSource() {
  const source = readHarnessSource();
  const start = source.indexOf('const DRIVER_SOURCE = ');
  const end = source.indexOf('// The cross-host observer driver needs a small plan extension');
  assert.ok(start >= 0 && end > start, 'driver source region markers are missing');
  return source.slice(start, end);
}

function driverFunctionBetween(driver, name, nextName) {
  const start = driver.indexOf(`async function ${name}`);
  const end = driver.indexOf(`async function ${nextName}`);
  assert.ok(start >= 0 && end > start, `driver function ${name} is missing`);
  return driver.slice(start, end);
}

test('workload driver opens a session before waiting for fixture model text', () => {
  const driver = readDriverSource();
  for (const [name, nextName] of [['runWorkload', 'runExtraTurn'], ['runExtraTurn', 'runCrossHostObserver']]) {
    const body = driverFunctionBetween(driver, name, nextName);
    const sessionClick = body.indexOf('await clickNewSession(page);');
    const modelWait = body.indexOf('await waitForFixtureModel(page);');
    assert.ok(sessionClick >= 0 && sessionClick < modelWait,
      `${name} must open a session before the fixture model wait`);
  }
  const helper = driverFunctionBetween(driver, 'waitForFixtureModel', 'runSample');
  assert.ok(helper.includes("'fixture model selection'"), 'the model wait helper must keep its bounded label');
});

test('launched hosts, samplers, and drivers are registered for emergency cleanup', () => {
  const source = readHarnessSource();
  const armBody = source.slice(
    source.indexOf('async function runRealFixtureArm'),
    source.indexOf('function readProviderStateFile'));
  assert.ok(armBody.includes('registerOwnedPid(rootPid);'),
    'the arm root pid must be registered before any later step can fail');
  assert.ok(armBody.includes('registerEmergencyStop(() => sampler.stop());'),
    'the arm sampler must be registered for emergency stop');
  assert.ok(armBody.includes('const lateRootPid = findCodeRootPid'),
    'a failed health wait must re-find and register the host by marker');
  assert.ok(armBody.includes('if (driverRun.pid) killTree(driverRun.pid);'),
    'the arm workload driver must be registered for emergency kill');

  const dualBody = source.slice(
    source.indexOf('async function runDualHostPhase'),
    source.indexOf('// ─── Telemetry aggregation'));
  assert.ok(dualBody.includes('registerOwnedPid(producerRootPid);')
    && dualBody.includes('registerOwnedPid(observerRootPid);'),
  'both dual-host roots must be registered for emergency cleanup');
  assert.ok(dualBody.includes('killTree(observerChild.pid);'),
    'the observer driver child must be registered for emergency kill');

  const sampler = source.slice(
    source.indexOf('function startTopologySampler'),
    source.indexOf('// ─── Telemetry math'));
  assert.ok(sampler.includes('`telemetry-sampler-${rootPid}.ps1`'),
    'sampler scripts must be unique per sampled tree');
  assert.ok(sampler.includes('stopRequested'), 'sampler stop must be idempotent');

  const orchestrator = source.slice(source.indexOf('async function runMatchedHostMeasurement'));
  assert.ok(orchestrator.includes('const emergencyStops = [];'),
    'the orchestrator must own the emergency-stop registry');
  assert.ok(orchestrator.includes('for (const stop of emergencyStops.splice(0))'),
    'the outer catch must run every registered emergency stop');
});