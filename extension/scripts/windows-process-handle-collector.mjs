import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COLLECTOR_VERSION = 'windows-process-handle-collector-r01';
const IDENTITY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_MAX_REQUESTS = 256;
const DEFAULT_MAX_ACTIVE_HANDLES = 64;
const DEFAULT_MAX_DURATION_MS = 900_000;
const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-process-handle-collector.ps1');

function isSafePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validIdentity(identity) {
  return identity && typeof identity === 'object' && !Array.isArray(identity)
    && typeof identity.instanceId === 'string' && IDENTITY_PATTERN.test(identity.instanceId)
    && isSafePositiveInteger(identity.pid)
    && isSafePositiveInteger(identity.spawnedAtMs);
}

function sameIdentity(left, right) {
  return validIdentity(left) && validIdentity(right)
    && left.instanceId === right.instanceId
    && left.pid === right.pid
    && left.spawnedAtMs === right.spawnedAtMs;
}

function requestKey(clientId, requestId) {
  return `${clientId}:${requestId}`;
}

function validRequest(clientId, requestId, identity) {
  return typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 128
    && isSafePositiveInteger(requestId) && validIdentity(identity);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/** Validate one collector receipt against the query worker identity that
 * produced its lifecycle terminal event. This is deliberately independent of
 * the collector process so reports cannot turn malformed native output into a
 * memory qualification. */
export function validateWindowsProcessReceipt(receipt, expectedIdentity) {
  const errors = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { valid: false, errors: ['collector receipt is missing or not an object'] };
  }
  if (!sameIdentity(receipt.identity, expectedIdentity)) errors.push('collector receipt identity does not match query worker');
  if (!['available', 'unavailable'].includes(receipt.status)) errors.push('collector receipt status is invalid');
  if (typeof receipt.requestKey !== 'string' || receipt.requestKey.length === 0 || receipt.requestKey.length > 256) {
    errors.push('collector receipt request key is invalid');
  }
  if (receipt.status === 'available') {
    if (receipt.reason !== null && receipt.reason !== undefined) errors.push('available collector receipt has a reason');
    if (!receipt.memory || typeof receipt.memory !== 'object' || Array.isArray(receipt.memory)
      || !isSafePositiveInteger(receipt.memory.peakWorkingSetBytes)
      || receipt.memory.units !== 'bytes') {
      errors.push('collector final peak working set is invalid');
    }
    if (!receipt.cpu || typeof receipt.cpu !== 'object' || Array.isArray(receipt.cpu)
      || !isSafeNonNegativeInteger(receipt.cpu.userCpuTimeMicros)
      || !isSafeNonNegativeInteger(receipt.cpu.systemCpuTimeMicros)
      || receipt.cpu.units !== 'microseconds') {
      errors.push('collector final CPU counters are invalid');
    }
    if (!receipt.final || receipt.final.handleRetainedThroughExit !== true
      || typeof receipt.final.exitTime100ns !== 'string' || !/^\d+$/u.test(receipt.final.exitTime100ns)) {
      errors.push('collector final exit identity is missing');
    }
    if (receipt.handleRetainedThroughExit !== true) errors.push('collector did not retain the handle through exit');
    if (receipt.handleClosed !== true) errors.push('collector did not prove handle closure');
    if (!receipt.registration || receipt.registration.creationWindowMatch !== true
      || typeof receipt.registration.creationTime100ns !== 'string'
      || !/^\d+$/u.test(receipt.registration.creationTime100ns)
      || typeof receipt.registration.imagePath !== 'string' || receipt.registration.imagePath.length === 0) {
      errors.push('collector registration identity binding is incomplete');
    }
  } else {
    if (typeof receipt.reason !== 'string' || receipt.reason.length === 0) errors.push('unavailable collector receipt has no reason');
    if (receipt.memory !== null) errors.push('unavailable collector receipt must have null memory');
    if (receipt.cpu !== null) errors.push('unavailable collector receipt must have null CPU');
    if (receipt.handleRetainedThroughExit !== false) errors.push('unavailable collector receipt cannot claim handle retention through exit');
  }
  return { valid: errors.length === 0, errors };
}

/** Validate the bounded native evidence envelope and bind every receipt to a
 * persisted query lifecycle identity. Unavailable races remain honest and
 * keep the mixed memory gate unqualified. */
export function validateWindowsProcessEvidence(evidence, expectedIdentities) {
  const errors = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { valid: false, errors: ['native process evidence is missing'] };
  }
  if (!Array.isArray(expectedIdentities) || expectedIdentities.length === 0) {
    return { valid: false, errors: ['expected query worker identities are missing'] };
  }
  if (evidence.qualificationOnly !== true) errors.push('native process evidence must be marked qualification-only');
  if (evidence.overhead?.collectorProcessExcludedFromWorkloadTotals !== true
    || evidence.overhead?.pairedBaselineRequired !== true
    || !isSafeNonNegativeInteger(evidence.overhead?.protocolBytes)
    || !isSafeNonNegativeInteger(evidence.overhead?.protocolWrites)) {
    errors.push('native collector overhead disclosure is incomplete');
  }
  if (!Array.isArray(evidence.rejections)) errors.push('native collector rejection records are missing');
  else {
    for (const [index, rejection] of evidence.rejections.entries()) {
      if (!rejection || typeof rejection !== 'object' || typeof rejection.requestKey !== 'string'
        || rejection.requestKey.length === 0 || rejection.reason !== 'terminal-identity-mismatch') {
        errors.push(`native collector rejection[${index}] is malformed`);
      }
    }
  }
  const expected = new Map();
  for (const [index, identity] of expectedIdentities.entries()) {
    if (!validIdentity(identity)) {
      errors.push(`expected query worker identity[${index}] is malformed`);
      continue;
    }
    expected.set(identityKey(identity), identity);
  }
  if (expected.size !== expectedIdentities.filter(validIdentity).length) errors.push('expected query worker identities are duplicated');
  if (!Array.isArray(evidence.receipts)) errors.push('native process receipts are missing');
  const receipts = Array.isArray(evidence.receipts) ? evidence.receipts : [];
  const seen = new Set();
  for (const [index, receipt] of receipts.entries()) {
    const identity = receipt?.identity;
    const key = validIdentity(identity) ? identityKey(identity) : `invalid:${index}`;
    if (seen.has(key)) errors.push(`native process receipt is duplicated: ${key}`);
    seen.add(key);
    const validation = validateWindowsProcessReceipt(receipt, expected.get(key));
    if (!validation.valid) errors.push(...validation.errors.map((error) => `receipt[${index}]: ${error}`));
  }
  for (const key of expected.keys()) {
    if (!seen.has(key)) errors.push(`native process receipt is missing for ${key}`);
  }
  if (evidence.enabled === true && evidence.platform !== 'win32') errors.push('enabled native collector has a non-Windows platform');
  if (evidence.enabled !== true && receipts.some((receipt) => receipt?.status !== 'unavailable')) {
    errors.push('disabled native collector cannot contain available receipts');
  }
  return { valid: errors.length === 0, errors };
}

function identityKey(identity) {
  return `${identity.instanceId}:${identity.pid}:${identity.spawnedAtMs}`;
}

function unavailableReceipt(request, reason) {
  return {
    type: 'receipt',
    requestKey: requestKey(request.clientId, request.requestId),
    clientId: request.clientId,
    requestId: request.requestId,
    identity: clone(request.identity),
    status: 'unavailable',
    reason,
    memory: null,
    cpu: null,
    handleRetainedThroughExit: false,
    handleClosed: true,
  };
}

function createDisabledCollector(reason) {
  const receipts = [];
  const protocolErrors = [];
  const rejections = [];
  const seen = new Set();
  return {
    enabled: false,
    platform: process.platform,
    status: reason,
    receipts,
    protocolErrors,
    registerWorker: (event) => {
      if (event?.phase !== 'spawned' || !validRequest(event.clientId, event.requestId, event.identity)) return false;
      const key = identityKey(event.identity);
      if (seen.has(key)) return false;
      seen.add(key);
      receipts.push(unavailableReceipt({ clientId: event.clientId, requestId: event.requestId, identity: event.identity }, reason));
      return false;
    },
    recordTerminal: () => false,
    snapshot: () => ({
      version: COLLECTOR_VERSION,
      enabled: false,
      platform: process.platform,
      status: reason,
      qualificationOnly: true,
      overhead: {
        collectorProcessExcludedFromWorkloadTotals: true,
        pairedBaselineRequired: true,
        protocolBytes: 0,
        protocolWrites: 0,
      },
      receipts: clone(receipts),
      rejections: clone(rejections),
      protocolErrors: [...protocolErrors],
    }),
    stop: async () => ({
      version: COLLECTOR_VERSION,
      enabled: false,
      platform: process.platform,
      status: reason,
      qualificationOnly: true,
      overhead: {
        collectorProcessExcludedFromWorkloadTotals: true,
        pairedBaselineRequired: true,
        protocolBytes: 0,
        protocolWrites: 0,
      },
      receipts: clone(receipts),
      rejections: clone(rejections),
      protocolErrors: [...protocolErrors],
    }),
  };
}

function boundedOption(value, fallback, minimum, maximum, name) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

/** Start the finite Windows collector before a qualification workload. The
 * returned callbacks only enqueue bounded NDJSON writes and never participate
 * in query completion or admission. */
export async function startWindowsProcessHandleCollector(options = {}) {
  if (process.platform !== 'win32') return createDisabledCollector('unsupported-platform');
  if (!existsSync(scriptPath)) return createDisabledCollector('collector-script-missing');
  const maxRequests = boundedOption(options.maxRequests, DEFAULT_MAX_REQUESTS, 1, 10_000, 'maxRequests');
  const maxActiveHandles = boundedOption(options.maxActiveHandles, DEFAULT_MAX_ACTIVE_HANDLES, 1, 256, 'maxActiveHandles');
  const maxDurationMs = boundedOption(options.maxDurationMs, DEFAULT_MAX_DURATION_MS, 1_000, 1_800_000, 'maxDurationMs');
  const readyTimeoutMs = boundedOption(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS, 500, 30_000, 'readyTimeoutMs');
  const stopTimeoutMs = boundedOption(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, 500, 30_000, 'stopTimeoutMs');
  const expectedImagePath = path.resolve(options.expectedImagePath ?? process.execPath);
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-ExpectedImagePath', expectedImagePath,
    '-MaxRequests', String(maxRequests),
    '-MaxActiveHandles', String(maxActiveHandles),
    '-MaxDurationMs', String(maxDurationMs),
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const receipts = [];
  const protocolErrors = [];
  const rejections = [];
  const pending = new Map();
  const closed = new Set();
  const stderrChunks = [];
  let status = 'starting';
  let stopped = false;
  let inputBytes = 0;
  let inputWrites = 0;
  let inputBackpressure = false;
  let childClosed = false;
  const reader = createInterface({ input: child.stdout });
  let readyResolve;
  const readyPromise = new Promise((resolve) => { readyResolve = resolve; });
  const setStartupFailure = (reason) => {
    if (status === 'starting') {
      status = reason;
      readyResolve(false);
    }
  };
  reader.on('line', (line) => {
    if (line.length > 256 * 1024) {
      protocolErrors.push('collector output line exceeded 256 KiB');
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      protocolErrors.push('collector emitted malformed JSON');
      return;
    }
    if (message?.type === 'ready') {
      status = 'ready';
      readyResolve(true);
      return;
    }
    if (message?.type === 'receipt') {
      const key = typeof message.requestKey === 'string' ? message.requestKey : '';
      const existing = key ? receipts.find((entry) => entry.requestKey === key) : undefined;
      if (existing) {
        const sameStatus = existing.status === message.status;
        const sameIdentityValue = JSON.stringify(existing.identity) === JSON.stringify(message.identity);
        if (!(sameStatus && sameIdentityValue && message.status === 'unavailable')) {
          protocolErrors.push(`conflicting duplicate collector receipt: ${key || 'missing-key'}`);
        }
        pending.delete(key);
        return;
      }
      receipts.push(message);
      if (key) pending.delete(key);
      return;
    }
    if (message?.type === 'closed') {
      closed.add(message.requestKey);
      const receipt = receipts.find((entry) => entry.requestKey === message.requestKey);
      if (receipt) receipt.handleClosed = message.handleCloseOk === true;
      return;
    }
    if (message?.type === 'protocol-error') {
      protocolErrors.push(typeof message.reason === 'string' ? message.reason : 'collector protocol error');
      return;
    }
    if (message?.type === 'rejection') {
      rejections.push(message);
      return;
    }
    if (message?.type === 'stopped') {
      status = typeof message.reason === 'string' ? `stopped-${message.reason}` : 'stopped';
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (stderrChunks.join('').length < 8 * 1024) stderrChunks.push(String(chunk).slice(0, 8 * 1024));
  });
  child.once('error', (error) => setStartupFailure(`spawn-failed:${error.message}`));
  child.once('exit', (code, signal) => {
    if (status === 'starting') setStartupFailure(`exited-before-ready:${String(code)}:${String(signal)}`);
    if (!stopped && status === 'ready') status = `exited:${String(code)}:${String(signal)}`;
  });
  child.once('close', () => { childClosed = true; });
  const readyTimer = setTimeout(() => setStartupFailure('ready-timeout'), readyTimeoutMs);
  readyTimer.unref?.();
  const ready = await Promise.race([readyPromise, new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), readyTimeoutMs + 100);
    timer.unref?.();
  })]);
  clearTimeout(readyTimer);
  if (ready !== true) {
    status = status === 'starting' ? 'unavailable-before-ready' : status;
  }

  const send = (message) => {
    if (stopped || ready !== true || !child.stdin.writable) return false;
    const line = `${JSON.stringify(message)}\n`;
    if (line.length > 64 * 1024 || inputWrites >= maxRequests * 3) return false;
    try {
      inputBytes += Buffer.byteLength(line);
      inputWrites += 1;
      const accepted = child.stdin.write(line);
      if (!accepted) inputBackpressure = true;
      return true;
    } catch {
      return false;
    }
  };
  const registerWorker = (event) => {
    if (event?.phase !== 'spawned' || !validRequest(event.clientId, event.requestId, event.identity)) return false;
    const key = requestKey(event.clientId, event.requestId);
    const request = {
      clientId: event.clientId,
      requestId: event.requestId,
      identity: clone(event.identity),
    };
    const recordUnavailable = (reason) => {
      if (![...receipts].some((receipt) => receipt.requestKey === key)) receipts.push(unavailableReceipt(request, reason));
      return false;
    };
    if (pending.has(key) || [...receipts].some((receipt) => receipt.requestKey === key)) return false;
    if (ready !== true) return recordUnavailable('collector-unavailable-before-ready');
    if (pending.size >= maxActiveHandles) return recordUnavailable('collector-active-handle-limit');
    if (pending.size >= maxRequests) return recordUnavailable('collector-request-limit');
    const observedAtMs = Date.now();
    request.requestKey = key;
    request.spawnWindowStartMs = event.identity.spawnedAtMs;
    request.spawnWindowEndMs = observedAtMs;
    request.observedAtMs = observedAtMs;
    if (!send({
      type: 'register',
      requestKey: key,
      clientId: request.clientId,
      requestId: request.requestId,
      identity: request.identity,
      spawnWindowStartMs: request.spawnWindowStartMs,
      spawnWindowEndMs: request.spawnWindowEndMs,
      observedAtMs: request.observedAtMs,
    })) return recordUnavailable('collector-registration-send-failed');
    pending.set(key, request);
    return true;
  };
  const recordTerminal = (event) => {
    if (event?.phase !== 'terminal' || typeof event.clientId !== 'string' || event.clientId.length === 0
      || event.clientId.length > 128 || !isSafePositiveInteger(event.requestId)) return false;
    const key = requestKey(event.clientId, event.requestId);
    const request = pending.get(key);
    if (!request) return false;
    if (!sameIdentity(request.identity, event.identity)) {
      // Forward a well-formed mismatched identity so the collector records a
      // rejection without closing the validated handle. The actual terminal
      // may still arrive and remains the only event that settles the request.
      send({ type: 'terminal', requestKey: key, clientId: event.clientId, requestId: event.requestId, identity: clone(event.identity) });
      return false;
    }
    if (send({ type: 'terminal', requestKey: key, clientId: event.clientId, requestId: event.requestId, identity: clone(event.identity) })) return true;
    pending.delete(key);
    receipts.push(unavailableReceipt(request, 'collector-terminal-send-failed'));
    return false;
  };
  const syntheticPending = (reason) => {
    for (const request of pending.values()) receipts.push(unavailableReceipt(request, reason));
    pending.clear();
  };
  const snapshot = () => ({
    version: COLLECTOR_VERSION,
    enabled: true,
    platform: process.platform,
    status,
    qualificationOnly: true,
    expectedImagePath,
    maxRequests,
    maxActiveHandles,
    maxDurationMs,
    inputWrites,
    inputBytes,
    inputBackpressure,
    rejections: clone(rejections),
    overhead: {
      collectorProcessExcludedFromWorkloadTotals: true,
      pairedBaselineRequired: true,
      protocolBytes: inputBytes,
      protocolWrites: inputWrites,
    },
    activeRegistrations: pending.size,
    closedHandles: closed.size,
    stderr: stderrChunks.join('').slice(0, 8 * 1024),
    protocolErrors: [...protocolErrors],
    receipts: clone(receipts),
  });
  const stop = async () => {
    if (stopped) return snapshot();
    if (ready === true) send({ type: 'shutdown' });
    else syntheticPending('collector-unavailable-before-ready');
    stopped = true;
    const exited = childClosed
      ? true
      : await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), stopTimeoutMs);
        timer.unref?.();
        child.once('close', () => { clearTimeout(timer); resolve(true); });
      });
    if (!exited) {
      syntheticPending('collector-stop-timeout');
      child.kill();
    }
    if (pending.size > 0) syntheticPending('collector-stopped-before-receipt');
    reader.close();
    return snapshot();
  };
  return { enabled: ready === true, platform: process.platform, status, receipts, protocolErrors, registerWorker, recordTerminal, snapshot, stop };
}

export { COLLECTOR_VERSION };
