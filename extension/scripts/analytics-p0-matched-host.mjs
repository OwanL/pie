#!/usr/bin/env node
/** P0 matched-host/UI measurement seam (authoritative producer).
 *
 * Produces one schema-5 `pie-p0-matched-host-v1` report comparing paired
 * analytics-disabled versus canonical candidate host sessions on one machine
 * with the same build, source manifest, deterministic workload, hidden
 * isolated VS Code hosts, and a harness-owned deterministic provider.
 *
 * Measurements per arm (identical workload plan and prompt markers):
 * - agent turnaround, cancellation, provider-failover, UI interaction and
 *   stream-paint latencies measured from the real renderer served by the
 *   isolated host's browser server, driven by headless Playwright;
 * - local live summary freshness (enabled arm): deterministic provider
 *   settlement completion → the next host state frame whose analytics-derived
 *   aggregate summary carries the expected cumulative output tokens;
 * - cross-host summary freshness (enabled arm, dual-host phase): a second
 *   host sharing the same canonical data root must observe a settlement
 *   committed by the first host through the shared projection revision;
 * - active/idle CPU and topology working-set telemetry sampled by an
 *   observer-independent PowerShell Win32_Process sampler over the whole
 *   owned host process tree (Code.exe host + forked analytics helpers);
 * - incremental retained host memory as the matched idle-topology median
 *   delta between the enabled and disabled arms.
 *
 * The disabled arm runs the production total-disable rehearsal seam
 * (`PIE_ANALYTICS_REHEARSAL_MODE=total-disabled-v1`) from a fresh legacy
 * state; the enabled arm prepares a canonical synthetic activation via the
 * compiled ActivationStore sequence from the same copied build. Production
 * admission is never claimed and no cutoff/restart is performed.
 *
 * Report integrity follows the component-envelope contract enforced by
 * analytics-p0-overall-qualification.mjs: shared source manifest fingerprint
 * (this harness file included), completed measurement, honest cleanup with a
 * removed fixture root, and scenario-passed/unqualified qualification.
 *
 * Cross-report integration: `results.matchedHost` is aggregated by
 * analytics-p0-overall-qualification.mjs under the `matchedHost` role. The
 * coordinated source-manifest addition is complete: analytics-p0-qualification.mjs
 * (artifactProvenance ownedFiles) and analytics-p0-schema-faults.mjs
 * (COMMON_SOURCE_FILES) carry the same entries as this harness, so every
 * producer's report binds one candidate with the same scenario-independent
 * source fingerprint.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { summarizeTimingSamples } from './analytics-p0-capacity.mjs';
import { computeQualificationSourceFingerprint } from './analytics-p0-overall-qualification.mjs';

const extensionRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const outRoot = path.join(extensionRoot, 'out');

export const REPORT_SCHEMA_VERSION = 5;
export const REPORT_KIND = 'pie-p0-matched-host-v1';
export const HARNESS_VERSION = 'p0-matched-host-v1';
export const MATCHED_HOST_SCENARIO = 'matched-host';

/** Fixed fixture ports. The seam refuses to start while any is occupied. */
export const MATCHED_HOST_PORTS = Object.freeze({
  provider: 2998,
  disabledHost: 2996,
  enabledHost: 2997,
  enabledSecondHost: 2995,
});

/** Qualification thresholds. These mirror the overall aggregator's
 * matchedAgentUi / incrementalHostMemory predicates and are never weakened. */
export const MATCHED_HOST_THRESHOLDS = Object.freeze({
  minMatchedSampleCount: 10,
  localSummaryFreshnessP95Ms: 250,
  localSummaryFreshnessP99Ms: 500,
  crossHostSummaryFreshnessMs: 1_000,
  idleAnalyticsCpuOneCorePercent: 0.5,
  activeCaptureCpuDeltaOneCorePercent: 10,
  incrementalRetainedHostBytes: 16 * 1024 * 1024,
});

/** Predeclared physical-memory guards. The entry guard matches the prior
 * isolated-fixture launch contract (4 GiB); the dual-host phase requires more
 * because it holds two concurrent VS Code instances. */
export const MATCHED_HOST_RESOURCE_GUARDS = Object.freeze({
  entryFreePhysicalBytes: 4 * 1024 * 1024 * 1024,
  singleHostFreePhysicalBytes: 3 * 1024 * 1024 * 1024,
  dualHostFreePhysicalBytes: 4_500 * 1024 * 1024,
  duringRunFreePhysicalBytes: 2 * 1024 * 1024 * 1024,
});

export const MATCHED_HOST_WORKLOAD_DEFAULTS = Object.freeze({
  sampleCountPerScenario: 12,
  idleWindowMs: 60_000,
  telemetryIntervalMs: 1_000,
  scenarioOrder: Object.freeze(['turnaround', 'failover', 'cancel']),
});

const PROVIDER_USAGE = Object.freeze({ promptTokens: 12, completionTokens: 8 });
const MAX_EVIDENCE_JSON_BYTES = 8 * 1024 * 1024;
const DEFAULT_CODE_PATH = 'C:\\Users\\OwanLazic\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
const SEED_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const REQUIRED_OUT_FILES = Object.freeze([
  'extension.js',
  'backend.js',
  'worker-entry.js',
  'analytics-recorder-worker.js',
  'analytics-recorder-supervisor.js',
  'analytics-sqlite-recorder.js',
  'analytics-query-worker.js',
  'analytics-query-client.js',
  'analytics-activation-sequence.js',
  'analytics-activation-store.js',
  'pie-build-id.txt',
  path.join('webview', 'panel', '.vite', 'manifest.json'),
  path.join('webview', 'panel', 'pie-build-id.txt'),
]);

/** This list intentionally matches the COMMON_SOURCE_FILES list in
 * analytics-p0-schema-faults.mjs and the artifactProvenance ownedFiles list in
 * analytics-p0-qualification.mjs, including this harness's own
 * authoritative-producer entry, so every producer's report binds one candidate
 * with the same scenario-independent source fingerprint. */
const COMMON_SOURCE_FILES = Object.freeze([
  ['extension/out/analytics-recorder-supervisor.js', path.join(outRoot, 'analytics-recorder-supervisor.js')],
  ['extension/out/analytics-sqlite-recorder.js', path.join(outRoot, 'analytics-sqlite-recorder.js')],
  ['extension/out/analytics-query-client.js', path.join(outRoot, 'analytics-query-client.js')],
  ['extension/out/analytics-recorder-worker.js', path.join(outRoot, 'analytics-recorder-worker.js')],
  ['extension/out/analytics-query-worker.js', path.join(outRoot, 'analytics-query-worker.js')],
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

export const MATCHED_HOST_HARNESS_FILE = ['extension/scripts/analytics-p0-matched-host.mjs', path.join(extensionRoot, 'scripts', 'analytics-p0-matched-host.mjs')];

// ─── Small shared helpers ────────────────────────────────────────────────────

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileReceipt(filePath) {
  const bytes = readFileSync(filePath);
  return { sha256: sha256Bytes(bytes), bytes: statSync(filePath).size };
}

function isoNow() {
  return new Date().toISOString();
}

function deterministicUuid(seed) {
  const digest = createHash('sha256').update(`pie-p0-matched-host\0${seed}`).digest('hex');
  const hex = digest.slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Summarize latency samples with the repository's nearest-rank percentiles. */
export function summarizeLatencySamples(values) {
  return summarizeTimingSamples(values);
}

function meanOf(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  let total = 0;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    total += value;
  }
  return total / values.length;
}

function medianOf(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

// ─── Provenance ──────────────────────────────────────────────────────────────

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
  try {
    gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: extensionRoot, encoding: 'utf8' }).stdout?.trim() ?? null;
  } catch {
    errors.push('source Git HEAD is unavailable');
  }
  let hostBuildId = null;
  let rendererBuildId = null;
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
    scenarioHarness = fileReceipt(MATCHED_HOST_HARNESS_FILE[1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scenarioHarness = { error: message };
    errors.push(`matched-host scenario harness: ${message}`);
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

// ─── Gate evaluation (recomputes the overall aggregator's predicates) ───────

const MATCHED_METRIC_NAMES = Object.freeze([
  'agentTurnaroundP95Ms',
  'cancellationP95Ms',
  'failoverP95Ms',
  'uiInteractionP95Ms',
  'streamPaintP95Ms',
]);

export function evaluateMatchedHostGates(value) {
  const disabled = value?.disabled;
  const enabled = value?.enabled;
  const matchedCounts = isSafeNonNegativeInteger(disabled?.sampleCount)
    && disabled.sampleCount >= MATCHED_HOST_THRESHOLDS.minMatchedSampleCount
    && enabled?.sampleCount === disabled.sampleCount;
  const noRegression = MATCHED_METRIC_NAMES.every((name) => isFiniteNonNegative(disabled?.[name])
    && isFiniteNonNegative(enabled?.[name])
    && enabled[name] <= disabled[name]);
  const freshness = isFiniteNonNegative(enabled?.localSummaryFreshnessP95Ms)
    && enabled.localSummaryFreshnessP95Ms <= MATCHED_HOST_THRESHOLDS.localSummaryFreshnessP95Ms
    && isFiniteNonNegative(enabled?.localSummaryFreshnessP99Ms)
    && enabled.localSummaryFreshnessP99Ms <= MATCHED_HOST_THRESHOLDS.localSummaryFreshnessP99Ms
    && isFiniteNonNegative(enabled?.crossHostSummaryFreshnessMs)
    && enabled.crossHostSummaryFreshnessMs <= MATCHED_HOST_THRESHOLDS.crossHostSummaryFreshnessMs;
  const cpu = isFiniteNonNegative(enabled?.idleAnalyticsCpuOneCorePercent)
    && enabled.idleAnalyticsCpuOneCorePercent < MATCHED_HOST_THRESHOLDS.idleAnalyticsCpuOneCorePercent
    && isFiniteNonNegative(disabled?.activeCaptureCpuOneCorePercent)
    && isFiniteNonNegative(enabled?.activeCaptureCpuOneCorePercent)
    && enabled.activeCaptureCpuOneCorePercent - disabled.activeCaptureCpuOneCorePercent
      <= MATCHED_HOST_THRESHOLDS.activeCaptureCpuDeltaOneCorePercent;
  const incrementalHostMemory = isFiniteNonNegative(enabled?.incrementalRetainedHostBytes)
    && enabled.incrementalRetainedHostBytes <= MATCHED_HOST_THRESHOLDS.incrementalRetainedHostBytes;
  const sameWorkload = value?.sameWorkload === true;
  const sameHostBuildConfig = value?.sameHostBuildConfig === true;
  const nativeTelemetry = value?.nativeTelemetryComplete === true;
  const matchedAgentUi = matchedCounts && noRegression && freshness && cpu
    && sameWorkload && sameHostBuildConfig;
  const failedGates = [
    ...(!matchedAgentUi ? ['matchedAgentUi'] : []),
    ...(!incrementalHostMemory ? ['incrementalHostMemory'] : []),
    ...(!nativeTelemetry ? ['nativeTelemetry'] : []),
  ];
  return {
    actual: { matchedCounts, noRegression, freshness, cpu, incrementalHostMemory, sameWorkload, sameHostBuildConfig, nativeTelemetry },
    passed: failedGates.length === 0,
    failedGates,
  };
}

/** Recompute the component-envelope contract for this role locally, using the
 * overall aggregator's own fingerprint function where possible. */
export function validateMatchedHostEnvelope(report) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) return ['report is not an object'];
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) errors.push('schemaVersion must be 5');
  if (report.kind !== REPORT_KIND) errors.push(`kind must be ${REPORT_KIND}`);
  if (typeof report.harnessVersion !== 'string' || report.harnessVersion.length === 0
    || report.harnessVersion.length > 1024) errors.push('harnessVersion is missing or invalid');
  if (report.status !== 'passed') errors.push('status must be passed');
  if (report.configuration?.scenario !== MATCHED_HOST_SCENARIO) errors.push('configuration.scenario is invalid');
  if (report.measurement?.completed !== true) errors.push('measurement is incomplete');
  if (report.cleanup?.completed !== true || report.cleanup?.rootRemoved !== true) errors.push('cleanup is incomplete');
  const qualification = report.qualification;
  if (qualification?.decision !== 'scenario-passed' || qualification?.overallP0 !== 'unqualified'
    || !Array.isArray(qualification?.failedGates) || qualification.failedGates.length !== 0) {
    errors.push('qualification is not a clean scenario-passed result');
  }
  const provenance = report.provenance;
  if (provenance?.valid !== true) errors.push('provenance is not valid');
  if (!/^[0-9a-f]{40}$/iu.test(provenance?.gitHead ?? '')) errors.push('gitHead is invalid');
  if (provenance?.coordinatedBuildId !== provenance?.hostBuildId
    || provenance?.hostBuildId !== provenance?.rendererBuildId) {
    errors.push('coordinated build identities are incomplete');
  }
  if (provenance?.files?.[MATCHED_HOST_HARNESS_FILE[0]]?.sha256 !== provenance?.scenarioHarness?.sha256) {
    errors.push('authoritative producer receipt is absent or does not match the scenario harness receipt');
  }
  try {
    const recomputed = computeQualificationSourceFingerprint(provenance ?? {});
    if (recomputed !== provenance?.fingerprint) errors.push('fingerprint does not recompute from the source manifest');
  } catch (error) {
    errors.push(`fingerprint recompute failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const gates = evaluateMatchedHostGates(report.results?.matchedHost);
  if (!gates.passed) errors.push(`measured gates do not pass: ${gates.failedGates.join(', ')}`);
  return errors;
}

// ─── Arm receipt validation ──────────────────────────────────────────────────

export function validateArmReceipt(receipt, expected) {
  const errors = [];
  if (!receipt || typeof receipt !== 'object') return ['arm receipt is missing'];
  if (receipt.arm !== expected.arm) errors.push('arm name mismatch');
  if (receipt.status !== 'passed') errors.push('arm did not complete');
  if (receipt.buildId !== expected.buildId || receipt.rendererBuildId !== expected.buildId) {
    errors.push('arm build identities do not match the coordinated build');
  }
  if (receipt.copiedTreeSha256 !== expected.copiedTreeSha256) errors.push('arm copied build tree hash mismatch');
  const driver = receipt.driver?.evidence;
  if (driver?.status !== 'passed') errors.push('arm workload driver did not pass');
  if (driver?.rendererBuildIds && !driver.rendererBuildIds.includes(expected.buildId)) {
    errors.push('renderer handshake did not report the validated build');
  }
  const planSampleCount = expected.sampleCountPerScenario;
  for (const scenario of expected.scenarios) {
    const samples = driver?.samples?.[scenario];
    if (!Array.isArray(samples) || samples.length !== planSampleCount) {
      errors.push(`arm workload sample count mismatch for ${scenario}`);
      break;
    }
  }
  const minimumIdleSamples = Math.floor(expected.idleWindowMs / expected.telemetryIntervalMs) - 2;
  if (typeof receipt.idle?.sampleCount !== 'number' || receipt.idle.sampleCount < minimumIdleSamples
    || typeof receipt.idle?.windowMs !== 'number'
    || receipt.idle.windowMs < expected.idleWindowMs - 2 * expected.telemetryIntervalMs) {
    errors.push('arm idle telemetry window is incomplete');
  }
  if (receipt.processes?.verifiedGone !== true) errors.push('arm processes were not verified gone');
  if (receipt.arm === 'disabled') {
    if (receipt.analytics?.canonicalDatabasePresent === true) errors.push('disabled arm unexpectedly created the canonical analytics database');
    if (receipt.analytics?.loadedGenerationReceiptPresent === true) errors.push('disabled arm unexpectedly produced a loaded-generation receipt');
  }
  if (receipt.arm === 'enabled') {
    if (receipt.analytics?.canonicalDatabasePresent !== true) errors.push('enabled arm has no canonical analytics database');
    if (receipt.analytics?.loadedGenerationReceipt?.buildId !== expected.buildId) {
      errors.push('enabled arm loaded-generation receipt is missing or belongs to another build');
    }
    if (receipt.activation?.authority !== 'canonical' || receipt.activation?.synthetic !== true) {
      errors.push('enabled arm activation receipt is not a synthetic canonical activation');
    }
  }
  return errors;
}

// ─── Generated fixture sources ───────────────────────────────────────────────

const PROVIDER_SERVER_SOURCE = `'use strict';
/* Harness-owned deterministic OpenAI-compatible provider for the matched-host
 * measurement. Behavior is fixed by the harness version: streamed 12-byte
 * chunks every 20 ms, fixed 12/8 token usage, one injected HTTP 500 per
 * failover marker, and a cancel stream that holds until the client aborts. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, '$1'));
const port = Number(process.env.PIE_MATCHED_PROVIDER_PORT || 2998);
const statePath = path.join(root, 'server-state.json');
const records = [];
const injectedFailoverMarkers = new Set();
let requestSequence = 0;

function persist(status) {
  const next = {
    status: status || 'running',
    port,
    requestCount: records.length,
    injectedFailoverMarkers: [...injectedFailoverMarkers],
    records: records.map((record) => ({ ...record })),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2) + '\\n', 'utf8');
}

function chunk(id, model, delta, finishReason, usage) {
  const value = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason === undefined ? null : finishReason }],
  };
  if (usage) value.usage = usage;
  return value;
}

function writeSse(res, value) {
  res.write('data: ' + JSON.stringify(value) + '\\n\\n');
}

function usage() {
  return { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
}

function makeRecord(body, sequence) {
  let parsed = {};
  try { parsed = JSON.parse(body); } catch { }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const failoverMarker = /fixture-failover-[A-Za-z0-9._-]+/u.exec(body);
  const plan = body.includes('fixture-cancel-flow')
    ? 'cancel'
    : failoverMarker
      ? 'failover'
      : 'normal-stream';
  const marker = failoverMarker ? failoverMarker[0] : body.includes('fixture-cancel-flow')
    ? 'fixture-cancel-flow-' + sequence
    : 'fixture-normal-stream-' + sequence;
  return {
    sequence,
    plan,
    marker,
    status: 200,
    injectedFailover: false,
    bodyBytes: Buffer.byteLength(body),
    messageRoles: messages.map((message) => (typeof message?.role === 'string' ? message.role : 'unknown')),
    responseChunks: 0,
    aborted: false,
    completed: false,
    receivedAt: new Date().toISOString(),
    responseStartedAt: undefined,
    completedAt: undefined,
    terminalReason: undefined,
  };
}

function finishRecord(record, aborted, terminalReason) {
  record.aborted = aborted === true;
  record.completed = aborted !== true;
  record.terminalReason = terminalReason ?? (aborted ? 'aborted' : 'stop');
  record.completedAt = new Date().toISOString();
  persist();
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, provider: 'pie-fixture', port }));
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'pie-fixture-model', object: 'model', owned_by: 'pie-p0-matched-host' }],
    }));
    return;
  }
  if (req.method === 'GET' && req.url === '/control/state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'running',
      requestCount: records.length,
      injectedFailoverMarkers: [...injectedFailoverMarkers],
      records: records.map((record) => ({ ...record })),
    }));
    return;
  }
  if (req.method === 'POST' && req.url === '/control/reset') {
    records.length = 0;
    injectedFailoverMarkers.clear();
    requestSequence = 0;
    persist();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, reset: true }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: 'matched-host provider route not found', type: 'invalid_request_error' } }));
    return;
  }

  let body = '';
  let bodyBytes = 0;
  req.on('data', (part) => {
    bodyBytes += part.length;
    if (bodyBytes <= 2 * 1024 * 1024) body += part.toString('utf8');
  });
  req.on('end', () => {
    const sequence = ++requestSequence;
    const record = makeRecord(body, sequence);
    record.bodyBytes = bodyBytes;
    records.push(record);
    persist();

    const responseId = 'pie-fixture-' + sequence;
    const model = 'pie-fixture-model';

    if (record.plan === 'failover' && !injectedFailoverMarkers.has(record.marker)) {
      injectedFailoverMarkers.add(record.marker);
      record.status = 500;
      record.injectedFailover = true;
      record.completedAt = new Date().toISOString();
      record.terminalReason = 'failover-injected';
      record.completed = false;
      record.aborted = false;
      persist();
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'matched-host failover injected', type: 'server_error' } }));
      return;
    }

    let closed = false;
    const timers = new Set();
    const later = (fn, ms) => {
      const timer = setTimeout(() => { timers.delete(timer); if (!closed) fn(); }, ms);
      timers.add(timer);
    };
    const close = (aborted, terminalReason) => {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      finishRecord(record, aborted, terminalReason);
      if (!res.writableEnded) res.end();
    };
    res.on('close', () => {
      if (!res.writableEnded) close(true, 'aborted');
    });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    record.responseStartedAt = new Date().toISOString();
    persist();

    writeSse(res, chunk(responseId, model, { role: 'assistant' }));
    record.responseChunks += 1;
    if (record.plan === 'cancel') {
      writeSse(res, chunk(responseId, model, { content: 'fixture-cancel-' }));
      record.responseChunks += 1;
      later(() => { writeSse(res, chunk(responseId, model, { content: 'stream-' })); record.responseChunks += 1; }, 250);
      later(() => { writeSse(res, chunk(responseId, model, { content: 'in-progress' })); record.responseChunks += 1; }, 500);
      later(() => close(false, 'hold-expired'), 10_000);
      return;
    }
    const text = record.plan === 'failover'
      ? 'Fixture provider recovered after failover.'
      : 'Fixture provider streamed a normal reply.';
    let offset = 0;
    const emitText = () => {
      if (offset >= text.length) {
        writeSse(res, chunk(responseId, model, {}, 'stop'));
        record.responseChunks += 1;
        writeSse(res, chunk(responseId, model, {}, null, usage()));
        writeSse(res, '[DONE]');
        close(false, 'stop');
        return;
      }
      const next = Math.min(text.length, offset + 12);
      writeSse(res, chunk(responseId, model, { content: text.slice(offset, next) }));
      record.responseChunks += 1;
      offset = next;
      later(emitText, 20);
    };
    emitText();
  });
});

server.on('error', (error) => {
  fs.writeFileSync(path.join(root, 'server-error.txt'), error.name + ': ' + error.message + '\\n', 'utf8');
  persist('error');
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => persist('running'));
process.on('SIGINT', () => { persist('stopped'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { persist('stopped'); server.close(() => process.exit(0)); });
`;

const SAMPLER_PS1_SOURCE = [
  'param(',
  '  [Parameter(Mandatory = $true)] [int] $RootPid,',
  '  [Parameter(Mandatory = $true)] [int] $IntervalMs,',
  '  [Parameter(Mandatory = $true)] [int] $MaxSamples',
  ')',
  "$ErrorActionPreference = 'Stop'",
  'for ($i = 0; $i -lt $MaxSamples; $i++) {',
  "  $procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'Code.exe' OR Name = 'node.exe'\")",
  '  $byPid = @{}',
  '  $children = @{}',
  '  foreach ($p in $procs) {',
  '    $id = [int]$p.ProcessId',
  '    $byPid[$id] = $p',
  '    $ppid = [int]$p.ParentProcessId',
  '    if (-not $children.ContainsKey($ppid)) { $children[$ppid] = New-Object System.Collections.Generic.List[int] }',
  '    $children[$ppid].Add($id)',
  '  }',
  '  $owned = New-Object System.Collections.Generic.List[object]',
  '  $seen = New-Object \'System.Collections.Generic.HashSet[int]\'',
  '  $stack = New-Object System.Collections.Stack',
  '  $stack.Push($RootPid)',
  '  while ($stack.Count -gt 0) {',
  '    $current = [int]$stack.Pop()',
  '    if (-not $seen.Add($current)) { continue }',
  '    if (-not $byPid.ContainsKey($current)) { continue }',
  '    $p = $byPid[$current]',
  '    $cmd = [string]$p.CommandLine',
  "    $role = 'other'",
  "    if ($cmd -like '*--type=extension-host*') { $role = 'extension-host' }",
  "    elseif ($cmd -like '*analytics-recorder-worker*') { $role = 'analytics-recorder-worker' }",
  "    elseif ($cmd -like '*analytics-query-worker*') { $role = 'analytics-query-worker' }",
  "    elseif ($cmd -like '*worker-entry*' -or $cmd -like '*backend.js*') { $role = 'backend' }",
  "    elseif ($cmd -like '*--type=renderer*') { $role = 'renderer' }",
  "    elseif ($cmd -like '*--type=utility*') { $role = 'utility' }",
  "    elseif ($cmd -like '*--type=zygote*') { $role = 'zygote' }",
  "    elseif ($cmd -like '*--type=gpu-process*') { $role = 'gpu' }",
  "    elseif ($cmd -like '*--type=crashpad-handler*') { $role = 'crashpad' }",
  '    $creationMs = 0',
  '    try {',
  '      if ($p.CreationDate -is [DateTime]) { $creationMs = ([DateTimeOffset]$p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() }',
  '      elseif ($p.CreationDate -is [DateTimeOffset]) { $creationMs = $p.CreationDate.ToUnixTimeMilliseconds() }',
  '      elseif ($null -ne $p.CreationDate) { $creationMs = ([DateTimeOffset]::Parse([string]$p.CreationDate)).ToUnixTimeMilliseconds() }',
  '    } catch { }',
  '    $owned.Add([ordered]@{',
  '      pid = [int]$p.ProcessId',
  '      ppid = [int]$p.ParentProcessId',
  '      name = [string]$p.Name',
  '      role = $role',
  '      wsBytes = [int64]$p.WorkingSetSize',
  '      kernel100ns = [int64]$p.KernelModeTime',
  '      user100ns = [int64]$p.UserModeTime',
  '      creationUnixMs = $creationMs',
  '    })',
  '    if ($children.ContainsKey($current)) { foreach ($c in $children[$current]) { $stack.Push($c) } }',
  '  }',
  "  $sample = [ordered]@{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); rootPid = $RootPid; procs = $owned }",
  '  [Console]::Out.WriteLine(($sample | ConvertTo-Json -Compress -Depth 4))',
  '  [Console]::Out.Flush()',
  '  Start-Sleep -Milliseconds $IntervalMs',
  '}',
].join('\n');

const DRIVER_SOURCE = `'use strict';
/* Matched-host workload driver. Drives the real renderer served by the
 * isolated host's browser server through headless Playwright with the same
 * prompt markers and scenario order for both arms. Latencies are measured
 * with a bounded 20 ms polling loop; freshness uses the received WS state
 * frames that carry the analytics-derived aggregate summary. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const argv = parseArgv(process.argv.slice(2));
const plan = JSON.parse(fs.readFileSync(path.resolve(String(argv.plan)), 'utf8'));
const require = createRequire(import.meta.url);
const { chromium } = require(plan.playwrightModulePath);

const evidence = {
  status: 'failed',
  error: undefined,
  mode: plan.mode,
  arm: plan.arm,
  expectedBuildId: plan.expectedBuildId,
  rendererBuildIds: [],
  rendererFrameTypes: [],
  stateFrameCount: 0,
  lastAggregateTokens: null,
  samples: { turnaround: [], failover: [], cancel: [] },
  interactionSamples: [],
  freshnessSamples: [],
  frameSeriesTail: [],
  crossHost: undefined,
  startedAt: new Date().toISOString(),
  finishedAt: undefined,
};

const stateFrames = [];
let expectedTokens = 0;

main().then((code) => {
  evidence.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(String(argv.evidence)), { recursive: true });
  fs.writeFileSync(String(argv.evidence), JSON.stringify(evidence, null, 2) + '\\n', 'utf8');
  process.exit(code);
}).catch((error) => {
  evidence.error = error instanceof Error ? (error.stack || error.message) : String(error);
  evidence.finishedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(String(argv.evidence)), { recursive: true });
    fs.writeFileSync(String(argv.evidence), JSON.stringify(evidence, null, 2) + '\\n', 'utf8');
  } catch { }
  console.error(evidence.error);
  process.exit(1);
});

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('websocket', (socket) => {
      const observe = (event) => {
        let parsed;
        try {
          const payload = event && typeof event === 'object' && 'payload' in event ? event.payload : event;
          parsed = typeof payload === 'string' ? JSON.parse(payload) : JSON.parse(Buffer.from(payload).toString('utf8'));
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== 'object') return;
        if (parsed.type === 'rendererHello' || parsed.type === 'ready') {
          evidence.rendererFrameTypes.push(parsed.type);
          if (typeof parsed.buildId === 'string') evidence.rendererBuildIds.push(parsed.buildId);
          return;
        }
        if (parsed.type === 'state') {
          const tokens = parsed.state && parsed.state.aggregateStats
            ? parsed.state.aggregateStats.todayOutputTokens
            : undefined;
          evidence.stateFrameCount += 1;
          if (typeof tokens === 'number' && Number.isFinite(tokens)) {
            stateFrames.push({ t: Date.now(), tokens });
            evidence.lastAggregateTokens = tokens;
            if (stateFrames.length > 4000) stateFrames.splice(0, stateFrames.length - 4000);
          }
        }
      };
      socket.on('framereceived', observe);
      socket.on('framesent', observe);
    });
    await page.goto(plan.uiUrl, { waitUntil: 'networkidle', timeout: 30_000 });

    if (plan.mode === 'cross-host-observer') return await runCrossHostObserver(page);
    if (plan.mode === 'cross-host-producer') return await runExtraTurn(page);
    return await runWorkload(page);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function runWorkload(page) {
  // The fixture model text lives in the composer toolbar, which only exists
  // once a session is open: a fresh arm lands on the empty landing page.
  await clickNewSession(page);
  await waitForComposerReady(page);
  await assertRendererBuild();
  await waitForFixtureModel(page);

  for (const scenario of plan.scenarios) {
    for (let index = 1; index <= plan.sampleCount; index += 1) {
      await runSample(page, scenario, index);
      await waitFor(async () => readProviderState().records.every((record) => record.completed || record.aborted || record.terminalReason === 'failover-injected'),
        plan.timeouts.settleMs, 'provider quiescence before next sample');
    }
  }
  evidence.frameSeriesTail = stateFrames.slice(-200).map((frame) => frame.tokens);
  evidence.status = 'passed';
}

async function runExtraTurn(page) {
  await assertRendererBuild();
  await clickNewSession(page);
  await waitForComposerReady(page);
  await waitForFixtureModel(page);
  const index = plan.sampleCount + 1;
  await runSample(page, 'turnaround', index, '-extra');
  evidence.frameSeriesTail = stateFrames.slice(-200).map((frame) => frame.tokens);
  evidence.status = 'passed';
}

async function runCrossHostObserver(page) {
  const deadline = Date.now() + plan.timeouts.baselineMs;
  let baseline = null;
  while (baseline === null && Date.now() < deadline) {
    await assertRendererBuild();
    if (stateFrames.length > 0) baseline = stateFrames[stateFrames.length - 1].tokens;
    else await delay(100);
  }
  if (baseline === null) throw new Error('cross-host observer saw no aggregate summary state frame');
  process.stdout.write('READY baseline=' + String(baseline) + '\\n');
  const observed = await awaitSummaryFrame(Date.now(), baseline + plan.crossHostIncrement, plan.timeouts.crossHostMs);
  evidence.crossHost = { baselineTokens: baseline, ...observed };
  evidence.frameSeriesTail = stateFrames.slice(-200).map((frame) => frame.tokens);
  if (!observed.observed) throw new Error('cross-host summary refresh was not observed within its bounded wait');
  evidence.status = 'passed';
}

async function assertRendererBuild() {
  if (evidence.rendererBuildIds.length === 0) {
    await waitFor(async () => evidence.rendererBuildIds.length > 0, plan.timeouts.handshakeMs, 'renderer handshake frames');
  }
  if (!evidence.rendererBuildIds.includes(plan.expectedBuildId)) {
    throw new Error('renderer handshake did not report the validated build: '
      + JSON.stringify([...new Set(evidence.rendererBuildIds)]));
  }
}

async function waitForFixtureModel(page) {
  await waitFor(async () => {
    const body = await page.locator('body').innerText().catch(() => '');
    return body.includes(plan.modelName) || body.includes(plan.modelId);
  }, plan.timeouts.modelMs, 'fixture model selection');
}

async function runSample(page, scenario, index, suffix = '') {
  const marker = 'fixture-' + scenarioPlanName(scenario) + '-' + plan.runId + '-' + String(index) + suffix;
  const interactionStart = Date.now();
  await clickNewSession(page);
  await waitForComposerReady(page);
  const interactionMs = Date.now() - interactionStart;
  evidence.interactionSamples.push(interactionMs);

  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  await composer.fill(promptFor(scenario, marker));
  const send = page.getByRole('button', { name: 'Send message', exact: true }).first();
  await waitFor(async () => !(await send.isDisabled().catch(() => true)), plan.timeouts.sendReadyMs, 'send button readiness');
  const sentAtMs = Date.now();
  await send.click();

  if (scenario === 'cancel') {
    await waitFor(bodyIncludes(page, 'fixture-cancel-'), plan.timeouts.firstMarkerMs, 'cancel first stream marker');
    const interruptAtMs = Date.now();
    await clickInterrupt(page);
    await waitForTerminalIdle(page, plan.timeouts.terminalMs);
    const cancellationMs = Date.now() - interruptAtMs;
    await waitFor(async () => recordsForMarker(marker).some((record) => record.plan === 'cancel' && record.terminalReason === 'aborted'),
      plan.timeouts.providerTerminalMs, 'provider cancellation aborted terminal');
    evidence.samples.cancel.push({ index, marker, interactionMs, cancellationMs, interruptAtMs });
    return;
  }

  await waitFor(bodyIncludes(page, firstMarkerText(scenario)), plan.timeouts.firstMarkerMs, 'first stream marker');
  const streamPaintMs = Date.now() - sentAtMs;
  await waitFor(bodyIncludes(page, finalText(scenario)), plan.timeouts.finalTextMs, 'final provider text');
  await waitForTerminalIdleAndSendReady(page, plan.timeouts.terminalMs);
  const latencyMs = Date.now() - sentAtMs;
  const settlement = await waitForSettlement(marker);
  let freshness = null;
  if (plan.measureFreshness === true) {
    expectedTokens += plan.completionTokensPerSettlement;
    freshness = await awaitSummaryFrame(settlement.completedAtMs, expectedTokens, plan.timeouts.freshnessMs);
    evidence.freshnessSamples.push({
      marker,
      settlementCompletedAtMs: settlement.completedAtMs,
      expectedTokens,
      ...freshness,
    });
  }
  evidence.samples[scenario].push({
    index,
    marker,
    interactionMs,
    streamPaintMs,
    latencyMs,
    sentAtMs,
    settlementCompletedAtMs: settlement.completedAtMs,
    providerSequences: settlement.sequences,
    ...(freshness ? { freshnessMs: freshness.latencyMs, freshnessObserved: freshness.observed } : {}),
  });
}

function promptFor(scenario, marker) {
  return 'Send the deterministic fixture provider this exact marker and repeat nothing else: ' + marker;
}

function scenarioPlanName(scenario) {
  return scenario === 'turnaround' ? 'normal-stream' : scenario === 'failover' ? 'failover' : 'cancel-flow';
}

function firstMarkerText(scenario) {
  return scenario === 'turnaround'
    ? 'Fixture provider streamed'
    : 'Fixture provider recovered';
}

function finalText(scenario) {
  return scenario === 'turnaround'
    ? 'Fixture provider streamed a normal reply.'
    : 'Fixture provider recovered after failover.';
}

function readProviderState() {
  const parsed = JSON.parse(fs.readFileSync(plan.providerStatePath, 'utf8'));
  return { records: Array.isArray(parsed.records) ? parsed.records : [] };
}

function recordsForMarker(marker) {
  return readProviderState().records.filter((record) => record.marker === marker);
}

async function waitForSettlement(marker) {
  let sequences = [];
  await waitFor(() => {
    const records = recordsForMarker(marker);
    sequences = records.map((record) => record.sequence);
    return records.length > 0 && records.every((record) => record.terminalReason !== undefined);
  }, plan.timeouts.providerTerminalMs, 'provider settlement terminal');
  const completed = recordsForMarker(marker).find((record) => record.completed === true);
  if (!completed || typeof completed.completedAt !== 'string') {
    throw new Error('provider settlement has no completed record: ' + marker);
  }
  return { completedAtMs: Date.parse(completed.completedAt), sequences };
}

async function awaitSummaryFrame(afterMs, expectedTokens, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const missLatency = budgetMs;
  while (Date.now() < deadline) {
    const match = stateFrames.find((frame) => frame.t >= afterMs && frame.tokens >= expectedTokens);
    if (match) {
      return { observed: true, latencyMs: Math.max(0, match.t - afterMs), observedTokens: match.tokens, frameAtMs: match.t };
    }
    await delay(15);
  }
  return { observed: false, latencyMs: missLatency, observedTokens: null };
}

async function clickNewSession(page) {
  const stripButton = page.locator('button.session-tabs-new').first();
  if (await stripButton.count() > 0 && !(await stripButton.isDisabled().catch(() => true))) {
    await stripButton.click();
    return;
  }
  const landingButton = page.getByRole('button', { name: 'New Session', exact: true }).first();
  await landingButton.waitFor({ state: 'visible', timeout: plan.timeouts.sessionMs });
  await landingButton.click();
}

async function waitForComposerReady(page) {
  await waitFor(async () => {
    const label = page.locator('.session-tab.active .session-tab-label').first();
    const activeIsNew = await label.count() > 0
      && (await label.innerText().catch(() => '')).trim() === 'New Session';
    const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
    const composerVisible = await composer.isVisible().catch(() => false);
    return activeIsNew && composerVisible;
  }, plan.timeouts.sessionMs, 'new session composer readiness');
}

async function clickInterrupt(page) {
  const byClass = page.locator('button.composer-action-stop').first();
  if (await byClass.count() > 0 && await byClass.isVisible().catch(() => false)) {
    await byClass.click();
    return;
  }
  const byRole = page.getByRole('button', { name: 'Interrupt response', exact: true }).first();
  if (await byRole.count() > 0 && await byRole.isVisible().catch(() => false)) {
    await byRole.click();
    return;
  }
  throw new Error('active UI interruption control was not found');
}

async function terminalIdle(page) {
  const interrupt = page.locator('button.composer-action-stop').first();
  const stopVisible = await interrupt.count() > 0 && await interrupt.isVisible().catch(() => false);
  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  const composerEditable = await composer.count() > 0
    && await composer.isVisible().catch(() => false)
    && await composer.isEditable().catch(() => false);
  return !stopVisible && composerEditable;
}

async function waitForTerminalIdle(page, timeoutMs) {
  await waitFor(() => terminalIdle(page), timeoutMs, 'terminal idle composer');
}

async function waitForTerminalIdleAndSendReady(page, timeoutMs) {
  await waitFor(() => terminalIdle(page), timeoutMs, 'terminal idle composer');
  const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
  const send = page.getByRole('button', { name: 'Send message', exact: true }).first();
  const probe = 'pie-ui-send-ready-probe-' + String(Date.now());
  await composer.fill(probe);
  await waitFor(async () => !(await send.isDisabled().catch(() => true)), timeoutMs, 'send ready with draft');
  await composer.fill('');
}

function bodyIncludes(page, needle) {
  return async () => (await page.locator('body').innerText().catch(() => '')).includes(needle);
}

function parseArgv(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!String(values[index]).startsWith('--')) throw new Error('unexpected driver argument');
    const key = String(values[index]).slice(2);
    const next = values[index + 1];
    result[key] = next === undefined || String(next).startsWith('--') ? true : next;
    if (next !== undefined && !String(next).startsWith('--')) index += 1;
  }
  return result;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(label + ' did not complete within ' + String(timeoutMs) + 'ms');
}
`;

// The cross-host observer driver needs a small plan extension; both modes are
// covered by the same source above.

// ─── Fixture preparation helpers ─────────────────────────────────────────────

function copyBuildInto(root) {
  const copied = path.join(root, 'build', 'pie.pie-0.3.0');
  const hostBuildId = readFileSync(path.join(outRoot, 'pie-build-id.txt'), 'utf8').trim();
  const rendererBuildId = readFileSync(path.join(outRoot, 'webview', 'panel', 'pie-build-id.txt'), 'utf8').trim();
  if (!/^[0-9a-f]{20}$/u.test(hostBuildId) || hostBuildId !== rendererBuildId) {
    throw new Error(`extension out has no coordinated host/renderer build identity (${hostBuildId} != ${rendererBuildId})`);
  }
  for (const required of REQUIRED_OUT_FILES) {
    if (!statSync(path.join(outRoot, required)).isFile()) {
      throw new Error(`extension out is missing required file: ${required}`);
    }
  }
  const sourcePackage = path.join(extensionRoot, 'package.json');
  mkdirSync(path.dirname(copied), { recursive: true });
  cpSync(outRoot, path.join(copied, 'out'), { recursive: true });
  cpSync(path.join(extensionRoot, 'media'), path.join(copied, 'media'), { recursive: true });
  const manifest = JSON.parse(readFileSync(sourcePackage, 'utf8'));
  manifest.main = './out/extension.js';
  delete manifest.pieRuntimeBootstrap;
  writeFileSync(path.join(copied, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const treeHash = directoryTreeHash(path.join(copied, 'out'));
  const copiedRendererBuildId = readFileSync(
    path.join(copied, 'out', 'webview', 'panel', 'pie-build-id.txt'), 'utf8').trim();
  if (copiedRendererBuildId !== hostBuildId) {
    throw new Error('copied build renderer identity does not match the host build identity');
  }
  return { copiedPath: copied, buildId: hostBuildId, rendererBuildId: copiedRendererBuildId, outputTreeSha256: treeHash };
}

function directoryTreeHash(directory) {
  const base = path.resolve(directory);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  const records = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) {
        const relative = entryPath.slice(prefix.length).split(path.sep).join('/');
        records.push(`${relative}\0${sha256Bytes(readFileSync(entryPath))}\0`);
      }
    }
  };
  visit(base);
  return sha256Bytes(Buffer.from(records.join(''), 'utf8'));
}

function writeArmAgentAssets({ armRoot, providerPort }) {
  const agentDir = path.join(armRoot, 'agent');
  for (const sub of ['auth', 'sessions', path.join('data'), path.join('data', 'analytics'), path.join('data', 'state'), 'deferred-triggers', path.join('extensions')]) {
    mkdirSync(path.join(agentDir, sub), { recursive: true });
  }
  writeFileSync(path.join(agentDir, 'settings.json'), `${JSON.stringify({
    defaultModel: 'pie-fixture-model',
    defaultProvider: 'pie-fixture',
    defaultThinkingLevel: 'off',
    packages: [],
    sessionDir: 'sessions',
  }, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(agentDir, 'extensions', 'pie-fixture-provider.ts'), `const FIXTURE_BASE_URL = 'http://127.0.0.1:${providerPort}/v1';\n\nexport default function (pi) {\n  pi.registerProvider('pie-fixture', {\n    name: 'Pie Matched Host Fixture',\n    baseUrl: FIXTURE_BASE_URL,\n    apiKey: 'pie-p0-matched-host',\n    api: 'openai-completions',\n    models: [{\n      id: 'pie-fixture-model',\n      name: 'Pie Matched Host Fixture Model',\n      reasoning: false,\n      input: ['text'],\n      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },\n      contextWindow: 8192,\n      maxTokens: 256,\n    }],\n  });\n}\n`, 'utf8');
  return agentDir;
}

function writeArmVsCodeAssets({ armRoot, agentDir, extensionsDir, port }) {
  const userData = path.join(armRoot, 'user-data');
  const workspace = path.join(armRoot, 'workspace');
  mkdirSync(path.join(userData, 'User'), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  writeFileSync(path.join(userData, 'User', 'settings.json'), `${JSON.stringify({
    'pie.agentDir': agentDir.replace(/\\/gu, '/'),
    'pie.browserServer.enabled': true,
    'pie.browserServer.port': port,
    'pie.browserServer.requirePreferredPort': true,
    'pie.logLevel': 'error',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
  }, null, 2)}\n`, 'utf8');
  const extensionsJson = [{
    identifier: { id: 'pie.pie' },
    version: '0.3.0',
    location: { $mid: 1, path: `/${extensionsDir.split('\\').join('/')}/pie.pie-0.3.0`, scheme: 'file' },
    relativeLocation: 'pie.pie-0.3.0',
  }];
  writeFileSync(path.join(extensionsDir, 'extensions.json'), JSON.stringify(extensionsJson), 'utf8');
  return { userData, workspace };
}

function writeLauncher({ armRoot, agentDir, dataDir, userData, extensionsDir, workspace, codePath, analyticsDisabled }) {
  const lines = [
    '@echo off',
    'setlocal',
    `set "PI_CODING_AGENT_DIR=${agentDir}"`,
    `set "PI_CODING_AGENT_AUTH_DIR=${path.join(agentDir, 'auth')}"`,
    `set "PI_CODING_AGENT_SESSION_DIR=${path.join(agentDir, 'sessions')}"`,
    `set "PIE_DATA_DIR=${dataDir}"`,
    'set "PIE_ANALYTICS_DIR="',
    'set "PIE_ANALYTICS_HANDOFF_KEY="',
    'set "PIE_ANALYTICS_RESTART_NONCE="',
    'set "PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH="',
    'set "PIE_STORAGE_CUTOFF_AUTHORIZATION="',
    'set "PIE_ANALYTICS_REHEARSAL_MODE="',
    ...(analyticsDisabled ? ['set "PIE_ANALYTICS_REHEARSAL_MODE=total-disabled-v1"'] : []),
    'set "VSCODE_NLS_CONFIG="',
    'set "ELECTRON_RUN_AS_NODE="',
    `"${codePath}" --user-data-dir="${userData}" --extensions-dir="${extensionsDir}" --disable-workspace-trust --disable-updates --skip-welcome --skip-release-notes --new-window "${workspace}"`,
    'exit /b %ERRORLEVEL%',
  ];
  const launcherPath = path.join(armRoot, analyticsDisabled ? 'launch-disabled.cmd' : 'launch-enabled.cmd');
  writeFileSync(launcherPath, `${lines.join('\r\n')}\r\n`, 'utf8');
  return launcherPath;
}

async function prepareCanonicalActivation({ copiedOut, dataDir, buildId, generationId }) {
  const sequenceModulePath = path.join(copiedOut, 'analytics-activation-sequence.js');
  const storeModulePath = path.join(copiedOut, 'analytics-activation-store.js');
  if (!statSync(sequenceModulePath).isFile() || !statSync(storeModulePath).isFile()) {
    throw new Error('copied build is missing the compiled ActivationStore sequence');
  }
  const [{ activateGeneration }, { ActivationStore }] = await Promise.all([
    import(pathToFileURL(sequenceModulePath).href),
    import(pathToFileURL(storeModulePath).href),
  ]);
  const stateDir = path.join(dataDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const qualificationSha256 = sha256Bytes(Buffer.from(`synthetic qualification fixture\0${buildId}`, 'utf8'));
  const trialSha256 = sha256Bytes(Buffer.from(`synthetic isolated trial fixture\0${buildId}`, 'utf8'));
  const activatedAt = new Date().toISOString();
  const store = new ActivationStore({ stateDir });
  const outcome = await activateGeneration(store, {
    generationId,
    buildId,
    qualificationSha256,
    trialSha256,
    activatedAt,
    cutoffReceiptSha256: null,
  });
  const read = store.read();
  if (read.authority !== 'canonical' || !read.manifest?.activeGeneration) {
    throw new Error('compiled ActivationStore did not produce a canonical active generation');
  }
  if (read.manifest.activeGeneration.identity.buildId !== buildId
    || read.manifest.activeGeneration.identity.generationId !== generationId
    || read.manifest.activeGeneration.cutoffReceiptSha256 !== null) {
    throw new Error('compiled ActivationStore returned an unexpected synthetic identity');
  }
  return {
    authority: 'canonical',
    synthetic: true,
    generationId,
    buildId,
    qualificationSha256,
    trialSha256,
    cutoffReceiptSha256: null,
    manifestSha256: read.sha256,
    activationRevision: read.manifest.revision,
    alreadyActive: outcome.alreadyActive === true,
    activatedAt,
    productionAdmissionClaim: false,
  };
}

function httpProbe(url, timeoutMs = 3_000, options = {}) {
  return new Promise((resolve) => {
    const request = new URL(url);
    const req = http.request(request, { method: options.method ?? 'GET', timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on('data', (part) => {
        chunks.push(part);
        if (chunks.reduce((total, chunk) => total + chunk.length, 0) > 2 * 1024 * 1024) request.destroy();
      });
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

async function waitHealthy({ port, deadlineMs }) {
  const deadline = Date.now() + deadlineMs;
  let healthStatus = 0;
  while (Date.now() < deadline) {
    healthStatus = (await httpProbe(`http://127.0.0.1:${port}/health`)).status;
    if (healthStatus === 200) {
      const root = await httpProbe(`http://127.0.0.1:${port}/`);
      const match = /\/assets\/[A-Za-z0-9._/-]+/u.exec(root.body);
      const assetStatus = match
        ? (await httpProbe(`http://127.0.0.1:${port}${match[0]}`)).status
        : 0;
      if (assetStatus === 200) {
        return { assetPath: match[0], healthStatus, rootStatus: root.status, assetStatus };
      }
    }
    await delay(250);
  }
  throw new Error(`browser server on port ${port} did not become healthy before its deadline`);
}

function portInUse(port) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue) -ne $null`,
  ], { encoding: 'utf8', timeout: 15_000 });
  return result.stdout?.trim() === 'True';
}

function findCodeRootPid({ marker, notBeforeMs }) {
  const script = [
    "$marker = $args[0]; $notBefore = [int64]$args[1]",
    "$roots = @(Get-CimInstance Win32_Process -Filter \"Name = 'Code.exe'\" | Where-Object { [string]$_.CommandLine -like ('*' + $marker + '*') })",
    '$codePids = @{}',
    'foreach ($p in $roots) { $codePids[[int]$p.ProcessId] = $true }',
    '$rootPids = @()',
    'foreach ($p in $roots) {',
    '  $parent = [int]$p.ParentProcessId',
    '  $created = 0',
    '  try {',
    '    if ($p.CreationDate -is [DateTime]) { $created = ([DateTimeOffset]$p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() }',
    '    elseif ($p.CreationDate -is [DateTimeOffset]) { $created = $p.CreationDate.ToUnixTimeMilliseconds() }',
    '  } catch { }',
    '  if (-not $codePids.ContainsKey($parent) -and $created -ge $notBefore) { $rootPids += [int]$p.ProcessId }',
    '}',
    '($rootPids | Sort-Object)[0]',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script, marker, String(notBeforeMs)], {
    encoding: 'utf8', timeout: 20_000,
  });
  const pid = Number.parseInt((result.stdout ?? '').trim(), 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function killTree(pid) {
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 30_000 });
  return { pid, exitCode: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

function verifyPidsGone(pids) {
  if (pids.length === 0) return { verifiedGone: true, remaining: [] };
  const script = [
    '$targets = @(' + pids.join(',') + ')',
    "$procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'Code.exe' OR Name = 'node.exe'\" | Where-Object { $targets -contains [int]$_.ProcessId })",
    '($procs | ForEach-Object { [int]$_.ProcessId }) -join \',\'',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', timeout: 20_000,
  });
  const remaining = (result.stdout ?? '').trim().split(',').filter((value) => value.length > 0).map(Number);
  return { verifiedGone: remaining.length === 0, remaining };
}

// ─── Telemetry sampler ───────────────────────────────────────────────────────

function startTopologySampler({ root, rootPid, intervalMs, maxSamples }) {
  // Unique per sampled tree: the dual-host phase starts two samplers sharing
  // one root, and a concurrent script rewrite would race the live reader.
  const scriptPath = path.join(root, `telemetry-sampler-${rootPid}.ps1`);
  writeFileSync(scriptPath, `${SAMPLER_PS1_SOURCE}\n`, 'utf8');
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    '-RootPid', String(rootPid), '-IntervalMs', String(intervalMs), '-MaxSamples', String(maxSamples),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const samples = [];
  let tail = '';
  let stderrText = '';
  const stdout = child.stdout;
  stdout.setEncoding('utf8');
  stdout.on('data', (part) => {
    tail += part;
    let newlineIndex;
    while ((newlineIndex = tail.indexOf('\n')) >= 0) {
      const line = tail.slice(0, newlineIndex).trim();
      tail = tail.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      try {
        samples.push(JSON.parse(line));
      } catch (error) {
        stderrText += `sampler line parse error: ${error instanceof Error ? error.message : String(error)}\n`;
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (part) => { stderrText += part; });
  let stopRequested = false;
  return {
    scriptPath,
    child,
    samples,
    stop: () => new Promise((resolve) => {
      // Emergency cleanup may run stop() after the arm's own success-path stop;
      // the second call must resolve without waiting on another exit event.
      if (stopRequested) {
        resolve({ sampleCount: samples.length, stderrText });
        return;
      }
      stopRequested = true;
      try { child.kill(); } catch { /* process may already be dead */ }
      const deadline = Date.now() + 5_000;
      const finish = () => resolve({ sampleCount: samples.length, stderrText });
      child.once('exit', finish);
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* process may already be dead */ }
        try { spawnSync('taskkill', ['/PID', String(child.pid ?? 0), '/T', '/F']); } catch { /* process may already be dead */ }
        finish();
      }, Math.max(0, deadline - Date.now()));
    }),
  };
}

// ─── Telemetry math ──────────────────────────────────────────────────────────

function sampleIntervalCpuOneCorePercent(previous, next, logicalCores) {
  const wallMs = next.t - previous.t;
  if (wallMs <= 0) return null;
  let cpu100ns = 0;
  for (const proc of next.procs) {
    const before = previous.procs.find((candidate) => candidate.pid === proc.pid);
    if (!before) continue;
    cpu100ns += Math.max(0, (proc.kernel100ns + proc.user100ns) - (before.kernel100ns + before.user100ns));
  }
  const cpuMicros = cpu100ns / 10;
  const wallMicros = wallMs * 1_000;
  return (cpuMicros / wallMicros) * 100 / logicalCores;
}

function summarizeTopologySamples(samples, { logicalCores }) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return { sampleCount: Array.isArray(samples) ? samples.length : 0, cpuOneCorePercentMean: null, rssMedianBytes: null };
  }
  const cpuPercents = [];
  const rssTotals = [];
  for (let index = 1; index < samples.length; index += 1) {
    const percent = sampleIntervalCpuOneCorePercent(samples[index - 1], samples[index], logicalCores);
    if (percent !== null) cpuPercents.push(percent);
  }
  for (const sample of samples) {
    let total = 0;
    for (const proc of sample.procs) total += proc.wsBytes;
    rssTotals.push(total);
  }
  const helperCpuPercents = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const next = samples[index];
    for (const proc of next.procs) {
      if (proc.role !== 'analytics-recorder-worker' && proc.role !== 'analytics-query-worker') continue;
      const before = previous.procs.find((candidate) => candidate.pid === proc.pid);
      if (!before) continue;
      const wallMs = next.t - previous.t;
      if (wallMs <= 0) continue;
      const cpu100ns = Math.max(0, (proc.kernel100ns + proc.user100ns) - (before.kernel100ns + before.user100ns));
      helperCpuPercents.push(((cpu100ns / 10) / (wallMs * 1_000)) * 100 / logicalCores);
    }
  }
  return {
    sampleCount: samples.length,
    windowMs: samples.length >= 2 ? samples[samples.length - 1].t - samples[0].t : 0,
    cpuOneCorePercentMean: meanOf(cpuPercents),
    helperCpuOneCorePercentMean: meanOf(helperCpuPercents),
    rssMedianBytes: medianOf(rssTotals),
    processSampleCount: samples.reduce((total, sample) => total + sample.procs.length, 0),
  };
}

// ─── Driver plan + evidence ──────────────────────────────────────────────────

function buildDriverPlan({ arm, mode = 'workload', runId, uiUrl, providerUrl, providerStatePath, buildId, sampleCountPerScenario, measureFreshness, timeoutOverrides = {} }) {
  return {
    mode,
    arm,
    runId,
    uiUrl,
    providerUrl,
    providerStatePath,
    expectedBuildId: buildId,
    modelId: 'pie-fixture-model',
    modelName: 'Pie Matched Host Fixture Model',
    scenarios: [...MATCHED_HOST_WORKLOAD_DEFAULTS.scenarioOrder],
    sampleCount: sampleCountPerScenario,
    measureFreshness,
    completionTokensPerSettlement: PROVIDER_USAGE.completionTokens,
    crossHostIncrement: PROVIDER_USAGE.completionTokens,
    playwrightModulePath: path.join(extensionRoot, 'node_modules', 'playwright', 'index.js'),
    timeouts: {
      sessionMs: 15_000,
      modelMs: 15_000,
      handshakeMs: 10_000,
      sendReadyMs: 5_000,
      firstMarkerMs: 15_000,
      finalTextMs: 30_000,
      terminalMs: 15_000,
      providerTerminalMs: 8_000,
      settleMs: 5_000,
      freshnessMs: 5_000,
      baselineMs: 20_000,
      crossHostMs: 15_000,
      ...timeoutOverrides,
    },
  };
}

function summarizeDriverEvidence(evidence, { arm, sampleCountPerScenario }) {
  const errors = [];
  if (!evidence || typeof evidence !== 'object') throw new Error('driver evidence is missing');
  if (evidence.status !== 'passed') errors.push(`driver status is ${evidence.status}`);
  const samples = evidence.samples ?? {};
  const latency = (scenario, key) => samples[scenario].map((sample) => sample[key]).filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const turnaround = summarizeTimingSamples(latency('turnaround', 'latencyMs'));
  const failover = summarizeTimingSamples(latency('failover', 'latencyMs'));
  const cancellation = summarizeTimingSamples(latency('cancel', 'cancellationMs'));
  const interaction = summarizeTimingSamples(evidence.interactionSamples.filter(isFiniteNonNegative));
  const streamPaint = summarizeTimingSamples([
    ...latency('turnaround', 'streamPaintMs'),
    ...latency('failover', 'streamPaintMs'),
  ]);
  const freshness = arm === 'enabled'
    ? summarizeTimingSamples(evidence.freshnessSamples.map((sample) => sample.latencyMs).filter(isFiniteNonNegative))
    : null;
  const freshnessMisses = arm === 'enabled'
    ? evidence.freshnessSamples.filter((sample) => sample.observed !== true).length
    : 0;
  for (const scenario of ['turnaround', 'failover', 'cancel']) {
    if (!Array.isArray(samples[scenario]) || samples[scenario].length !== sampleCountPerScenario) {
      errors.push(`driver ${scenario} sample count mismatch`);
    }
  }
  if (arm === 'enabled' && freshnessMisses > 0) errors.push(`${freshnessMisses} freshness observations missed their bounded wait`);
  if (errors.length > 0) throw new Error(`driver evidence is incomplete: ${errors.join('; ')}`);
  return {
    sampleCount: sampleCountPerScenario,
    agentTurnaroundP95Ms: turnaround.p95Ms,
    agentTurnaround: { ...turnaround },
    cancellationP95Ms: cancellation.p95Ms,
    cancellation: { ...cancellation },
    failoverP95Ms: failover.p95Ms,
    failover: { ...failover },
    uiInteractionP95Ms: interaction.p95Ms,
    uiInteraction: { ...interaction },
    streamPaintP95Ms: streamPaint.p95Ms,
    streamPaint: { ...streamPaint },
    ...(arm === 'enabled' ? {
      localSummaryFreshnessP95Ms: freshness.p95Ms,
      localSummaryFreshnessP99Ms: freshness.p99Ms,
      freshness: { ...freshness, misses: freshnessMisses },
    } : {}),
  };
}

function providerStateSummary(state) {
  const records = Array.isArray(state?.records) ? state.records : [];
  const byPlan = {};
  for (const record of records) {
    const plan = record.plan ?? 'unknown';
    byPlan[plan] = (byPlan[plan] ?? 0) + 1;
  }
  return {
    requestCount: records.length,
    byPlan,
    injectedFailoverCount: records.filter((record) => record.injectedFailover === true).length,
    abortedCount: records.filter((record) => record.aborted === true).length,
  };
}

// ─── Default real arm runner ─────────────────────────────────────────────────

async function runRealFixtureArm({ arm, context, registerOwnedPid, registerEmergencyStop }) {
  const { root, build, providerPort, runId, sampleCountPerScenario, idleWindowMs, telemetryIntervalMs, codePath } = context;
  const armRoot = path.join(root, 'arms', arm);
  mkdirSync(armRoot, { recursive: true });
  const port = arm === 'disabled' ? MATCHED_HOST_PORTS.disabledHost : MATCHED_HOST_PORTS.enabledHost;
  const extensionsSource = build.copiedPath;
  const extensionsDir = path.join(armRoot, 'extensions');
  const copiedExtensionDir = path.join(extensionsDir, 'pie.pie-0.3.0');
  cpSync(extensionsSource, copiedExtensionDir, { recursive: true });
  const copiedTreeSha256 = directoryTreeHash(path.join(copiedExtensionDir, 'out'));
  if (copiedTreeSha256 !== build.outputTreeSha256) {
    throw new Error(`arm ${arm} copied build tree hash does not match the canonical copy`);
  }
  const agentDir = writeArmAgentAssets({ armRoot, providerPort });
  const dataDir = path.join(agentDir, 'data');
  const { userData, workspace } = writeArmVsCodeAssets({ armRoot, agentDir, extensionsDir, port });
  const launcher = writeLauncher({ armRoot, agentDir, dataDir, userData, extensionsDir, workspace, codePath, analyticsDisabled: arm === 'disabled' });

  let activation = null;
  if (arm === 'enabled') {
    activation = await prepareCanonicalActivation({
      copiedOut: path.join(copiedExtensionDir, 'out'),
      dataDir,
      buildId: build.buildId,
      generationId: deterministicGenerationId(runId),
    });
  }

  const guard = freePhysicalBytes();
  if (guard < MATCHED_HOST_RESOURCE_GUARDS.singleHostFreePhysicalBytes) {
    throw new Error(`free physical memory is below the single-host launch guard: ${guard} bytes`);
  }
  const launchedAt = Date.now();
  const wrapper = spawn('cmd.exe', ['/c', launcher], { detached: true, stdio: 'ignore', windowsHide: true });
  const health = await waitHealthy({ port, deadlineMs: 120_000 }).catch((error) => {
    // The host can keep running even when its browser server never became
    // healthy; register it by marker so the outer emergency cleanup kills it.
    const lateRootPid = findCodeRootPid({ marker: userData, notBeforeMs: launchedAt - 2_000 });
    if (lateRootPid !== null) registerOwnedPid(lateRootPid);
    throw new Error(`arm ${arm} browser server did not become healthy: ${error instanceof Error ? error.message : String(error)}`);
  });
  let rootPid = findCodeRootPid({ marker: userData, notBeforeMs: launchedAt - 2_000 });
  if (rootPid === null) {
    // One delayed re-read: the process census can briefly lag the spawn.
    await delay(2_000);
    rootPid = findCodeRootPid({ marker: userData, notBeforeMs: launchedAt - 2_000 });
  }
  if (rootPid === null) {
    throw new Error(`arm ${arm} root Code.exe process was not found by its user-data marker`);
  }
  // Register before any later step can fail, so the outer catch always
  // force-kills the launched host even when this arm never returns a receipt.
  registerOwnedPid(rootPid);

  const sampler = startTopologySampler({
    root,
    rootPid,
    intervalMs: telemetryIntervalMs,
    maxSamples: 10_000,
  });
  registerEmergencyStop(() => sampler.stop());

  const driverPlan = buildDriverPlan({
    arm,
    runId,
    uiUrl: `http://127.0.0.1:${port}/`,
    providerUrl: `http://127.0.0.1:${providerPort}`,
    providerStatePath: context.providerStatePath,
    buildId: build.buildId,
    sampleCountPerScenario,
    measureFreshness: arm === 'enabled',
  });
  const driverPlanPath = path.join(root, `driver-plan-${arm}.json`);
  writeFileSync(driverPlanPath, `${JSON.stringify(driverPlan, null, 2)}\n`, 'utf8');
  const driverEvidencePath = path.join(root, `driver-evidence-${arm}.json`);
  const driverRun = spawnSync(process.execPath, [
    path.join(root, 'workload-driver.mjs'),
    '--plan', driverPlanPath,
    '--evidence', driverEvidencePath,
  ], { encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  registerEmergencyStop(async () => {
    // Best-effort: a timed-out driver's browser children must not outlive the
    // arm; a finished driver's pid kill is a harmless no-op.
    if (driverRun.pid) killTree(driverRun.pid);
  });
  if (driverRun.status !== 0 || !existsSync(driverEvidencePath)) {
    throw new Error(`arm ${arm} workload driver failed (exit ${driverRun.status}): ${(driverRun.stderr ?? '').slice(-2_000)}`);
  }
  if (statSync(driverEvidencePath).size > MAX_EVIDENCE_JSON_BYTES) {
    throw new Error(`arm ${arm} workload driver evidence exceeds the ${MAX_EVIDENCE_JSON_BYTES}-byte bound`);
  }
  const driverEvidence = JSON.parse(readFileSync(driverEvidencePath, 'utf8'));
  if (driverEvidence.status !== 'passed') {
    throw new Error(`arm ${arm} workload driver reported ${driverEvidence.status}: ${driverEvidence.error ?? 'unknown'}`);
  }

  const idleSamplesBefore = sampler.samples.length;
  if (freePhysicalBytes() < MATCHED_HOST_RESOURCE_GUARDS.duringRunFreePhysicalBytes) {
    throw new Error(`arm ${arm} free physical memory dropped below the during-run guard before the idle window`);
  }
  await delay(idleWindowMs);
  const idleWindowSamples = sampler.samples.slice(idleSamplesBefore);

  const samplerStop = await sampler.stop();
  const census = readProcessCensus(rootPid);
  const killReceipts = [killTree(rootPid)];
  const verified = verifyPidsGone([rootPid, ...census.map((proc) => proc.pid)]);

  const analytics = analyzeAnalyticsState({ arm, dataDir });

  const receipt = {
    arm,
    status: 'passed',
    startedAt: new Date(launchedAt).toISOString(),
    launcher,
    wrapperPid: wrapper.pid,
    rootPid,
    codePath,
    userDataDir: userData,
    extensionsDir,
    copiedExtensionDir,
    agentDir,
    dataDir,
    port,
    browserServer: { assetPath: health.assetPath, healthStatus: health.healthStatus, rootStatus: health.rootStatus, assetStatus: health.assetStatus },
    buildId: build.buildId,
    rendererBuildId: build.rendererBuildId,
    copiedTreeSha256,
    authority: arm === 'disabled' ? 'total-disabled-v1' : 'canonical-synthetic-activation',
    ...(activation ? { activation } : {}),
    analytics,
    driver: { planPath: driverPlanPath, evidencePath: driverEvidencePath, evidence: boundedEvidence(driverEvidence) },
    providerState: providerStateSummary(readProviderStateFile(context.providerStatePath)),
    telemetry: {
      sampler: { scriptPath: sampler.scriptPath, intervalMs: telemetryIntervalMs, sampleCount: samplerStop.sampleCount, stderrBytes: samplerStop.stderrText.length },
      active: summarizeTopologySamples(sampler.samples.slice(0, idleSamplesBefore), { windowMs: idleWindowMs, logicalCores: os.cpus().length }),
    },
    idle: summarizeTopologySamples(idleWindowSamples, { windowMs: idleWindowMs, logicalCores: os.cpus().length }),
    processes: { rootPid, census, killReceipts, ...verified },
    finishedAt: new Date().toISOString(),
  };
  return receipt;
}

function readProviderStateFile(providerStatePath) {
  try {
    return JSON.parse(readFileSync(providerStatePath, 'utf8'));
  } catch {
    return { requestCount: 0, records: [] };
  }
}

function boundedEvidence(evidence) {
  return {
    status: evidence.status,
    arm: evidence.arm,
    expectedBuildId: evidence.expectedBuildId,
    rendererBuildIds: [...new Set(evidence.rendererBuildIds ?? [])],
    stateFrameCount: evidence.stateFrameCount ?? 0,
    lastAggregateTokens: evidence.lastAggregateTokens ?? null,
    samples: evidence.samples,
    interactionSamples: evidence.interactionSamples,
    freshnessSamples: evidence.freshnessSamples,
    frameSeriesTail: (evidence.frameSeriesTail ?? []).slice(-64),
    crossHost: evidence.crossHost,
    startedAt: evidence.startedAt,
    finishedAt: evidence.finishedAt,
  };
}

function analyzeAnalyticsState({ dataDir }) {
  const analyticsDir = path.join(dataDir, 'analytics');
  const databasePath = path.join(analyticsDir, 'analytics.sqlite');
  const loadedReceiptPath = path.join(dataDir, 'state', 'analytics-loaded-generation-v1.json');
  let loadedGenerationReceipt = null;
  try {
    loadedGenerationReceipt = JSON.parse(readFileSync(loadedReceiptPath, 'utf8'));
  } catch {
    loadedGenerationReceipt = null;
  }
  let tableCounts = null;
  if (existsSync(databasePath)) {
    try {
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
      const database = new DatabaseSync(databasePath, { readOnly: true });
      tableCounts = {};
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'analytics_%'").all();
      for (const { name } of tables.slice(0, 32)) {
        tableCounts[name] = Number(database.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count);
      }
      database.close();
    } catch (error) {
      tableCounts = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return {
    canonicalDatabasePresent: existsSync(databasePath),
    canonicalDatabaseBytes: existsSync(databasePath) ? statSync(databasePath).size : 0,
    loadedGenerationReceiptPresent: loadedGenerationReceipt !== null,
    loadedGenerationReceipt,
    tableCounts,
  };
}

// ─── Runtime helpers ─────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePhysicalBytes() {
  return os.freemem();
}

/** Deterministic UUID derived from the run seed; the compiled ActivationStore
 * requires a UUID-shaped generationId and every activation identity in this
 * fixture must be reproducible and explicitly synthetic. */
function deterministicGenerationId(runId) {
  return deterministicUuid(`generation\0${runId}`);
}

// ─── Owned-process census ────────────────────────────────────────────────

function readProcessCensus(rootPid) {
  const script = [
    "$rootPid = [int]$args[0]",
    "$procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'Code.exe' OR Name = 'node.exe'\")",
    '$byPid = @{}',
    '$children = @{}',
    'foreach ($p in $procs) {',
    '  $id = [int]$p.ProcessId',
    '  $byPid[$id] = $p',
    '  $ppid = [int]$p.ParentProcessId',
    '  if (-not $children.ContainsKey($ppid)) { $children[$ppid] = New-Object System.Collections.Generic.List[int] }',
    '  $children[$ppid].Add($id)',
    '}',
    '$owned = New-Object System.Collections.Generic.List[object]',
    "$seen = New-Object 'System.Collections.Generic.HashSet[int]'",
    '$stack = New-Object System.Collections.Stack',
    '$stack.Push($rootPid)',
    'while ($stack.Count -gt 0) {',
    '  $current = [int]$stack.Pop()',
    '  if (-not $seen.Add($current)) { continue }',
    '  if (-not $byPid.ContainsKey($current)) { continue }',
    '  $p = $byPid[$current]',
    '  $cmd = [string]$p.CommandLine',
    "  $role = 'other'",
    "  if ($cmd -like '*--type=extension-host*') { $role = 'extension-host' }",
    "  elseif ($cmd -like '*analytics-recorder-worker*') { $role = 'analytics-recorder-worker' }",
    "  elseif ($cmd -like '*analytics-query-worker*') { $role = 'analytics-query-worker' }",
    "  elseif ($cmd -like '*worker-entry*' -or $cmd -like '*backend.js*') { $role = 'backend' }",
    "  elseif ($cmd -like '*--type=renderer*') { $role = 'renderer' }",
    "  elseif ($cmd -like '*--type=utility*') { $role = 'utility' }",
    "  elseif ($cmd -like '*--type=zygote*') { $role = 'zygote' }",
    "  elseif ($cmd -like '*--type=gpu-process*') { $role = 'gpu' }",
    "  elseif ($cmd -like '*--type=crashpad-handler*') { $role = 'crashpad' }",
    '  $owned.Add([ordered]@{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; name = [string]$p.Name; role = $role; wsBytes = [int64]$p.WorkingSetSize })',
    '  if ($children.ContainsKey($current)) { foreach ($c in $children[$current]) { $stack.Push($c) } }',
    '}',
    '($owned | ConvertTo-Json -Compress -Depth 3)',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script, String(rootPid)], {
    encoding: 'utf8', timeout: 20_000,
  });
  const output = (result.stdout ?? '').trim();
  if (output.length === 0) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ─── Fixture provider lifecycle ──────────────────────────────────────────

function startProviderServer({ root, providerPort }) {
  const serverPath = path.join(root, 'provider-server.mjs');
  writeFileSync(serverPath, PROVIDER_SERVER_SOURCE, 'utf8');
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, PIE_MATCHED_PROVIDER_PORT: String(providerPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (part) => { stderrText += part; });
  return { child, serverPath, stderrTail: () => stderrText.slice(-2_000) };
}

async function waitProviderHealthy({ provider, providerPort }) {
  const deadline = Date.now() + 15_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const health = await httpProbe(`http://127.0.0.1:${providerPort}/health`);
    if (health.status === 200) {
      let parsed = null;
      try { parsed = JSON.parse(health.body); } catch { /* non-JSON health body is a failure */ }
      if (parsed?.ok === true) return { healthStatus: 200, health: parsed };
    }
    lastStatus = health.status;
    if (provider.child.exitCode !== null) {
      throw new Error(`fixture provider exited during startup (code ${provider.child.exitCode}): ${provider.stderrTail()}`);
    }
    await delay(250);
  }
  throw new Error(`fixture provider on port ${providerPort} did not become healthy (last status ${lastStatus})`);
}

async function resetProvider(providerPort) {
  const response = await httpProbe(`http://127.0.0.1:${providerPort}/control/reset`, 5_000, { method: 'POST' });
  if (response.status !== 200) throw new Error(`fixture provider control reset failed with status ${response.status}`);
}

async function stopProvider(provider) {
  const pid = provider.child.pid;
  const kill = killTree(pid);
  const exited = await new Promise((resolve) => {
    if (provider.child.exitCode !== null || provider.child.signalCode !== null) return resolve(true);
    provider.child.once('exit', () => resolve(true));
    setTimeout(() => resolve(false), 5_000);
  });
  const gone = verifyPidsGone([pid]);
  return { pid, kill, exited, verifiedGone: gone.verifiedGone, remaining: gone.remaining };
}

// ─── Dual-host cross-host phase ──────────────────────────────────────

async function runDualHostPhase({ context, build, registerOwnedPid, registerEmergencyStop }) {
  const { root, buildId, runId, sampleCountPerScenario, idleWindowMs, telemetryIntervalMs, codePath, providerStatePath } = context;
  const phaseRoot = path.join(root, 'dual-host');
  mkdirSync(phaseRoot, { recursive: true });
  const guard = freePhysicalBytes();
  if (guard < MATCHED_HOST_RESOURCE_GUARDS.dualHostFreePhysicalBytes) {
    throw new Error(`free physical memory is below the dual-host launch guard: ${guard} bytes`);
  }
  const producerPort = MATCHED_HOST_PORTS.enabledHost;
  const observerPort = MATCHED_HOST_PORTS.enabledSecondHost;

  // The observer host gets its own VS Code user-data and its own identical
  // extension copy, but shares the producer arm's canonical agent data root,
  // so its summary must reflect the producer's settlement through the shared
  // projection revision.
  const producerArmRoot = path.join(root, 'arms', 'enabled');
  const sharedAgentDir = path.join(producerArmRoot, 'agent');
  const observerRoot = path.join(phaseRoot, 'observer');
  mkdirSync(observerRoot, { recursive: true });
  const observerExtensionsDir = path.join(observerRoot, 'extensions');
  const observerCopiedExtensionDir = path.join(observerExtensionsDir, 'pie.pie-0.3.0');
  cpSync(build.copiedPath, observerCopiedExtensionDir, { recursive: true });
  const observerTreeSha256 = directoryTreeHash(path.join(observerCopiedExtensionDir, 'out'));
  if (observerTreeSha256 !== build.outputTreeSha256) {
    throw new Error('dual-host observer copied build tree hash does not match the canonical copy');
  }
  const observerVsCode = writeArmVsCodeAssets({ armRoot: observerRoot, agentDir: sharedAgentDir, extensionsDir: observerExtensionsDir, port: observerPort });
  const observerLauncher = writeLauncher({
    armRoot: observerRoot,
    agentDir: sharedAgentDir,
    dataDir: path.join(sharedAgentDir, 'data'),
    userData: observerVsCode.userData,
    extensionsDir: observerExtensionsDir,
    workspace: observerVsCode.workspace,
    codePath,
    analyticsDisabled: false,
  });

  await resetProvider(MATCHED_HOST_PORTS.provider);

  const launchedAt = Date.now();
  const producerWrapper = spawn('cmd.exe', ['/c', path.join(producerArmRoot, 'launch-enabled.cmd')], { detached: true, stdio: 'ignore', windowsHide: true });
  const producerHealth = await waitHealthy({ port: producerPort, deadlineMs: 120_000 }).catch((error) => {
    const lateRootPid = findCodeRootPid({ marker: path.join(producerArmRoot, 'user-data'), notBeforeMs: launchedAt - 2_000 });
    if (lateRootPid !== null) registerOwnedPid(lateRootPid);
    throw new Error(`dual-host producer browser server did not become healthy: ${error instanceof Error ? error.message : String(error)}`);
  });
  let producerRootPid = findCodeRootPid({ marker: path.join(producerArmRoot, 'user-data'), notBeforeMs: launchedAt - 2_000 });
  if (producerRootPid === null) {
    await delay(2_000);
    producerRootPid = findCodeRootPid({ marker: path.join(producerArmRoot, 'user-data'), notBeforeMs: launchedAt - 2_000 });
  }
  if (producerRootPid === null) throw new Error('dual-host producer root Code.exe process was not found by its user-data marker');
  registerOwnedPid(producerRootPid);

  const observerWrapper = spawn('cmd.exe', ['/c', observerLauncher], { detached: true, stdio: 'ignore', windowsHide: true });
  const observerHealth = await waitHealthy({ port: observerPort, deadlineMs: 120_000 }).catch((error) => {
    const lateRootPid = findCodeRootPid({ marker: observerVsCode.userData, notBeforeMs: launchedAt - 2_000 });
    if (lateRootPid !== null) registerOwnedPid(lateRootPid);
    throw new Error(`dual-host observer browser server did not become healthy: ${error instanceof Error ? error.message : String(error)}`);
  });
  let observerRootPid = findCodeRootPid({ marker: observerVsCode.userData, notBeforeMs: launchedAt - 2_000 });
  if (observerRootPid === null) {
    await delay(2_000);
    observerRootPid = findCodeRootPid({ marker: observerVsCode.userData, notBeforeMs: launchedAt - 2_000 });
  }
  if (observerRootPid === null) throw new Error('dual-host observer root Code.exe process was not found by its user-data marker');
  registerOwnedPid(observerRootPid);

  const producerSampler = startTopologySampler({ root: phaseRoot, rootPid: producerRootPid, intervalMs: telemetryIntervalMs, maxSamples: 600 });
  const observerSampler = startTopologySampler({ root: phaseRoot, rootPid: observerRootPid, intervalMs: telemetryIntervalMs, maxSamples: 600 });
  registerEmergencyStop(() => producerSampler.stop());
  registerEmergencyStop(() => observerSampler.stop());

  // The observer driver starts first: it captures its baseline aggregate
  // summary before the producer's extra settlement can raise the shared total.
  const observerPlan = buildDriverPlan({
    arm: 'enabled-observer',
    mode: 'cross-host-observer',
    runId,
    uiUrl: `http://127.0.0.1:${observerPort}/`,
    providerUrl: `http://127.0.0.1:${MATCHED_HOST_PORTS.provider}`,
    providerStatePath,
    buildId,
    sampleCountPerScenario,
    measureFreshness: false,
    timeoutOverrides: { baselineMs: 30_000, crossHostMs: 60_000 },
  });
  const observerPlanPath = path.join(phaseRoot, 'driver-plan-observer.json');
  writeFileSync(observerPlanPath, `${JSON.stringify(observerPlan, null, 2)}\n`, 'utf8');
  const observerEvidencePath = path.join(phaseRoot, 'driver-evidence-observer.json');
  const observerChild = spawn(process.execPath, [path.join(root, 'workload-driver.mjs'), '--plan', observerPlanPath, '--evidence', observerEvidencePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  registerEmergencyStop(async () => {
    // A failed phase must not leave the observer driver or its Chromium tree
    // running; a finished driver kill is a harmless no-op.
    if (observerChild.exitCode === null && observerChild.signalCode === null) {
      killTree(observerChild.pid);
    }
  });
  let observerStdout = '';
  let observerStderr = '';
  observerChild.stdout.setEncoding('utf8');
  observerChild.stdout.on('data', (part) => { observerStdout += part; });
  observerChild.stderr.setEncoding('utf8');
  observerChild.stderr.on('data', (part) => { observerStderr += part; });

  // Wait for the observer's READY baseline before sending the extra prompt.
  const readyDeadline = Date.now() + (10_000 + 30_000 + 15_000);
  let baseline = null;
  while (Date.now() < readyDeadline && baseline === null) {
    const match = /READY baseline=(\d+)/u.exec(observerStdout);
    if (match) baseline = Number(match[1]);
    else await delay(200);
  }
  if (baseline === null) {
    throw new Error(`cross-host observer did not report its baseline summary within its budget: ${(observerStderr || observerStdout).slice(-2_000)}`);
  }

  const producerPlan = buildDriverPlan({
    arm: 'enabled-producer',
    mode: 'cross-host-producer',
    runId,
    uiUrl: `http://127.0.0.1:${producerPort}/`,
    providerUrl: `http://127.0.0.1:${MATCHED_HOST_PORTS.provider}`,
    providerStatePath,
    buildId,
    sampleCountPerScenario,
    measureFreshness: false,
  });
  const producerPlanPath = path.join(phaseRoot, 'driver-plan-producer.json');
  writeFileSync(producerPlanPath, `${JSON.stringify(producerPlan, null, 2)}\n`, 'utf8');
  const producerEvidencePath = path.join(phaseRoot, 'driver-evidence-producer.json');
  const producerRun = spawnSync(process.execPath, [path.join(root, 'workload-driver.mjs'), '--plan', producerPlanPath, '--evidence', producerEvidencePath],
    { encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  registerEmergencyStop(async () => {
    if (producerRun.pid) killTree(producerRun.pid);
  });
  if (producerRun.status !== 0 || !existsSync(producerEvidencePath)) {
    throw new Error(`cross-host producer driver failed (exit ${producerRun.status}): ${(producerRun.stderr ?? '').slice(-2_000)}`);
  }
  if (statSync(producerEvidencePath).size > MAX_EVIDENCE_JSON_BYTES) throw new Error('cross-host producer evidence exceeds the evidence byte bound');
  const producerEvidence = JSON.parse(readFileSync(producerEvidencePath, 'utf8'));
  if (producerEvidence.status !== 'passed') {
    throw new Error(`cross-host producer driver reported ${producerEvidence.status}: ${producerEvidence.error ?? 'unknown'}`);
  }
  const extraSettlement = (producerEvidence.samples?.turnaround ?? [])
    .find((sample) => String(sample.marker ?? '').endsWith('-extra') && typeof sample.settlementCompletedAtMs === 'number');
  if (!extraSettlement) throw new Error('cross-host producer extra settlement was not recorded');

  const observerExit = await new Promise((resolve) => {
    const deadline = Date.now() + 90_000;
    const poll = () => {
      if (observerChild.exitCode !== null || observerChild.signalCode !== null) resolve(true);
      else if (Date.now() > deadline) resolve(false);
      else setTimeout(poll, 250);
    };
    observerChild.once('exit', () => resolve(true));
    poll();
  });
  if (!observerExit || !existsSync(observerEvidencePath)) {
    throw new Error(`cross-host observer driver did not finish (exit ${observerChild.exitCode}): ${(observerStderr || observerStdout).slice(-2_000)}`);
  }
  if (statSync(observerEvidencePath).size > MAX_EVIDENCE_JSON_BYTES) throw new Error('cross-host observer evidence exceeds the evidence byte bound');
  const observerEvidence = JSON.parse(readFileSync(observerEvidencePath, 'utf8'));
  if (observerEvidence.status !== 'passed') {
    throw new Error(`cross-host observer driver reported ${observerEvidence.status}: ${observerEvidence.error ?? 'unknown'}`);
  }
  const crossHost = observerEvidence.crossHost;
  if (!crossHost || crossHost.observed !== true || typeof crossHost.frameAtMs !== 'number') {
    throw new Error('cross-host summary refresh was not observed through the shared projection revision');
  }
  if (crossHost.baselineTokens !== baseline) throw new Error('cross-host observer baseline changed between READY and its evidence');
  const crossHostSummaryFreshnessMs = Math.max(0, crossHost.frameAtMs - extraSettlement.settlementCompletedAtMs);

  const producerSamplerStop = await producerSampler.stop();
  const observerSamplerStop = await observerSampler.stop();
  const producerCensus = readProcessCensus(producerRootPid);
  const observerCensus = readProcessCensus(observerRootPid);
  const producerKill = killTree(producerRootPid);
  const observerKill = killTree(observerRootPid);
  const verified = verifyPidsGone([
    producerRootPid, observerRootPid,
    ...producerCensus.map((proc) => proc.pid),
    ...observerCensus.map((proc) => proc.pid),
  ]);
  if (!verified.verifiedGone) {
    throw new Error(`dual-host processes were not verified gone: ${verified.remaining.join(', ')}`);
  }

  return {
    status: 'passed',
    startedAt: new Date(launchedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    producerPort,
    observerPort,
    producer: { rootPid: producerRootPid, wrapperPid: producerWrapper.pid, browserServer: producerHealth },
    observer: {
      rootPid: observerRootPid,
      wrapperPid: observerWrapper.pid,
      launcher: observerLauncher,
      userDataDir: observerVsCode.userData,
      extensionsDir: observerExtensionsDir,
      copiedTreeSha256: observerTreeSha256,
      browserServer: observerHealth,
    },
    crossHostSummaryFreshnessMs,
    crossHostEvidence: {
      baselineTokens: crossHost.baselineTokens,
      observed: crossHost.observed,
      observedTokens: crossHost.observedTokens,
      frameAtMs: crossHost.frameAtMs,
      producerSettlementCompletedAtMs: extraSettlement.settlementCompletedAtMs,
      producerMarker: extraSettlement.marker,
      observerWaitLatencyMs: crossHost.latencyMs,
    },
    driver: {
      observerPlanPath,
      observerEvidencePath,
      producerPlanPath,
      producerEvidencePath,
      observerEvidence: boundedEvidence(observerEvidence),
      producerEvidence: boundedEvidence(producerEvidence),
    },
    telemetry: {
      producer: summarizeTopologySamples(producerSampler.samples, { windowMs: idleWindowMs, logicalCores: os.cpus().length }),
      observer: summarizeTopologySamples(observerSampler.samples, { windowMs: idleWindowMs, logicalCores: os.cpus().length }),
      sampler: {
        producer: { sampleCount: producerSamplerStop.sampleCount, stderrBytes: producerSamplerStop.stderrText.length },
        observer: { sampleCount: observerSamplerStop.sampleCount, stderrBytes: observerSamplerStop.stderrText.length },
      },
    },
    processes: { killReceipts: [producerKill, observerKill], ...verified },
  };
}

// ─── Telemetry aggregation ──────────────────────────────────────────────

export function summarizeMatchedTelemetry({ arms, dual, idleMinimumSamples, logicalCores }) {
  const armTelemetry = (receipt) => {
    const idle = receipt.idle ?? {};
    const active = receipt.telemetry?.active ?? {};
    return {
      idleSampleCount: idle.sampleCount ?? 0,
      idleCpuOneCorePercentMean: idle.cpuOneCorePercentMean ?? null,
      helperIdleCpuOneCorePercentMean: idle.helperCpuOneCorePercentMean ?? null,
      idleRssMedianBytes: idle.rssMedianBytes ?? null,
      activeSampleCount: active.sampleCount ?? 0,
      activeCpuOneCorePercentMean: active.cpuOneCorePercentMean ?? null,
    };
  };
  const disabled = armTelemetry(arms.disabled);
  const enabled = armTelemetry(arms.enabled);
  const idleAnalyticsCpuOneCorePercent = enabled.idleCpuOneCorePercentMean !== null
    && disabled.idleCpuOneCorePercentMean !== null
    ? Math.max(0, enabled.idleCpuOneCorePercentMean - disabled.idleCpuOneCorePercentMean)
    : null;
  const incrementalRetainedHostBytes = enabled.idleRssMedianBytes !== null
    && disabled.idleRssMedianBytes !== null
    ? Math.max(0, enabled.idleRssMedianBytes - disabled.idleRssMedianBytes)
    : null;
  const dualProducer = dual.telemetry?.producer ?? {};
  const dualObserver = dual.telemetry?.observer ?? {};
  const nativeTelemetryComplete = [disabled, enabled].every((entry) =>
    entry.idleSampleCount >= idleMinimumSamples
    && entry.idleCpuOneCorePercentMean !== null
    && entry.idleRssMedianBytes !== null
    && entry.activeCpuOneCorePercentMean !== null)
    && (dualProducer.sampleCount ?? 0) > 0
    && (dualObserver.sampleCount ?? 0) > 0;
  return {
    logicalCores,
    idleMinimumSamples,
    idleAnalyticsCpuOneCorePercent,
    incrementalRetainedHostBytes,
    nativeTelemetryComplete,
    disabled,
    enabled,
    dual: { producer: dualProducer, observer: dualObserver },
  };
}

function sameDriverPlanShape(leftPath, rightPath) {
  const strip = (plan) => {
    const rest = { ...plan };
    delete rest.arm;
    delete rest.mode;
    delete rest.uiUrl;
    delete rest.measureFreshness;
    return rest;
  };
  const left = JSON.parse(readFileSync(leftPath, 'utf8'));
  const right = JSON.parse(readFileSync(rightPath, 'utf8'));
  return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
}

function buildMatchedHostResults({ arms, dual, telemetry, context, build }) {
  const disabledMetrics = summarizeDriverEvidence(arms.disabled.driver.evidence, { arm: 'disabled', sampleCountPerScenario: context.sampleCountPerScenario });
  const enabledMetrics = summarizeDriverEvidence(arms.enabled.driver.evidence, { arm: 'enabled', sampleCountPerScenario: context.sampleCountPerScenario });
  const samePlanShape = sameDriverPlanShape(arms.disabled.driver.planPath, arms.enabled.driver.planPath);
  const sameProviderCounts = JSON.stringify(arms.disabled.providerState.byPlan) === JSON.stringify(arms.enabled.providerState.byPlan);
  const sameHostBuildConfig = arms.disabled.buildId === arms.enabled.buildId
    && arms.disabled.buildId === build.buildId
    && arms.disabled.copiedTreeSha256 === arms.enabled.copiedTreeSha256
    && arms.enabled.copiedTreeSha256 === build.outputTreeSha256;
  const sameWorkload = samePlanShape && sameProviderCounts
    && arms.disabled.driver.evidence.samples.turnaround.length === arms.enabled.driver.evidence.samples.turnaround.length;
  return {
    sampleCount: context.sampleCountPerScenario,
    disabled: {
      ...disabledMetrics,
      activeCaptureCpuOneCorePercent: telemetry.disabled.activeCpuOneCorePercentMean,
      idleCpuOneCorePercent: telemetry.disabled.idleCpuOneCorePercentMean,
      helperIdleCpuOneCorePercentMean: telemetry.disabled.helperIdleCpuOneCorePercentMean,
      idleTopologyRssMedianBytes: telemetry.disabled.idleRssMedianBytes,
    },
    enabled: {
      ...enabledMetrics,
      crossHostSummaryFreshnessMs: dual.crossHostSummaryFreshnessMs,
      activeCaptureCpuOneCorePercent: telemetry.enabled.activeCpuOneCorePercentMean,
      idleAnalyticsCpuOneCorePercent: telemetry.idleAnalyticsCpuOneCorePercent,
      idleCpuOneCorePercent: telemetry.enabled.idleCpuOneCorePercentMean,
      helperIdleCpuOneCorePercentMean: telemetry.enabled.helperIdleCpuOneCorePercentMean,
      idleTopologyRssMedianBytes: telemetry.enabled.idleRssMedianBytes,
      incrementalRetainedHostBytes: telemetry.incrementalRetainedHostBytes,
    },
    sameWorkload,
    sameHostBuildConfig,
    nativeTelemetryComplete: telemetry.nativeTelemetryComplete,
  };
}

// ─── Report writing + orchestration ──────────────────────────────────

function removeFixtureRoot(root) {
  const errors = [];
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  } catch (error) {
    errors.push(`fixture root removal failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rootRemoved = !existsSync(root);
  if (!rootRemoved) errors.push('fixture root still exists after removal');
  return { completed: rootRemoved && errors.length === 0, rootCreated: true, rootRemoved, rootPath: root, errors };
}

function writeAtomically(filePath, report) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    // Publish without a check-then-replace race: link creation fails if another
    // process has already claimed the evidence path.
    linkSync(temporary, filePath);
  } finally {
    try { unlinkSync(temporary); } catch { /* temporary may not have been created */ }
  }
}

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
    else if (name === '--code-path') options.codePath = value;
    else throw new Error(`Unsupported option: ${name}`);
  }
  if (typeof options.seed !== 'string' || !SEED_PATTERN.test(options.seed)) {
    throw new Error('--seed is required and must use 1-128 letters, digits, dots, underscores, or hyphens');
  }
  if (typeof options.report !== 'string' || !path.isAbsolute(options.report)
    || !options.report.toLowerCase().endsWith('.json')) {
    throw new Error('--report must be an absolute new .json path');
  }
  options.report = path.resolve(options.report);
  if (existsSync(options.report)) throw new Error('--report must name a new file');
  if (typeof options.codePath !== 'string') options.codePath = DEFAULT_CODE_PATH;
  if (!existsSync(options.codePath)) throw new Error(`--code-path does not exist: ${options.codePath}`);
  return options;
}

async function runMatchedHostMeasurement(options) {
  const startedAt = isoNow();
  const runId = `${options.seed}-${Date.now().toString(36)}`;
  const root = mkdtempSync(path.join(tmpdir(), 'pie-p0-matched-host-'));
  let provider = null;
  const ownedHostRootPids = [];
  const emergencyStops = [];
  try {
    for (const [role, port] of Object.entries(MATCHED_HOST_PORTS)) {
      if (portInUse(port)) throw new Error(`fixture ${role} port ${port} is already in use; refusing to start`);
    }
    if (!existsSync(options.codePath)) throw new Error(`--code-path does not exist: ${options.codePath}`);
    if (!existsSync(path.join(extensionRoot, 'node_modules', 'playwright', 'index.js'))) {
      throw new Error('repository Playwright module is missing');
    }
    const entryGuard = freePhysicalBytes();
    if (entryGuard < MATCHED_HOST_RESOURCE_GUARDS.entryFreePhysicalBytes) {
      throw new Error(`free physical memory is below the entry guard: ${entryGuard} bytes`);
    }

    const build = copyBuildInto(root);
    const providerPort = MATCHED_HOST_PORTS.provider;
    provider = startProviderServer({ root, providerPort });
    const providerPid = provider.child.pid;
    const providerStart = await waitProviderHealthy({ provider, providerPort });
    writeFileSync(path.join(root, 'workload-driver.mjs'), DRIVER_SOURCE, 'utf8');

    const context = {
      root,
      build,
      runId,
      providerPort,
      providerStatePath: path.join(root, 'server-state.json'),
      sampleCountPerScenario: MATCHED_HOST_WORKLOAD_DEFAULTS.sampleCountPerScenario,
      idleWindowMs: MATCHED_HOST_WORKLOAD_DEFAULTS.idleWindowMs,
      telemetryIntervalMs: MATCHED_HOST_WORKLOAD_DEFAULTS.telemetryIntervalMs,
      codePath: options.codePath,
    };

    const registerOwnedPid = (pid) => ownedHostRootPids.push(pid);
    const registerEmergencyStop = (stop) => emergencyStops.push(stop);
    const arms = {};
    for (const arm of ['disabled', 'enabled']) {
      await resetProvider(providerPort);
      const receipt = await runRealFixtureArm({ arm, context, registerOwnedPid, registerEmergencyStop });
      const receiptErrors = validateArmReceipt(receipt, {
        arm,
        buildId: build.buildId,
        copiedTreeSha256: build.outputTreeSha256,
        sampleCountPerScenario: context.sampleCountPerScenario,
        scenarios: [...MATCHED_HOST_WORKLOAD_DEFAULTS.scenarioOrder],
        idleWindowMs: context.idleWindowMs,
        telemetryIntervalMs: context.telemetryIntervalMs,
      });
      if (receiptErrors.length > 0) throw new Error(`arm ${arm} receipt is invalid: ${receiptErrors.join('; ')}`);
      arms[arm] = receipt;
      ownedHostRootPids.push(receipt.rootPid);
    }

    const dual = await runDualHostPhase({ context, build, registerOwnedPid, registerEmergencyStop });
    ownedHostRootPids.push(dual.producer.rootPid, dual.observer.rootPid);

    const providerStop = await stopProvider(provider);
    provider = null;
    if (!providerStop.verifiedGone) {
      throw new Error(`fixture provider process was not verified gone: ${providerStop.remaining.join(', ')}`);
    }

    const idleMinimumSamples = Math.floor(context.idleWindowMs / context.telemetryIntervalMs) - 2;
    const telemetry = summarizeMatchedTelemetry({ arms, dual, idleMinimumSamples, logicalCores: os.cpus().length });
    const matchedHost = buildMatchedHostResults({ arms, dual, telemetry, context, build });

    const gates = evaluateMatchedHostGates(matchedHost);
    if (!gates.passed) {
      throw new Error(`matched-host measured gates did not pass: ${gates.failedGates.join(', ')}`);
    }

    const provenance = collectArtifactProvenance();
    if (!provenance.valid) {
      throw new Error(`provenance is not valid: ${provenance.errors.join('; ')}`);
    }

    const cleanup = removeFixtureRoot(root);
    if (!cleanup.completed) throw new Error(`cleanup is incomplete: ${cleanup.errors.join('; ')}`);
    const finishedAt = isoNow();
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      kind: REPORT_KIND,
      harnessVersion: HARNESS_VERSION,
      status: 'passed',
      generatedAt: startedAt,
      finishedAt,
      configuration: {
        scenario: MATCHED_HOST_SCENARIO,
        rows: null,
        seed: options.seed,
        reportPath: options.report,
        runId,
        codePath: options.codePath,
        buildId: build.buildId,
        ports: MATCHED_HOST_PORTS,
        sampleCountPerScenario: context.sampleCountPerScenario,
        idleWindowMs: context.idleWindowMs,
        telemetryIntervalMs: context.telemetryIntervalMs,
        scenarioOrder: [...MATCHED_HOST_WORKLOAD_DEFAULTS.scenarioOrder],
        fixtureRoot: root,
      },
      provenance,
      results: { matchedHost },
      measurement: {
        completed: true,
        startedAt,
        finishedAt,
        provider: {
          port: providerPort,
          serverPath: path.join(root, 'provider-server.mjs'),
          pid: providerPid,
          start: providerStart,
          stop: providerStop,
        },
        arms,
        dualHost: dual,
        telemetry,
      },
      cleanup,
      qualification: {
        scenario: MATCHED_HOST_SCENARIO,
        decision: 'scenario-passed',
        failedGates: [],
        overallP0: 'unqualified',
      },
    };
    const envelopeErrors = validateMatchedHostEnvelope(report);
    if (envelopeErrors.length > 0) {
      throw new Error(`report envelope is invalid: ${envelopeErrors.join('; ')}`);
    }
    writeAtomically(options.report, report);
    console.log(JSON.stringify({
      reportPath: options.report,
      qualification: report.qualification,
      fingerprint: provenance.fingerprint,
      matchedHost: {
        sampleCount: matchedHost.sampleCount,
        sameWorkload: matchedHost.sameWorkload,
        sameHostBuildConfig: matchedHost.sameHostBuildConfig,
        nativeTelemetryComplete: matchedHost.nativeTelemetryComplete,
      },
    }, null, 2));
  } catch (error) {
    const cleanupErrors = [];
    if (provider) {
      try {
        const stop = await stopProvider(provider);
        if (!stop.verifiedGone) cleanupErrors.push(`provider process survived cleanup: ${stop.remaining.join(', ')}`);
      } catch (stopError) {
        cleanupErrors.push(`provider stop failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`);
      }
    }
    for (const pid of ownedHostRootPids) {
      try { killTree(pid); } catch { /* best-effort; verified below */ }
    }
    const remaining = verifyPidsGone(ownedHostRootPids);
    if (!remaining.verifiedGone) cleanupErrors.push(`host processes survived cleanup: ${remaining.remaining.join(', ')}`);
    for (const stop of emergencyStops.splice(0)) {
      try { await stop(); } catch (stopError) {
        cleanupErrors.push(`emergency stop failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`);
      }
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    } catch (removeError) {
      cleanupErrors.push(`fixture root removal failed: ${removeError instanceof Error ? removeError.message : String(removeError)}`);
    }
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const suffix = cleanupErrors.length > 0 ? `\ncleanup errors: ${cleanupErrors.join('; ')}` : '';
    console.error(`matched-host measurement failed: ${message}${suffix}`);
    process.exitCode = 1;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await runMatchedHostMeasurement(options);
}

if (path.basename(process.argv[1] ?? '') === 'analytics-p0-matched-host.mjs'
  && import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}