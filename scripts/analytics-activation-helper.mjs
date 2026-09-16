#!/usr/bin/env node
// One-shot analytics activation helper.
//
// Owns the finite activation cutover, the controlled restart request and the
// post-restart report. It is designed to be launched detached with `--detach`,
// so it keeps running when the terminal or agent session that started it exits,
// and to be safe to re-run at any point because every phase is idempotent and
// the phase record is written durably before the phase is attempted.
//
// What it deliberately does NOT do:
//   - write source or Git. Committing the activation evidence is a separate,
//     reviewed step. It only writes its own phase record and report.
//   - invent a storage-outage policy, shorten retention, or touch caller files.
//   - force-kill the VS Code process tree. The restart is requested through the
//     supported command and the helper verifies the outcome rather than assuming
//     it.
//
// Phases, each recorded before it runs so an interruption is observable:
//   prepare         validate inputs, resolve paths, hash the evidence reports
//   activate        write candidate -> ready -> active via the activation sequence
//   restart         request a quiet reload and record the request
//   verify          confirm the loaded generation matches the activated one
//   report          write the sanitized report and exit
//
// Usage:
//   node scripts/analytics-activation-helper.mjs --plan <plan.json> [--detach]
//   node scripts/analytics-activation-helper.mjs --preflight --plan <plan.json>
//   node scripts/analytics-activation-helper.mjs --status --state <stateDir>
//
// `--preflight`/`--dry-run` is always read-only. A plan with a distinct
// `cutoverMode: "analytics-activation"` or `cutoverMode: "storage-cutoff"`
// and the explicit authorization/prerequisite envelope selects the production
// all-host orchestrator; it must be launched detached and never falls back to
// the legacy helper path.
//
// The plan file is JSON:
// {
//   "stateDir":        "<resolved state dir owning the activation manifest>",
//   "qualificationReport": "<absolute path to the accepted qualification report>",
//   "trialReport":     "<absolute path to the isolated candidate-trial report>",
//   "generationId":    "<uuid for this generation>",
//   "buildId":         "<host + renderer build id this generation was validated against>",
//   "sourceHead":      "<40-character Git source head used by both reports>",
//   "sourceFingerprint":"<qualification provenance fingerprint>",
//   "reportPath":      "<absolute path for the sanitized activation report>",
//   "restartCommand":  "<optional; omit to activate without requesting a restart>",
//   "cutoverMode":     "analytics-activation | storage-cutoff",
//   "cutoffInventory": ["<validated lifecycle session id>"],
//   "cutoffInventoryValidated": true,
//   "cutoffRoots":     { "sessions": "<absolute final root>", "artifacts": "<absolute final root>" },
//   "analyticsDatabasePath": "<absolute canonical analytics.sqlite path>",
//   "workspaceId":     "<analytics workspace identity>",
//   "runtimeRootPath": "<extension>/pie-runtime",
//   "runtimeIdentity": { "publisher": "...", "name": "...", "version": "..." },
//   "hostHandoffKeys":     { "<hostInstanceId>": "<per-boot key>" },
//   "hostHandoffKeysPath": "<owner-controlled per-host key file; re-read at probe time>",
//   "terminalRestartReceiptPath": "<durable terminal restart receipt>"
// }
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  readLoadedGeneration,
  waitForFreshLoadedGeneration,
} from './analytics-activation-recovery.mjs';
import { sendBoundedAnalyticsFrame, sendBoundedAnalyticsFrameWithStallRetry, retryStalledAnalyticsDiscovery } from './analytics-handoff-transport.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..');
const outRoot = path.join(repositoryRoot, 'extension', 'out');

const PHASES = ['prepare', 'activate', 'cutoff', 'restart', 'verify', 'report'];
const STORAGE_CUTOFF_AUTHORIZATION_ENV = 'PIE_STORAGE_CUTOFF_AUTHORIZATION';
const STORAGE_CUTOFF_AUTHORIZATION_VALUE = 'p7b-authorized-v1';
const MAX_HANDOFF_RECEIPT_BYTES = 256 * 1024;
const PHASE_LOCK_FILENAME = '.analytics-activation-helper-v1.lock';
const PHASE_LOCK_TIMEOUT_MS = 5_000;
const PHASE_LOCK_RETRY_MS = 25;
const ATOMIC_WRITE_TIMEOUT_MS = 5_000;
const TERMINAL_RESTART_WAIT_MS = 30_000;
const LEGACY_TERMINAL_RESTART_RECEIPT_FILENAME = 'analytics-terminal-restart-receipt-v1.json';
// The receipt is written only after the production all-host coordinator has
// returned its durable fenced receipt. A plan-provided JSON file is never
// accepted as a substitute for that producer.
const PRODUCTION_HANDOFF_RECEIPT_KIND = 'pie-analytics-all-host-handoff-v1';
const PROVISIONAL_P0_AUTHORIZATION = 'approved-provisional-p0-envelope-v1';

function fail(message) {
  process.stderr.write(`analytics-activation-helper: ${message}\n`);
  process.exit(1);
}

/** Legacy restarts use the nonce only to correlate the diagnostic loaded
 * marker. The receipt destination is still supplied so the host's strict
 * nonce+path contract cannot turn that diagnostic restart into a startup
 * failure; the legacy flow never uses this receipt as completion evidence. */
export function createLegacyRestartEnvironment(plan, restartNonce) {
  return {
    ...process.env,
    PIE_ANALYTICS_RESTART_NONCE: restartNonce,
    PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH: path.join(
      plan.stateDir,
      LEGACY_TERMINAL_RESTART_RECEIPT_FILENAME,
    ),
  };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error?.code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

function readPhaseLockOwner(lockPath) {
  if (!existsSync(lockPath)) return undefined;
  let value;
  try {
    value = JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
  } catch (error) {
    fail(`activation operation lock is corrupt; refusing stale-owner recovery: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object'
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.token !== 'string' || value.token.length === 0
    || typeof value.operationId !== 'string' || value.operationId.length === 0
    || !Number.isSafeInteger(value.acquiredAtMs)) {
    fail('activation operation lock owner is malformed; refusing stale-owner recovery.');
  }
  return value;
}

function tryPublishPhaseLock(lockPath, owner) {
  const candidatePath = `${lockPath}.candidate-${owner.token}`;
  try {
    mkdirSync(candidatePath, { mode: 0o700 });
    writeFileSync(path.join(candidatePath, 'owner.json'), `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(candidatePath, lockPath);
    return true;
  } catch (error) {
    rmSync(candidatePath, { recursive: true, force: true });
    const code = error?.code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') return false;
    throw error;
  }
}

async function acquirePhaseLock(stateDir, operationId) {
  mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, PHASE_LOCK_FILENAME);
  const owner = {
    schemaVersion: 1,
    pid: process.pid,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    operationId,
    acquiredAtMs: Date.now(),
  };
  const deadline = Date.now() + PHASE_LOCK_TIMEOUT_MS;
  for (;;) {
    if (tryPublishPhaseLock(lockPath, owner)) {
      return {
        release() {
          const current = readPhaseLockOwner(lockPath);
          if (!current) return;
          if (current.token !== owner.token || current.pid !== owner.pid) {
            throw new Error('activation operation lock ownership changed before release.');
          }
          rmSync(lockPath, { recursive: true, force: false });
        },
      };
    }
    const current = readPhaseLockOwner(lockPath);
    if (current && !processIsAlive(current.pid)) {
      rmSync(lockPath, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error('Timed out acquiring the activation operation lock.');
    await new Promise((resolve) => setTimeout(resolve, PHASE_LOCK_RETRY_MS));
  }
}

function parseArguments(argv) {
  const options = { detach: false, status: false, preflight: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--detach') { options.detach = true; continue; }
    if (argument === '--status') { options.status = true; continue; }
    if (argument === '--preflight' || argument === '--dry-run') { options.preflight = true; continue; }
    if (argument === '--plan') { options.plan = argv[++index]; continue; }
    if (argument === '--state') { options.state = argv[++index]; continue; }
    fail(`unsupported argument: ${argument}`);
  }
  return options;
}

function loadPlan(planPath, { preflight = false } = {}) {
  if (!planPath) fail('--plan is required');
  if (!path.isAbsolute(planPath)) fail('--plan must be an absolute path');
  if (!existsSync(planPath)) fail(`plan file does not exist: ${planPath}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (error) {
    fail(`plan file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const storageOnly = parsed.cutoverMode === 'storage-cutoff';
  const requiredFields = preflight
    ? ['stateDir']
    : storageOnly
      ? ['stateDir', 'generationId', 'buildId']
      : ['stateDir', 'qualificationReport', 'trialReport', 'generationId', 'buildId', 'sourceHead', 'sourceFingerprint', 'reportPath'];
  for (const field of requiredFields) {
    if (typeof parsed[field] !== 'string' || parsed[field].trim().length === 0) {
      fail(`plan.${field} must be a non-empty string`);
    }
  }
  const absoluteFields = preflight
    ? ['stateDir']
    : storageOnly
      ? ['stateDir']
      : ['stateDir', 'qualificationReport', 'trialReport', 'reportPath'];
  for (const field of absoluteFields) {
    if (!path.isAbsolute(parsed[field])) fail(`plan.${field} must be an absolute path`);
  }
  if (parsed.hostHandoffKeysPath !== undefined
    && (typeof parsed.hostHandoffKeysPath !== 'string'
      || !path.isAbsolute(parsed.hostHandoffKeysPath))) {
    fail('plan.hostHandoffKeysPath must be an absolute path when present');
  }
  // Non-enumerable: the plan file is re-read at probe time for the per-host
  // key channel, but the path must never leak into serialized evidence.
  Object.defineProperty(parsed, 'planPath', { value: planPath, enumerable: false });
  return parsed;
}

/** Durable phase record. Written before each phase is attempted, so a killed
 * helper leaves the phase it had entered rather than appearing complete. */
function phaseRecordPath(stateDir) {
  return path.join(stateDir, 'analytics-activation-phases.json');
}

function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    const deadline = Date.now() + ATOMIC_WRITE_TIMEOUT_MS;
    let delayMs = 25;
    for (;;) {
      try {
        renameSync(temporary, filePath);
        break;
      } catch (error) {
        const code = error?.code;
        if ((code !== 'EACCES' && code !== 'EBUSY' && code !== 'EPERM') || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
        delayMs = Math.min(delayMs * 2, 500);
      }
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readPhaseRecord(stateDir) {
  const filePath = phaseRecordPath(stateDir);
  if (!existsSync(filePath)) return { schemaVersion: 1, phases: [], lastError: null };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.phases)) {
      fail('activation phase record is malformed; refusing to continue');
    }
    return parsed;
  } catch (error) {
    fail(`activation phase record is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function appendPhase(stateDir, phase, detail) {
  const record = readPhaseRecord(stateDir);
  record.phases.push({ phase, at: new Date().toISOString(), detail: detail ?? null });
  record.lastError = null;
  mkdirSync(stateDir, { recursive: true });
  atomicWriteJson(phaseRecordPath(stateDir), record);
  return record;
}

function recordError(stateDir, phase, error) {
  const record = readPhaseRecord(stateDir);
  record.phases.push({ phase, at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
  record.lastError = error instanceof Error ? error.message : String(error);
  mkdirSync(stateDir, { recursive: true });
  atomicWriteJson(phaseRecordPath(stateDir), record);
}

function hasCompleted(stateDir, phase) {
  return readPhaseRecord(stateDir).phases.some((entry) => entry.phase === phase && !entry.error);
}

function hasCompletedCutoff(stateDir) {
  const cutoffEntries = readPhaseRecord(stateDir).phases.filter((entry) => entry.phase === 'cutoff');
  const entry = cutoffEntries[cutoffEntries.length - 1];
  return Boolean(entry && (
    entry.phase === 'cutoff'
      && !entry.error
      && entry.detail?.completed === true
      && entry.detail?.performed === true
      && entry.detail?.failureCount === 0
      && typeof entry.detail?.cutoffReceiptSha256 === 'string'
      && typeof entry.detail?.handoffReceiptSha256 === 'string'
  ));
}

function hasCompletedRestart(stateDir, restartRequested) {
  const restartEntries = readPhaseRecord(stateDir).phases.filter((entry) => entry.phase === 'restart');
  const entry = restartEntries[restartEntries.length - 1];
  return Boolean(entry && (
    entry.phase === 'restart'
      && !entry.error
      && entry.detail?.completed === true
      && entry.detail?.cutoffCompleted === true
      && entry.detail?.requested === restartRequested
  ));
}

/** Only the production all-host coordinator's durable receipt can authorize
 * the storage cutoff. A plan flag or caller-provided inventory is not a
 * writer fence. */
function readAuthoritativeCutoffHandoff(plan) {
  const receiptPath = plan.cutoffHandoffReceiptPath;
  if (typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath)) {
    return { ok: false, reason: 'authoritative all-host handoff receipt path is missing' };
  }
  if (!existsSync(receiptPath)) return { ok: false, reason: 'authoritative all-host handoff receipt is missing' };
  let size;
  try {
    size = statSync(receiptPath).size;
  } catch (error) {
    return { ok: false, reason: `authoritative all-host handoff receipt cannot be inspected: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (size > MAX_HANDOFF_RECEIPT_BYTES) return { ok: false, reason: 'authoritative all-host handoff receipt exceeds the bounded size' };
  let raw;
  try {
    raw = readFileSync(receiptPath, 'utf8');
  } catch (error) {
    return { ok: false, reason: `authoritative all-host handoff receipt cannot be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `authoritative all-host handoff receipt is invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const hostIds = parsed && typeof parsed === 'object' && Array.isArray(parsed.hostInstanceIds) ? parsed.hostInstanceIds : null;
  const acknowledgedHostIds = parsed && typeof parsed === 'object' && Array.isArray(parsed.acknowledgedHostInstanceIds)
    ? parsed.acknowledgedHostInstanceIds : null;
  const validHostIds = hostIds && hostIds.length > 0 && hostIds.length <= 512
    && hostIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 512);
  const sortedHostIds = validHostIds && JSON.stringify(hostIds) === JSON.stringify([...hostIds].sort());
  if (!parsed || typeof parsed !== 'object'
    || parsed.schemaVersion !== 1
    || parsed.kind !== PRODUCTION_HANDOFF_RECEIPT_KIND
    || parsed.workspaceId !== plan.workspaceId
    || parsed.operationId !== `${plan.generationId}:cutoff`
    || parsed.purpose !== 'storage-cutoff'
    || parsed.status !== 'fenced'
    || !Number.isSafeInteger(parsed.fenceEpoch) || parsed.fenceEpoch <= 0
    || !validHostIds
    || !sortedHostIds
    || !acknowledgedHostIds
    || JSON.stringify(acknowledgedHostIds) !== JSON.stringify(hostIds)
    || new Set(hostIds).size !== hostIds.length) {
    return { ok: false, reason: 'authoritative all-host handoff receipt is not the durable fenced receipt from the production coordinator' };
  }
  return {
    ok: true,
    sha256: createHash('sha256').update(raw).digest('hex'),
    hostCount: hostIds.length,
    receipt: {
      schemaVersion: parsed.schemaVersion,
      workspaceId: parsed.workspaceId,
      operationId: parsed.operationId,
      purpose: parsed.purpose,
      fenceEpoch: parsed.fenceEpoch,
      status: parsed.status,
      hostInstanceIds: [...parsed.hostInstanceIds],
      acknowledgedHostInstanceIds: [...parsed.acknowledgedHostInstanceIds],
    },
  };
}

/** Establish the actual storage-cutoff fence through the production adapter,
 * then persist only the receipt returned by the durable coordinator. This is
 * deliberately not called by PREFLIGHT. */
async function produceAuthoritativeCutoffHandoff(plan) {
  const receiptPath = plan.cutoffHandoffReceiptPath;
  if (typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath)) {
    return { ok: false, reason: 'authoritative all-host handoff receipt path is missing' };
  }
  if (typeof plan.workspaceId !== 'string' || plan.workspaceId.trim().length === 0) {
    return { ok: false, reason: 'workspaceId is required for the all-host storage fence' };
  }
  const blockers = [];
  const runtimeRootPath = plan.runtimeRootPath ?? process.env.PIE_RUNTIME_ROOT;
  const runtimeIdentity = readPreflightRuntimeIdentity(plan, blockers);
  if (!runtimeIdentity || typeof runtimeRootPath !== 'string' || !path.isAbsolute(runtimeRootPath)) {
    return { ok: false, reason: blockers.join('; ') || 'runtime lease discovery is not configured' };
  }
  const keyChannel = readHostHandoffKeyChannel(plan);
  if (keyChannel.error !== undefined) blockers.push(keyChannel.error);
  const keys = keyChannel.keys ?? new Map();
  if (blockers.length > 0) return { ok: false, reason: blockers.join('; ') };
  const cutoffStateDir = plan.cutoffStateDir ?? plan.stateDir;
  if (typeof cutoffStateDir !== 'string' || !path.isAbsolute(cutoffStateDir)) {
    return { ok: false, reason: 'cutoffStateDir must be absolute' };
  }
  const lifecycleStorePath = path.join(cutoffStateDir, 'session-lifecycle.sqlite');
  try {
    const { createProductionAnalyticsHostAdapters, SessionLifecycleStore } = await loadProductionHostModules();
    const registry = new SessionLifecycleStore(lifecycleStorePath);
    try {
      const active = new ActivationStore({ stateDir: plan.stateDir }).read();
      if (active.authority !== 'canonical' || !active.manifest?.activeGeneration) {
        return { ok: false, reason: 'storage cutoff requires an already-active canonical analytics generation' };
      }
      const adapters = createProductionAnalyticsHostAdapters({
        workspaceId: plan.workspaceId,
        registry,
        runtimeRootPath,
        runtimeIdentity,
        analyticsGenerationId: active.manifest.activeGeneration.identity.generationId,
        keyForHost: (host) => keys.get(host.hostInstanceId),
        probeTimeoutMs: plan.hostProbeTimeoutMs,
        send: sendBoundedAnalyticsFrame,
      });
      const receipt = await adapters.coordinator('storage-cutoff').ensureFenced(`${plan.generationId}:cutoff`);
      mkdirSync(path.dirname(receiptPath), { recursive: true });
      atomicWriteJson(receiptPath, { kind: PRODUCTION_HANDOFF_RECEIPT_KIND, ...receipt });
      return readAuthoritativeCutoffHandoff(plan);
    } finally {
      registry.close();
    }
  } catch (error) {
    return { ok: false, reason: `production all-host storage fence failed closed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

let ActivationStore;
let activateGeneration;
let admitActivationEvidence;
let inspectActivationEvidence;

/** Admission evidence options derived from the activation plan. A plan that
 * explicitly records `qualificationMode: "provisional"` admits the overall
 * report under the exact approved provisional envelope (never full
 * qualification); any other value uses the unchanged fully-qualified gate. */
function admissionEvidenceOptions(plan) {
  return {
    qualificationPath: plan.qualificationReport,
    trialPath: plan.trialReport,
    generationId: plan.generationId,
    buildId: plan.buildId,
    sourceHead: plan.sourceHead,
    sourceFingerprint: plan.sourceFingerprint,
    workspaceId: plan.workspaceId,
    provisional: plan.qualificationMode === 'provisional',
    ...(plan.candidateBuildId !== undefined || plan.sourceEquivalenceReceipt !== undefined ? {
      candidateBuildId: plan.candidateBuildId,
      sourceEquivalenceReceipt: plan.sourceEquivalenceReceipt,
    } : {}),
  };
}

/** Bind the orchestrator's P0 prerequisite to the evidence just admitted by
 * the authoritative validator. Plan-supplied hashes/status cannot relabel an
 * honestly provisional report as fully qualified or substitute other bytes. */
export function productionCutoverPrerequisites(plan, admitted) {
  const prerequisites = plan.prerequisites;
  if (!prerequisites || typeof prerequisites !== 'object'
    || !prerequisites.p0 || typeof prerequisites.p0 !== 'object') {
    throw new Error('Production cutover P0 prerequisites are missing.');
  }
  const common = {
    commitSha: prerequisites.p0.commitSha,
    qualificationSha256: admitted.qualificationSha256,
    trialSha256: admitted.trialSha256,
  };
  if (admitted.qualificationMode === 'provisional') {
    if (plan.qualificationMode !== 'provisional') {
      throw new Error('Provisionally qualified P0 evidence requires explicit provisional activation mode.');
    }
    return {
      ...prerequisites,
      p0: {
        status: 'provisional-qualified',
        provisionalAuthorization: PROVISIONAL_P0_AUTHORIZATION,
        ...common,
      },
    };
  }
  if (admitted.qualificationMode !== 'qualified') {
    throw new Error('Admitted P0 evidence has no authorized qualification mode.');
  }
  return { ...prerequisites, p0: { status: 'qualified', ...common } };
}

async function loadAdmissionModule() {
  if (inspectActivationEvidence) return;
  try {
    ({ admitActivationEvidence, inspectActivationEvidence } = await import(
      pathToFileURL(path.join(repositoryRoot, 'scripts', 'analytics-activation-admission.mjs')).href
    ));
  } catch {
    fail('analytics-activation-admission.mjs is missing');
  }
}

async function loadActivationModules() {
  try {
    ({ ActivationStore } = await import(pathToFileURL(path.join(outRoot, 'analytics-activation-store.js')).href));
    ({ activateGeneration } = await import(pathToFileURL(path.join(outRoot, 'analytics-activation-sequence.js')).href));
  } catch {
    fail('activation build entries are missing; run the extension build first');
  }
  await loadAdmissionModule();
}

/** Load the storage-cutoff modules only when a cutoff is requested, so an
 * activation-only run does not depend on the lifecycle build entries. */
async function loadCutoffModules() {
  const load = async (name) => {
    try {
      return await import(pathToFileURL(path.join(outRoot, `${name}.js`)).href);
    } catch {
      fail(`${name}.js is missing; run the extension build first`);
    }
  };
  const [{ performStorageCutoff, inspectStorageCutoff, storageCutoffReceiptSha256 }, { SessionLifecycleStore }, lifecycle] = await Promise.all([
    load('storage-cutoff'),
    load('session-lifecycle-store'),
    load('session-filesystem-lifecycle'),
  ]);
  return { performStorageCutoff, inspectStorageCutoff, storageCutoffReceiptSha256, SessionLifecycleStore, lifecycle };
}

async function loadProductionHostModules() {
  const load = async (name) => import(pathToFileURL(path.join(outRoot, `${name}.js`)).href);
  const [{ createProductionAnalyticsHostAdapters }, { SessionLifecycleStore }] = await Promise.all([
    load('analytics-production-adapters'),
    load('session-lifecycle-store'),
  ]);
  return { createProductionAnalyticsHostAdapters, SessionLifecycleStore };
}

function uniqueBlockers(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

const MAX_HOST_HANDOFF_KEY_FILE_BYTES = 256 * 1024;
const HOST_HANDOFF_KEY_MIN_LENGTH = 4;
const HOST_HANDOFF_KEY_MAX_LENGTH = 4_096;
const MAX_PLAN_REREAD_BYTES = 8 * 1024 * 1024;

function readBoundedJson(filePath, label, maxBytes) {
  if (!existsSync(filePath)) return { error: `${label} is missing` };
  let size;
  try {
    size = statSync(filePath).size;
  } catch (error) {
    return { error: `${label} cannot be inspected: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!Number.isSafeInteger(size) || size > maxBytes) return { error: `${label} exceeds its bounded size` };
  try {
    return { value: JSON.parse(readFileSync(filePath, 'utf8')) };
  } catch (error) {
    return { error: `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Parse the bounded per-host key map shape. Key values are never logged or
 * echoed; failures identify the offending hostInstanceId only. Any structural
 * problem fails the whole read closed: a partial map could otherwise mask a
 * missing post-restart key behind the pre-restart ones. */
function parseHostHandoffKeyMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { keys: null, error: 'authenticated host key channel must be a hostInstanceId map' };
  }
  const keys = new Map();
  for (const [hostInstanceId, key] of Object.entries(value)) {
    if (typeof key !== 'string'
      || key.trim().length < HOST_HANDOFF_KEY_MIN_LENGTH
      || key.length > HOST_HANDOFF_KEY_MAX_LENGTH) {
      return { keys: null, error: `authenticated handoff key for ${hostInstanceId} is missing or invalid` };
    }
    keys.set(hostInstanceId, key);
  }
  return { keys, error: undefined };
}

/** Read the owner-controlled per-host key channel at the moment it is needed.
 *
 * The plan is the activation owner's controlled input, so the in-plan key map
 * and the optional dedicated key file are read fresh for every probe: keys
 * minted for the controlled post-restart host boot become visible to the
 * helper without restarting it. The process environment cannot be refreshed
 * for a running helper, so it remains only a fallback channel for plans that
 * carry no key channel of their own. Values are handed to the signed-probe
 * seam only and are never logged, persisted, or embedded in receipts. */
function readHostHandoffKeyChannel(plan) {
  if (plan.hostHandoffKeysPath !== undefined) {
    const file = readBoundedJson(plan.hostHandoffKeysPath, 'host handoff key file', MAX_HOST_HANDOFF_KEY_FILE_BYTES);
    if (file.error !== undefined) return { keys: null, error: file.error };
    return parseHostHandoffKeyMap(file.value);
  }
  if (plan.planPath !== undefined && plan.hostHandoffKeys !== undefined) {
    const planFile = readBoundedJson(plan.planPath, 'activation plan', MAX_PLAN_REREAD_BYTES);
    if (planFile.error !== undefined) return { keys: null, error: planFile.error };
    if (!planFile.value || typeof planFile.value !== 'object'
      || planFile.value.hostHandoffKeys === undefined) {
      return { keys: null, error: 'activation plan no longer carries the authenticated host key channel' };
    }
    return parseHostHandoffKeyMap(planFile.value.hostHandoffKeys);
  }
  const envRaw = process.env.PIE_ANALYTICS_HANDOFF_KEYS_JSON;
  if (envRaw === undefined) return { keys: new Map(), error: undefined };
  let parsed;
  try {
    parsed = JSON.parse(envRaw);
  } catch {
    return { keys: null, error: 'authenticated host key channel is not valid JSON' };
  }
  return parseHostHandoffKeyMap(parsed);
}

function readPreflightRuntimeIdentity(plan, blockers) {
  const identity = plan.runtimeIdentity;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)
    || !['publisher', 'name', 'version'].every((field) => typeof identity[field] === 'string'
      && identity[field].trim().length > 0 && identity[field].length <= 512)) {
    blockers.push('runtime generation identity is missing; exact runtime lease ownership cannot be reconciled');
    return null;
  }
  return identity;
}

function readTerminalRestartReceipt(plan) {
  const receiptPath = plan.terminalRestartReceiptPath;
  if (typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath)) {
    return { ready: false, blockers: ['terminal restart receipt readiness is missing'] };
  }
  if (!existsSync(receiptPath)) {
    return { ready: false, blockers: ['terminal restart receipt is missing'] };
  }
  let size;
  try {
    size = statSync(receiptPath).size;
  } catch (error) {
    return { ready: false, blockers: [`terminal restart receipt cannot be inspected: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!Number.isSafeInteger(size) || size > MAX_HANDOFF_RECEIPT_BYTES) {
    return { ready: false, blockers: ['terminal restart receipt exceeds the bounded size'] };
  }
  let raw;
  let parsed;
  try {
    raw = readFileSync(receiptPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ready: false, blockers: [`terminal restart receipt is invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const valid = parsed && typeof parsed === 'object'
    && `${JSON.stringify(parsed, null, 2)}\n` === raw
    && parsed.schemaVersion === 1
    && parsed.kind === 'pie-p7-terminal-restart-v1'
    && parsed.status === 'ready'
    && parsed.generationId === plan.generationId
    && parsed.buildId === plan.buildId
    && typeof parsed.restartNonce === 'string' && parsed.restartNonce.length > 0 && parsed.restartNonce.length <= 256
    && typeof parsed.hostInstanceId === 'string' && parsed.hostInstanceId.length > 0 && parsed.hostInstanceId.length <= 512
    && Number.isSafeInteger(parsed.processId) && parsed.processId > 0
    && typeof parsed.loadedAt === 'string' && Number.isFinite(Date.parse(parsed.loadedAt))
      && new Date(parsed.loadedAt).toISOString() === parsed.loadedAt
    && typeof parsed.verifiedAt === 'string' && Number.isFinite(Date.parse(parsed.verifiedAt))
      && new Date(parsed.verifiedAt).toISOString() === parsed.verifiedAt;
  if (!valid) return { ready: false, blockers: ['terminal restart receipt is not bound to the requested generation, build, and loaded host identity'] };
  return {
    ready: true,
    path: receiptPath,
    evidence: {
      generationId: parsed.generationId,
      buildId: parsed.buildId,
      hostInstanceId: parsed.hostInstanceId,
      processId: parsed.processId,
      restartNonce: parsed.restartNonce,
      loadedAt: parsed.loadedAt,
      verifiedAt: parsed.verifiedAt,
      evidenceSha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    },
    blockers: [],
  };
}

function isTerminalReceiptAfterStorageCutoff(plan, terminal) {
  if (!terminal.ready) return false;
  const receiptPath = path.join(plan.stateDir, 'storage-cutoff-receipt-v1.json');
  if (!existsSync(receiptPath)) return false;
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    return receipt?.operationId === (plan.operationId ?? plan.generationId)
      && typeof receipt.completedAt === 'string'
      && Number.isFinite(Date.parse(receipt.completedAt))
      && Date.parse(terminal.evidence.loadedAt) >= Date.parse(receipt.completedAt);
  } catch {
    return false;
  }
}

async function requestAndAwaitTerminalRestart(plan, previousLoaded) {
  const receiptPath = plan.terminalRestartReceiptPath;
  if (typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath)) {
    throw new Error('terminal restart receipt path is required for controlled production restart');
  }
  // Do not allow a prior generation's receipt or marker to satisfy this
  // restart. The loaded marker is overwritten atomically by the new host, and
  // the receipt is correlated with this fresh nonce below.
  rmSync(receiptPath, { force: true });
  const requestedAtMs = Date.now();
  const restartNonce = randomUUID();
  const child = spawn(plan.restartCommand, {
    shell: true,
    detached: true,
    stdio: 'ignore',
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PIE_ANALYTICS_RESTART_NONCE: restartNonce,
      PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH: receiptPath,
    },
  });
  child.unref();
  const deadline = Date.now() + TERMINAL_RESTART_WAIT_MS;
  let terminal = readTerminalRestartReceipt(plan);
  while (Date.now() < deadline) {
    if (terminal.ready
      && terminal.evidence.restartNonce === restartNonce
      && Date.parse(terminal.evidence.loadedAt) > requestedAtMs
      && (previousLoaded === null || previousLoaded === undefined
        || terminal.evidence.hostInstanceId !== previousLoaded.hostInstanceId)) {
      const loaded = readLoadedGeneration(plan.stateDir);
      if (loaded
        && loaded.generationId === plan.generationId
        && loaded.buildId === plan.buildId
        && loaded.restartNonce === restartNonce
        && loaded.hostInstanceId === terminal.evidence.hostInstanceId
        && loaded.loadedAt === terminal.evidence.loadedAt
        && loaded.loadedAtMs > requestedAtMs) {
        return terminal;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    terminal = readTerminalRestartReceipt(plan);
  }
  throw new Error('controlled restart did not produce fresh terminal readiness evidence before timeout');
}

function formatDiscoveryEvidence(discovery) {
  if (!discovery) return null;
  return {
    workspaceId: discovery.workspaceId,
    observedAtMs: discovery.observedAtMs,
    complete: discovery.complete === true,
    registryComplete: discovery.registryComplete === true,
    runtimeLeasesComplete: discovery.runtimeLeasesComplete === true,
    processOwnersComplete: discovery.processOwnersComplete === true,
    authenticatedHostsComplete: discovery.authenticatedHostsComplete === true,
    hostCount: Array.isArray(discovery.hosts) ? discovery.hosts.length : null,
    hosts: Array.isArray(discovery.hosts) ? discovery.hosts.map((host) => ({
      hostInstanceId: host.hostInstanceId,
      processId: host.processId,
      state: host.state,
      status: host.status,
      reasonCodes: Array.isArray(host.reasons) ? host.reasons.map((entry) => entry.code) : [],
    })) : [],
    reasonCodes: Array.isArray(discovery.reasons) ? discovery.reasons.map((entry) => entry.code) : [],
    unregisteredRuntimeLeaseCount: Array.isArray(discovery.unregisteredRuntimeLeases)
      ? discovery.unregisteredRuntimeLeases.length : null,
    unregisteredBackendOwnerCount: Array.isArray(discovery.unregisteredBackendOwners)
      ? discovery.unregisteredBackendOwners.length : null,
  };
}

/** Production-backed, read-only readiness inspection. This function never
 * acquires the phase lock, opens a writable SQLite handle, runs an activation
 * sequence, sends a freeze request, requests a restart, or writes a report. */
async function runPreflight(plan) {
  const storageCutoffRequested = plan.cutoverMode === 'storage-cutoff'
    || plan.storageCutoff === true || plan.cutoffInventory !== undefined;
  const blockers = [];
  let admission = { ready: null, evidence: null, blockers: [] };
  if (!storageCutoffRequested) {
    await loadAdmissionModule();
    admission = inspectActivationEvidence(admissionEvidenceOptions(plan));
    blockers.push(...admission.blockers);
  }

  let loadedGeneration = null;
  try {
    loadedGeneration = readLoadedGeneration(plan.stateDir);
  } catch {
    blockers.push('loaded-generation evidence could not be read');
  }

  let activeManifest = null;
  let ActivationStoreForRead;
  try {
    ({ ActivationStore: ActivationStoreForRead } = await import(
      pathToFileURL(path.join(outRoot, 'analytics-activation-store.js')).href
    ));
    activeManifest = new ActivationStoreForRead({ stateDir: plan.stateDir }).read();
    // A missing canonical active generation is the legitimate pre-activation
    // state of a first-ever activation: the production cutover itself proves
    // that absence by reading this same store and proceeds with the absent
    // descriptor allowance. Only a storage cutoff (P7b) is bound to an
    // already-active generation, and that mode states its own blocker below.
    // Requiring the generation here would make every first activation
    // unrunnable: the gate it demands can only be produced by the activation
    // it gates.
    if (!activeManifest.manifest?.activeGeneration?.identity?.generationId
      && storageCutoffRequested) {
      blockers.push('canonical active analytics generation is missing; process descriptors cannot be bound');
    }
  } catch (error) {
    blockers.push(`canonical activation authority could not be read without mutation: ${error instanceof Error ? error.message : String(error)}`);
  }

  const runtimeRootPath = plan.runtimeRootPath ?? process.env.PIE_RUNTIME_ROOT;
  if (typeof runtimeRootPath !== 'string' || !path.isAbsolute(runtimeRootPath)) {
    blockers.push('runtimeRootPath is missing; bounded runtime lease discovery cannot run');
  }
  const runtimeIdentity = readPreflightRuntimeIdentity(plan, blockers);
  if (typeof plan.workspaceId !== 'string' || plan.workspaceId.trim().length === 0) {
    blockers.push('workspaceId is missing; host identities cannot be scoped');
  }
  const lifecycleStorePath = plan.lifecycleStorePath ?? path.join(plan.stateDir, 'session-lifecycle.sqlite');
  if (typeof lifecycleStorePath !== 'string' || !path.isAbsolute(lifecycleStorePath)) {
    blockers.push('lifecycleStorePath must be absolute');
  }
  const keyChannel = readHostHandoffKeyChannel(plan);
  if (keyChannel.error !== undefined) blockers.push(keyChannel.error);
  const keys = keyChannel.keys ?? new Map();
  let discovery = null;
  let lifecycleStore;
  if (runtimeIdentity && typeof runtimeRootPath === 'string' && path.isAbsolute(runtimeRootPath)
    && typeof lifecycleStorePath === 'string' && path.isAbsolute(lifecycleStorePath)
    && typeof plan.workspaceId === 'string' && plan.workspaceId.trim().length > 0) {
    if (!existsSync(lifecycleStorePath)) {
      blockers.push('session lifecycle registry is missing; host census is incomplete');
    } else {
      try {
        const { createProductionAnalyticsHostAdapters, SessionLifecycleStore } = await loadProductionHostModules();
        lifecycleStore = new SessionLifecycleStore(lifecycleStorePath, { readOnly: true });
        // Mirror the production cutover exactly: the pre-census binds to the
        // store's canonical generation when one exists and waives the absent
        // descriptor only when this same read proved a first-ever activation.
        const storeGenerationId = activeManifest?.manifest?.activeGeneration?.identity?.generationId;
        const firstActivation = !storageCutoffRequested && !storeGenerationId;
        const adapters = createProductionAnalyticsHostAdapters({
          workspaceId: plan.workspaceId,
          registry: lifecycleStore,
          runtimeRootPath,
          runtimeIdentity,
          ...(storeGenerationId ? { analyticsGenerationId: storeGenerationId } : {}),
          ...(firstActivation ? { allowAbsentAnalyticsDescriptor: true } : {}),
          keyForHost: (host) => keys.get(host.hostInstanceId),
          probeTimeoutMs: plan.hostProbeTimeoutMs,
          send: sendBoundedAnalyticsFrame,
        });
        // Mirror the fence census semantics: the production all-host handoff
        // ignores durably stopped hosts, so the read-only preflight must judge
        // readiness by the same census and not by a stricter superseded one.
        discovery = await retryStalledAnalyticsDiscovery(() => adapters.discover({ ignoreStoppedHosts: true }));
        if (discovery.complete === true && discovery.hosts.length === 0) {
          blockers.push('host census contains no registered hosts');
        }
        if (discovery.complete !== true) {
          const blockersForDiscovery = discovery.reasons.map((entry) => {
            const identity = entry.hostInstanceId ? ` (${entry.hostInstanceId})` : '';
            const process = entry.processId === undefined ? '' : ` [pid ${entry.processId}]`;
            return `host census blocker: ${entry.code}${identity}${process}`;
          });
          blockers.push(...(blockersForDiscovery.length > 0
            ? blockersForDiscovery : ['host census is incomplete']))
        }
      } catch (error) {
        blockers.push(`production host/process discovery failed closed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        lifecycleStore?.close();
      }
    }
  }

  const terminalRestartReceipt = readTerminalRestartReceipt(plan);
  const terminalWillBeProduced = plan.prerequisites?.terminalHandoff?.status === 'pending'
    && typeof plan.restartCommand === 'string' && plan.restartCommand.trim().length > 0
    && typeof plan.terminalRestartReceiptPath === 'string' && path.isAbsolute(plan.terminalRestartReceiptPath);
  if (!terminalWillBeProduced) blockers.push(...terminalRestartReceipt.blockers);
  let storageCutoff = { requested: false, ready: null, blockers: [] };
  if (storageCutoffRequested) {
    const storageBlockers = [];
    if (plan.cutoverMode !== 'storage-cutoff') storageBlockers.push('storage cutoff requires cutoverMode storage-cutoff');
    const authorization = plan.authorization;
    const prerequisites = plan.prerequisites;
    const p7a = prerequisites?.p7a;
    const p7b = prerequisites?.p7b;
    // The authoritative plan marker is the production orchestrator's own
    // constant from the same built module execution uses, so preflight and
    // execution can never disagree about which authorization envelope is
    // mandatory.
    let planReference = null;
    try {
      ({ ANALYTICS_CUTOVER_PLAN_REFERENCE: planReference } = await import(
        pathToFileURL(path.join(outRoot, 'analytics-cutover-orchestrator.js')).href
      ));
    } catch {
      planReference = null;
    }
    if (planReference === null) {
      storageBlockers.push('production analytics cutover authority module is missing; run the extension build first');
    } else if (!authorization || authorization.schemaVersion !== 1
      || authorization.plan !== planReference
      || authorization.approved !== true || !/^[0-9a-f]{40}$/iu.test(authorization.commitSha ?? '')) {
      storageBlockers.push('production analytics cutover is not explicitly authorized');
    }
    if (!prerequisites?.p0
      || (prerequisites.p0.status !== 'qualified' && prerequisites.p0.status !== 'provisional-qualified')
      || prerequisites.p0.commitSha?.toLowerCase() !== authorization?.commitSha?.toLowerCase()
      || !/^[0-9a-f]{64}$/iu.test(prerequisites.p0.qualificationSha256 ?? '')
      || !/^[0-9a-f]{64}$/iu.test(prerequisites.p0.trialSha256 ?? '')
      || (prerequisites.p0.status === 'provisional-qualified'
        && prerequisites.p0.provisionalAuthorization !== PROVISIONAL_P0_AUTHORIZATION)
      || (prerequisites.p0.status === 'qualified'
        && prerequisites.p0.provisionalAuthorization !== undefined)) {
      storageBlockers.push('P0 qualification evidence is missing or does not match the authorization commit');
    }
    if (!p7a || p7a.analyticsReady !== true || p7a.privacyDeleteReady !== true
      || p7a.queryReady !== true || p7a.selectedDesignQualified !== true) {
      storageBlockers.push('P7a prerequisites are incomplete');
    }
    if (!p7b || p7b.lifecycleOwnerReady !== true || p7b.legacyScrubBoundaryReady !== true
      || p7b.rootSwitchReady !== true || p7b.expiryInPlaceReady !== true) {
      storageBlockers.push('P7b prerequisites are incomplete');
    }
    if (prerequisites?.terminalHandoff?.status === 'ready') {
      if (!/^[0-9a-f]{64}$/iu.test(prerequisites.terminalHandoff.evidenceSha256 ?? '')) {
        storageBlockers.push('terminal handoff evidence hash is invalid');
      }
    } else if (!terminalWillBeProduced) {
      storageBlockers.push('storage cutoff requires authorized terminal evidence or a complete pending restart ingress');
    }
    if (activeManifest?.authority !== 'canonical' || !activeManifest.manifest?.activeGeneration) {
      storageBlockers.push('storage cutoff requires an already-active canonical analytics generation');
    } else if (plan.expectedActiveGenerationId !== activeManifest.manifest.activeGeneration.identity.generationId
      || plan.generationId !== activeManifest.manifest.activeGeneration.identity.generationId
      || plan.buildId !== activeManifest.manifest.activeGeneration.identity.buildId) {
      storageBlockers.push('storage cutoff plan is not bound to the exact active analytics generation and build');
    }
    if (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] !== STORAGE_CUTOFF_AUTHORIZATION_VALUE) {
      storageBlockers.push(`storage cutoff requires ${STORAGE_CUTOFF_AUTHORIZATION_ENV}=${STORAGE_CUTOFF_AUTHORIZATION_VALUE}`);
    }
    if (typeof lifecycleStorePath === 'string' && path.isAbsolute(lifecycleStorePath) && existsSync(lifecycleStorePath)) {
      let storageStore;
      try {
        const [lifecycle, filesystem, analyticsRecorder] = await Promise.all([
          import(pathToFileURL(path.join(outRoot, 'session-lifecycle-store.js')).href),
          import(pathToFileURL(path.join(outRoot, 'session-filesystem-lifecycle.js')).href),
          import(pathToFileURL(path.join(outRoot, 'analytics-sqlite-recorder.js')).href),
        ]);
        storageStore = new lifecycle.SessionLifecycleStore(lifecycleStorePath, { readOnly: true });
        validateProductionStorageInventory(plan, storageStore, {
          storageCutoffRootCapability: lifecycle.storageCutoffRootCapability,
          verifyFilesystemArtifactIdentity: filesystem.verifyFilesystemArtifactIdentity,
          SqliteAnalyticsRecorder: analyticsRecorder.SqliteAnalyticsRecorder,
        });
      } catch (error) {
        storageBlockers.push(error instanceof Error ? error.message : String(error));
      } finally {
        storageStore?.close();
      }
    }
    storageCutoff = { requested: true, ready: storageBlockers.length === 0, blockers: storageBlockers };
    blockers.push(...storageBlockers);
  }

  const unique = uniqueBlockers(blockers);
  const storageBlockers = new Set(storageCutoff.blockers);
  const analyticsBlockers = unique.filter((blocker) => !storageBlockers.has(blocker));
  const discoveryEvidence = formatDiscoveryEvidence(discovery);
  const readiness = {
    p0Qualification: storageCutoffRequested ? null : admission.ready,
    analyticsEvidenceStructure: storageCutoffRequested ? null : admission.evidence !== null,
    hostProcessCensus: discovery?.processOwnersComplete === true,
    authenticatedHostProbes: discovery?.authenticatedHostsComplete === true,
    allHostDiscovery: discovery?.complete === true && discovery.hosts.length > 0,
    terminalRestartReceipt: terminalRestartReceipt.ready,
    terminalRestartIngress: terminalWillBeProduced,
    storageCutoff: storageCutoff.ready,
    analyticsActivation: storageCutoffRequested ? null : analyticsBlockers.length === 0,
  };
  return {
    schemaVersion: 1,
    mode: 'PREFLIGHT',
    status: unique.length === 0 ? 'ready' : 'blocked',
    readiness,
    blockers: unique,
    evidence: {
      admission,
      activeGenerationId: activeManifest?.manifest?.activeGeneration?.identity?.generationId ?? null,
      loadedGeneration: loadedGeneration ? {
        generationId: loadedGeneration.generationId,
        buildId: loadedGeneration.buildId,
        hostInstanceId: loadedGeneration.hostInstanceId,
        loadedAt: loadedGeneration.loadedAt,
      } : null,
      hostDiscovery: discoveryEvidence,
      terminalRestartReceipt: terminalRestartReceipt.evidence ?? null,
      storageCutoff,
    },
    destructiveActions: {
      activation: false,
      restart: false,
      shutdown: false,
      storageCutoff: false,
    },
  };
}

async function loadProductionCutoverDependencies() {
  await loadActivationModules();
  const [orchestrator, adapters, lifecycle, filesystemLifecycle, storageLifecycle, analyticsRecorder, analyticsProcessCensus] = await Promise.all([
    import(pathToFileURL(path.join(outRoot, 'analytics-cutover-orchestrator.js')).href),
    import(pathToFileURL(path.join(outRoot, 'analytics-production-adapters.js')).href),
    import(pathToFileURL(path.join(outRoot, 'session-lifecycle-store.js')).href),
    import(pathToFileURL(path.join(outRoot, 'session-filesystem-lifecycle.js')).href),
    import(pathToFileURL(path.join(outRoot, 'storage-cutoff-production.js')).href),
    import(pathToFileURL(path.join(outRoot, 'analytics-sqlite-recorder.js')).href),
    import(pathToFileURL(path.join(outRoot, 'analytics-process-census.js')).href),
  ]);
  return {
    admitActivationEvidence,
    ActivationStore,
    activateGeneration,
    AnalyticsCutoverOrchestrator: orchestrator.AnalyticsCutoverOrchestrator,
    analyticsCutoverInventorySha256: orchestrator.analyticsCutoverInventorySha256,
    analyticsCutoverJournalFilename: orchestrator.ANALYTICS_CUTOVER_JOURNAL_FILENAME,
    createProductionAnalyticsHostAdapters: adapters.createProductionAnalyticsHostAdapters,
    SessionLifecycleStore: lifecycle.SessionLifecycleStore,
    storageCutoffRootCapability: lifecycle.storageCutoffRootCapability,
    verifyFilesystemArtifactIdentity: filesystemLifecycle.verifyFilesystemArtifactIdentity,
    createProductionStorageCutoffLifecycle: storageLifecycle.createProductionStorageCutoffLifecycle,
    SqliteAnalyticsRecorder: analyticsRecorder.SqliteAnalyticsRecorder,
    analyticsProcessCensus,
  };
}

const CUTOVER_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;

/** Bounded, tolerant read of the durable cutover journal's activation
 * timestamp. A rerun may reuse a timestamp only when the recorded generation,
 * build, and evidence hashes exactly match the currently admitted evidence;
 * anything else falls back to a fresh timestamp, which the orchestrator's
 * exact-match journal recovery then rejects instead of silently accepting
 * changed evidence under an old instant. */
function readCutoverJournalActivatedAt({ stateDir, journalFilename, request }) {
  const journalPath = path.join(stateDir, journalFilename);
  if (!existsSync(journalPath)) return undefined;
  let size;
  try {
    size = statSync(journalPath).size;
  } catch {
    return undefined;
  }
  if (!Number.isSafeInteger(size) || size > CUTOVER_JOURNAL_MAX_BYTES) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(journalPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1) return undefined;
  const recorded = parsed.activationRequest;
  if (!recorded || typeof recorded !== 'object') return undefined;
  if (recorded.generationId !== request.generationId
    || recorded.buildId !== request.buildId
    || recorded.qualificationSha256 !== request.qualificationSha256
    || recorded.trialSha256 !== request.trialSha256) {
    return undefined;
  }
  const activatedAt = recorded.activatedAt;
  if (typeof activatedAt !== 'string' || !Number.isFinite(Date.parse(activatedAt))
    || new Date(activatedAt).toISOString() !== activatedAt) {
    return undefined;
  }
  return activatedAt;
}

/** Resolve per-host handoff keys at probe time from the owner-controlled
 * channel, so a key minted for the controlled post-restart boot authenticates
 * the new hostInstanceId. Structural problems fail the probe closed; the
 * census then reports missing authenticated keys instead of silently using a
 * stale channel. Key values never reach logs or evidence. */
/** Settle terminal analytics host rows whose writer is confirmed dead, with
 * census proof (the same standard as the bootstrap launcher's settlement:
 * a pid absent from the complete process census and owning no live backend).
 * The durable all-host writer fence requires its census to cover the COMPLETE
 * host registry (`assertWriterRegistrySnapshot` compares every analytics_hosts
 * row), while the coordinator's census covers only live registered hosts, and
 * the loaded build offers no supported removal for terminal rows — so a
 * registry that accumulated `stopped` rows from ordinary host lifecycles
 * cannot be fenced without this settlement. `stopping` rows of dead writers
 * are settled through the store API first; only already-terminal rows are
 * removed, through an identity-guarded delete on the store's own connection.
 * Any row whose pid is still alive is left untouched, and the fence then
 * fails loudly on the complete-registry snapshot. Runs only for a cutover
 * that is about to fence: refused or already-committed reruns must not
 * mutate the registry. */
async function settleTerminalAnalyticsHostRows(registry, deps, plan) {
  const rows = [];
  let cursor;
  for (;;) {
    const page = registry.listAnalyticsHosts(plan.workspaceId, { limit: 64, ...(cursor ? { cursor } : {}) });
    rows.push(...page.hosts);
    if (rows.length > 512 || (page.truncated && (!page.nextCursor || page.nextCursor === cursor))) {
      throw new Error('terminal-row settlement could not read the complete host registry.');
    }
    if (!page.truncated) break;
    cursor = page.nextCursor;
  }
  const staleStoppingRows = rows.filter((host) => host.state === 'stopping');
  const terminalRows = rows.filter((host) => host.state === 'stopped');
  if (staleStoppingRows.length === 0 && terminalRows.length === 0) return;
  const census = await deps.analyticsProcessCensus.readProcessCensus();
  if (!census.complete) {
    throw new Error(`Terminal-row settlement requires a complete process census: ${census.reasons.map((entry) => entry.code).join(', ') || 'unknown blocker'}`);
  }
  const livePids = new Set(census.processes.map((entry) => entry.processId));
  const backendHostPids = new Set(census.backendOwners.map((entry) => entry.hostProcessId));
  const isConfirmedDead = (host) => !livePids.has(host.processId) && !backendHostPids.has(host.processId);
  let settledStopping = 0;
  for (const host of staleStoppingRows) {
    if (!isConfirmedDead(host)) continue;
    registry.markAnalyticsHostState(host.hostInstanceId, host.processId, host.generationId, 'stopped', Date.now());
    settledStopping += 1;
  }
  const purgeCandidates = terminalRows.filter(isConfirmedDead);
  for (const host of purgeCandidates) {
    // The loaded SessionLifecycleStore exposes no removal for terminal rows,
    // so the settlement uses the store's own SQLite connection with an
    // identity guard that can only match an already-terminal row.
    const result = registry.database.prepare(
      "DELETE FROM analytics_hosts WHERE host_instance_id = ? AND process_id = ? AND state = 'stopped'",
    ).run(host.hostInstanceId, host.processId);
    if (Number(result.changes) !== 1) {
      throw new Error(`terminal-row settlement lost its identity guard for analytics host ${host.hostInstanceId} [pid ${host.processId}]; nothing was removed`);
    }
  }
  if (settledStopping > 0 || purgeCandidates.length > 0) {
    process.stderr.write(`settled ${settledStopping} stopping and removed ${purgeCandidates.length} terminal analytics host row(s) of confirmed-dead pids before the writer fence.` +
      `${rows.length - purgeCandidates.length - settledStopping} row(s) remain in the registry census scope.` +
      '\n');
  }
}

function createHostHandoffKeyResolver(plan) {
  return {
    keyForHost: (host) => {
      const channel = readHostHandoffKeyChannel(plan);
      if (channel.error !== undefined || !channel.keys) return undefined;
      return channel.keys.get(host.hostInstanceId);
    },
  };
}

/** The all-host writer fence census probes every registered host over the
 * extension host's pipe runtime, whose FIRST connection after an idle period
 * can be accepted but never delivers its frame (observed live 2026-09-16 and
 * reproducible on every fresh process against the bound host). The compiled
 * coordinator runs the census once and fails closed on incompleteness, while
 * the preflight runs the identical census behind a fresh-signed retry — so
 * first-activation readiness is otherwise not reproducible by the production
 * path. Retry only the pre-mutation census refusal: the census completes
 * before `beginAnalyticsWriterFence` writes anything, so a refused attempt
 * leaves no durable state, every retry signs fresh requests, and any other
 * conflict fails loudly on the first attempt. */
const WRITER_FENCE_CENSUS_STALL_ATTEMPTS = 4;
const WRITER_FENCE_CENSUS_STALL_SPACING_MS = 100;

/** Wrap the analytics-activation coordinator so each fence attempt first
 * settles terminal rows of confirmed-dead writers (see
 * settleTerminalAnalyticsHostRows). The wrapper runs exactly when the
 * orchestrator is about to fence: committed or fenced journals resume from
 * their receipts without calling the coordinator, and refusals happen before
 * it, so neither mutates the registry. */
function withTerminalRowSettlement(coordinator, { registry, deps, plan }) {
  return {
    run: async (operationId) => {
      await settleTerminalAnalyticsHostRows(registry, deps, plan);
      return coordinator.run(operationId);
    },
  };
}

function withWriterFenceCensusStallRetry(coordinator) {
  return {
    run: async (operationId) => {
      for (let attempt = 1; attempt <= WRITER_FENCE_CENSUS_STALL_ATTEMPTS; attempt += 1) {
        try {
          return await coordinator.run(operationId);
        } catch (error) {
          const isCensusRefusal = error instanceof Error
            && error.message.includes('All-host writer census is incomplete or ambiguous');
          if (!isCensusRefusal || attempt === WRITER_FENCE_CENSUS_STALL_ATTEMPTS) throw error;
          await new Promise((resolve) => setTimeout(resolve, WRITER_FENCE_CENSUS_STALL_SPACING_MS));
        }
      }
    },
  };
}

function validateProductionStorageInventory(plan, registry, dependencies) {
  if (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] !== STORAGE_CUTOFF_AUTHORIZATION_VALUE) {
    throw new Error(`Storage cutoff requires ${STORAGE_CUTOFF_AUTHORIZATION_ENV}=${STORAGE_CUTOFF_AUTHORIZATION_VALUE}.`);
  }
  if (!Array.isArray(plan.cutoffInventory) || plan.cutoffInventoryValidated !== true) {
    throw new Error('Storage cutoff requires an explicitly validated cutoffInventory.');
  }
  const sessionIds = [...new Set(plan.cutoffInventory)];
  if (sessionIds.length !== plan.cutoffInventory.length
    || sessionIds.some((sessionId) => typeof sessionId !== 'string'
      || sessionId.length === 0 || sessionId.length > 512 || sessionId.includes('\u0000'))) {
    throw new Error('Storage cutoff inventory contains a duplicate or invalid session id.');
  }
  const roots = plan.cutoffRoots;
  if (!roots || typeof roots !== 'object'
    || typeof roots.sessions !== 'string' || !path.isAbsolute(roots.sessions)
    || typeof roots.artifacts !== 'string' || !path.isAbsolute(roots.artifacts)) {
    throw new Error('Storage cutoff requires absolute cutoffRoots.sessions and cutoffRoots.artifacts paths.');
  }
  if (typeof plan.analyticsDatabasePath !== 'string' || !path.isAbsolute(plan.analyticsDatabasePath)
    || !existsSync(plan.analyticsDatabasePath)) {
    throw new Error('Storage cutoff requires the existing canonical analyticsDatabasePath.');
  }
  if (dependencies.SqliteAnalyticsRecorder) {
    const analytics = new dependencies.SqliteAnalyticsRecorder(plan.analyticsDatabasePath, { readOnly: true });
    analytics.close();
  }
  for (const sessionId of sessionIds) {
    const record = registry.get(sessionId);
    if (!record) throw new Error(`Storage cutoff inventory session ${sessionId} is absent from the lifecycle registry.`);
    if (record.cleanupState === 'deleted') continue;
    const artifacts = registry.listArtifacts(sessionId);
    const transcript = artifacts.find((artifact) => artifact.artifactId === 'transcript');
    if (!transcript || transcript.kind !== 'transcript') {
      throw new Error(`Storage cutoff inventory session ${sessionId} has no registered transcript target.`);
    }
    for (const artifact of artifacts) {
      if (artifact.locationKind === 'external') {
        if (artifact.artifactId !== 'review-sidecar-entry' && artifact.artifactId !== 'prompt-setting-entry') {
          throw new Error(`Storage cutoff inventory session ${sessionId} has unsupported external artifact ${artifact.artifactId}.`);
        }
        continue;
      }
      const absolutePath = artifact.locationKind === 'fixed_absolute'
        ? path.resolve(artifact.location)
        : path.resolve(roots[artifact.rootName], ...artifact.location.split('/'));
      if (artifact.state === 'present') {
        if (!existsSync(absolutePath)) {
          throw new Error(`Storage cutoff inventory artifact ${sessionId}/${artifact.artifactId} is missing.`);
        }
        dependencies.verifyFilesystemArtifactIdentity(artifact, absolutePath);
      }
    }
  }
  return {
    sessionIds,
    roots,
    rootCapability: dependencies.storageCutoffRootCapability(roots.sessions),
  };
}

/**
 * Run the real production all-host cutover for a fully authorized plan.
 *
 * `dependencies` is a narrow seam for tests that must exercise this exact
 * path without a live activation: it swaps only module resolution (activation
 * store/sequence, orchestrator, adapter factory, lifecycle registry, and the
 * candidate-trial admission, whose authoritative validator does not exist
 * yet) plus the process/lease/socket census adapters inside the factory
 * options. Production always uses the default built extension entries.
 */
export async function runProductionCutover(plan, dependencies) {
  if (process.env.PIE_ANALYTICS_HELPER_DETACHED !== '1') {
    throw new Error('Production cutover requires terminal ownership to be transferred to a detached helper first.');
  }
  const deps = dependencies ?? await loadProductionCutoverDependencies();
  const mode = plan.cutoverMode ?? 'analytics-activation';
  if (mode !== 'analytics-activation' && mode !== 'storage-cutoff') {
    throw new Error('Production cutover requires one distinct analytics-activation or storage-cutoff operation.');
  }
  // P7a owns qualification admission. A distinct P7b run instead binds to the
  // already-active canonical generation and must not re-admit candidate bytes.
  const admitted = mode === 'analytics-activation'
    ? deps.admitActivationEvidence(admissionEvidenceOptions(plan))
    : null;
  const terminal = readTerminalRestartReceipt(plan);
  const terminalPrerequisite = plan.prerequisites?.terminalHandoff;
  const terminalIsAuthorized = terminalPrerequisite?.status === 'ready'
    && terminal.ready
    && terminalPrerequisite.evidenceSha256 === terminal.evidence.evidenceSha256;
  const terminalWillBeProduced = terminalPrerequisite?.status === 'pending'
    && typeof plan.restartCommand === 'string' && plan.restartCommand.trim().length > 0
    && typeof plan.terminalRestartReceiptPath === 'string' && path.isAbsolute(plan.terminalRestartReceiptPath);
  if (!terminalIsAuthorized && !terminalWillBeProduced) {
    if (!terminal.ready) throw new Error(terminal.blockers.join('; '));
    throw new Error('Terminal restart receipt bytes do not match the authorized terminal-handoff evidence hash.');
  }
  if (typeof plan.workspaceId !== 'string' || plan.workspaceId.trim().length === 0) {
    throw new Error('Production cutover workspaceId is required.');
  }
  const runtimeRootPath = plan.runtimeRootPath ?? process.env.PIE_RUNTIME_ROOT;
  const blockers = [];
  const runtimeIdentity = readPreflightRuntimeIdentity(plan, blockers);
  if (!runtimeIdentity || typeof runtimeRootPath !== 'string' || !path.isAbsolute(runtimeRootPath)) {
    throw new Error(blockers.join('; '));
  }
  const keyChannel = readHostHandoffKeyChannel(plan);
  if (keyChannel.error !== undefined) {
    throw new Error(`Production cutover authenticated host key channel: ${keyChannel.error}`);
  }
  const lifecycleStorePath = plan.lifecycleStorePath ?? path.join(plan.stateDir, 'session-lifecycle.sqlite');
  if (typeof lifecycleStorePath !== 'string' || !path.isAbsolute(lifecycleStorePath) || !existsSync(lifecycleStorePath)) {
    throw new Error('Production cutover lifecycle registry is missing or not absolute.');
  }
  const activationStore = new deps.ActivationStore({ stateDir: plan.stateDir });
  // The pre-fence census must describe the generation the loaded hosts are
  // actually running, not the one being activated. A canonical store names
  // that active generation; a first-ever activation has none, which is proven
  // here by the store read itself, so the backend's absent canonical
  // descriptor is legitimate while every process/owner identity check stays
  // mandatory. A malformed or ambiguous activation store fails closed above.
  const preCutoverActivation = activationStore.read();
  const preCutoverGenerationId = preCutoverActivation.authority === 'canonical'
    ? preCutoverActivation.manifest?.activeGeneration?.identity.generationId
    : undefined;
  if (mode === 'storage-cutoff') {
    const activeIdentity = preCutoverActivation.manifest?.activeGeneration?.identity;
    if (preCutoverActivation.authority !== 'canonical' || !activeIdentity) {
      throw new Error('Storage cutoff requires an already-active canonical analytics generation.');
    }
    if (typeof plan.expectedActiveGenerationId !== 'string'
      || plan.expectedActiveGenerationId !== activeIdentity.generationId
      || plan.generationId !== activeIdentity.generationId
      || plan.buildId !== activeIdentity.buildId) {
      throw new Error('Storage cutoff plan is not bound to the exact active analytics generation and build.');
    }
  }
  const hostKeyResolver = createHostHandoffKeyResolver(plan);
  const registry = new deps.SessionLifecycleStore(lifecycleStorePath);
  let storageLifecycle;
  try {
    const adapters = deps.createProductionAnalyticsHostAdapters({
      workspaceId: plan.workspaceId,
      registry,
      runtimeRootPath,
      runtimeIdentity,
      ...(preCutoverGenerationId !== undefined
        ? { analyticsGenerationId: preCutoverGenerationId }
        : { allowAbsentAnalyticsDescriptor: true }),
      keyForHost: hostKeyResolver.keyForHost,
      probeTimeoutMs: plan.hostProbeTimeoutMs,
      // The cutover's authenticated requests include the nonce-guarded writer
      // freeze acknowledgement: the documented first-connection pipe stall
      // closes the endpoint without a response after the fence census warmed
      // it, so every cutover frame uses the same-nonce stall retry (a replayed
      // freeze that WAS processed is rejected loudly by the host's nonce
      // replay guard, never silently double-processed).
      send: sendBoundedAnalyticsFrameWithStallRetry,
    });
    let activationRequest;
    if (mode === 'analytics-activation') {
      const recoveredActivatedAt = readCutoverJournalActivatedAt({
        stateDir: plan.stateDir,
        journalFilename: deps.analyticsCutoverJournalFilename,
        request: {
          generationId: plan.generationId,
          buildId: plan.buildId,
          qualificationSha256: admitted.qualificationSha256,
          trialSha256: admitted.trialSha256,
        },
      });
      activationRequest = plan.activationRequest ?? {
        generationId: plan.generationId,
        buildId: plan.buildId,
        qualificationSha256: admitted.qualificationSha256,
        trialSha256: admitted.trialSha256,
        activatedAt: recoveredActivatedAt ?? new Date().toISOString(),
      };
    }
    const storageInventory = mode === 'storage-cutoff'
      ? validateProductionStorageInventory(plan, registry, deps)
      : null;
    if (storageInventory) {
      storageLifecycle = deps.createProductionStorageCutoffLifecycle({
        store: registry,
        stateDir: plan.stateDir,
        roots: storageInventory.roots,
        analyticsDatabasePath: plan.analyticsDatabasePath,
      });
    }
    const runtime = {
      terminalHandoffProduction: true,
      completeAnalyticsActivation: async ({ operationId, manifest }) => {
        let currentTerminal = readTerminalRestartReceipt(plan);
        const previousLoaded = readLoadedGeneration(plan.stateDir);
        if (terminalPrerequisite?.status === 'pending') {
          currentTerminal = await requestAndAwaitTerminalRestart(plan, previousLoaded);
        }
        if (!currentTerminal.ready) throw new Error(currentTerminal.blockers.join('; '));
        const loaded = readLoadedGeneration(plan.stateDir);
        if (!loaded
          || loaded.generationId !== manifest.activeGeneration?.identity.generationId
          || loaded.buildId !== manifest.activeGeneration?.identity.buildId
          || loaded.hostInstanceId !== currentTerminal.evidence.hostInstanceId
          || loaded.restartNonce !== currentTerminal.evidence.restartNonce
          || loaded.loadedAt !== currentTerminal.evidence.loadedAt) {
          throw new Error('Terminal restart receipt and actually-loaded generation evidence do not match.');
        }
        const committedGenerationId = manifest.activeGeneration?.identity.generationId;
        if (!committedGenerationId) {
          throw new Error('Post-restart census requires the committed analytics generation.');
        }
        // The post-restart census explicitly names the committed generation
        // and re-proves the descriptor: restarted hosts must show the NEW
        // generation, not merely lack the old one.
        const discovery = await retryStalledAnalyticsDiscovery(() => adapters.discover({
          ignoreStoppedHosts: true,
          analyticsGenerationId: committedGenerationId,
          allowAbsentAnalyticsDescriptor: false,
        }));
        if (!discovery.complete || discovery.hosts.length === 0) {
          throw new Error(`Post-restart authenticated host census is incomplete: ${discovery.reasons.map((entry) => entry.code).join(', ') || 'unknown blocker'}`);
        }
        if (!discovery.hosts.some((host) => host.hostInstanceId === currentTerminal.evidence.hostInstanceId)) {
          throw new Error(`Post-restart host census does not include the controlled terminal receipt host ${currentTerminal.evidence.hostInstanceId}.`);
        }
        const hosts = discovery.hosts.map((host) => {
          if (host.status !== 'reconciled' || host.backendGeneration === undefined) {
            throw new Error(`Post-restart host ${host.hostInstanceId} is not fully reconciled.`);
          }
          return {
            hostInstanceId: host.hostInstanceId,
            processId: host.processId,
            backendGeneration: host.backendGeneration,
          };
        });
        const committed = activationStore.read();
        if (!committed.sha256 || !committed.manifest?.activeGeneration) {
          throw new Error('Post-restart activation manifest is not canonical.');
        }
        registry.reopenAnalyticsWriterAdmission({
          workspaceId: plan.workspaceId,
          operationId,
          purpose: 'analytics-activation',
          nowMs: Date.now(),
        });
        return {
          verified: true,
          generationId: committed.manifest.activeGeneration.identity.generationId,
          buildId: committed.manifest.activeGeneration.identity.buildId,
          manifestRevision: committed.manifest.revision,
          manifestSha256: committed.sha256,
          hosts,
          admissionReopened: true,
          terminalEvidenceSha256: currentTerminal.evidence.evidenceSha256,
        };
      },
      completeStorageCutoff: async ({ operationId, manifest }) => {
        if (!storageInventory) throw new Error('Storage cutoff lifecycle is not configured.');
        registry.authorizeStorageCutoffSuccessorCapability({
          workspaceId: plan.workspaceId,
          operationId,
          requiredCapability: storageInventory.rootCapability,
          nowMs: Date.now(),
        });
        const previousLoaded = readLoadedGeneration(plan.stateDir);
        let currentTerminal = readTerminalRestartReceipt(plan);
        if (terminalPrerequisite?.status === 'pending'
          && !isTerminalReceiptAfterStorageCutoff(plan, currentTerminal)) {
          currentTerminal = await requestAndAwaitTerminalRestart(plan, previousLoaded);
        }
        if (!currentTerminal.ready) throw new Error(currentTerminal.blockers.join('; '));
        const active = manifest.activeGeneration;
        const loaded = readLoadedGeneration(plan.stateDir);
        if (!active || !loaded
          || loaded.generationId !== active.identity.generationId
          || loaded.buildId !== active.identity.buildId
          || loaded.hostInstanceId !== currentTerminal.evidence.hostInstanceId
          || loaded.restartNonce !== currentTerminal.evidence.restartNonce
          || loaded.loadedAt !== currentTerminal.evidence.loadedAt) {
          throw new Error('Storage-cutoff restart did not preserve the active analytics generation.');
        }
        const discovery = await retryStalledAnalyticsDiscovery(() => adapters.discover({
          ignoreStoppedHosts: true,
          analyticsGenerationId: active.identity.generationId,
          allowAbsentAnalyticsDescriptor: false,
        }));
        if (!discovery.complete || discovery.hosts.length === 0) {
          throw new Error(`Post-storage-restart authenticated host census is incomplete: ${discovery.reasons.map((entry) => entry.code).join(', ') || 'unknown blocker'}`);
        }
        const hosts = discovery.hosts.map((host) => {
          if (host.status !== 'reconciled' || host.backendGeneration === undefined) {
            throw new Error(`Post-storage-restart host ${host.hostInstanceId} is not fully reconciled.`);
          }
          const registered = registry.getAnalyticsHost(host.hostInstanceId);
          if (!registered) throw new Error(`Post-storage-restart host ${host.hostInstanceId} is absent from the lifecycle registry.`);
          registry.assertStorageCutoffSuccessorAdmission({
            workspaceId: plan.workspaceId,
            operationId,
            identity: registered,
            requiredCapability: storageInventory.rootCapability,
          });
          return {
            hostInstanceId: host.hostInstanceId,
            processId: host.processId,
            backendGeneration: host.backendGeneration,
          };
        });
        if (!hosts.some((host) => host.hostInstanceId === currentTerminal.evidence.hostInstanceId)) {
          throw new Error(`Post-storage-restart host census does not include the controlled terminal receipt host ${currentTerminal.evidence.hostInstanceId}.`);
        }
        return { verified: true, hosts, admissionReopened: true };
      },
    };
    const operationId = plan.operationId ?? plan.generationId;
    const orchestrator = new deps.AnalyticsCutoverOrchestrator({
      enabled: true,
      mode,
      operationId,
      workspaceId: plan.workspaceId,
      stateDir: plan.stateDir,
      authorization: plan.authorization,
      prerequisites: mode === 'analytics-activation'
        ? productionCutoverPrerequisites(plan, admitted)
        : plan.prerequisites,
      activationStore,
      registry,
      ...(mode === 'analytics-activation' ? {
        analyticsHandoff: withWriterFenceCensusStallRetry(withTerminalRowSettlement(
          adapters.coordinator('analytics-activation'),
          { registry, deps, plan },
        )),
        activationRequest,
      } : {
        storageHandoff: adapters.coordinator('storage-cutoff'),
        // The immutable canonical storage request is journaled by the
        // orchestrator before the first private cleanup; a resumed plan that
        // changed the inventory, roots, or analytics database is then refused
        // instead of silently scrubbing a different database.
        storageRequest: {
          inventorySha256: deps.analyticsCutoverInventorySha256(storageInventory.sessionIds),
          cutoffRoots: storageInventory.roots,
          analyticsDatabasePath: plan.analyticsDatabasePath,
        },
        collectInventory: async (fence) => {
          if (fence.operationId !== operationId || fence.purpose !== 'storage-cutoff') {
            throw new Error('Storage inventory cannot be collected outside its durable writer fence.');
          }
          const validated = validateProductionStorageInventory(plan, registry, deps);
          return {
            source: 'explicit-lifecycle-registry-v1',
            complete: true,
            sessionIds: validated.sessionIds,
            fenceOperationId: fence.operationId,
            fenceEpoch: fence.fenceEpoch,
            inventorySha256: deps.analyticsCutoverInventorySha256(validated.sessionIds),
          };
        },
      }),
      expectedActiveGenerationId: plan.expectedActiveGenerationId,
      cleaner: storageLifecycle?.cleaner,
      runtime,
    });
    return await orchestrator.run();
  } finally {
    storageLifecycle?.close();
    registry.close();
  }
}

/** Direct-execution entry point. Imported tests must not execute the CLI
 * flow, so every top-level execution side effect lives here. */
async function main(plan, options) {
  if (options.detach && options.preflight) fail('--preflight/--dry-run cannot be detached');

  if (options.detach) {
    // Re-exec detached so the helper outlives the terminal or agent session that
    // started it. The child outlives this process, so its stdout/stderr are the
    // only durable record of a failed run: capture them in an append-mode log
    // next to the plan/report instead of discarding them, so a silent child
    // death (for example fail() exiting without releasing the phase lock) is
    // diagnosable after the fact.
    const detachLogPath = path.join(path.dirname(plan.reportPath ?? options.plan), 'activation-helper-detach.log');
    mkdirSync(path.dirname(detachLogPath), { recursive: true });
    const detachLog = openSync(detachLogPath, 'a');
    writeSync(detachLog, `analytics-activation-helper: detached launch at ${new Date().toISOString()} (spawner pid ${process.pid})\n`);
    const child = spawn(process.execPath, process.argv.slice(1).filter((value) => value !== '--detach'), {
      detached: true,
      stdio: ['ignore', detachLog, detachLog],
      cwd: repositoryRoot,
      env: { ...process.env, PIE_ANALYTICS_HELPER_DETACHED: '1' },
    });
    child.unref();
    closeSync(detachLog);
    process.stdout.write(`analytics-activation-helper: detached as pid ${child.pid}; child output: ${detachLogPath}\n`);
    process.exit(0);
  }

  if (options.status) {
    if (!options.state) fail('--status requires --state');
    process.stdout.write(`${JSON.stringify(readPhaseRecord(options.state), null, 2)}\n`);
    process.exit(0);
  }

  if (options.preflight) {
    const result = await runPreflight(plan).catch((error) => ({
      schemaVersion: 1,
      mode: 'PREFLIGHT',
      status: 'blocked',
      readiness: { analyticsActivation: false, storageCutoff: null },
      blockers: [error instanceof Error ? error.message : String(error)],
      evidence: null,
      destructiveActions: { activation: false, restart: false, shutdown: false, storageCutoff: false },
    }));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.status === 'ready' ? 0 : 2);
  }

  if (plan.cutoverMode !== undefined || plan.authorization !== undefined) {
    try {
      const result = await runProductionCutover(plan);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(0);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  await runLegacyActivationSequence(plan);
}

/** The original direct CLI activation flow, retained as the legacy rehearsal
 * path. It acquires the phase lock itself and never runs in production. */
async function runLegacyActivationSequence(plan) {
  await loadActivationModules();
  // Phase: prepare. Hash the evidence reports now, so the activated generation
  // names exact bytes rather than a path that could change later.
  const store = new ActivationStore({ stateDir: plan.stateDir });
  // Admission is deliberately before every manifest mutation. It parses and
  // rechecks the exact bounded report bytes on every resume; a prior phase
  // record can never turn changed, partial, or rehearsal evidence into an
  // activation authorization.
  let admitted;
  try {
    admitted = admitActivationEvidence(admissionEvidenceOptions(plan));
  } catch (error) {
    recordError(plan.stateDir, 'prepare', error);
    throw error;
  }
  if (!hasCompleted(plan.stateDir, 'prepare')) {
    appendPhase(plan.stateDir, 'prepare', admitted);
  }

  const prepared = readPhaseRecord(plan.stateDir).phases.find((entry) => entry.phase === 'prepare' && !entry.error);
  if (!prepared) fail('prepare phase did not record evidence');
  if (prepared.detail?.qualificationSha256 !== admitted.qualificationSha256
    || prepared.detail?.trialSha256 !== admitted.trialSha256) {
    fail('prepared evidence hashes do not match the currently admitted report bytes');
  }

  // Phase: activate. Idempotent, so a rerun after any interruption resumes.
  if (!hasCompleted(plan.stateDir, 'activate')) {
    try {
      const outcome = await activateGeneration(store, {
        generationId: plan.generationId,
        buildId: plan.buildId,
        qualificationSha256: admitted.qualificationSha256,
        trialSha256: admitted.trialSha256,
        activatedAt: new Date().toISOString(),
      });
      appendPhase(plan.stateDir, 'activate', {
        alreadyActive: outcome.alreadyActive,
        revision: outcome.revision,
        authority: store.read().authority,
      });
    } catch (error) {
      recordError(plan.stateDir, 'activate', error);
      throw error;
    }
  }

  // Phase: cutoff. Analytics activation and storage cutoff are distinct ordered
  // gates. Inventory validation and the all-host handoff must be present before
  // loading the lifecycle store, so a caller's list can never become a writer
  // fence by itself. An empty *validated* inventory remains a legitimate no-session
  // operation; missing or unvalidated inventory is inadmissible.
  let cutoffReadyForRestart = false;
  if (!hasCompletedCutoff(plan.stateDir)) {
    let cutoffBlockedReason;
    if (!Array.isArray(plan.cutoffInventory)) cutoffBlockedReason = 'cutoff inventory is missing';
    else if (plan.cutoffInventoryValidated !== true) cutoffBlockedReason = 'cutoff inventory is not explicitly validated';
    else if (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] !== STORAGE_CUTOFF_AUTHORIZATION_VALUE) {
      cutoffBlockedReason = `storage cutoff requires ${STORAGE_CUTOFF_AUTHORIZATION_ENV}=${STORAGE_CUTOFF_AUTHORIZATION_VALUE}`;
    }
    const handoff = cutoffBlockedReason
      ? { ok: false, reason: cutoffBlockedReason }
      : await produceAuthoritativeCutoffHandoff(plan);
    if (!handoff.ok) {
      appendPhase(plan.stateDir, 'cutoff', {
        completed: false,
        performed: false,
        admissible: false,
        reason: handoff.reason,
      });
    } else {
      try {
        const { performStorageCutoff, storageCutoffReceiptSha256, SessionLifecycleStore, lifecycle } =
          await loadCutoffModules();
        const cutoffStateDir = plan.cutoffStateDir ?? plan.stateDir;
        mkdirSync(cutoffStateDir, { recursive: true });
        const cutoffStore = new SessionLifecycleStore(path.join(cutoffStateDir, 'session-lifecycle.sqlite'));
        try {
          const barrier = new lifecycle.SessionFilesystemMutationBarrier({
            store: cutoffStore,
            lockRoot: path.join(cutoffStateDir, 'session-mutation-locks'),
          });
          // No canonical analytics deletion adapter is established at this
          // helper boundary yet. The cutoff module therefore preflights private
          // sessions and fails before closing any session if one is inventoried.
          const cleaner = new lifecycle.SessionLifecycleCleaner({
            store: cutoffStore,
            barrier,
            roots: plan.cutoffRoots ?? {},
          });
          const receipt = await performStorageCutoff({
            store: cutoffStore,
            cleaner,
            stateDir: cutoffStateDir,
            inventory: plan.cutoffInventory,
            inventoryValidated: true,
            operationId: `${plan.generationId}:cutoff`,
            writerFence: {
              ensureFenced: async () => handoff.receipt,
            },
          });
          appendPhase(plan.stateDir, 'cutoff', {
            completed: receipt.failures.length === 0,
            performed: true,
            admissible: receipt.failures.length === 0,
            closedSessionCount: receipt.closedSessionIds.length,
            alreadyClosedCount: receipt.alreadyClosedSessionIds.length,
            deletedSessionCount: receipt.deletedSessionIds.length,
            failureCount: receipt.failures.length,
            cutoffReceiptSha256: storageCutoffReceiptSha256(receipt),
            handoffReceiptSha256: handoff.sha256,
            handoffHostCount: handoff.hostCount,
          });
        } finally {
          cutoffStore.close();
        }
      } catch (error) {
        recordError(plan.stateDir, 'cutoff', error);
        throw error;
      }
    }
  }

  // A phase record is only a progress hint. Re-read the journal and receipt
  // owned by the cutoff module, and bind them to the phase's receipt and the
  // current all-host handoff before permitting the restart phase.
  if (hasCompletedCutoff(plan.stateDir)) {
    let cutoffValidationReason;
    if (!Array.isArray(plan.cutoffInventory)) cutoffValidationReason = 'cutoff inventory is missing';
    else if (plan.cutoffInventoryValidated !== true) cutoffValidationReason = 'cutoff inventory is not explicitly validated';
    else if (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] !== STORAGE_CUTOFF_AUTHORIZATION_VALUE) {
      cutoffValidationReason = `storage cutoff requires ${STORAGE_CUTOFF_AUTHORIZATION_ENV}=${STORAGE_CUTOFF_AUTHORIZATION_VALUE}`;
    }
    const handoff = cutoffValidationReason
      ? { ok: false, reason: cutoffValidationReason }
      : readAuthoritativeCutoffHandoff(plan);
    if (!handoff.ok) cutoffValidationReason = handoff.reason;
    if (!cutoffValidationReason) {
      try {
        const { inspectStorageCutoff, storageCutoffReceiptSha256 } = await loadCutoffModules();
        const inspected = inspectStorageCutoff({
          stateDir: plan.cutoffStateDir ?? plan.stateDir,
          inventory: plan.cutoffInventory,
          inventoryValidated: true,
          operationId: `${plan.generationId}:cutoff`,
        });
        const cutoffPhase = readPhaseRecord(plan.stateDir).phases
          .filter((entry) => entry.phase === 'cutoff' && !entry.error)
          .at(-1);
        if (inspected.receipt.failures.length !== 0
          || cutoffPhase?.detail?.cutoffReceiptSha256 !== storageCutoffReceiptSha256(inspected.receipt)
          || cutoffPhase?.detail?.handoffReceiptSha256 !== handoff.sha256) {
          cutoffValidationReason = 'cutoff phase, durable receipt, and authoritative handoff are not bound';
        } else {
          cutoffReadyForRestart = true;
        }
      } catch (error) {
        cutoffValidationReason = `durable cutoff completion cannot be verified: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (cutoffValidationReason) {
      appendPhase(plan.stateDir, 'cutoff', {
        completed: false,
        performed: false,
        admissible: false,
        reason: cutoffValidationReason,
      });
    }
  }

  // Phase: restart. Requested through a configured command rather than by killing
  // the process tree, and recorded whether or not a command was supplied.
  if (!hasCompletedRestart(plan.stateDir, Boolean(plan.restartCommand))) {
    if (!cutoffReadyForRestart) {
      appendPhase(plan.stateDir, 'restart', {
        completed: false,
        requested: false,
        reason: 'restart is held until the storage cutoff has a zero-failure completed phase and authoritative handoff',
      });
    } else if (!plan.restartCommand) {
      appendPhase(plan.stateDir, 'restart', {
        completed: true,
        cutoffCompleted: true,
        requested: false,
        reason: 'no restartCommand in plan',
      });
    } else {
      try {
        const previousLoaded = readLoadedGeneration(plan.stateDir);
        const requestedAtMs = Date.now();
        const restartNonce = randomUUID();
        const child = spawn(plan.restartCommand, {
          shell: true,
          detached: true,
          stdio: 'ignore',
          cwd: repositoryRoot,
          env: createLegacyRestartEnvironment(plan, restartNonce),
        });
        child.unref();
        appendPhase(plan.stateDir, 'restart', {
          completed: true,
          cutoffCompleted: true,
          requested: true,
          pid: child.pid,
          command: plan.restartCommand,
          requestedAtMs,
          requestedAt: new Date(requestedAtMs).toISOString(),
          restartNonce,
          previousHostInstanceId: previousLoaded?.hostInstanceId ?? null,
          previousLoadedAt: previousLoaded?.loadedAt ?? null,
        });
      } catch (error) {
        recordError(plan.stateDir, 'restart', error);
        throw error;
      }
    }
  }

  // Phase: verify. Read back what is actually recorded, and state plainly that a
  // manifest read is not proof the new code is loaded in a running host.
  const verification = await (async () => {
    const read = store.read();
    const active = read.manifest?.activeGeneration ?? null;
    // A host writes this after it reaches canonical readiness, so its presence
    // distinguishes "the manifest records a generation" from "a host loaded that
    // generation and passed its readiness probe". Both are needed before the
    // activation can be called live.
    const loadedBeforeVerification = readLoadedGeneration(plan.stateDir);
    const restartEntry = readPhaseRecord(plan.stateDir).phases
      .filter((entry) => entry.phase === 'restart' && !entry.error && entry.detail?.requested === true)
      .at(-1);
    const restartDetail = restartEntry?.detail;
    let loaded = loadedBeforeVerification;
    let freshLoaded = false;
    let loadedWaitTimedOut = false;
    if (plan.restartCommand && restartDetail
      && Number.isSafeInteger(restartDetail.requestedAtMs)
      && typeof restartDetail.requestedAt === 'string') {
      const waited = await waitForFreshLoadedGeneration(plan.stateDir, plan, restartDetail);
      loaded = waited.loaded;
      freshLoaded = waited.matched;
      loadedWaitTimedOut = waited.timedOut;
    }
    const loadedGenerationIdentityMatchesPlan = loaded?.generationId === plan.generationId
      && loaded?.buildId === plan.buildId;
    const loadedHostIdentityChanged = Boolean(loaded
      && restartDetail
      && (restartDetail.previousHostInstanceId === null
        || loaded.hostInstanceId !== restartDetail.previousHostInstanceId));
    return {
      authority: read.authority,
      manifestRevision: read.manifest?.revision ?? null,
      activeGenerationId: active?.identity.generationId ?? null,
      activeBuildId: active?.identity.buildId ?? null,
      generationMatchesPlan: active?.identity.generationId === plan.generationId,
      tombstonePresent: read.tombstonePresent,
      loadedGenerationId: loaded?.generationId ?? null,
      loadedBuildId: loaded?.buildId ?? null,
      loadedRestartNonce: loaded?.restartNonce ?? null,
      loadedHostInstanceId: loaded?.hostInstanceId ?? null,
      loadedAt: loaded?.loadedAt ?? null,
      loadedGenerationIdentityMatchesPlan,
      loadedEvidenceFreshForRestart: freshLoaded,
      loadedHostIdentityChanged,
      loadedWaitTimedOut,
      loadedGenerationMatchesPlan: loadedGenerationIdentityMatchesPlan
        && freshLoaded
        && loadedHostIdentityChanged,
    };
  })();
  if (!hasCompleted(plan.stateDir, 'verify')) {
    appendPhase(plan.stateDir, 'verify', verification);
  }

  // Phase: report.
  const phases = readPhaseRecord(plan.stateDir).phases;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    plan: {
      stateDir: plan.stateDir,
      generationId: plan.generationId,
      buildId: plan.buildId,
      restartRequested: Boolean(plan.restartCommand),
    },
    verification,
    phases,
    // Stated explicitly so a manifest read is never presented as proof that the
    // loaded host generation changed. `loadedGenerationMatchesPlan` is the field
    // that answers that, and it is null until a host has actually started under
    // the new authority.
    postRestartProbeRequired: verification.loadedGenerationMatchesPlan !== true,
  };
  const cutoffCompleted = cutoffReadyForRestart;
  const activeAuthorityVerified = verification.authority === 'canonical'
    && verification.generationMatchesPlan === true
    && verification.tombstonePresent === true;
  const complete = Boolean(plan.restartCommand)
    && verification.loadedGenerationMatchesPlan === true
    && activeAuthorityVerified
    && cutoffCompleted;
  const incompleteReasons = [];
  if (!activeAuthorityVerified) incompleteReasons.push('active canonical manifest does not match the requested generation');
  if (!cutoffCompleted) incompleteReasons.push('storage cutoff has no zero-failure completed phase with an authoritative all-host handoff');
  if (verification.loadedGenerationMatchesPlan !== true) incompleteReasons.push('no matching actually-loaded generation evidence');
  if (!plan.restartCommand) incompleteReasons.push('no restart was requested; this is a rehearsal only');
  report.status = complete ? 'complete' : (plan.restartCommand ? 'incomplete' : 'rehearsal');
  report.incompleteReasons = incompleteReasons;
  mkdirSync(path.dirname(plan.reportPath), { recursive: true });
  atomicWriteJson(plan.reportPath, report);
  appendPhase(plan.stateDir, 'report', { reportPath: plan.reportPath });

  process.stdout.write(`${JSON.stringify({ status: report.status, report: plan.reportPath, verification, incompleteReasons }, null, 2)}\n`);
}

export { loadPlan, parseArguments, runPreflight };

/** Execute the CLI only when this file is the direct entry point. Other
 * importers (tests, tools) never trigger the activation flow. */
const entryArg = process.argv[1];
if (entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href) {
  const options = parseArguments(process.argv.slice(2));
  if (options.detach && options.preflight) fail('--preflight/--dry-run cannot be detached');
  if (options.status && !options.state) fail('--status requires --state');
  const plan = loadPlan(options.plan, { preflight: options.preflight });
  const phaseLock = await acquirePhaseLock(plan.stateDir, plan.generationId);
  try {
    await main(plan, options);
  } finally {
    phaseLock.release();
  }
}
