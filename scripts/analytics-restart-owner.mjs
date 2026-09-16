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
//      host durably records the nonce/receipt pair, acknowledges, and then
//      performs its own supported quiet restart
//      (`workbench.action.restartExtensionHost`, falling back to a window
//      reload; both preserve unsaved editor work; no process is killed).
//   4. Watches the lifecycle registry for the restarted host boots and
//      refreshes the owner-controlled per-host key channel so the helper's
//      post-restart census can authenticate the new boots with the same
//      launch-channel key.
//   5. Writes a sanitized durable owner record in the plan's state dir and
//      exits. It never fabricates evidence: the terminal restart receipt, the
//      loaded-generation marker and the authenticated census stay owned by the
//      restarted hosts and the helper.
//
// It deliberately does NOT force-kill anything, restart VS Code's main
// process, write host/global VS Code state, or wait forever. If the currently
// loaded hosts lack the controlled-restart ingress, it reports the exact
// bootstrap blocker and exits non-zero instead of pretending.

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
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

/** Every restarted boot uses the same launch-channel key as the fenced hosts,
 * so the common pre-restart key is the only honest value available for new
 * host ids. Ambiguous channels fail closed before any restart is requested. */
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

/** Add entries for newly observed host ids without disturbing existing ones. */
export function mergeKeyChannelEntries(channel, entries, maxBytes = MAX_KEY_FILE_BYTES) {
  const merged = { ...Object.fromEntries(channel.keys.entries()) };
  for (const [hostInstanceId, key] of Object.entries(entries)) {
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
  const record = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    mode: fence.mode,
    restartNonce: requested.restartNonce,
    terminalRestartReceiptPath: requested.terminalRestartReceiptPath,
    preRestartHostInstanceIds: [],
    ackedHostInstanceIds: [],
    refreshedKeyHostInstanceIds: [],
    receiptObserved: false,
    outcome: 'started',
  };
  let exitCode = 0;
  try {
    const fenceRecord = registry.getAnalyticsWriterFence(plan.workspaceId);
    if (!fenceRecord || fenceRecord.state !== 'fenced'
      || fenceRecord.operationId !== fence.operationId || fenceRecord.purpose !== fence.purpose) {
      throw new Error(
        `the all-host writer fence for ${fence.mode} is not durable and fenced; refusing to restart hosts.`,
      );
    }
    const hosts = dependencies.readCompleteProductionAnalyticsHosts(registry, plan.workspaceId)
      .filter((host) => host.state === 'registered');
    if (hosts.length === 0) throw new Error('no registered analytics hosts were found to restart.');
    let channel = readKeyChannel(plan, planPath);
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
    const sharedKey = commonHostKey(hostKeys);
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
    }
    record.preRestartHostInstanceIds = hosts.map((host) => host.hostInstanceId).sort();
    for (const host of hosts) {
      const key = keyChannelValue(channel, host.hostInstanceId);
      const request = dependencies.createControlledRestartRequest({
        workspaceId: plan.workspaceId,
        purpose: fence.purpose,
        operationId: fence.operationId,
        restartNonce: requested.restartNonce,
        terminalRestartReceiptPath: requested.terminalRestartReceiptPath,
      }, key);
      let response;
      try {
        response = await dependencies.sendBoundedAnalyticsFrame(
          host.endpointName,
          request,
          typeof plan.hostProbeTimeoutMs === 'number' && Number.isFinite(plan.hostProbeTimeoutMs)
            ? Math.max(1, Math.floor(plan.hostProbeTimeoutMs))
            : DEFAULT_SEND_TIMEOUT_MS,
        );
      } catch (error) {
        throw new Error(
          `host ${host.hostInstanceId} did not answer the controlled restart: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const acknowledgement = dependencies.verifyControlledRestartResponse(response, key);
      if (acknowledgement.ok !== true
        || acknowledgement.requestId !== request.requestId
        || acknowledgement.nonce !== request.nonce
        || acknowledgement.host.hostInstanceId !== host.hostInstanceId) {
        throw new Error(`host ${host.hostInstanceId} returned a stale or mismatched restart acknowledgement.`);
      }
      record.ackedHostInstanceIds.push(host.hostInstanceId);
    }
    record.outcome = 'restarts-acked';
    // Watch the restarted boots and keep the key channel complete so the
    // helper's post-restart census can authenticate every new host boot. The
    // receipt is observed first so the last pass still refreshes the channel
    // for hosts that registered at the same moment the receipt appeared.
    const receiptPath = requested.terminalRestartReceiptPath;
    const settleDeadline = Date.now() + DEFAULT_SETTLE_TIMEOUT_MS;
    while (Date.now() < settleDeadline) {
      const receiptObserved = existsSync(receiptPath);
      const currentHosts = dependencies.readCompleteProductionAnalyticsHosts(registry, plan.workspaceId)
        .filter((host) => host.state === 'registered'
          && !record.preRestartHostInstanceIds.includes(host.hostInstanceId));
      if (currentHosts.length > 0) {
        const refreshEntries = {};
        for (const host of currentHosts) {
          if (keyChannelValue(channel, host.hostInstanceId) === undefined) {
            refreshEntries[host.hostInstanceId] = sharedKey;
          }
        }
        if (Object.keys(refreshEntries).length > 0) {
          channel = mergeKeyChannelEntries(channel, refreshEntries);
          record.refreshedKeyHostInstanceIds.push(...Object.keys(refreshEntries));
        }
      }
      if (receiptObserved) {
        record.receiptObserved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
    record.completedAt = new Date().toISOString();
    record.outcome = 'completed';
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