import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_DIRECTORY = '.cache/development-runtime';
const READERS_DIRECTORY = 'readers';
const COORDINATION_FILE = 'coordination.lock';
const WRITER_FILE = 'writer.json';
const COORDINATION_TIMEOUT_MS = 5_000;
const COORDINATION_RETRY_MS = 25;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errnoCode(error) {
  return error && typeof error === 'object' ? error.code : undefined;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function gateError(message) {
  return new Error(`Development workspace gate: ${message}`);
}

async function ensureDirectory(directory, { create = false, label = directory } = {}) {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT' || !create) throw error;
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if (errnoCode(mkdirError) !== 'EEXIST') throw mkdirError;
    }
    stat = await fs.lstat(directory);
  }
  if (stat.isSymbolicLink()) {
    throw gateError(`refusing linked ${label} path ${directory}; gate state must be owned directly by this workspace.`);
  }
  if (!stat.isDirectory()) throw gateError(`expected ${label} to be a directory at ${directory}.`);
}

async function getWorkspaceState(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    throw new TypeError('workspaceRoot must be a non-empty path string.');
  }

  const suppliedRoot = path.resolve(workspaceRoot);
  const root = await fs.realpath(suppliedRoot);
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw gateError(`Pi workspace root is not a directory: ${root}`);

  const cachePath = path.join(root, '.cache');
  const directory = path.join(root, STATE_DIRECTORY);
  const readersPath = path.join(directory, READERS_DIRECTORY);
  await ensureDirectory(cachePath, { create: true, label: 'workspace .cache' });
  await ensureDirectory(directory, { create: true, label: 'development-runtime state' });
  await ensureDirectory(readersPath, { create: true, label: 'reader registry' });

  return { root, cachePath, directory, readersPath,
    coordinationPath: path.join(directory, COORDINATION_FILE),
    writerPath: path.join(directory, WRITER_FILE) };
}

function validRecord(record, expectedKind, root) {
  return record !== null
    && typeof record === 'object'
    && !Array.isArray(record)
    && record.schema === 1
    && record.kind === expectedKind
    && typeof record.id === 'string'
    && UUID_PATTERN.test(record.id)
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && typeof record.createdAt === 'string'
    && record.workspaceRoot === root;
}

async function readRecord(filePath, expectedKind, root) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return { status: 'missing' };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return { status: 'invalid', reason: 'linked state path (not followed)' };
  }
  if (!stat.isFile()) return { status: 'invalid', reason: 'state path is not a regular file' };
  if (stat.nlink > 1) return { status: 'invalid', reason: `state file has ${stat.nlink} hard links` };

  let contents;
  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    return { status: 'invalid', reason: `state file cannot be read (${errnoCode(error) ?? 'unknown error'})` };
  }
  let record;
  try {
    record = JSON.parse(contents);
  } catch {
    return { status: 'invalid', reason: 'state file is not valid JSON' };
  }
  if (!validRecord(record, expectedKind, root)) {
    return { status: 'invalid', reason: `state record is not a valid ${expectedKind} record`, record };
  }
  return { status: 'valid', record };
}

function formatRecord(kind, filePath, record) {
  const pid = Number.isSafeInteger(record?.pid) ? record.pid : 'unknown';
  const id = typeof record?.id === 'string' ? record.id : 'unknown';
  const createdAt = typeof record?.createdAt === 'string' ? record.createdAt : 'unknown';
  return `${kind} (pid ${pid}, id ${id}, registered ${createdAt}) at ${filePath}`;
}

async function scanState(state, coordinationId) {
  const problems = [];
  const readers = [];
  let writer;

  const coordination = await readRecord(state.coordinationPath, 'coordination', state.root);
  if (coordination.status !== 'valid' || coordination.record.id !== coordinationId) {
    throw gateError(`coordination ownership was lost at ${state.coordinationPath}; no gate state was changed.`);
  }

  const topEntries = await fs.readdir(state.directory, { withFileTypes: true });
  for (const entry of topEntries) {
    if (![COORDINATION_FILE, WRITER_FILE, READERS_DIRECTORY].includes(entry.name)) {
      problems.push({ path: path.join(state.directory, entry.name), reason: 'unrecognized state entry' });
    }
  }

  const writerResult = await readRecord(state.writerPath, 'writer', state.root);
  if (writerResult.status === 'valid') writer = writerResult.record;
  else if (writerResult.status === 'invalid') {
    problems.push({ path: state.writerPath, reason: writerResult.reason, record: writerResult.record });
  }

  const readerEntries = await fs.readdir(state.readersPath, { withFileTypes: true });
  for (const entry of readerEntries) {
    const filePath = path.join(state.readersPath, entry.name);
    const readerResult = await readRecord(filePath, 'reader', state.root);
    const expectedName = readerResult.status === 'valid'
      ? `reader-${readerResult.record.id}.json`
      : undefined;
    if (readerResult.status === 'valid' && entry.name === expectedName) {
      readers.push({ path: filePath, record: readerResult.record });
    } else {
      problems.push({
        path: filePath,
        reason: readerResult.status === 'invalid'
          ? readerResult.reason
          : readerResult.status === 'missing'
            ? 'state entry disappeared while inspecting it'
            : 'reader filename does not match its registration id',
        record: readerResult.record,
      });
    }
  }

  return { readers, writer, problems };
}

function throwBlocked(state, operation, blockers) {
  const list = blockers.map((blocker) => `  - ${blocker}`).join('\n');
  const nextStep = 'Inspect the listed gate records and confirm no owning operation or reader lifetime remains before manually removing stale state. Records are never reclaimed by PID or age.';
  if (operation === 'writer') {
    throw gateError(`writer denied for canonical Pi workspace ${state.root}: ${blockers.length} blocker(s). The operation was not started, so it could not rewrite workspace outputs.\n${list}\n${nextStep}`);
  }
  throw gateError(`reader denied for canonical Pi workspace ${state.root}: ${blockers.length} blocker(s).\n${list}\n${nextStep}`);
}

function newRecord(kind, root) {
  return {
    schema: 1,
    kind,
    id: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
    workspaceRoot: root,
  };
}

async function createRecord(filePath, record) {
  let handle;
  try {
    handle = await fs.open(filePath, 'wx', 0o600);
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') {
      throw gateError(`unexpected existing gate record at ${filePath}; it was not replaced.`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    throw gateError(`could not complete the newly created state record ${filePath}; it remains as conservative recovery evidence (${errnoCode(error) ?? 'write error'}).`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function acquireCoordination(state) {
  const startedAt = Date.now();
  const id = randomUUID();
  const record = newRecord('coordination', state.root);
  record.id = id;

  while (true) {
    await ensureDirectory(state.cachePath, { label: 'workspace .cache' });
    await ensureDirectory(state.directory, { label: 'development-runtime state' });
    await ensureDirectory(state.readersPath, { label: 'reader registry' });

    let handle;
    try {
      handle = await fs.open(state.coordinationPath, 'wx', 0o600);
    } catch (error) {
      const code = errnoCode(error);
      if (code !== 'EEXIST' && code !== 'EACCES' && code !== 'EPERM' && code !== 'EBUSY') throw error;
      const existing = await readRecord(state.coordinationPath, 'coordination', state.root);
      if (existing.status === 'invalid'
        && (['linked state path (not followed)', 'state path is not a regular file'].includes(existing.reason)
          || existing.reason.includes('hard links'))) {
        throw gateError(`unowned coordination state at ${state.coordinationPath} (${existing.reason}); inspect and recover it manually.`);
      }
      if (Date.now() - startedAt >= COORDINATION_TIMEOUT_MS) {
        const owner = existing.status === 'valid'
          ? formatRecord('coordination lock', state.coordinationPath, existing.record)
          : `coordination lock at ${state.coordinationPath}${existing.status === 'invalid' ? ` (${existing.reason})` : ''}`;
        throw gateError(`timed out waiting for ${owner}. It may be active or left by a crash; no age/PID reclamation is attempted. Confirm the gate is idle before manual recovery.`);
      }
      await sleep(COORDINATION_RETRY_MS);
      continue;
    }

    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      throw gateError(`coordination state could not be completed at ${state.coordinationPath}; the file was retained for conservative manual recovery (${errnoCode(error) ?? 'write error'}).`);
    } finally {
      await handle.close().catch(() => undefined);
    }
    return { id, record };
  }
}

async function releaseCoordination(state, coordinationId) {
  const lock = await readRecord(state.coordinationPath, 'coordination', state.root);
  if (lock.status !== 'valid' || lock.record.id !== coordinationId) {
    throw gateError(`coordination lock ownership changed at ${state.coordinationPath}; the lock was not removed.`);
  }
  await fs.unlink(state.coordinationPath);
}

async function withCoordination(state, operation) {
  const lock = await acquireCoordination(state);
  let result;
  let operationError;
  let operationFailed = false;
  try {
    result = await operation(lock.id);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await releaseCoordination(state, lock.id);
  } catch (releaseError) {
    if (operationFailed) {
      throw new AggregateError([operationError, releaseError], 'Gate operation failed and its coordination lock could not be released.');
    }
    throw releaseError;
  }
  if (operationFailed) throw operationError;
  return result;
}

async function removeOwnedRecord(filePath, kind, state, id) {
  const result = await readRecord(filePath, kind, state.root);
  if (result.status === 'missing') return;
  if (result.status !== 'valid' || result.record.id !== id) {
    throw gateError(`cannot release ${kind} registration because ownership evidence changed at ${filePath}; the record was retained.`);
  }
  await fs.unlink(filePath);
}

/** Register a live development reader. Its durable registration blocks writers until teardown is confirmed. */
export async function acquireDevelopmentReader(workspaceRoot) {
  const state = await getWorkspaceState(workspaceRoot);
  return withCoordination(state, async (coordinationId) => {
    const scan = await scanState(state, coordinationId);
    const blockers = [];
    if (scan.writer) blockers.push(formatRecord('writer intent', state.writerPath, scan.writer));
    for (const problem of scan.problems) blockers.push(`${problem.reason} at ${problem.path}`);
    if (blockers.length > 0) throwBlocked(state, 'reader', blockers);

    const record = newRecord('reader', state.root);
    const filePath = path.join(state.readersPath, `reader-${record.id}.json`);
    await createRecord(filePath, record);
    return {
      async release({ teardownConfirmed } = {}) {
        if (typeof teardownConfirmed !== 'boolean') {
          throw new TypeError('release requires { teardownConfirmed: boolean }.');
        }
        if (!teardownConfirmed) return;
        await withCoordination(state, async () => removeOwnedRecord(filePath, 'reader', state, record.id));
      },
    };
  });
}

/** Run a development-only writer operation while excluding all registered readers and other writers. */
export async function withDevelopmentWriter(workspaceRoot, operation) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function.');
  const state = await getWorkspaceState(workspaceRoot);
  const writerRecord = await withCoordination(state, async (coordinationId) => {
    const scan = await scanState(state, coordinationId);
    const blockers = scan.readers.map(({ path: filePath, record }) => formatRecord('reader', filePath, record));
    if (scan.writer) blockers.push(formatRecord('writer intent', state.writerPath, scan.writer));
    for (const problem of scan.problems) blockers.push(`${problem.reason} at ${problem.path}`);
    if (blockers.length > 0) throwBlocked(state, 'writer', blockers);

    const record = newRecord('writer', state.root);
    await createRecord(state.writerPath, record);
    return record;
  });

  let result;
  let operationError;
  let operationFailed = false;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  // A failed operation may still own child writers. Their uncertainty is
  // durable blocking evidence, not permission to admit SDK readers.
  if (operationFailed && operationError?.teardownUnconfirmed === true) throw operationError;

  try {
    await withCoordination(state, async () => removeOwnedRecord(state.writerPath, 'writer', state, writerRecord.id));
  } catch (releaseError) {
    if (operationFailed) {
      throw new AggregateError([operationError, releaseError], 'Development writer operation failed and its blocking intent could not be released.');
    }
    throw releaseError;
  }

  if (operationFailed) throw operationError;
  return result;
}
