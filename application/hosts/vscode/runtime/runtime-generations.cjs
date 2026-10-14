'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const RUNTIME_DIRECTORY = 'pie-runtime';
const GENERATIONS_DIRECTORY = 'generations';
const SELECTIONS_DIRECTORY = 'selections';
const LEASES_DIRECTORY = 'leases';
const LOCK_DIRECTORY = '.lock';
const LOCK_OWNER_FILE = 'owner.json';
const RUNTIME_MANIFEST_FILE = 'runtime-manifest.json';
const RUNTIME_SCHEMA = 1;
const TOOLING_DIRECTORY = 'pi-tooling';
const TOOLING_REFERENCE = 'pi-runtime/tooling-reference.json';
const REQUIRED_RUNTIME_FILES = ['extension.js', 'backend.js', 'worker-entry.js'];
const BUILD_ID_FILE = 'pie-build-id.txt';
const RENDERER_DIRECTORY = path.join('webview', 'panel');
const RENDERER_MANIFEST_FILE = path.join(RENDERER_DIRECTORY, '.vite', 'manifest.json');
const GENERATION_PATTERN = /^[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const LOCK_RETRY_MS = 25;
const LOCK_METADATA_GRACE_MS = 2_000;
const LOCK_TIMEOUT_MS = 60_000;
const FILE_SCAN_CONCURRENCY = 8;
const HASH_FILE_READ_CHUNK_BYTES = 64 * 1024;
const STARTUP_TIMING_FILE = path.join(os.tmpdir(), 'pie-startup-timing.jsonl');
const STARTUP_TIMING_TAG = 'DEBUG-startup-profile';
const STARTUP_TIMING_MAX_BYTES = 1_048_576;
// Eight generation summaries plus one overflow summary, with scan aggregates.
const STARTUP_TIMING_MAX_RECORD_BYTES = 8_192;
const MAX_REPORTED_GENERATIONS = 8;

let sequence = 0;
let startupTimingWriteQueue = Promise.resolve();

function monotonicNow() {
  return process.hrtime.bigint();
}

function elapsedMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function roundedMs(milliseconds) {
  return Math.round(milliseconds * 1000) / 1000;
}

function createPublishTiming() {
  if (!process.env.PIE_BUILD_TIMING) return null;
  return {
    snapshot: 0,
    copy: 0,
    stagedScan: 0,
    stagedVerify: 0,
    previousSelections: 0,
    cleanup: 0,
  };
}

function recordBuildPhase(timing, phase, startedAt) {
  if (timing) timing[phase] = elapsedMs(startedAt);
}

function emitPublishTiming(timing) {
  if (!timing) return;
  try {
    console.log(`[pie-build-timing] ${JSON.stringify({
      event: 'runtime-generation-publish',
      phasesMs: Object.fromEntries(Object.entries(timing).map(([phase, milliseconds]) => [phase, roundedMs(milliseconds)])),
    })}`);
  } catch {
    // Build instrumentation is observational only.
  }
}

function startupTimingPath() {
  const tempRoot = path.resolve(os.tmpdir());
  const configuredPath = process.env.PIE_STARTUP_TIMING_FILE;
  if (typeof configuredPath === 'string' && configuredPath.length > 0) {
    const resolvedPath = path.resolve(configuredPath);
    const relativePath = path.relative(tempRoot, resolvedPath);
    if (relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))) {
      return resolvedPath;
    }
  }
  return STARTUP_TIMING_FILE;
}

function queueStartupTiming(record) {
  let line;
  let filePath;
  try {
    line = `${JSON.stringify({
      ...record,
      tag: STARTUP_TIMING_TAG,
      timestamp: new Date().toISOString(),
      pid: process.pid,
    })}\n`;
    if (Buffer.byteLength(line, 'utf8') > STARTUP_TIMING_MAX_RECORD_BYTES) return;
    filePath = startupTimingPath();
  } catch {
    return;
  }

  startupTimingWriteQueue = startupTimingWriteQueue.then(async () => {
    try {
      const backupPath = `${filePath}.1`;
      let existingSize = 0;
      try {
        existingSize = (await fs.stat(filePath)).size;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') return;
      }
      if (existingSize + Buffer.byteLength(line, 'utf8') > STARTUP_TIMING_MAX_BYTES) {
        await fs.rm(backupPath, { force: true });
        try {
          await fs.rename(filePath, backupPath);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') return;
        }
      }
      await fs.appendFile(filePath, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
      await fs.chmod(filePath, 0o600).catch(() => undefined);
    } catch {
      // Startup instrumentation is best effort and must never affect runtime selection.
    }
  }).catch(() => undefined);
}

function createAcquisitionTiming() {
  return {
    startedAt: monotonicNow(),
    outcome: 'error',
    lockWaitMs: 0,
    selectionVerificationMs: 0,
    cleanupMs: 0,
    verifications: new Map(),
    verificationOverflow: null,
  };
}

function createScanProfile() {
  return {
    cpuUserMs: 0,
    cpuSystemMs: 0,
    lstat: { count: 0, observedTotalMs: 0, observedMaxMs: 0 },
    readdir: { count: 0, observedTotalMs: 0, observedMaxMs: 0 },
    hash: { count: 0, observedTotalMs: 0, observedMaxMs: 0 },
  };
}

function diagnosticNow(profile) {
  try {
    return profile ? monotonicNow() : null;
  } catch {
    return null;
  }
}

function recordScanOperation(profile, operation, startedAt) {
  if (!profile || startedAt === null) return;
  try {
    // Observed elapsed includes callback/event-loop scheduling, not just I/O.
    // Totals overlap across the eight slots; they are not additive wall time.
    const milliseconds = elapsedMs(startedAt);
    const metric = profile[operation];
    metric.count += 1;
    metric.observedTotalMs += milliseconds;
    metric.observedMaxMs = Math.max(metric.observedMaxMs, milliseconds);
  } catch {
    // Diagnostics must not replace a validation error or interrupt draining.
  }
}

function scanCpuUsage(profile, previous) {
  if (!profile) return null;
  try {
    // Process-wide CPU, including unrelated work during this scan.
    const usage = process.cpuUsage(previous);
    if (previous) {
      profile.cpuUserMs += usage.user / 1000;
      profile.cpuSystemMs += usage.system / 1000;
    }
    return usage;
  } catch {
    return null;
  }
}

function mergeScanProfile(target, profile) {
  target.cpuUserMs += profile.cpuUserMs;
  target.cpuSystemMs += profile.cpuSystemMs;
  for (const operation of ['lstat', 'readdir', 'hash']) {
    target[operation].count += profile[operation].count;
    target[operation].observedTotalMs += profile[operation].observedTotalMs;
    target[operation].observedMaxMs = Math.max(target[operation].observedMaxMs, profile[operation].observedMaxMs);
  }
}

function finalizeScanProfile(profile) {
  return {
    cpuUserMs: roundedMs(profile.cpuUserMs),
    cpuSystemMs: roundedMs(profile.cpuSystemMs),
    ...Object.fromEntries(['lstat', 'readdir', 'hash'].map((operation) => [operation, {
      count: profile[operation].count,
      observedTotalMs: roundedMs(profile[operation].observedTotalMs),
      observedMaxMs: roundedMs(profile[operation].observedMaxMs),
    }])),
  };
}

function createVerificationSummary(generation) {
  return {
    generation,
    scanProfile: createScanProfile(),
    count: 0,
    failures: 0,
    totalMs: 0,
    files: 0,
    bytes: 0,
    phasesMs: {
      manifestMs: 0,
      fileScanMs: 0,
      manifestComparisonMs: 0,
      contentHashMs: 0,
      outputShapeMs: 0,
    },
  };
}

function recordVerification(timing, generation, verification) {
  if (!timing) return;
  let summary = timing.verifications.get(generation);
  if (!summary && timing.verifications.size < MAX_REPORTED_GENERATIONS) {
    summary = createVerificationSummary(generation);
    timing.verifications.set(generation, summary);
  }
  if (!summary) {
    if (!timing.verificationOverflow) {
      timing.verificationOverflow = {
        scanProfile: createScanProfile(),
        count: 0,
        failures: 0,
        totalMs: 0,
        files: 0,
        bytes: 0,
        phasesMs: {
          manifestMs: 0,
          fileScanMs: 0,
          manifestComparisonMs: 0,
          contentHashMs: 0,
          outputShapeMs: 0,
        },
      };
    }
    summary = timing.verificationOverflow;
  }
  mergeScanProfile(summary.scanProfile, verification.scanProfile);
  summary.count += 1;
  summary.failures += verification.failed ? 1 : 0;
  summary.totalMs += verification.totalMs;
  summary.files += verification.files;
  summary.bytes += verification.bytes;
  for (const [phase, milliseconds] of Object.entries(verification.phasesMs)) {
    summary.phasesMs[phase] += milliseconds;
  }
}

function finalizeAcquisitionTiming(timing) {
  const verifications = [...timing.verifications.values()].map((summary) => ({
    generation: summary.generation,
    scanProfile: finalizeScanProfile(summary.scanProfile),
    count: summary.count,
    failures: summary.failures,
    totalMs: roundedMs(summary.totalMs),
    files: summary.files,
    bytes: summary.bytes,
    phasesMs: Object.fromEntries(Object.entries(summary.phasesMs).map(([phase, milliseconds]) => [phase, roundedMs(milliseconds)])),
  }));
  let verificationOverflow;
  if (timing.verificationOverflow) {
    const summary = timing.verificationOverflow;
    verificationOverflow = {
      ...summary,
      scanProfile: finalizeScanProfile(summary.scanProfile),
      totalMs: roundedMs(summary.totalMs),
      phasesMs: Object.fromEntries(Object.entries(summary.phasesMs).map(([phase, milliseconds]) => [phase, roundedMs(milliseconds)])),
    };
  }
  queueStartupTiming({
    schema: 1,
    source: 'runtime-generations',
    event: 'acquire',
    outcome: timing.outcome,
    acquisitionMs: roundedMs(elapsedMs(timing.startedAt)),
    lockWaitMs: roundedMs(timing.lockWaitMs),
    selectionVerificationMs: roundedMs(timing.selectionVerificationMs),
    cleanupMs: roundedMs(timing.cleanupMs),
    verification: verifications,
    ...(verificationOverflow ? { verificationOverflow } : {}),
  });
}

function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertIdentity(identity) {
  if (!isPlainObject(identity)) throw new Error('Runtime identity must be an object.');
  for (const field of ['publisher', 'name', 'version']) {
    const value = identity[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\\/\0]/u.test(value)) {
      throw new Error(`Invalid runtime identity ${field}.`);
    }
  }
  return {
    publisher: identity.publisher,
    name: identity.name,
    version: identity.version,
  };
}

function sameIdentity(left, right) {
  return left.publisher === right.publisher
    && left.name === right.name
    && left.version === right.version;
}

function assertGeneration(generation) {
  if (typeof generation !== 'string' || !GENERATION_PATTERN.test(generation)) {
    throw new Error(`Invalid Pie runtime generation: ${String(generation)}`);
  }
}

function assertBuildId(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\r\n\0]/u.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function runtimeRoot(extensionDir) {
  if (typeof extensionDir !== 'string' || extensionDir.length === 0) {
    throw new Error('extensionDir is required.');
  }
  return path.join(path.resolve(extensionDir), RUNTIME_DIRECTORY);
}

function packagedOutDir(extensionDir) {
  return path.join(path.resolve(extensionDir), 'out');
}

function safeRelativePath(relativePath, label = 'path') {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 4_096) {
    throw new Error(`Invalid ${label}.`);
  }
  if (relativePath.includes('\0') || path.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error(`${label} must stay inside its runtime output.`);
  }
  const pieces = relativePath.split(/[\\/]/u);
  if (pieces.some((piece) => piece === '..')) {
    throw new Error(`${label} must not traverse its runtime output.`);
  }
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized === '' || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`${label} must stay inside its runtime output.`);
  }
  return normalized;
}

function safeChildPath(root, relativePath, label = 'path') {
  const normalized = safeRelativePath(relativePath, label);
  const base = path.resolve(root);
  const candidate = path.resolve(base, normalized);
  const back = path.relative(base, candidate);
  if (back === '' || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    throw new Error(`${label} must stay inside its runtime output.`);
  }
  return candidate;
}

function normalizeFileRecordPath(relativePath) {
  return safeRelativePath(relativePath, 'runtime manifest file path');
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nextSequence() {
  sequence = (sequence + 1) % 1_000_000_000;
  return sequence;
}

function ownerIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

async function readLockOwner(lockDir) {
  try {
    const owner = await readJson(path.join(lockDir, LOCK_OWNER_FILE));
    if (!isPlainObject(owner) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !/^[0-9a-f]{32}$/u.test(owner.token)) {
      return null;
    }
    return owner;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    return null;
  }
}

/**
 * Publication, acquisition, and retention use one directory lock. The owner
 * record includes the PID so a crashed publisher can be distinguished from a
 * live one without ever replacing a live owner's lock.
 */
async function acquireDirectoryLock(extensionDir, timing) {
  const root = runtimeRoot(extensionDir);
  await fs.mkdir(root, { recursive: true });
  const lockDir = path.join(root, LOCK_DIRECTORY);
  const token = crypto.randomBytes(16).toString('hex');
  const startedAt = Date.now();
  const deadline = startedAt + LOCK_TIMEOUT_MS;
  let contentionStartedAt;

  function recordLockWait() {
    if (!timing || contentionStartedAt === undefined) return;
    timing.lockWaitMs += elapsedMs(contentionStartedAt);
    contentionStartedAt = undefined;
  }

  for (;;) {
    try {
      await fs.mkdir(lockDir);
      try {
        await fs.writeFile(
          path.join(lockDir, LOCK_OWNER_FILE),
          `${JSON.stringify({ pid: process.pid, token, startedAt })}\n`,
          { flag: 'wx' },
        );
      } catch (error) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }

      recordLockWait();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const owner = await readJson(path.join(lockDir, LOCK_OWNER_FILE));
          if (owner && owner.pid === process.pid && owner.token === token) {
            await fs.rm(lockDir, { recursive: true, force: true });
          }
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        recordLockWait();
        throw error;
      }
      if (timing && contentionStartedAt === undefined) contentionStartedAt = monotonicNow();
      const owner = await readLockOwner(lockDir);
      if (owner && !ownerIsAlive(owner.pid)) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch((removeError) => {
          if (errorCode(removeError) !== 'ENOENT') throw removeError;
        });
        continue;
      }

      if (owner === null || owner === undefined) {
        // mkdir and the owner write are separate operations. Give a winning
        // process a short grace period, then recover a lock abandoned between
        // those operations (including a missing owner record).
        try {
          const lockStat = await fs.stat(lockDir);
          if (Date.now() - lockStat.mtimeMs > LOCK_METADATA_GRACE_MS) {
            await fs.rm(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (errorCode(statError) !== 'ENOENT') throw statError;
        }
      }

      if (Date.now() >= deadline) {
        recordLockWait();
        throw new Error(`Timed out waiting for the Pie runtime lock at ${lockDir}.`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function assertRegularFile(filePath, label) {
  const info = await fs.lstat(filePath);
  if (!info.isFile()) throw new Error(`${label} is not a regular file.`);
  return info;
}

async function hashFile(filePath, buffer) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  let handle;
  let hasPrimaryError = false;
  let primaryError;
  let result;
  try {
    handle = await fs.open(filePath, 'r');
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    result = { sha256: hash.digest('hex'), size };
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      if (!hasPrimaryError) throw error;
    }
  }
  if (hasPrimaryError) throw primaryError;
  return result;
}

async function collectFileRecords(rootDir, { split = false, omitTooling = false, scanProfile } = {}) {
  const root = path.resolve(rootDir);
  const rootStartedAt = diagnosticNow(scanProfile);
  let rootInfo;
  try {
    rootInfo = await fs.lstat(root);
  } finally {
    recordScanOperation(scanProfile, 'lstat', rootStartedAt);
  }
  if (!rootInfo.isDirectory()) throw new Error(`Runtime output is not a directory: ${rootDir}`);
  const records = [];
  const freeBuffers = [];
  let sawTooling = false;
  const pending = [{ path: '', absolute: root, isDirectory: true }];
  let nextTaskIndex = 0;
  let active = 0;
  let failed = false;
  let firstError;

  async function scan(task) {
    if (task.isDirectory) {
      const startedAt = diagnosticNow(scanProfile);
      let entries;
      try {
        entries = await fs.readdir(task.absolute, { withFileTypes: true });
      } finally {
        recordScanOperation(scanProfile, 'readdir', startedAt);
      }
      if (failed) return;
      entries.sort((left, right) => left.name.localeCompare(right.name));
      const candidates = entries.map((entry) => {
        const relative = task.path ? path.join(task.path, entry.name) : entry.name;
        const normalized = normalizeFileRecordPath(relative);
        return {
          path: normalized,
          absolute: safeChildPath(root, normalized, 'runtime output path'),
          isDirectory: false,
        };
      });
      for (const candidate of candidates) pending.push(candidate);
      return;
    }

    if (split && task.path.split('/')[0].toLowerCase() === TOOLING_DIRECTORY && task.path.split('/')[0] !== TOOLING_DIRECTORY) throw new Error('Noncanonical tooling directory.');
    const metadataStartedAt = diagnosticNow(scanProfile);
    let info;
    try {
      info = await fs.lstat(task.absolute);
    } finally {
      recordScanOperation(scanProfile, 'lstat', metadataStartedAt);
    }
    if (failed) return;
    if (split && task.path === TOOLING_DIRECTORY) {
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Tooling output is not an ordinary directory.');
      sawTooling = true;
      if (omitTooling) return;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Runtime output may not contain symlinks: ${task.path}`);
    }
    if (info.isDirectory()) {
      pending.push({ ...task, isDirectory: true });
    } else if (info.isFile()) {
      // Keep the slot through hashing: directory reads, metadata, and hashes
      // all share the same global limit, without directory-wide barriers.
      const hashStartedAt = diagnosticNow(scanProfile);
      let digest;
      // Each slot owns its buffer through close; at most eight scan-local
      // allocations avoid a large Buffer allocation for every read.
      const buffer = freeBuffers.pop() || Buffer.allocUnsafeSlow(HASH_FILE_READ_CHUNK_BYTES);
      try {
        digest = await hashFile(task.absolute, buffer);
      } finally {
        recordScanOperation(scanProfile, 'hash', hashStartedAt);
        freeBuffers.push(buffer);
      }
      records.push({ path: task.path, sha256: digest.sha256, size: digest.size });
    } else {
      throw new Error(`Unsupported runtime output entry: ${task.path}`);
    }
  }

  await new Promise((resolve) => {
    function admit() {
      while (!failed && active < FILE_SCAN_CONCURRENCY && nextTaskIndex < pending.length) {
        const task = pending[nextTaskIndex];
        pending[nextTaskIndex] = undefined;
        nextTaskIndex += 1;
        active += 1;
        scan(task).catch((error) => {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }).finally(() => {
          active -= 1;
          admit();
        });
      }
      // Reclaim consumed queue storage while keeping admission constant-time.
      if (nextTaskIndex === pending.length) {
        pending.length = 0;
        nextTaskIndex = 0;
      }
      if (active === 0) resolve();
    }
    admit();
  });
  if (failed) throw firstError;
  if (split && !sawTooling) throw new Error('Missing tooling directory.');

  records.sort((left, right) => left.path.localeCompare(right.path));
  return records;
}

function recordsByPath(records) {
  const result = new Map();
  for (const record of records) {
    const normalized = normalizeFileRecordPath(record.path);
    if (result.has(normalized)) throw new Error(`Duplicate runtime manifest file: ${normalized}`);
    result.set(normalized, { ...record, path: normalized });
  }
  return result;
}

function hashRecords(records) {
  const hash = crypto.createHash('sha256');
  for (const record of [...records].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(record.path, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(String(record.size), 'utf8');
    hash.update('\0', 'utf8');
    hash.update(record.sha256, 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

async function copyTree(sourceDir, destinationDir) {
  const source = path.resolve(sourceDir);
  const sourceInfo = await fs.lstat(source);
  if (!sourceInfo.isDirectory()) throw new Error(`Runtime source output is not a directory: ${sourceDir}`);
  await fs.mkdir(destinationDir, { recursive: true });

  const inFlightCopies = new Set();
  let firstCopyError;

  async function copyFileBounded(sourcePath, destinationPath) {
    while (inFlightCopies.size >= FILE_SCAN_CONCURRENCY) {
      await Promise.race([...inFlightCopies].map((copy) => copy.then(() => undefined, () => undefined)));
    }
    if (firstCopyError) throw firstCopyError;

    const copy = fs.copyFile(sourcePath, destinationPath).catch((error) => {
      if (!firstCopyError) firstCopyError = error;
      throw error;
    });
    inFlightCopies.add(copy);
    copy.then(
      () => inFlightCopies.delete(copy),
      () => inFlightCopies.delete(copy),
    ).catch(() => undefined);
    return { promise: copy };
  }

  async function drainCopies() {
    while (inFlightCopies.size > 0) {
      await Promise.allSettled([...inFlightCopies]);
    }
  }

  async function visit(sourceDirectory, destinationDirectory) {
    if (firstCopyError) throw firstCopyError;
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const candidates = entries.map((entry) => ({
      name: entry.name,
      sourcePath: path.join(sourceDirectory, entry.name),
      destinationPath: path.join(destinationDirectory, entry.name),
    }));
    const metadata = new Array(candidates.length);
    let nextCandidateIndex = 0;
    let firstMetadataError;

    async function checkMetadata() {
      while (!firstMetadataError && !firstCopyError) {
        const index = nextCandidateIndex;
        nextCandidateIndex += 1;
        if (index >= candidates.length) return;
        const candidate = candidates[index];
        try {
          const info = await fs.lstat(candidate.sourcePath);
          if (info.isSymbolicLink()) {
            throw new Error(`Runtime source may not contain symlinks: ${candidate.name}`);
          }
          if (!info.isDirectory() && !info.isFile()) {
            throw new Error(`Unsupported runtime source entry: ${candidate.name}`);
          }
          metadata[index] = { ...candidate, isDirectory: info.isDirectory() };
        } catch (error) {
          if (!firstMetadataError) firstMetadataError = error;
        }
      }
    }

    const metadataWorkerCount = Math.min(FILE_SCAN_CONCURRENCY, candidates.length);
    await Promise.allSettled(Array.from({ length: metadataWorkerCount }, () => checkMetadata()));
    if (firstMetadataError) throw firstMetadataError;
    if (firstCopyError) throw firstCopyError;

    const fileCopies = [];
    for (const candidate of metadata) {
      if (firstCopyError) break;
      if (candidate.isDirectory) {
        await fs.mkdir(candidate.destinationPath, { recursive: true });
        await visit(candidate.sourcePath, candidate.destinationPath);
      } else {
        const scheduledCopy = await copyFileBounded(candidate.sourcePath, candidate.destinationPath);
        fileCopies.push(scheduledCopy.promise);
      }
    }
    await Promise.allSettled(fileCopies);
    if (firstCopyError) throw firstCopyError;
  }

  try {
    await visit(source, destinationDir);
  } finally {
    await drainCopies();
  }
}

function assertManifestObject(manifest, manifestPath) {
  if (!isPlainObject(manifest)) throw new Error(`Invalid renderer manifest at ${manifestPath}`);
}

function manifestOwn(manifest, key) {
  return Object.prototype.hasOwnProperty.call(manifest, key);
}

async function verifyRendererManifest(outDir) {
  const manifestPath = path.join(outDir, RENDERER_MANIFEST_FILE);
  const manifest = await readJson(manifestPath);
  assertManifestObject(manifest, manifestPath);
  const listedFiles = new Set();
  let entryCount = 0;

  for (const [chunkName, rawChunk] of Object.entries(manifest)) {
    if (!isPlainObject(rawChunk) || typeof rawChunk.file !== 'string' || rawChunk.file.length === 0) {
      throw new Error(`Invalid renderer manifest chunk: ${chunkName}`);
    }
    listedFiles.add(safeRelativePath(rawChunk.file, `renderer manifest file for ${chunkName}`));
    if (rawChunk.isEntry === true) entryCount += 1;

    for (const field of ['css', 'assets']) {
      const values = rawChunk[field] ?? [];
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length === 0)) {
        throw new Error(`Invalid renderer manifest ${field} list: ${chunkName}`);
      }
      for (const value of values) listedFiles.add(safeRelativePath(value, `renderer manifest ${field} for ${chunkName}`));
    }

    for (const field of ['imports', 'dynamicImports']) {
      const references = rawChunk[field] ?? [];
      if (!Array.isArray(references) || references.some((value) => typeof value !== 'string' || !manifestOwn(manifest, value))) {
        throw new Error(`Invalid renderer manifest ${field} reference: ${chunkName}`);
      }
    }
  }

  if (entryCount !== 1) {
    throw new Error(`Expected one renderer manifest entry in ${manifestPath}`);
  }

  const rendererDir = path.join(outDir, RENDERER_DIRECTORY);
  for (const relativePath of listedFiles) {
    const absolute = safeChildPath(rendererDir, relativePath, 'renderer manifest path');
    await assertRegularFile(absolute, `Renderer manifest asset ${relativePath}`);
  }

  // Vite does not list ?worker&url output in manifest.json. Verify the same
  // strict hashed worker literals as the renderer publication path.
  const javascriptFiles = [...listedFiles].filter((relativePath) => relativePath.endsWith('.js'));
  for (const relativePath of javascriptFiles) {
    const source = await fs.readFile(safeChildPath(rendererDir, relativePath, 'renderer manifest JavaScript path'), 'utf8');
    const workerPattern = /["']\/assets\/([A-Za-z0-9_-]+-worker-[A-Za-z0-9_-]+\.js)["']/gu;
    for (const match of source.matchAll(workerPattern)) {
      const workerPath = safeChildPath(rendererDir, path.join('assets', match[1]), 'renderer worker asset path');
      await assertRegularFile(workerPath, `Renderer worker asset ${match[1]}`);
    }
  }

  return { manifest, listedFiles };
}

async function verifyBuildIds(outDir) {
  const hostBuildId = assertBuildId(
    (await fs.readFile(path.join(outDir, BUILD_ID_FILE), 'utf8')).trim(),
    'host build ID',
  );
  const rendererBuildId = assertBuildId(
    (await fs.readFile(path.join(outDir, RENDERER_DIRECTORY, BUILD_ID_FILE), 'utf8')).trim(),
    'renderer build ID',
  );
  if (hostBuildId !== rendererBuildId) {
    throw new Error(`Host/renderer build identity mismatch (${hostBuildId} != ${rendererBuildId}).`);
  }
  return { buildId: hostBuildId, rendererBuildId };
}

async function verifyOutputShape(outDir) {
  for (const relativePath of REQUIRED_RUNTIME_FILES) {
    await assertRegularFile(path.join(outDir, relativePath), `Required runtime file ${relativePath}`);
  }
  const buildIds = await verifyBuildIds(outDir);
  await verifyRendererManifest(outDir);
  return buildIds;
}

function assertExactKeys(value, keys, label) {
  if (!isPlainObject(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error(`Invalid ${label} fields.`);
}

// Authorize parsed metadata only against the digest captured by the scan.
async function readToolingReference(outDir, records) {
  const record = records.find((entry) => entry.path === TOOLING_REFERENCE);
  if (!record) throw new Error('Missing runtime tooling reference record.');
  const bytes = await fs.readFile(path.join(outDir, TOOLING_REFERENCE));
  if (bytes.length !== record.size || crypto.createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error('Runtime tooling reference checksum mismatch.');
  const reference = JSON.parse(bytes.toString('utf8'));
  assertExactKeys(reference, ['schemaVersion', 'artifactDirectory', 'identity'], 'tooling reference');
  if (reference.schemaVersion !== 1 || reference.artifactDirectory !== '../pi-tooling'
    || typeof reference.identity !== 'string' || !SHA256_PATTERN.test(reference.identity)) throw new Error('Invalid runtime tooling reference.');
  return reference;
}

async function snapshotSource(sourceOutDir) {
  const records = await collectFileRecords(sourceOutDir);
  let tooling;
  if (records.some((record) => record.path === TOOLING_REFERENCE)) {
    const reference = await readToolingReference(sourceOutDir, records);
    await collectFileRecords(sourceOutDir, { split: true, omitTooling: true });
    tooling = { path: TOOLING_DIRECTORY, identity: reference.identity,
      files: records.filter((record) => record.path.startsWith(`${TOOLING_DIRECTORY}/`)) };
  }
  const buildIds = await verifyOutputShape(sourceOutDir);
  if (!records.some((record) => record.path === 'extension.js')) {
    throw new Error('Runtime output is missing extension.js.');
  }
  return {
    records,
    tooling,
    generation: hashRecords(records),
    buildId: buildIds.buildId,
    rendererBuildId: buildIds.rendererBuildId,
  };
}

function runtimeManifestFor({ identity, generation, buildId, rendererBuildId, records, tooling }) {
  return {
    schema: tooling ? 2 : RUNTIME_SCHEMA,
    identity,
    generation,
    buildId,
    rendererBuildId,
    files: records.filter((record) => !tooling || !record.path.startsWith(`${TOOLING_DIRECTORY}/`)).map((record) => ({ ...record })),
    ...(tooling ? { tooling } : {}),
  };
}

function validateRuntimeManifest(manifest, generation, identity) {
  if (!isPlainObject(manifest) || ![RUNTIME_SCHEMA, 2].includes(manifest.schema)) {
    throw new Error('Invalid Pie runtime manifest.');
  }
  const split = manifest.schema === 2;
  if (split) {
    assertExactKeys(manifest, ['schema', 'identity', 'generation', 'buildId', 'rendererBuildId', 'files', 'tooling'], 'runtime manifest');
    assertExactKeys(manifest.identity, ['publisher', 'name', 'version'], 'runtime identity');
    assertExactKeys(manifest.tooling, ['path', 'identity', 'files'], 'tooling manifest');
    if (manifest.tooling.path !== TOOLING_DIRECTORY || typeof manifest.tooling.identity !== 'string'
      || !SHA256_PATTERN.test(manifest.tooling.identity) || !Array.isArray(manifest.tooling.files)
      || manifest.tooling.files.length === 0) throw new Error('Invalid tooling manifest.');
  }
  assertGeneration(manifest.generation);
  if (manifest.generation !== generation) throw new Error('Pie runtime manifest generation mismatch.');
  if (!isPlainObject(manifest.identity)) throw new Error('Pie runtime manifest identity is invalid.');
  const manifestIdentity = assertIdentity(manifest.identity);
  if (!sameIdentity(manifestIdentity, identity)) throw new Error('Pie runtime manifest identity mismatch.');
  const buildId = assertBuildId(manifest.buildId, 'runtime host build ID');
  const rendererBuildId = assertBuildId(manifest.rendererBuildId, 'runtime renderer build ID');
  if (buildId !== rendererBuildId) throw new Error('Pie runtime manifest build identity mismatch.');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Pie runtime manifest has no files.');
  }

  const records = [];
  const seen = new Set();
  const toolingRecords = [];
  const allRecords = [...manifest.files, ...(split ? manifest.tooling.files : [])];
  for (const [index, rawRecord] of allRecords.entries()) {
    if (!isPlainObject(rawRecord)) throw new Error('Invalid Pie runtime manifest file record.');
    const filePath = normalizeFileRecordPath(rawRecord.path);
    const toolingRecord = index >= manifest.files.length;
    if (split) {
      assertExactKeys(rawRecord, ['path', 'sha256', 'size'], 'runtime file record');
      if (filePath !== rawRecord.path || filePath.split('/').some((piece) => piece === '' || piece === '.')
        || rawRecord.path.includes('\\')) throw new Error('Noncanonical runtime file path.');
      if (toolingRecord ? !filePath.startsWith(`${TOOLING_DIRECTORY}/`)
        : filePath.split('/')[0].toLowerCase() === TOOLING_DIRECTORY) throw new Error('Runtime/tooling role overlap.');
    }
    if (seen.has(filePath)) throw new Error(`Duplicate Pie runtime manifest file: ${filePath}`);
    seen.add(filePath);
    if (!SHA256_PATTERN.test(rawRecord.sha256)) throw new Error(`Invalid SHA256 for runtime file: ${filePath}`);
    if (!Number.isSafeInteger(rawRecord.size) || rawRecord.size < 0) throw new Error(`Invalid size for runtime file: ${filePath}`);
    (toolingRecord ? toolingRecords : records).push({ path: filePath, sha256: rawRecord.sha256, size: rawRecord.size });
  }
  records.sort((left, right) => left.path.localeCompare(right.path));
  for (const required of REQUIRED_RUNTIME_FILES) {
    if (!seen.has(required)) throw new Error(`Runtime manifest is missing ${required}.`);
  }
  if (split && (!records.some((record) => record.path === TOOLING_REFERENCE)
    || !toolingRecords.some((record) => record.path === `${TOOLING_DIRECTORY}/manifest.json`))) throw new Error('Missing tooling role metadata.');
  return { records, toolingRecords, split, toolingIdentity: manifest.tooling?.identity, buildId, rendererBuildId };
}

async function verifyStoredGeneration(generationDir, generation, identity, timing, fullTooling = false) {
  const startedAt = timing ? monotonicNow() : null;
  const phasesMs = timing ? {
    manifestMs: 0,
    fileScanMs: 0,
    manifestComparisonMs: 0,
    contentHashMs: 0,
    outputShapeMs: 0,
  } : null;
  const scanProfile = timing ? createScanProfile() : undefined;
  let files = 0;
  let bytes = 0;
  let failed = true;
  try {
    assertGeneration(generation);
    const manifestStartedAt = timing ? monotonicNow() : null;
    let manifest;
    let validated;
    try {
      manifest = await readJson(path.join(generationDir, RUNTIME_MANIFEST_FILE));
      validated = validateRuntimeManifest(manifest, generation, identity);
    } finally {
      if (timing) phasesMs.manifestMs += elapsedMs(manifestStartedAt);
    }
    const outDir = path.join(generationDir, 'out');
    const fileScanStartedAt = timing ? monotonicNow() : null;
    let actualRecords;
    try {
      const cpuStartedAt = scanCpuUsage(scanProfile);
      try {
        actualRecords = await collectFileRecords(outDir, { split: validated.split, omitTooling: validated.split && !fullTooling, scanProfile });
      } finally {
        if (cpuStartedAt) scanCpuUsage(scanProfile, cpuStartedAt);
      }
      if (validated.split && (await readToolingReference(outDir, actualRecords)).identity !== validated.toolingIdentity) throw new Error('Tooling identity mismatch.');
      if (timing) {
        files = actualRecords.length;
        bytes = actualRecords.reduce((total, record) => total + record.size, 0);
      }
    } finally {
      if (timing) phasesMs.fileScanMs += elapsedMs(fileScanStartedAt);
    }
    const comparisonStartedAt = timing ? monotonicNow() : null;
    try {
      const actualByPath = recordsByPath(actualRecords);
      const expectedRecords = [...validated.records, ...(fullTooling ? validated.toolingRecords : [])];
      if (actualByPath.size !== expectedRecords.length) {
        throw new Error('Pie runtime output does not match its manifest file set.');
      }

      for (const expected of expectedRecords) {
        const actual = actualByPath.get(expected.path);
        if (!actual || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
          throw new Error(`Pie runtime file checksum mismatch: ${expected.path}`);
        }
      }
    } finally {
      if (timing) phasesMs.manifestComparisonMs += elapsedMs(comparisonStartedAt);
    }

    const contentHashStartedAt = timing ? monotonicNow() : null;
    try {
      const actualGeneration = hashRecords([...actualRecords, ...(fullTooling ? [] : validated.toolingRecords)]);
      if (actualGeneration !== generation) throw new Error('Pie runtime content hash mismatch.');
    } finally {
      if (timing) phasesMs.contentHashMs += elapsedMs(contentHashStartedAt);
    }

    const outputShapeStartedAt = timing ? monotonicNow() : null;
    let buildIds;
    try {
      buildIds = await verifyOutputShape(outDir);
      if (buildIds.buildId !== validated.buildId || buildIds.rendererBuildId !== validated.rendererBuildId) {
        throw new Error('Pie runtime build identity does not match its manifest.');
      }
    } finally {
      if (timing) phasesMs.outputShapeMs += elapsedMs(outputShapeStartedAt);
    }
    failed = false;
    return {
      generation,
      outDir,
      buildId: buildIds.buildId,
      rendererBuildId: buildIds.rendererBuildId,
    };
  } finally {
    if (timing) {
      try {
        recordVerification(timing, generation, {
          failed,
          totalMs: elapsedMs(startedAt),
          files,
          bytes,
          phasesMs,
          scanProfile,
        });
      } catch {
        // Diagnostics must not change verification success or its first error.
      }
    }
  }
}

function selectionMarkerName(publishedAt, generation) {
  return `${String(publishedAt).padStart(13, '0')}-${String(process.pid).padStart(10, '0')}-${String(nextSequence()).padStart(9, '0')}-${generation}-${crypto.randomBytes(8).toString('hex')}.json`;
}

function safeSelectionName(name) {
  if (typeof name !== 'string' || !/^[0-9]{13}-[0-9]+-[0-9]+-[0-9a-f]{64}-[0-9a-f]{16}\.json$/u.test(name)) {
    throw new Error(`Invalid Pie runtime selection marker name: ${String(name)}`);
  }
  return name;
}

function leaseName(generation, token) {
  return `${generation}-${process.pid}-${token}.json`;
}

function leaseGenerationFromName(name) {
  const match = typeof name === 'string' ? name.match(/^([0-9a-f]{64})-[0-9]+-[0-9a-f]{32}\.json$/u) : null;
  return match ? match[1] : null;
}

async function listSelectionRecords(root, identity, { allowMissing = true, timing, limit = 2 } = {}) {
  const startedAt = timing ? monotonicNow() : null;
  try {
    const selectionsDir = path.join(root, SELECTIONS_DIRECTORY);
    let entries;
    try {
      entries = await fs.readdir(selectionsDir, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT' && allowMissing) return [];
      throw error;
    }

    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
      let markerName;
      try {
        markerName = safeSelectionName(entry.name);
      } catch {
        continue;
      }
      try {
        const marker = await readJson(path.join(selectionsDir, markerName));
        if (!isPlainObject(marker) || marker.schema !== RUNTIME_SCHEMA || !isPlainObject(marker.identity)) continue;
        const markerIdentity = assertIdentity(marker.identity);
        if (!sameIdentity(markerIdentity, identity)) continue;
        assertGeneration(marker.generation);
        if (!Number.isSafeInteger(marker.publishedAt) || marker.publishedAt < 0) continue;
        candidates.push({
          name: markerName,
          generation: marker.generation,
          publishedAt: marker.publishedAt,
        });
      } catch {
        // A torn marker is deliberately skipped; other markers may still select
        // a complete generation.
      }
    }

    candidates.sort((left, right) => right.publishedAt - left.publishedAt || right.name.localeCompare(left.name));
    const records = [];
    if (limit === 0) return records;
    const verifiedGenerations = new Set();
    for (const candidate of candidates) {
      if (verifiedGenerations.has(candidate.generation)) continue;
      verifiedGenerations.add(candidate.generation);
      try {
        const generationDir = path.join(root, GENERATIONS_DIRECTORY, candidate.generation);
        const verified = await verifyStoredGeneration(generationDir, candidate.generation, identity, timing);
        records.push({ ...candidate, outDir: verified.outDir });
        if (records.length >= limit) break;
      } catch {
        // A damaged generation is deliberately skipped; resolution continues
        // with the next distinct complete generation.
      }
    }
    return records;
  } finally {
    if (timing) timing.selectionVerificationMs += elapsedMs(startedAt);
  }
}

async function listLeasedGenerations(root, { allowMissing = true } = {}) {
  const leasesDir = path.join(root, LEASES_DIRECTORY);
  let entries;
  try {
    entries = await fs.readdir(leasesDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT' && allowMissing) return new Set();
    throw error;
  }

  const generations = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const generation = leaseGenerationFromName(entry.name);
    if (generation) generations.add(generation);
  }
  return generations;
}

async function cleanupRuntime(root, identity, timing, verifiedSelectionRecords) {
  const selectionsDir = path.join(root, SELECTIONS_DIRECTORY);
  const generationsDir = path.join(root, GENERATIONS_DIRECTORY);
  const leasesDir = path.join(root, LEASES_DIRECTORY);
  let selectionEntries;
  let generationEntries;
  try {
    // Read every metadata directory before deleting anything. Missing or
    // unreadable lease knowledge is a cleanup no-op, never an empty lease set.
    [selectionEntries, generationEntries] = await Promise.all([
      fs.readdir(selectionsDir, { withFileTypes: true }),
      fs.readdir(generationsDir, { withFileTypes: true }),
      fs.readdir(leasesDir, { withFileTypes: true }),
    ]);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }

  const records = verifiedSelectionRecords ?? await listSelectionRecords(root, identity, { allowMissing: false, timing, limit: 2 });
  const retainedGenerations = new Set();
  const retainedMarkers = new Set();
  for (const record of records) {
    if (retainedGenerations.has(record.generation)) continue;
    if (retainedGenerations.size < 2) {
      retainedGenerations.add(record.generation);
      retainedMarkers.add(record.name);
    }
  }

  // Leases are intentionally conservative. A dead VS Code host may have left
  // a worker alive, so leases are retained indefinitely rather than guessing
  // whether a PID is safe to reclaim. A future explicit release can still
  // make the generation eligible for ordinary current+prior retention.
  const leasedGenerations = await listLeasedGenerations(root, { allowMissing: false });
  for (const generation of leasedGenerations) retainedGenerations.add(generation);

  for (const entry of selectionEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    if (!retainedMarkers.has(entry.name)) await fs.rm(path.join(selectionsDir, entry.name), { force: true });
  }

  for (const entry of generationEntries) {
    if (!entry.isDirectory()) continue;
    if (!GENERATION_PATTERN.test(entry.name)) continue;
    if (!retainedGenerations.has(entry.name)) {
      await fs.rm(path.join(generationsDir, entry.name), { recursive: true, force: true });
    }
  }
}

async function resolveRuntimeGenerationUnlocked(extensionDir, identity, timing, verifiedSelectionRecords) {
  const root = runtimeRoot(extensionDir);
  const records = verifiedSelectionRecords ?? await listSelectionRecords(root, identity, { timing, limit: 1 });
  if (records[0]) {
    return {
      generation: records[0].generation,
      outDir: records[0].outDir,
      publishedAt: records[0].publishedAt,
    };
  }
  return { generation: null, outDir: packagedOutDir(extensionDir), publishedAt: 0 };
}

/**
 * Publish a complete immutable copy of sourceOutDir. The generation identity is
 * a SHA-256 over every output path, size, and file digest; PIE_BUILD_ID is only
 * checked for host/renderer coordination and is never used as the generation
 * identity.
 */
async function publishRuntimeGeneration({ sourceOutDir, extensionDir, identity, beforeSelect }) {
  const normalizedIdentity = assertIdentity(identity);
  if (typeof beforeSelect !== 'undefined' && typeof beforeSelect !== 'function') {
    throw new Error('beforeSelect must be a function.');
  }
  const buildTiming = createPublishTiming();
  const snapshotStartedAt = buildTiming ? monotonicNow() : null;
  let sourceSnapshot;
  try {
    sourceSnapshot = await snapshotSource(sourceOutDir);
  } catch (error) {
    recordBuildPhase(buildTiming, 'snapshot', snapshotStartedAt);
    emitPublishTiming(buildTiming);
    throw error;
  }
  recordBuildPhase(buildTiming, 'snapshot', snapshotStartedAt);

  let releaseLock;
  try {
    releaseLock = await acquireDirectoryLock(extensionDir);
  } catch (error) {
    emitPublishTiming(buildTiming);
    throw error;
  }
  const root = runtimeRoot(extensionDir);
  const generationsDir = path.join(root, GENERATIONS_DIRECTORY);
  const selectionsDir = path.join(root, SELECTIONS_DIRECTORY);
  const leasesDir = path.join(root, LEASES_DIRECTORY);
  const generation = sourceSnapshot.generation;
  const generationDir = path.join(generationsDir, generation);
  const outDir = path.join(generationDir, 'out');
  let stagingDir;

  try {
    await Promise.all([
      fs.mkdir(generationsDir, { recursive: true }),
      fs.mkdir(selectionsDir, { recursive: true }),
      fs.mkdir(leasesDir, { recursive: true }),
    ]);

    let existingIsValid = false;
    try {
      await verifyStoredGeneration(generationDir, generation, normalizedIdentity, undefined, true);
      existingIsValid = true;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        // An existing directory is never repaired in place. We stage a fresh
        // copy and let the final no-replace rename decide whether it can win.
      }
    }

    if (!existingIsValid) {
      const stagingName = `.staging-${process.pid}-${nextSequence()}-${crypto.randomBytes(8).toString('hex')}`;
      stagingDir = path.join(generationsDir, stagingName);
      await fs.rm(stagingDir, { recursive: true, force: true });
      await fs.mkdir(stagingDir, { recursive: true });
      const copyStartedAt = buildTiming ? monotonicNow() : null;
      try {
        await copyTree(sourceOutDir, path.join(stagingDir, 'out'));
      } finally {
        recordBuildPhase(buildTiming, 'copy', copyStartedAt);
      }

      const stagedScanStartedAt = buildTiming ? monotonicNow() : null;
      let stagedRecords;
      try {
        stagedRecords = await collectFileRecords(path.join(stagingDir, 'out'));
        if (hashRecords(stagedRecords) !== generation) {
          throw new Error('Runtime source changed while it was being staged.');
        }
      } finally {
        recordBuildPhase(buildTiming, 'stagedScan', stagedScanStartedAt);
      }

      const stagedVerifyStartedAt = buildTiming ? monotonicNow() : null;
      try {
        const stagedBuildIds = await verifyOutputShape(path.join(stagingDir, 'out'));
        await fs.writeFile(
          path.join(stagingDir, RUNTIME_MANIFEST_FILE),
          `${JSON.stringify(runtimeManifestFor({
            identity: normalizedIdentity,
            generation,
            buildId: stagedBuildIds.buildId,
            rendererBuildId: stagedBuildIds.rendererBuildId,
            records: stagedRecords,
            tooling: sourceSnapshot.tooling,
          }), null, 2)}\n`,
          { flag: 'wx' },
        );
        await verifyStoredGeneration(stagingDir, generation, normalizedIdentity, undefined, true);
      } finally {
        recordBuildPhase(buildTiming, 'stagedVerify', stagedVerifyStartedAt);
      }

      try {
        await fs.rename(stagingDir, generationDir);
        stagingDir = undefined;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(errorCode(error))) throw error;
        // Another publisher cannot normally win while this lock is held, but
        // never overwrite a directory if an external process did so anyway.
        await verifyStoredGeneration(generationDir, generation, normalizedIdentity, undefined, true);
      }
    }

    const previousSelectionsStartedAt = buildTiming ? monotonicNow() : null;
    let previousSelections;
    try {
      previousSelections = await listSelectionRecords(root, normalizedIdentity, { allowMissing: false, limit: 1 });
    } finally {
      recordBuildPhase(buildTiming, 'previousSelections', previousSelectionsStartedAt);
    }
    const publishedAt = Math.max(Date.now(), (previousSelections[0]?.publishedAt ?? -1) + 1);
    await beforeSelect?.({ generation, outDir, publishedAt });
    if (sourceSnapshot.tooling) await verifyStoredGeneration(generationDir, generation, normalizedIdentity, undefined, true);

    const markerName = selectionMarkerName(publishedAt, generation);
    const markerPath = path.join(selectionsDir, markerName);
    const markerStaging = path.join(selectionsDir, `.staging-${markerName}`);
    await fs.writeFile(
      markerStaging,
      `${JSON.stringify({
        schema: RUNTIME_SCHEMA,
        identity: normalizedIdentity,
        generation,
        publishedAt,
      })}\n`,
      { flag: 'wx' },
    );
    await fs.rename(markerStaging, markerPath);

    const cleanupStartedAt = buildTiming ? monotonicNow() : null;
    try {
      await cleanupRuntime(root, normalizedIdentity);
    } catch (error) {
      // Selection is already durable. Retention is best effort so a transient
      // filesystem failure cannot turn a complete publication into a failure.
      console.warn(`[pie-runtime] retention cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      recordBuildPhase(buildTiming, 'cleanup', cleanupStartedAt);
    }

    return { generation, outDir, publishedAt };
  } finally {
    try {
      if (stagingDir) await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      await releaseLock();
    } finally {
      emitPublishTiming(buildTiming);
    }
  }
}

/** Resolve the newest complete selected generation, or the packaged flat out/. */
async function resolveRuntimeGeneration({ extensionDir, identity }) {
  const normalizedIdentity = assertIdentity(identity);
  const releaseLock = await acquireDirectoryLock(extensionDir);
  try {
    return await resolveRuntimeGenerationUnlocked(extensionDir, normalizedIdentity);
  } finally {
    await releaseLock();
  }
}

async function acquireRuntimeGeneration({ extensionDir, identity }) {
  const timing = createAcquisitionTiming();
  try {
    const normalizedIdentity = assertIdentity(identity);
    const releaseLock = await acquireDirectoryLock(extensionDir, timing);
    const root = runtimeRoot(extensionDir);
    let leasePath;
    let resolved;
    try {
      await Promise.all([
        fs.mkdir(path.join(root, GENERATIONS_DIRECTORY), { recursive: true }),
        fs.mkdir(path.join(root, SELECTIONS_DIRECTORY), { recursive: true }),
        fs.mkdir(path.join(root, LEASES_DIRECTORY), { recursive: true }),
      ]);
      // Startup verifies only the generation it will lease and load. Retention
      // verifies current+prior separately during publication or lease release.
      const verifiedSelectionRecords = await listSelectionRecords(root, normalizedIdentity, { timing, limit: 1 });
      resolved = await resolveRuntimeGenerationUnlocked(extensionDir, normalizedIdentity, timing, verifiedSelectionRecords);
      if (resolved.generation !== null) {
        const token = crypto.randomBytes(16).toString('hex');
        const leasesDir = path.join(root, LEASES_DIRECTORY);
        await fs.mkdir(leasesDir, { recursive: true });
        const name = leaseName(resolved.generation, token);
        leasePath = path.join(leasesDir, name);
        const leaseStaging = path.join(leasesDir, `.staging-${name}`);
        await fs.writeFile(
          leaseStaging,
          `${JSON.stringify({
            schema: RUNTIME_SCHEMA,
            identity: normalizedIdentity,
            generation: resolved.generation,
            pid: process.pid,
            createdAt: Date.now(),
          })}\n`,
          { flag: 'wx' },
        );
        await fs.rename(leaseStaging, leasePath);
      }
    } catch (error) {
      if (leasePath) await fs.rm(leasePath, { force: true }).catch(() => undefined);
      await releaseLock();
      throw error;
    }
    await releaseLock();

    let released = false;
    timing.outcome = 'success';
    return {
      ...resolved,
      release: async () => {
        if (released) return;
        released = true;
        const releaseLeaseLock = await acquireDirectoryLock(extensionDir);
        try {
          if (leasePath) await fs.rm(leasePath, { force: true });
          await cleanupRuntime(root, normalizedIdentity);
        } finally {
          await releaseLeaseLock();
        }
      },
    };
  } finally {
    try {
      finalizeAcquisitionTiming(timing);
    } catch {
      // Instrumentation is observational only.
    }
  }
}

module.exports = {
  SUPPORTED_MANIFEST_SCHEMAS: Object.freeze([1, 2]),
  publishRuntimeGeneration,
  resolveRuntimeGeneration,
  acquireRuntimeGeneration,
  // These constants are intentionally small test/integration seams; callers
  // should use the three functions above rather than depending on storage names.
  RUNTIME_DIRECTORY,
  GENERATIONS_DIRECTORY,
  SELECTIONS_DIRECTORY,
  LEASES_DIRECTORY,
  RUNTIME_MANIFEST_FILE,
};
