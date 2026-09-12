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
//   node scripts/analytics-activation-helper.mjs --status --state <stateDir>
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
//   "cutoffInventory": ["<validated lifecycle session id>"],
//   "cutoffInventoryValidated": true,
//   "cutoffHandoffReceiptPath": "<authoritative all-host handoff receipt>"
// }
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  readLoadedGeneration,
  waitForFreshLoadedGeneration,
} from './analytics-activation-recovery.mjs';

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
// No host-supervisor producer currently emits an attested all-host handoff.
// Keep the provisional schema below for the integration boundary, but do not
// let a plan caller manufacture an equivalent JSON file and open P7b.
const ALL_HOST_HANDOFF_PRODUCER_AVAILABLE = false;

function fail(message) {
  process.stderr.write(`analytics-activation-helper: ${message}\n`);
  process.exit(1);
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
  const options = { detach: false, status: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--detach') { options.detach = true; continue; }
    if (argument === '--status') { options.status = true; continue; }
    if (argument === '--plan') { options.plan = argv[++index]; continue; }
    if (argument === '--state') { options.state = argv[++index]; continue; }
    fail(`unsupported argument: ${argument}`);
  }
  return options;
}

function loadPlan(planPath) {
  if (!planPath) fail('--plan is required');
  if (!path.isAbsolute(planPath)) fail('--plan must be an absolute path');
  if (!existsSync(planPath)) fail(`plan file does not exist: ${planPath}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (error) {
    fail(`plan file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const field of ['stateDir', 'qualificationReport', 'trialReport', 'generationId', 'buildId', 'sourceHead', 'sourceFingerprint', 'reportPath']) {
    if (typeof parsed[field] !== 'string' || parsed[field].trim().length === 0) {
      fail(`plan.${field} must be a non-empty string`);
    }
  }
  for (const field of ['stateDir', 'qualificationReport', 'trialReport', 'reportPath']) {
    if (!path.isAbsolute(parsed[field])) fail(`plan.${field} must be an absolute path`);
  }
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

function cutoffInventoryDigest(inventory) {
  const sorted = [...inventory].sort();
  return createHash('sha256').update(`${JSON.stringify(sorted)}\n`).digest('hex');
}

/** The all-host owner has to produce this receipt. A plan flag or a caller's
 * inventory is not a writer fence and cannot authorize P7b. */
function readAuthoritativeCutoffHandoff(plan) {
  if (!ALL_HOST_HANDOFF_PRODUCER_AVAILABLE) {
    return { ok: false, reason: 'authoritative all-host handoff receipt is required; no producer is wired' };
  }
  const receiptPath = plan.cutoffHandoffReceiptPath;
  if (typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath)) {
    return { ok: false, reason: 'authoritative all-host handoff receipt is required; no producer is wired' };
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
  const hostIds = parsed && typeof parsed === 'object' && Array.isArray(parsed.hostIds) ? parsed.hostIds : null;
  const validHostIds = hostIds && hostIds.length > 0 && hostIds.every((id) => typeof id === 'string' && id.length > 0);
  if (!parsed || typeof parsed !== 'object'
    || parsed.schemaVersion !== 1
    || parsed.kind !== 'pie-p7b-all-host-handoff-v1'
    || parsed.status !== 'quiesced'
    || parsed.authority !== 'pie-host-supervisor-v1'
    || parsed.quietAllHosts !== true
    || parsed.generationId !== plan.generationId
    || parsed.operationId !== `${plan.generationId}:cutoff`
    || parsed.inventorySha256 !== cutoffInventoryDigest(plan.cutoffInventory)
    || !validHostIds
    || new Set(hostIds).size !== hostIds.length) {
    return { ok: false, reason: 'authoritative all-host handoff receipt is not bound to this generation, operation, validated inventory, and quiet host fence' };
  }
  return {
    ok: true,
    sha256: createHash('sha256').update(raw).digest('hex'),
    hostCount: hostIds.length,
  };
}

const { ActivationStore } = await import(
  pathToFileURL(path.join(outRoot, 'analytics-activation-store.js')).href
).catch(() => fail('analytics-activation-store.js is missing; run the extension build first'));
const { activateGeneration } = await import(
  pathToFileURL(path.join(outRoot, 'analytics-activation-sequence.js')).href
).catch(() => fail('analytics-activation-sequence.js is missing; run the extension build first'));
const { admitActivationEvidence } = await import(
  pathToFileURL(path.join(repositoryRoot, 'scripts', 'analytics-activation-admission.mjs')).href
).catch(() => fail('analytics-activation-admission.mjs is missing'));

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

const options = parseArguments(process.argv.slice(2));

if (options.detach) {
  // Re-exec detached so the helper outlives the terminal or agent session that
  // started it. stdout/stderr are discarded rather than inherited so the parent
  // exiting cannot break the child's streams.
  const child = spawn(process.execPath, process.argv.slice(1).filter((value) => value !== '--detach'), {
    detached: true,
    stdio: 'ignore',
    cwd: repositoryRoot,
  });
  child.unref();
  process.stdout.write(`analytics-activation-helper: detached as pid ${child.pid}\n`);
  process.exit(0);
}

if (options.status) {
  if (!options.state) fail('--status requires --state');
  process.stdout.write(`${JSON.stringify(readPhaseRecord(options.state), null, 2)}\n`);
  process.exit(0);
}

const plan = loadPlan(options.plan);

async function main() {
  // Phase: prepare. Hash the evidence reports now, so the activated generation
  // names exact bytes rather than a path that could change later.
  const store = new ActivationStore({ stateDir: plan.stateDir });
  // Admission is deliberately before every manifest mutation. It parses and
  // rechecks the exact bounded report bytes on every resume; a prior phase
  // record can never turn changed, partial, or rehearsal evidence into an
  // activation authorization.
  let admitted;
  try {
    admitted = admitActivationEvidence({
      qualificationPath: plan.qualificationReport,
      trialPath: plan.trialReport,
      generationId: plan.generationId,
      buildId: plan.buildId,
      sourceHead: plan.sourceHead,
      sourceFingerprint: plan.sourceFingerprint,
    });
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
    const handoff = cutoffBlockedReason ? { ok: false, reason: cutoffBlockedReason } : readAuthoritativeCutoffHandoff(plan);
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
    const handoff = cutoffValidationReason ? { ok: false, reason: cutoffValidationReason } : readAuthoritativeCutoffHandoff(plan);
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
          env: { ...process.env, PIE_ANALYTICS_RESTART_NONCE: restartNonce },
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

const phaseLock = await acquirePhaseLock(plan.stateDir, plan.generationId);
try {
  await main();
} finally {
  phaseLock.release();
}
