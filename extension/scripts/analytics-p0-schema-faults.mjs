#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serialize } from 'node:v8';

const extensionRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const outRoot = path.join(extensionRoot, 'out');
const queryWorkerScript = path.join(outRoot, 'analytics-query-worker.js');
const REPORT_SCHEMA_VERSION = 5;
const REPORT_KIND = 'pie-p0-schema-faults-v1';
const HARNESS_VERSION = 'p0-schema-faults-v1';

const { DatabaseSync } = createRequire(process.execPath)('node:sqlite');

function parseArguments(argv) {
  const options = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (seen.has(name)) throw new Error(`Duplicate option: ${name}`);
    seen.add(name);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    if (name === '--seed') options.seed = value;
    else if (name === '--report') options.report = value;
    else throw new Error(`Unsupported option: ${name}`);
  }
  if (typeof options.seed !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.seed)) {
    throw new Error('--seed is required and must use 1-128 letters, digits, dots, underscores, or hyphens');
  }
  if (typeof options.report !== 'string' || !path.isAbsolute(options.report)
    || !options.report.toLowerCase().endsWith('.json')) {
    throw new Error('--report must be an absolute new .json path');
  }
  options.report = path.resolve(options.report);
  if (existsSync(options.report)) throw new Error('--report must name a new file');
  return options;
}

/** This list intentionally matches analytics-p0-qualification.mjs and
 * analytics-p0-matched-host.mjs so every producer's report binds one candidate
 * with the same scenario-independent source fingerprint, including the
 * matched-host harness's own authoritative-producer entry. This scenario's
 * own source receipt is carried separately below. */
const COMMON_SOURCE_FILES = Object.freeze([
  ['extension/out/analytics-recorder-supervisor.js', path.join(outRoot, 'analytics-recorder-supervisor.js')],
  ['extension/out/analytics-sqlite-recorder.js', path.join(outRoot, 'analytics-sqlite-recorder.js')],
  ['extension/out/analytics-query-client.js', path.join(outRoot, 'analytics-query-client.js')],
  ['extension/out/analytics-recorder-worker.js', path.join(outRoot, 'analytics-recorder-worker.js')],
  ['extension/out/analytics-query-worker.js', queryWorkerScript],
  ['extension/src/analytics/sqlite-recorder.ts', path.join(extensionRoot, 'src', 'analytics', 'sqlite-recorder.ts')],
  ['extension/scripts/analytics-p0-qualification.mjs', path.join(extensionRoot, 'scripts', 'analytics-p0-qualification.mjs')],
  ['extension/scripts/analytics-p0-matched-host.mjs', path.join(extensionRoot, 'scripts', 'analytics-p0-matched-host.mjs')],
  ['extension/scripts/analytics-p0-overall-qualification.mjs', path.join(extensionRoot, 'scripts', 'analytics-p0-overall-qualification.mjs')],
  ['extension/scripts/analytics-p0-capacity.mjs', path.join(extensionRoot, 'scripts', 'analytics-p0-capacity.mjs')],
  ['extension/scripts/analytics-p0-endurance-validation.mjs', path.join(extensionRoot, 'scripts', 'analytics-p0-endurance-validation.mjs')],
  ['extension/scripts/analytics-p0-mixed-validation.mjs', path.join(extensionRoot, 'scripts', 'analytics-p0-mixed-validation.mjs')],
  ['extension/scripts/analytics-p0-schema-faults.mjs', path.join(extensionRoot, 'scripts', 'analytics-p0-schema-faults.mjs')],
  ['extension/scripts/windows-process-handle-collector.mjs', path.join(extensionRoot, 'scripts', 'windows-process-handle-collector.mjs')],
  ['extension/scripts/windows-process-handle-collector.ps1', path.join(extensionRoot, 'scripts', 'windows-process-handle-collector.ps1')],
  ['extension/scripts/analytics-real-producer-probe.ts', path.join(extensionRoot, 'scripts', 'analytics-real-producer-probe.ts')],
  ['extensions/subagent/src/analytics-capture.ts', path.join(repositoryRoot, 'extensions', 'subagent', 'src', 'analytics-capture.ts')],
  ['extensions/subagent/src/runtime-trace.ts', path.join(repositoryRoot, 'extensions', 'subagent', 'src', 'runtime-trace.ts')],
  ['extensions/subagent/types.ts', path.join(repositoryRoot, 'extensions', 'subagent', 'types.ts')],
  ['shared/analytics/contracts.ts', path.join(repositoryRoot, 'shared', 'analytics', 'contracts.ts')],
  ['shared/sensitive-redaction.ts', path.join(repositoryRoot, 'shared', 'sensitive-redaction.ts')],
]);

function fileReceipt(filePath) {
  const bytes = readFileSync(filePath);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: statSync(filePath).size };
}

export function collectArtifactProvenance() {
  const files = {};
  const errors = [];
  for (const [relativePath, filePath] of COMMON_SOURCE_FILES) {
    try {
      files[relativePath] = fileReceipt(filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      files[relativePath] = { error: message };
      errors.push(`${relativePath}: ${message}`);
    }
  }
  let gitHead = null;
  let hostBuildId = null;
  let rendererBuildId = null;
  try {
    gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: extensionRoot, encoding: 'utf8' }).trim();
  } catch {
    errors.push('source Git HEAD is unavailable');
  }
  try {
    hostBuildId = readFileSync(path.join(outRoot, 'pie-build-id.txt'), 'utf8').trim();
  } catch {
    errors.push('host build identity is missing');
  }
  try {
    rendererBuildId = readFileSync(path.join(outRoot, 'webview', 'panel', 'pie-build-id.txt'), 'utf8').trim();
  } catch {
    errors.push('renderer build identity is missing');
  }
  if (!/^[0-9a-f]{40}$/iu.test(gitHead ?? '')) errors.push('source Git HEAD is invalid');
  if (!hostBuildId) errors.push('host build identity is empty');
  if (!rendererBuildId) errors.push('renderer build identity is empty');
  if (hostBuildId && rendererBuildId && hostBuildId !== rendererBuildId) {
    errors.push(`host/renderer build identity mismatch (${hostBuildId} != ${rendererBuildId})`);
  }
  const fingerprintInput = {
    schemaVersion: 1,
    gitHead,
    hostBuildId,
    rendererBuildId,
    files: Object.fromEntries(Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, receipt]) => [name, receipt.sha256 ?? null])),
  };
  let scenarioHarness;
  try {
    scenarioHarness = fileReceipt(path.join(extensionRoot, 'scripts', 'analytics-p0-schema-faults.mjs'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scenarioHarness = { error: message };
    errors.push(`schema-faults scenario harness: ${message}`);
  }
  return {
    gitHead,
    hostBuildId,
    rendererBuildId,
    coordinatedBuildId: hostBuildId && hostBuildId === rendererBuildId ? hostBuildId : null,
    fingerprint: createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex'),
    valid: errors.length === 0,
    errors,
    files,
    scenarioHarness,
  };
}

function observation(seed, name, rootSessionId, options = {}) {
  const generationId = `${seed}-generation`;
  const sourceKey = `${seed}-${name}`;
  const invocationId = options.provider ? `${seed}-${name}-invocation` : undefined;
  const base = {
    schemaVersion: 1,
    generationId,
    producerKind: 'schema-fault-qualification',
    stableOriginId: `${seed}-${name}-origin`,
    sourceKey,
    sourceSequence: '1',
    entityKind: options.provider ? 'providerCall' : 'execution',
    entityKey: invocationId ?? sourceKey,
    observationKind: options.provider ? 'providerSettlement' : 'end',
    observedAtMs: 1_780_000_000_000,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: `${seed}-workspace`,
      rootSessionId,
      ...(invocationId ? { invocationId } : {}),
    },
    captureSubject: { kind: 'session', rootSessionId },
    producer: { buildId: `${seed}-fixture-build`, processGeneration: `${seed}-fixture-process` },
    fields: options.provider ? {
      invocationId,
      provider: 'schema-provider',
      dispatchedModel: 'schema-model',
      purpose: 'conversation',
      outcome: 'success',
      inputTokens: 17,
      outputTokens: 3,
      inputIncludesCache: false,
      outputIncludesReasoning: true,
      cacheChannelsOmittedAsZero: true,
      reportedCostUsd: 0.001,
    } : { outcome: 'success' },
  };
  return { ...base, idempotencyKey: JSON.stringify([generationId, base.observationKind, sourceKey]) };
}

function detail(seed, name, rootSessionId) {
  const payloadId = `${seed}-${name}`;
  return {
    schemaVersion: 1,
    generationId: `${seed}-generation`,
    stableOriginId: `${seed}-${name}-detail-origin`,
    payloadId,
    sourceKey: payloadId,
    observedAtMs: 1_780_000_000_001,
    captureSubject: { kind: 'session', rootSessionId },
    mediaType: 'application/x-pie-subagent-result',
    encoding: 'node-v8',
    complete: true,
    bytes: serialize({ retainedBy: name }),
    metadata: {},
  };
}

const V2_TABLES = Object.freeze([
  'analytics_observations',
  'analytics_detail_content',
  'analytics_detail_payloads',
  'analytics_detail_references',
  'analytics_deleted_subjects',
  'analytics_pending_subject_bindings',
  'analytics_projection_state',
  'analytics_provider_settlements',
  'analytics_provider_accounting_projections',
  'analytics_execution_observations',
  'analytics_execution_states',
  'analytics_tool_observations',
  'analytics_tool_states',
  'analytics_activity_observations',
  'analytics_activity_states',
  'analytics_feature_observations',
  'analytics_producer_sequences',
  'analytics_producer_reconciliation',
]);

function extractSchemaDdl(source, functionName) {
  const functionStart = source.indexOf(`function ${functionName}(`);
  if (functionStart < 0) throw new Error(`source schema function is missing: ${functionName}`);
  const marker = 'database.exec(`';
  const sqlStart = source.indexOf(marker, functionStart);
  const sqlEnd = source.indexOf('\n  `);', sqlStart + marker.length);
  if (sqlStart < 0 || sqlEnd < 0) throw new Error(`source schema DDL is missing: ${functionName}`);
  return source.slice(sqlStart + marker.length, sqlEnd);
}

/** Create an actual historical v2 schema, then copy only columns owned by that
 * schema from a current recorder-built fixture. This avoids the false test of
 * merely relabeling a current database while leaving later objects in place. */
function createGenuineV2Fixture(currentPath, legacyPath) {
  const recorderSource = readFileSync(path.join(extensionRoot, 'src', 'analytics', 'sqlite-recorder.ts'), 'utf8');
  const legacy = new DatabaseSync(legacyPath);
  try {
    legacy.exec(extractSchemaDdl(recorderSource, 'createV1Tables'));
    legacy.exec(extractSchemaDdl(recorderSource, 'createV2Tables'));
    // V2 DDL seeds singleton projection state. Replace every seeded row with
    // the measured fixture state before copying in dependency order.
    for (const table of [...V2_TABLES].reverse()) legacy.exec(`DELETE FROM "${table}"`);
    legacy.prepare('ATTACH DATABASE ? AS current_fixture').run(currentPath);
    for (const table of V2_TABLES) {
      const columns = legacy.prepare(`PRAGMA table_info(${table})`).all().map((entry) => String(entry.name));
      if (columns.length === 0) throw new Error(`v2 schema table is missing: ${table}`);
      const identifiers = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(', ');
      legacy.exec(`INSERT INTO "${table}" (${identifiers}) SELECT ${identifiers} FROM current_fixture."${table}"`);
    }
    legacy.exec('DETACH DATABASE current_fixture; PRAGMA user_version = 2;');
    const unexpected = legacy.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'analytics_%'
        AND name NOT IN (${V2_TABLES.map(() => '?').join(', ')})
    `).all(...V2_TABLES);
    if (unexpected.length > 0) throw new Error(`v2 fixture retained later tables: ${unexpected.map((row) => row.name).join(', ')}`);
  } finally {
    legacy.close();
  }
}

function safeInteger(value, label) {
  const number = typeof value === 'bigint'
    ? Number(value)
    : typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is not a non-negative safe integer`);
  return number;
}

function scalar(database, sql, column, label) {
  const row = database.prepare(sql).get();
  return safeInteger(row?.[column], label);
}

function terminalWorkerCounts(events) {
  const spawned = new Set(events.filter((event) => event.state === 'spawned')
    .map((event) => `${event.identity?.instanceId}:${event.identity?.pid}:${event.identity?.spawnedAtMs}`));
  const terminal = new Set(events.filter((event) => event.state === 'terminal')
    .map((event) => `${event.identity?.instanceId}:${event.identity?.pid}:${event.identity?.spawnedAtMs}`));
  return {
    spawned: spawned.size,
    terminal: [...spawned].filter((identity) => terminal.has(identity)).length,
    complete: spawned.size > 0 && [...spawned].every((identity) => terminal.has(identity)),
  };
}

async function measureSchemaUpgrade(root, seed, SqliteAnalyticsRecorder, AnalyticsQueryClient, workerEvents) {
  const currentFixturePath = path.join(root, 'upgrade-current-fixture.sqlite');
  const databasePath = path.join(root, 'upgrade-v2.sqlite');
  const retainedRoot = `${seed}-upgrade-retained`;
  const deletedRoot = `${seed}-upgrade-deleted`;
  let recorder = new SqliteAnalyticsRecorder(currentFixturePath);
  try {
    recorder.submit(observation(seed, 'upgrade-retained-fact', retainedRoot, { provider: true }));
    recorder.submitDetail(detail(seed, 'upgrade-retained-detail', retainedRoot));
    recorder.submit(observation(seed, 'upgrade-deleted-fact', deletedRoot));
    recorder.submitDetail(detail(seed, 'upgrade-deleted-detail', deletedRoot));
    recorder.deleteSession(deletedRoot, `${seed}-upgrade-delete`, 1_780_000_000_010);
  } finally {
    recorder.close();
  }

  createGenuineV2Fixture(currentFixturePath, databasePath);
  const legacy = new DatabaseSync(databasePath);
  let before;
  try {
    before = {
      version: scalar(legacy, 'PRAGMA user_version', 'user_version', 'legacy schema version'),
      facts: scalar(legacy, 'SELECT COUNT(*) AS count FROM analytics_observations', 'count', 'legacy fact count'),
      details: scalar(legacy, 'SELECT COUNT(*) AS count FROM analytics_detail_payloads', 'count', 'legacy detail count'),
      deletionMarkers: scalar(legacy, 'SELECT COUNT(*) AS count FROM analytics_deleted_subjects', 'count', 'legacy deletion marker count'),
      projectionRevision: scalar(legacy, 'SELECT revision FROM analytics_projection_state WHERE singleton = 1', 'revision', 'legacy projection revision'),
    };
  } finally {
    legacy.close();
  }

  recorder = new SqliteAnalyticsRecorder(databasePath);
  try {
    const after = {
      version: recorder.getDatabaseSchemaVersion(),
      facts: recorder.countObservations(),
      details: recorder.countDetails(),
      deletionMarkers: safeInteger(recorder.executeReadOnlyQuery(
        'SELECT COUNT(*) AS count FROM analytics_deleted_subjects',
      ).rows[0]?.count, 'upgraded deletion marker count'),
      projectionRevision: safeInteger(recorder.getProjectionRevision(), 'upgraded projection revision'),
    };
    const queryClient = new AnalyticsQueryClient({
      databasePath,
      workerScript: queryWorkerScript,
      timeoutMs: 10_000,
      onWorkerLifecycle: (event) => workerEvents.push(structuredClone(event)),
    });
    const schema = await queryClient.query({ type: 'schema' });
    if (safeInteger(schema.databaseSchemaVersion, 'query schema version') !== after.version) {
      throw new Error('query worker observed a different upgraded schema version');
    }

    const countBeforeCapture = recorder.countObservations();
    recorder.submit(observation(seed, 'upgrade-post-capture', retainedRoot));
    const postUpgradeCaptureAccepted = recorder.countObservations() === countBeforeCapture + 1;
    let deletedSubjectRejected = false;
    try {
      recorder.submit(observation(seed, 'upgrade-late-deleted', deletedRoot));
    } catch (error) {
      deletedSubjectRejected = /capture subject is deleted/iu.test(error instanceof Error ? error.message : String(error));
    }

    return {
      fromVersion: before.version,
      toVersion: after.version,
      retainedFactsBefore: before.facts,
      retainedFactsAfter: after.facts,
      retainedDetailsBefore: before.details,
      retainedDetailsAfter: after.details,
      deletionMarkersBefore: before.deletionMarkers,
      deletionMarkersAfter: after.deletionMarkers,
      projectionRevisionBefore: before.projectionRevision,
      projectionRevisionAfter: after.projectionRevision,
      postUpgradeCaptureAccepted,
      deletedSubjectRejected,
    };
  } finally {
    recorder.close();
  }
}

function measurePartialWrite(root, seed, SqliteAnalyticsRecorder) {
  const databasePath = path.join(root, 'partial.sqlite');
  const firstRoot = `${seed}-partial-first`;
  const rejectedRoot = `${seed}-partial-rejected`;
  const first = observation(seed, 'partial-first', firstRoot);
  const rejected = observation(seed, 'partial-rejected', rejectedRoot);
  let recorder = new SqliteAnalyticsRecorder(databasePath);
  let firstSubjectCommitted;
  let secondSubjectRejected;
  try {
    recorder.deleteSession(rejectedRoot, `${seed}-partial-delete`, 1_780_000_000_020);
    let initialRejected = false;
    try {
      recorder.submitBatch([first, rejected]);
    } catch (error) {
      initialRejected = /capture subject is deleted/iu.test(error instanceof Error ? error.message : String(error));
    }
    firstSubjectCommitted = recorder.countObservations(firstRoot) === 1;
    secondSubjectRejected = initialRejected && recorder.countObservations(rejectedRoot) === 0;
  } finally {
    recorder.close();
  }

  recorder = new SqliteAnalyticsRecorder(databasePath);
  try {
    const rowsBeforeReplay = recorder.countObservations();
    let expectedReplayRejection = false;
    try {
      recorder.submitBatch([first, rejected]);
    } catch (error) {
      expectedReplayRejection = /capture subject is deleted/iu.test(error instanceof Error ? error.message : String(error));
    }
    const rowsAfterPartialReplay = recorder.countObservations();
    const continuation = observation(seed, 'partial-continuation', `${seed}-partial-continuation-root`);
    recorder.submit(continuation);
    const rowsAfterContinuation = recorder.countObservations();
    recorder.submit(continuation);
    const actualRowsAfterReplay = recorder.countObservations();
    const expectedRowsAfterReplay = rowsBeforeReplay + 1;
    const duplicateReplayNoOp = rowsAfterPartialReplay === rowsBeforeReplay
      && rowsAfterContinuation === expectedRowsAfterReplay
      && actualRowsAfterReplay === rowsAfterContinuation;
    const replayCompleted = expectedReplayRejection && rowsAfterPartialReplay === rowsBeforeReplay
      && rowsAfterContinuation === expectedRowsAfterReplay;

    return {
      firstSubjectCommitted,
      secondSubjectRejected,
      replayCompleted,
      duplicateReplayNoOp,
      expectedRowsAfterReplay,
      actualRowsAfterReplay,
    };
  } finally {
    recorder.close();
  }
}

async function measureCorruption(root, seed, SqliteAnalyticsRecorder, AnalyticsQueryClient, workerEvents) {
  const sourcePath = path.join(root, 'partial.sqlite');
  const databasePath = path.join(root, 'corrupt.sqlite');
  copyFileSync(sourcePath, databasePath);
  truncateSync(databasePath, 100);
  let recorderRejected = false;
  try {
    const recorder = new SqliteAnalyticsRecorder(databasePath);
    recorder.close();
  } catch (error) {
    recorderRejected = /database|sqlite|malform|corrupt|file is not/iu.test(error instanceof Error ? error.message : String(error));
  }

  const corruptionEvents = [];
  const queryClient = new AnalyticsQueryClient({
    databasePath,
    workerScript: queryWorkerScript,
    timeoutMs: 10_000,
    onWorkerLifecycle: (event) => {
      const receipt = structuredClone(event);
      corruptionEvents.push(receipt);
      workerEvents.push(receipt);
    },
  });
  let queryRejected = false;
  try {
    await queryClient.query({ type: 'schema' });
  } catch (error) {
    queryRejected = /database|sqlite|malform|corrupt|file is not/iu.test(error instanceof Error ? error.message : String(error));
  }
  const terminal = terminalWorkerCounts(corruptionEvents);
  return {
    recorderRejected,
    queryRejected,
    workersTerminal: terminal.complete,
  };
}

function evaluateSchemaFaults(value) {
  const upgrade = value?.upgrade;
  const partial = value?.partialWrite;
  const corruption = value?.corruption;
  const numericReceipts = [
    upgrade?.fromVersion, upgrade?.toVersion,
    upgrade?.retainedFactsBefore, upgrade?.retainedFactsAfter,
    upgrade?.retainedDetailsBefore, upgrade?.retainedDetailsAfter,
    upgrade?.deletionMarkersBefore, upgrade?.deletionMarkersAfter,
    upgrade?.projectionRevisionBefore, upgrade?.projectionRevisionAfter,
    partial?.expectedRowsAfterReplay, partial?.actualRowsAfterReplay,
  ];
  return numericReceipts.every((entry) => Number.isSafeInteger(entry) && entry >= 0)
    && upgrade.fromVersion === 2 && upgrade.toVersion >= 13
    && upgrade.retainedFactsBefore > 0 && upgrade.retainedDetailsBefore > 0
    && upgrade.deletionMarkersBefore > 0 && partial.expectedRowsAfterReplay > 0
    && upgrade.retainedFactsBefore === upgrade.retainedFactsAfter
    && upgrade.retainedDetailsBefore === upgrade.retainedDetailsAfter
    && upgrade.deletionMarkersBefore === upgrade.deletionMarkersAfter
    && upgrade.projectionRevisionAfter >= upgrade.projectionRevisionBefore
    && upgrade.postUpgradeCaptureAccepted === true && upgrade.deletedSubjectRejected === true
    && partial.firstSubjectCommitted === true && partial.secondSubjectRejected === true
    && partial.replayCompleted === true && partial.duplicateReplayNoOp === true
    && partial.expectedRowsAfterReplay === partial.actualRowsAfterReplay
    && corruption.recorderRejected === true && corruption.queryRejected === true
    && corruption.workersTerminal === true;
}

function writeNewReportAtomically(filePath, report) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    // A hard-link publication is atomic and fails with EEXIST rather than ever
    // replacing prior qualification evidence.
    linkSync(temporary, filePath);
  } finally {
    try { unlinkSync(temporary); } catch { /* the temporary may not have been created */ }
  }
}

async function runSchemaFaultScenario(options) {
  const generatedAt = new Date().toISOString();
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: REPORT_KIND,
    harnessVersion: HARNESS_VERSION,
    status: 'running',
    generatedAt,
    configuration: { scenario: 'schema-faults', rows: null, seed: options.seed, reportPath: options.report },
    provenance: { valid: false, errors: ['initialization did not complete'] },
    results: {},
    measurement: { completed: false },
    cleanup: { completed: false, rootCreated: false, rootRemoved: false },
    qualification: {
      scenario: 'schema-faults',
      decision: 'scenario-failed',
      failedGates: ['schemaV2AndFaults'],
      overallP0: 'unqualified',
    },
  };
  let root;
  let failure;
  const workerEvents = [];
  try {
    report.provenance = collectArtifactProvenance();
    if (!report.provenance.valid) {
      throw new Error(`artifact provenance is incomplete: ${report.provenance.errors.join('; ')}`);
    }
    const [{ SqliteAnalyticsRecorder }, { AnalyticsQueryClient }] = await Promise.all([
      import(pathToFileURL(path.join(outRoot, 'analytics-sqlite-recorder.js')).href),
      import(pathToFileURL(path.join(outRoot, 'analytics-query-client.js')).href),
    ]);
    root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-p0-schema-faults-'));
    report.cleanup = { ...report.cleanup, rootCreated: true, rootPath: root };
    const upgrade = await measureSchemaUpgrade(
      root, options.seed, SqliteAnalyticsRecorder, AnalyticsQueryClient, workerEvents,
    );
    const partialWrite = measurePartialWrite(root, options.seed, SqliteAnalyticsRecorder);
    const corruption = await measureCorruption(
      root, options.seed, SqliteAnalyticsRecorder, AnalyticsQueryClient, workerEvents,
    );
    report.results.schemaFaults = { upgrade, partialWrite, corruption };
    report.measurement = {
      completed: true,
      completedAt: new Date().toISOString(),
      queryWorkers: terminalWorkerCounts(workerEvents),
    };
    if (!evaluateSchemaFaults(report.results.schemaFaults)) {
      throw new Error('measured schema/fault receipts did not satisfy the scenario contract');
    }
  } catch (error) {
    failure = error;
  } finally {
    if (root) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        report.cleanup = { ...report.cleanup, completed: true, rootRemoved: !existsSync(root) };
      } catch (error) {
        report.cleanup = {
          ...report.cleanup,
          completed: false,
          rootRemoved: false,
          error: error instanceof Error ? error.message : String(error),
        };
        failure ??= error;
      }
    } else {
      report.cleanup = { ...report.cleanup, completed: true, rootRemoved: true };
    }
  }

  const allWorkersTerminal = report.measurement.queryWorkers?.complete === true;
  const passed = failure === undefined && report.measurement.completed === true
    && report.cleanup.completed === true && report.cleanup.rootRemoved === true
    && allWorkersTerminal && evaluateSchemaFaults(report.results.schemaFaults);
  report.status = passed ? 'passed' : 'failed';
  report.qualification = {
    scenario: 'schema-faults',
    decision: passed ? 'scenario-passed' : 'scenario-failed',
    failedGates: passed ? [] : ['schemaV2AndFaults'],
    overallP0: 'unqualified',
    ...(passed ? {} : { reason: failure instanceof Error ? failure.message : String(failure ?? 'scenario evidence is incomplete') }),
  };
  if (failure !== undefined) {
    report.failure = {
      name: failure instanceof Error ? failure.name : 'SchemaFaultQualificationError',
      message: failure instanceof Error ? failure.message : String(failure),
    };
  }
  report.finishedAt = new Date().toISOString();
  writeNewReportAtomically(options.report, report);
  return report;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runSchemaFaultScenario(options);
  console.log(JSON.stringify({
    reportPath: options.report,
    status: report.status,
    decision: report.qualification.decision,
  }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
