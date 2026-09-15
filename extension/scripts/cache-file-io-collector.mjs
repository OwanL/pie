import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COLLECTOR_VERSION = 'cache-file-io-collector-r01';
const DEFAULT_POLL_INTERVAL_MS = 20;
const DEFAULT_MAX_EVENTS = 512;
const DEFAULT_MAX_DURATION_MS = 600_000;
const DEFAULT_IDENTITY_TOLERANCE_MS = 2_000;
const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache-file-io-collector.ps1');

function isSafePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function boundedOption(value, fallback, minimum, maximum, name) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function normalizeFileList(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 16) {
    throw new Error('files must be an array of between 1 and 16 absolute paths');
  }
  const normalized = [];
  for (const file of files) {
    if (typeof file !== 'string' || file.length === 0 || file.length > 1024) {
      throw new Error('each monitored file must be a string of at most 1024 characters');
    }
    const absolute = path.resolve(file);
    if (path.win32.isAbsolute(absolute) === false && process.platform === 'win32') {
      throw new Error(`monitored file is not an absolute Windows path: ${file}`);
    }
    normalized.push(absolute);
  }
  return normalized;
}

/** Validate one catch against an expected process identity table. The
 * authoritative binding is pid + kernel process start time within a bounded
 * tolerance window, mirroring the creation-time-window binding used by the
 * native process-handle collector. Image names are informational only. */
export function validateCacheIoCatch(catchEvent, expectedIdentities, toleranceMs = DEFAULT_IDENTITY_TOLERANCE_MS) {
  const errors = [];
  if (!catchEvent || typeof catchEvent !== 'object' || Array.isArray(catchEvent)) {
    return { valid: false, errors: ['catch is missing or not an object'] };
  }
  if (catchEvent.type !== 'io') errors.push('catch event type is not io');
  if (typeof catchEvent.file !== 'string' || path.win32.isAbsolute(catchEvent.file) === false) {
    errors.push('catch file is missing or not an absolute Windows path');
  }
  if (!isSafePositiveInteger(catchEvent.pid) || catchEvent.pid > 0xffffffff) errors.push('catch pid is invalid');
  if (typeof catchEvent.processStartTime100ns !== 'string' || !/^[0-9]+$/u.test(catchEvent.processStartTime100ns || '')) {
    errors.push('catch process start time (100ns) is missing or malformed');
  }
  if (!isSafePositiveInteger(catchEvent.processStartTimeUnixMs)) errors.push('catch process start time (unix ms) is invalid');
  if (!isSafeNonNegativeInteger(catchEvent.observedAtMs)) errors.push('catch observed timestamp is invalid');
  if (typeof catchEvent.appName !== 'string' || catchEvent.appName.length === 0 || catchEvent.appName.length > 256) {
    errors.push('catch appName is missing or unbounded');
  }
  if (!isSafeNonNegativeInteger(catchEvent.pollTick)) errors.push('catch poll tick is invalid');
  const tolerance = typeof toleranceMs === 'number' && Number.isSafeInteger(toleranceMs) && toleranceMs > 0
    ? toleranceMs
    : DEFAULT_IDENTITY_TOLERANCE_MS;
  if (Array.isArray(expectedIdentities) && isSafePositiveInteger(catchEvent.pid)) {
    const identity = expectedIdentities.find((entry) => entry && entry.pid === catchEvent.pid);
    if (!identity || !isSafePositiveInteger(identity.creationUnixMs)) {
      errors.push('catch pid does not match any expected identity');
    } else if (Math.abs(Number(catchEvent.processStartTimeUnixMs) - Number(identity.creationUnixMs)) > tolerance) {
      errors.push('catch kernel process start time is outside the expected identity creation window');
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Validate the full observation envelope: bounded protocol surface, honest
 * terminal reason, and every catch bound to a live expected identity. */
export function validateCacheIoEvidence(evidence, expectedIdentities, toleranceMs = DEFAULT_IDENTITY_TOLERANCE_MS) {
  const errors = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { valid: false, errors: ['cache IO evidence is missing'] };
  }
  if (evidence.qualificationOnly !== true) errors.push('cache IO evidence must be marked qualification-only');
  if (evidence.platform !== process.platform) errors.push('cache IO evidence platform does not match the runner');
  if (evidence.version !== COLLECTOR_VERSION) errors.push('cache IO evidence version does not match the collector');
  if (!['duration-expired', 'event-limit', 'requested', 'input-closed'].includes(evidence.stopReason)) {
    errors.push('cache IO evidence stop reason is not an honest terminal reason');
  }
  if (!Array.isArray(evidence.files) || evidence.files.length < 1) errors.push('cache IO evidence file list is missing');
  if (!Array.isArray(evidence.catches)) errors.push('cache IO catch list is missing');
  if (!isSafeNonNegativeInteger(evidence.pollTicks)) errors.push('cache IO poll tick count is missing');
  if (!Array.isArray(evidence.protocolErrors)) errors.push('cache IO protocol error list is missing');
  else if (evidence.protocolErrors.length > 0) errors.push('cache IO collector reported protocol errors');
  if (Array.isArray(expectedIdentities) && expectedIdentities.length > 0) {
    if (evidence.catches.length === 0) errors.push('cache IO evidence contains no catches for the expected identities');
    for (const [index, catchEvent] of evidence.catches.entries()) {
      const validation = validateCacheIoCatch(catchEvent, expectedIdentities, toleranceMs);
      if (!validation.valid) errors.push(...validation.errors.map((error) => `catch[${index}]: ${error}`));
    }
  }
  return { valid: errors.length === 0, errors };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function unavailableSnapshot(reason, extras = {}) {
  return {
    version: COLLECTOR_VERSION,
    enabled: false,
    platform: process.platform,
    status: reason,
    qualificationOnly: true,
    files: [],
    pollTicks: 0,
    catches: [],
    stopReason: 'requested',
    protocolErrors: [],
    stderr: '',
    ...extras,
  };
}

/** Start the finite cache file I/O observer. Returns bounded evidence
 * callbacks that never touch production processes or files. */
export async function startCacheFileIoCollector(options = {}) {
  const pollIntervalMs = boundedOption(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 5, 1000, 'pollIntervalMs');
  const maxEvents = boundedOption(options.maxEvents, DEFAULT_MAX_EVENTS, 1, 10_000, 'maxEvents');
  const maxDurationMs = boundedOption(options.maxDurationMs, DEFAULT_MAX_DURATION_MS, 1_000, 1_800_000, 'maxDurationMs');
  const readyTimeoutMs = boundedOption(options.readyTimeoutMs, 15_000, 500, 60_000, 'readyTimeoutMs');
  const stopTimeoutMs = boundedOption(options.stopTimeoutMs, 10_000, 500, 60_000, 'stopTimeoutMs');
  const files = normalizeFileList(options.files);
  if (process.platform !== 'win32') return { ...unavailableSnapshot('unsupported-platform'), files };
  if (!existsSync(scriptPath)) return { ...unavailableSnapshot('collector-script-missing'), files };
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-Files', files.join(';'),
    '-PollIntervalMs', String(pollIntervalMs),
    '-MaxEvents', String(maxEvents),
    '-MaxDurationMs', String(maxDurationMs),
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const catches = [];
  const protocolErrors = [];
  const stderrChunks = [];
  let status = 'starting';
  let stopped = false;
  let ready = false;
  let pollTicks = 0;
  let stoppedEvent = null;
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
      ready = true;
      readyResolve(true);
      return;
    }
    if (message?.type === 'io') {
      if (ready) catches.push(message);
      else protocolErrors.push('catch emitted before ready');
      return;
    }
    if (message?.type === 'stopped') {
      stoppedEvent = message;
      pollTicks = Number(message.pollTicks) || 0;
      status = typeof message.reason === 'string' ? `stopped-${message.reason}` : 'stopped';
      return;
    }
    if (message?.type === 'protocol-error') {
      protocolErrors.push(typeof message.reason === 'string' ? message.reason : 'collector protocol error');
      return;
    }
    protocolErrors.push('collector emitted an unsupported message type');
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
  const readyResult = await Promise.race([
    readyPromise,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), readyTimeoutMs + 100);
      timer.unref?.();
    }),
  ]);
  clearTimeout(readyTimer);
  if (readyResult !== true) status = status === 'starting' ? 'unavailable-before-ready' : status;

  const snapshot = () => ({
    version: COLLECTOR_VERSION,
    enabled: ready === true,
    platform: process.platform,
    status,
    qualificationOnly: true,
    files,
    pollIntervalMs,
    maxEvents,
    maxDurationMs,
    pollTicks,
    catches: clone(catches),
    stopReason: stoppedEvent?.reason ?? 'requested',
    stoppedEvent: clone(stoppedEvent),
    protocolErrors: [...protocolErrors],
    stderr: stderrChunks.join('').slice(0, 8 * 1024),
  });
  // The native poll loop owns no OS resources (every RM session ends in its
  // inner finally), so terminating the child is an honest bounded stop. Give
  // it a short grace window to flush a natural terminal first, then
  // terminate.
  const stop = async () => {
    if (stopped) return snapshot();
    stopped = true;
    const graceMs = Math.min(stopTimeoutMs, 1500);
    const exited = childClosed
      ? true
      : await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), graceMs);
        timer.unref?.();
        child.once('close', () => { clearTimeout(timer); resolve(true); });
      });
    if (!exited) child.kill();
    reader.close();
    return snapshot();
  };
  return {
    ...snapshot(),
    snapshot,
    // Live catch list so an observation driver can inspect progress without
    // copying; snapshot()/stop() still return structured clones.
    catches,
    stop,
  };
}

export { COLLECTOR_VERSION };