#!/usr/bin/env node
// One-shot controlled VS Code restart owner for the analytics terminal handoff.
//
// This is the real ingress the activation helper invokes as `plan.restartCommand`.
// The helper spawns it detached with `PIE_ANALYTICS_RESTART_NONCE` and
// `PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH` in the environment, so it
// survives the parent session's exit and never depends on the helper's stdio.
//
// What it does, in one finite pass:
//   1. Validates the helper-issued nonce/receipt pair against the plan.
//   2. Fails closed unless the durable all-host writer fence for the plan's
//      cutover mode is `fenced` and every registered host exposes an
//      authenticated controlled-restart endpoint with a channel key (and, for
//      storage cutoff, the bound final-root capability). Nothing restarts
//      unless the whole fenced census can be coordinated.
//   3. Sends one signed controlled-restart request to every such host. Each
//      host durably records its host-scoped nonce/evidence paths and fresh
//      successor key, acknowledges, and then performs its own supported quiet
//      restart (`workbench.action.restartExtensionHost`, falling back to a
//      window reload; both preserve unsaved editor work; no process is killed).
//   4. Watches the lifecycle registry for the actual restarted host boots,
//      authenticates each with its distinct successor key, and refreshes the
//      owner-controlled per-host key channel so the helper's post-restart
//      census can authenticate the complete replacement set.
//   5. Writes a sanitized durable owner record in the plan's state dir and
//      exits. It never fabricates evidence: the terminal restart receipts,
//      loaded-generation markers and authenticated census stay owned by the
//      restarted hosts and the helper.
//
// It deliberately does NOT force-kill anything, restart VS Code's main
// process, write host/global VS Code state, or wait forever. If the currently
// loaded hosts lack the controlled-restart ingress, it reports the exact
// bootstrap blocker and exits non-zero instead of pretending.

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..');
const outRoot = path.join(repositoryRoot, 'extension', 'out');

const OWNER_RECORD_FILENAME = 'analytics-restart-owner-v1.json';
const MAX_PLAN_BYTES = 8 * 1024 * 1024;
const MAX_KEY_FILE_BYTES = 64 * 1024;
const DEFAULT_SEND_TIMEOUT_MS = 5_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 25_000;
const SETTLE_POLL_MS = 250;

function fail(message) {
  process.stderr.write(`analytics-restart-owner: ${message}\n`);
  process.exit(1);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoundedJson(filePath, label, maxBytes) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return { error: `${label} path must be absolute` };
  }
  let size;
  try {
    size = statSync(filePath).size;
  } catch {
    return { error: `${label} is missing` };
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
    return { error: `${label} exceeds ${maxBytes} bytes` };
  }
  try {
    return { value: JSON.parse(readFileSync(filePath, 'utf8')), error: undefined };
  } catch (error) {
    return { error: `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Write `value` to `filePath` atomically (exclusive temp + fsync + rename). */
export function writeBoundedJsonAtomically(filePath, value, maxBytes) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes, 'utf8') > maxBytes) {
    throw new Error(`${path.basename(filePath)} exceeds ${maxBytes} bytes.`);
  }
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}-${createHash('sha256')
      .update(`${Date.now()}:${process.pid}:${Math.random()}`).digest('hex').slice(0, 12)}.tmp`,
  );
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx' });
    const handle = openSync(temporary, 'r+');
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, filePath);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

/** Resolve the helper-issued restart pair from the environment. */
export function readRestartEnvironment(environment = process.env) {
  const restartNonce = environment.PIE_ANALYTICS_RESTART_NONCE?.trim() || null;
  const terminalRestartReceiptPath = environment.PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH?.trim();
  if (!restartNonce || !terminalRestartReceiptPath || !path.isAbsolute(terminalRestartReceiptPath)) {
    throw new Error(
      'controlled restart requires PIE_ANALYTICS_RESTART_NONCE and an absolute '
      + 'PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH (the helper supplies both).',
    );
  }
  return { restartNonce, terminalRestartReceiptPath };
}

/** Resolve the fence the helper must already have established before any
 * controlled restart is requested. The activation fence operation id is
 * derived exactly like the orchestrator's phase operation id. */
export function expectedFenceForMode(plan) {
  const mode = plan.cutoverMode ?? 'analytics-activation';
  if (mode !== 'analytics-activation' && mode !== 'storage-cutoff') {
    throw new Error(`plan cutoverMode ${String(mode)} is unsupported.`);
  }
  const operationId = typeof plan.operationId === 'string' && plan.operationId.trim().length > 0
    ? plan.operationId
    : plan.generationId;
  if (typeof operationId !== 'string' || operationId.trim().length === 0) {
    throw new Error('plan operationId or generationId is required.');
  }
  return {
    mode,
    operationId: mode === 'storage-cutoff' ? operationId : `${operationId}:analytics-activation`,
    purpose: mode,
  };
}

/** Legacy helper retained for focused contract tests. The restart owner no
 * longer calls this function: every successor receives a fresh key through its
 * signed, host-scoped pending record. */
export function commonHostKey(hostKeys) {
  if (hostKeys.length === 0) {
    throw new Error('no registered host carries an authenticated handoff key.');
  }
  const unique = [...new Set(hostKeys)];
  if (unique.length !== 1) {
    throw new Error('authenticated host keys are ambiguous; the launch channel must supply one shared key.');
  }
  return unique[0];
}

/** Read the owner-controlled key channel freshly. Mirrors the helper: a
 * dedicated key file wins, then in-plan keys, then the process environment. */
export function readKeyChannel(plan, planPath) {
  if (typeof plan.hostHandoffKeysPath === 'string') {
    const file = readBoundedJson(plan.hostHandoffKeysPath, 'host handoff key file', MAX_KEY_FILE_BYTES);
    if (file.error !== undefined) throw new Error(file.error);
    if (!isRecord(file.value)) throw new Error('host handoff key file must be a hostInstanceId map.');
    return { keys: new Map(Object.entries(file.value)), file: plan.hostHandoffKeysPath, planPath: undefined };
  }
  if (typeof planPath === 'string' && isRecord(plan.hostHandoffKeys)) {
    return { keys: new Map(Object.entries(plan.hostHandoffKeys)), file: undefined, planPath };
  }
  const envRaw = process.env.PIE_ANALYTICS_HANDOFF_KEYS_JSON;
  if (envRaw === undefined) {
    throw new Error('the plan carries no authenticated host key channel.');
  }
  let parsed;
  try {
    parsed = JSON.parse(envRaw);
  } catch {
    throw new Error('PIE_ANALYTICS_HANDOFF_KEYS_JSON is not valid JSON.');
  }
  if (!isRecord(parsed)) throw new Error('PIE_ANALYTICS_HANDOFF_KEYS_JSON must be a hostInstanceId map.');
  return { keys: new Map(Object.entries(parsed)), file: undefined, planPath: undefined };
}

function keyChannelValue(channel, hostInstanceId) {
  const key = channel.keys.get(hostInstanceId);
  return typeof key === 'string' && key.trim().length > 0 && key.length <= 4_096 ? key : undefined;
}

/** Add entries for newly observed host ids without disturbing existing ones.
 * A conflicting existing value is a stale/ambiguous handoff and fails closed;
 * successor keys are never silently replaced or copied from another host. */
export function mergeKeyChannelEntries(channel, entries, maxBytes = MAX_KEY_FILE_BYTES) {
  const merged = { ...Object.fromEntries(channel.keys.entries()) };
  for (const [hostInstanceId, key] of Object.entries(entries)) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 4_096) {
      throw new Error(`successor handoff key for ${hostInstanceId} is invalid.`);
    }
    if (merged[hostInstanceId] !== undefined && merged[hostInstanceId] !== key) {
      throw new Error(`successor handoff key for ${hostInstanceId} conflicts with the durable channel.`);
    }
    if (merged[hostInstanceId] === undefined) merged[hostInstanceId] = key;
  }
  const next = { keys: new Map(Object.entries(merged)), file: channel.file, planPath: channel.planPath };
  if (channel.file !== undefined) {
    writeBoundedJsonAtomically(channel.file, merged, maxBytes);
  } else if (channel.planPath !== undefined) {
    // The plan file is the owner's controlled input; refresh only its key map,
    // exactly like the rehearsed fixture channel, and re-read to confirm.
    const current = readBoundedJson(channel.planPath, 'activation plan', MAX_PLAN_BYTES);
    if (current.error !== undefined) throw new Error(current.error);
    writeBoundedJsonAtomically(channel.planPath, { ...current.value, hostHandoffKeys: merged }, MAX_PLAN_BYTES);
  } else {
    // Environment-only channel: nothing durable to refresh; the census must
    // be retried with a refreshed durable channel instead.
    throw new Error('the key channel has no durable file to refresh.');
  }
  return next;
}

export async function loadOwnerDependencies() {
  const load = async (name) => import(pathToFileURL(path.join(outRoot, `${name}.js`)).href);
  const [lifecycle, discovery, restart, adapters] = await Promise.all([
    load('session-lifecycle-store'),
    load('analytics-handoff-discovery'),
    load('analytics-controlled-restart'),
    load('analytics-production-adapters'),
  ]);
  return {
    SessionLifecycleStore: lifecycle.SessionLifecycleStore,
    storageCutoffRootCapability: lifecycle.storageCutoffRootCapability,
    sendBoundedAnalyticsFrame: discovery.sendBoundedAnalyticsFrame,
    createAuthenticatedAnalyticsHostStatusProbe: discovery.createAuthenticatedAnalyticsHostStatusProbe,
    createControlledRestartRequest: restart.createControlledRestartRequest,
    verifyControlledRestartResponse: restart.verifyControlledRestartResponse,
    readCompleteProductionAnalyticsHosts: adapters.readCompleteProductionAnalyticsHosts,
  };
}

/** The durable, sanitized owner record. Never carries key material. */
export function ownerRecordPath(stateDir) {
  return path.join(stateDir, OWNER_RECORD_FILENAME);
}

function writeOwnerRecord(stateDir, record) {
  const destination = ownerRecordPath(stateDir);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, destination);
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* best-effort */ }
    try {
      // The record is diagnostic evidence, not a gate input; keep it bounded.
      if (JSON.stringify(record).length <= 256 * 1024) {
        writeFileSync(destination, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8' });
      }
    } catch { /* best-effort */ }
  }
}

const LOADED_GENERATION_FILENAME = 'analytics-loaded-generation-v1.json';
const TERMINAL_RESTART_RECEIPT_KIND = 'pie-p7-terminal-restart-v1';
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_HOST_CENSUS = 64;

function hostEvidenceSuffix(hostInstanceId) {
  return createHash('sha256').update(hostInstanceId, 'utf8').digest('hex').slice(0, 32);
}

export function derivedSuccessorEvidencePath(basePath, hostInstanceId, suffix) {
  if (typeof basePath !== 'string' || !path.isAbsolute(basePath)) {
    throw new Error('successor evidence base path must be absolute.');
  }
  return `${basePath}.${hostEvidenceSuffix(hostInstanceId)}${suffix}`;
}

export function successorLoadedGenerationPath(stateDir, hostInstanceId, evidenceOwner) {
  const base = path.join(stateDir, LOADED_GENERATION_FILENAME);
  return evidenceOwner ? base : derivedSuccessorEvidencePath(base, hostInstanceId, '.json');
}

export function successorTerminalReceiptPath(basePath, hostInstanceId, evidenceOwner) {
  return evidenceOwner ? basePath : derivedSuccessorEvidencePath(basePath, hostInstanceId, '.json');
}

function isCanonicalInstant(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function exactObjectKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function readLoadedGenerationEvidence(filePath, expected) {
  const file = readBoundedJson(filePath, 'loaded-generation evidence', MAX_EVIDENCE_BYTES);
  if (file.error !== undefined) return { error: file.error };
  const value = file.value;
  if (!exactObjectKeys(value, [
    'buildId', 'generationId', 'hostInstanceId', 'loadedAt', 'manifestRevision',
    'manifestSha256', 'restartNonce', 'schemaVersion', 'workspaceId',
  ])) return { error: 'loaded-generation evidence fields are invalid' };
  if (value.schemaVersion !== 1 || value.generationId !== expected.generationId
    || value.buildId !== expected.buildId || value.workspaceId !== expected.workspaceId
    || value.restartNonce !== expected.restartNonce || typeof value.hostInstanceId !== 'string'
    || value.hostInstanceId.length === 0 || !isCanonicalInstant(value.loadedAt)
    || !Number.isSafeInteger(value.manifestRevision) || value.manifestRevision < 1
    || typeof value.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.manifestSha256)) {
    return { error: 'loaded-generation evidence does not match the requested restart' };
  }
  return { value };
}

function readTerminalRestartEvidence(filePath, expected) {
  const file = readBoundedJson(filePath, 'terminal restart evidence', MAX_EVIDENCE_BYTES);
  if (file.error !== undefined) return { error: file.error };
  const value = file.value;
  if (!exactObjectKeys(value, [
    'buildId', 'generationId', 'hostInstanceId', 'kind', 'loadedAt', 'processId',
    'restartNonce', 'schemaVersion', 'status', 'verifiedAt',
  ])) return { error: 'terminal restart evidence fields are invalid' };
  if (value.schemaVersion !== 1 || value.kind !== TERMINAL_RESTART_RECEIPT_KIND
    || value.status !== 'ready' || value.generationId !== expected.generationId
    || value.buildId !== expected.buildId || value.restartNonce !== expected.restartNonce
    || typeof value.hostInstanceId !== 'string' || value.hostInstanceId.length === 0
    || !Number.isSafeInteger(value.processId) || value.processId < 1
    || !isCanonicalInstant(value.loadedAt) || !isCanonicalInstant(value.verifiedAt)) {
    return { error: 'terminal restart evidence does not match the requested restart' };
  }
  return { value };
}

function boundedSettleTimeout(plan) {
  if (typeof plan.restartSettleTimeoutMs !== 'number' || !Number.isFinite(plan.restartSettleTimeoutMs)) {
    return DEFAULT_SETTLE_TIMEOUT_MS;
  }
  return Math.min(120_000, Math.max(100, Math.floor(plan.restartSettleTimeoutMs)));
}

function boundedHostProbeTimeout(plan) {
  if (typeof plan.hostProbeTimeoutMs !== 'number' || !Number.isFinite(plan.hostProbeTimeoutMs)) {
    return DEFAULT_SEND_TIMEOUT_MS;
  }
  return Math.min(DEFAULT_SEND_TIMEOUT_MS, Math.max(1, Math.floor(plan.hostProbeTimeoutMs)));
}

function removeEvidencePath(filePath) {
  try { rmSync(filePath, { force: true }); } catch { /* best-effort stale evidence cleanup */ }
}

async function runRestartOwner(argv, environment = process.env) {
  const planPathIndex = argv.indexOf('--plan');
  const planPath = planPathIndex >= 0 ? argv[planPathIndex + 1] : undefined;
  if (typeof planPath !== 'string' || !path.isAbsolute(planPath)) {
    fail('usage: node scripts/analytics-restart-owner.mjs --plan <absolute activation plan path>');
  }
  const planFile = readBoundedJson(planPath, 'activation plan', MAX_PLAN_BYTES);
  if (planFile.error !== undefined) fail(planFile.error);
  if (!isRecord(planFile.value)) fail('activation plan is not an object.');
  const plan = planFile.value;
  const requested = readRestartEnvironment(environment);
  if (typeof plan.terminalRestartReceiptPath === 'string'
    && path.resolve(plan.terminalRestartReceiptPath) !== path.resolve(requested.terminalRestartReceiptPath)) {
    fail('PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH does not match the plan terminal receipt path.');
  }
  const stateDir = plan.stateDir;
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
    fail('plan stateDir must be absolute.');
  }
  if (typeof plan.workspaceId !== 'string' || plan.workspaceId.trim().length === 0) {
    fail('plan workspaceId is required.');
  }
  const lifecycleStorePath = typeof plan.lifecycleStorePath === 'string' && plan.lifecycleStorePath.trim().length > 0
    ? plan.lifecycleStorePath
    : path.join(stateDir, 'session-lifecycle.sqlite');
  const dependencies = await loadOwnerDependencies();
  const fence = expectedFenceForMode(plan);
  const registry = new dependencies.SessionLifecycleStore(
    path.resolve(lifecycleStorePath),
    { readOnly: true },
  );
  const priorOwnerFile = readBoundedJson(ownerRecordPath(stateDir), 'previous restart owner record', 256 * 1024);
  const priorOwnerRecord = priorOwnerFile.error === undefined && isRecord(priorOwnerFile.value)
    ? priorOwnerFile.value
    : undefined;
  const record = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    mode: fence.mode,
    operationId: fence.operationId,
    restartNonce: requested.restartNonce,
    terminalRestartReceiptPath: requested.terminalRestartReceiptPath,
    preRestartHostInstanceIds: [],
    ackedHostInstanceIds: [],
    refreshedKeyHostInstanceIds: [],
    loadedGenerationHostInstanceIds: [],
    terminalEvidenceHostInstanceIds: [],
    authenticatedSuccessorHostInstanceIds: [],
    replacementHostInstanceIds: [],
    assignments: [],
    receiptObserved: false,
    outcome: 'started',
  };
  let exitCode = 0;
  try {
    if (priorOwnerRecord?.operationId === fence.operationId) {
      throw new Error(
        `a prior restart owner record for ${fence.operationId} exists with outcome ${String(priorOwnerRecord.outcome)}; `
        + 'refusing to issue another destructive restart request.',
      );
    }
    const expectedGenerationId = typeof plan.generationId === 'string' && plan.generationId.trim().length > 0
      ? plan.generationId
      : typeof plan.activeAnalyticsGenerationId === 'string' && plan.activeAnalyticsGenerationId.trim().length > 0
        ? plan.activeAnalyticsGenerationId
        : undefined;
    const expectedBuildId = typeof plan.buildId === 'string' && plan.buildId.trim().length > 0
      ? plan.buildId
      : undefined;
    const fenceRecord = registry.getAnalyticsWriterFence(plan.workspaceId);
    if (!fenceRecord || fenceRecord.state !== 'fenced'
      || fenceRecord.operationId !== fence.operationId || fenceRecord.purpose !== fence.purpose) {
      throw new Error(
        `the all-host writer fence for ${fence.mode} is not durable and fenced; refusing to restart hosts.`,
      );
    }
    if (!expectedGenerationId || !expectedBuildId) {
      throw new Error('restart owner requires plan generationId and buildId to validate successor evidence.');
    }
    const hosts = dependencies.readCompleteProductionAnalyticsHosts(registry, plan.workspaceId)
      .filter((host) => host.state === 'registered')
      .sort((left, right) => left.hostInstanceId.localeCompare(right.hostInstanceId));
    if (hosts.length === 0) throw new Error('no registered analytics hosts were found to restart.');
    if (hosts.length > MAX_HOST_CENSUS) throw new Error('registered analytics host census exceeds the bounded restart limit.');
    let channel = readKeyChannel(plan, planPath);
    if (channel.file === undefined && channel.planPath === undefined) {
      throw new Error('successor key handoff requires a durable owner-controlled key channel; refusing to restart hosts.');
    }
    const unsupported = hosts.filter((host) => !host.endpointName
      || !host.capabilities.includes('authenticated-control')
      || !host.capabilities.includes('controlled-restart'));
    if (unsupported.length > 0) {
      throw new Error(
        `${unsupported.length} of ${hosts.length} registered hosts lack the controlled-restart ingress; `
        + 'bootstrap required: perform one normal VS Code restart so the staged runtime with this ingress loads, '
        + 'then re-run the helper.',
      );
    }
    const hostKeys = hosts.map((host) => keyChannelValue(channel, host.hostInstanceId));
    if (hostKeys.some((key) => key === undefined)) {
      throw new Error('a registered host has no authenticated handoff key in the owner-controlled channel.');
    }
    if (hosts.some((host) => host.buildId !== expectedBuildId)) {
      throw new Error('registered hosts do not all carry the plan build; refusing to restart a mixed-build census.');
    }
    let requiredCapabilities = [];
    if (fence.mode === 'storage-cutoff') {
      const roots = plan.cutoffRoots;
      const sessionsRoot = isRecord(roots) ? roots.sessions : undefined;
      if (typeof sessionsRoot !== 'string' || !path.isAbsolute(sessionsRoot)) {
        throw new Error('storage cutoff requires absolute cutoffRoots.sessions.');
      }
      const requiredCapability = dependencies.storageCutoffRootCapability(sessionsRoot);
      const missing = hosts.filter((host) => !host.capabilities.includes(requiredCapability));
      if (missing.length > 0) {
        throw new Error(
          `${missing.length} registered host(s) do not advertise the bound final-root capability; `
          + 'restarting them could not satisfy successor admission.',
        );
      }
      requiredCapabilities = [requiredCapability];
    }

    const evidenceOwnerHostInstanceId = hosts[0].hostInstanceId;
    const assignments = hosts.map((host) => {
      const evidenceOwner = host.hostInstanceId === evidenceOwnerHostInstanceId;
      const terminalRestartReceiptPath = successorTerminalReceiptPath(
        requested.terminalRestartReceiptPath,
        host.hostInstanceId,
        evidenceOwner,
      );
      const loadedGenerationPath = successorLoadedGenerationPath(stateDir, host.hostInstanceId, evidenceOwner);
      const successorHandoffKey = randomBytes(32).toString('base64url');
      removeEvidencePath(terminalRestartReceiptPath);
      removeEvidencePath(loadedGenerationPath);
      return {
        predecessorHostInstanceId: host.hostInstanceId,
        predecessorEndpointName: host.endpointName,
        predecessorKey: keyChannelValue(channel, host.hostInstanceId),
        successorHandoffKey,
        successorCapabilities: requiredCapabilities,
        terminalRestartReceiptPath,
        loadedGenerationPath,
        evidenceOwner,
      };
    });
    record.preRestartHostInstanceIds = hosts.map((host) => host.hostInstanceId);
    record.assignments = assignments.map((assignment) => ({
      predecessorHostInstanceId: assignment.predecessorHostInstanceId,
      terminalRestartReceiptPath: assignment.terminalRestartReceiptPath,
      loadedGenerationPath: assignment.loadedGenerationPath,
      evidenceOwner: assignment.evidenceOwner,
    }));

    const sendTimeoutMs = boundedHostProbeTimeout(plan);
    for (const assignment of assignments) {
      const request = dependencies.createControlledRestartRequest({
        workspaceId: plan.workspaceId,
        purpose: fence.purpose,
        operationId: fence.operationId,
        restartNonce: requested.restartNonce,
        terminalRestartReceiptPath: assignment.terminalRestartReceiptPath,
        targetHostInstanceId: assignment.predecessorHostInstanceId,
        successorHandoffKey: assignment.successorHandoffKey,
        loadedGenerationPath: assignment.loadedGenerationPath,
        successorCapabilities: assignment.successorCapabilities,
        evidenceOwner: assignment.evidenceOwner,
      }, assignment.predecessorKey);
      let response;
      try {
        response = await dependencies.sendBoundedAnalyticsFrame(
          assignment.predecessorEndpointName,
          request,
          sendTimeoutMs,
        );
      } catch (error) {
        throw new Error(
          `host ${assignment.predecessorHostInstanceId} did not answer the controlled restart: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const acknowledgement = dependencies.verifyControlledRestartResponse(response, assignment.predecessorKey);
      if (acknowledgement.ok !== true
        || acknowledgement.requestId !== request.requestId
        || acknowledgement.nonce !== request.nonce
        || acknowledgement.host.hostInstanceId !== assignment.predecessorHostInstanceId) {
        throw new Error(`host ${assignment.predecessorHostInstanceId} returned a stale or mismatched restart acknowledgement.`);
      }
      record.ackedHostInstanceIds.push(assignment.predecessorHostInstanceId);
    }
    record.outcome = 'restarts-acked';

    // Each assignment has its own evidence paths and successor key. The
    // terminal receipt is the correlation token: its actual successor identity
    // is never guessed from the predecessor identity or registry order.
    const successorKeys = new Map();
    const statusProbe = dependencies.createAuthenticatedAnalyticsHostStatusProbe({
      keyForHost: (host) => successorKeys.get(host.hostInstanceId),
      timeoutMs: sendTimeoutMs,
      send: dependencies.sendBoundedAnalyticsFrame,
    });
    const settleDeadline = Date.now() + boundedSettleTimeout(plan);
    let lastBlockers = [];
    while (Date.now() < settleDeadline) {
      const currentHosts = dependencies.readCompleteProductionAnalyticsHosts(registry, plan.workspaceId)
        .filter((host) => host.state === 'registered');
      const currentById = new Map(currentHosts.map((host) => [host.hostInstanceId, host]));
      const evidenceByPredecessor = new Map();
      const blockers = [];
      for (const assignment of assignments) {
        const expected = {
          generationId: expectedGenerationId,
          buildId: expectedBuildId,
          workspaceId: plan.workspaceId,
          restartNonce: requested.restartNonce,
        };
        const loaded = readLoadedGenerationEvidence(assignment.loadedGenerationPath, expected);
        const terminal = readTerminalRestartEvidence(assignment.terminalRestartReceiptPath, expected);
        if (loaded.error !== undefined || terminal.error !== undefined) {
          blockers.push(`${assignment.predecessorHostInstanceId}: ${loaded.error ?? terminal.error}`);
          continue;
        }
        if (loaded.value.hostInstanceId !== terminal.value.hostInstanceId
          || loaded.value.loadedAt !== terminal.value.loadedAt) {
          blockers.push(`${assignment.predecessorHostInstanceId}: loaded and terminal evidence identify different boots`);
          continue;
        }
        const successor = currentById.get(terminal.value.hostInstanceId);
        if (!successor || assignment.predecessorHostInstanceId === successor.hostInstanceId) {
          blockers.push(`${assignment.predecessorHostInstanceId}: successor boot is not registered yet`);
          continue;
        }
        if (successor.processId !== terminal.value.processId
          || successor.workspaceId !== plan.workspaceId
          || successor.buildId !== expectedBuildId
          || !successor.endpointName
          || !successor.capabilities.includes('authenticated-control')
          || !successor.capabilities.includes('controlled-restart')) {
          blockers.push(`${assignment.predecessorHostInstanceId}: successor registry identity is incomplete`);
          continue;
        }
        successorKeys.set(successor.hostInstanceId, assignment.successorHandoffKey);
        let status;
        try {
          status = await statusProbe(successor);
        } catch (error) {
          blockers.push(`${assignment.predecessorHostInstanceId}: successor authentication is incomplete`);
          continue;
        }
        if (status.observedHost.hostInstanceId !== successor.hostInstanceId
          || status.observedHost.processId !== successor.processId
          || status.observedHost.workspaceId !== plan.workspaceId
          || status.observedHost.buildId !== expectedBuildId) {
          blockers.push(`${assignment.predecessorHostInstanceId}: successor status identity mismatched`);
          continue;
        }
        evidenceByPredecessor.set(assignment.predecessorHostInstanceId, {
          assignment,
          successor,
          loaded: loaded.value,
          terminal: terminal.value,
        });
        if (!record.refreshedKeyHostInstanceIds.includes(successor.hostInstanceId)) {
          channel = mergeKeyChannelEntries(channel, { [successor.hostInstanceId]: assignment.successorHandoffKey });
          record.refreshedKeyHostInstanceIds.push(successor.hostInstanceId);
        }
      }
      const replacementHostInstanceIds = [...evidenceByPredecessor.values()]
        .map(({ successor }) => successor.hostInstanceId)
        .sort();
      const registeredHostInstanceIds = currentHosts.map((host) => host.hostInstanceId).sort();
      const expectedHostInstanceIds = [...new Set(replacementHostInstanceIds)].sort();
      record.loadedGenerationHostInstanceIds = [...evidenceByPredecessor.values()]
        .map(({ terminal }) => terminal.hostInstanceId)
        .sort();
      record.terminalEvidenceHostInstanceIds = [...evidenceByPredecessor.values()]
        .map(({ terminal }) => terminal.hostInstanceId)
        .sort();
      record.authenticatedSuccessorHostInstanceIds = [...evidenceByPredecessor.values()]
        .map(({ successor }) => successor.hostInstanceId)
        .sort();
      record.replacementHostInstanceIds = expectedHostInstanceIds;
      record.receiptObserved = assignments.some((assignment) => assignment.evidenceOwner
        && evidenceByPredecessor.has(assignment.predecessorHostInstanceId));
      lastBlockers = blockers.slice(0, 16);
      const complete = evidenceByPredecessor.size === assignments.length
        && replacementHostInstanceIds.length === assignments.length
        && expectedHostInstanceIds.length === assignments.length
        && registeredHostInstanceIds.length === assignments.length
        && registeredHostInstanceIds.every((hostInstanceId, index) => hostInstanceId === expectedHostInstanceIds[index]);
      if (complete) {
        record.completedAt = new Date().toISOString();
        record.outcome = 'completed';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
    if (record.outcome !== 'completed') {
      const detail = lastBlockers.length > 0 ? ` (${lastBlockers.join('; ')})` : '';
      throw new Error(`controlled restart did not reach complete replacement census before timeout${detail}`);
    }
  } catch (error) {
    exitCode = 1;
    record.completedAt = new Date().toISOString();
    record.outcome = 'failed';
    record.error = error instanceof Error ? error.message : String(error);
    process.stderr.write(`analytics-restart-owner: ${record.error}\n`);
  } finally {
    writeOwnerRecord(stateDir, record);
    registry?.close?.();
  }
  return exitCode;
}

const entryArg = process.argv[1];
if (entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href) {
  const exitCode = await runRestartOwner(process.argv.slice(2), process.env);
  process.exit(exitCode);
}