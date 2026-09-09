'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const RUNTIME_DIRECTORY = 'pie-runtime';
const GENERATIONS_DIRECTORY = 'generations';
const SELECTIONS_DIRECTORY = 'selections';
const LEASES_DIRECTORY = 'leases';
const LOCK_DIRECTORY = '.lock';
const LOCK_OWNER_FILE = 'owner.json';
const RUNTIME_MANIFEST_FILE = 'runtime-manifest.json';
const RUNTIME_SCHEMA = 1;
const REQUIRED_RUNTIME_FILES = ['extension.js', 'backend.js', 'worker-entry.js'];
const BUILD_ID_FILE = 'pie-build-id.txt';
const RENDERER_DIRECTORY = path.join('webview', 'panel');
const RENDERER_MANIFEST_FILE = path.join(RENDERER_DIRECTORY, '.vite', 'manifest.json');
const GENERATION_PATTERN = /^[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const LOCK_RETRY_MS = 25;
const LOCK_METADATA_GRACE_MS = 2_000;
const LOCK_TIMEOUT_MS = 60_000;

let sequence = 0;

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
async function acquireDirectoryLock(extensionDir) {
  const root = runtimeRoot(extensionDir);
  await fs.mkdir(root, { recursive: true });
  const lockDir = path.join(root, LOCK_DIRECTORY);
  const token = crypto.randomBytes(16).toString('hex');
  const startedAt = Date.now();
  const deadline = startedAt + LOCK_TIMEOUT_MS;

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
      if (errorCode(error) !== 'EEXIST') throw error;
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

async function hashFile(filePath) {
  const contents = await fs.readFile(filePath);
  return {
    sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    size: contents.length,
  };
}

async function collectFileRecords(rootDir) {
  const root = path.resolve(rootDir);
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory()) throw new Error(`Runtime output is not a directory: ${rootDir}`);
  const records = [];

  async function visit(directory, relativeDirectory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      const normalized = normalizeFileRecordPath(relative);
      const absolute = safeChildPath(root, normalized, 'runtime output path');
      const info = await fs.lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(`Runtime output may not contain symlinks: ${normalized}`);
      }
      if (info.isDirectory()) {
        await visit(absolute, normalized);
      } else if (info.isFile()) {
        const digest = await hashFile(absolute);
        records.push({ path: normalized, sha256: digest.sha256, size: digest.size });
      } else {
        throw new Error(`Unsupported runtime output entry: ${normalized}`);
      }
    }
  }

  await visit(root, '');
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

  async function visit(sourceDirectory, destinationDirectory) {
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      const info = await fs.lstat(sourcePath);
      if (info.isSymbolicLink()) throw new Error(`Runtime source may not contain symlinks: ${entry.name}`);
      if (info.isDirectory()) {
        await fs.mkdir(destinationPath, { recursive: true });
        await visit(sourcePath, destinationPath);
      } else if (info.isFile()) {
        await fs.copyFile(sourcePath, destinationPath);
      } else {
        throw new Error(`Unsupported runtime source entry: ${entry.name}`);
      }
    }
  }

  await visit(source, destinationDir);
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

async function snapshotSource(sourceOutDir) {
  const records = await collectFileRecords(sourceOutDir);
  const buildIds = await verifyOutputShape(sourceOutDir);
  if (!records.some((record) => record.path === 'extension.js')) {
    throw new Error('Runtime output is missing extension.js.');
  }
  return {
    records,
    generation: hashRecords(records),
    buildId: buildIds.buildId,
    rendererBuildId: buildIds.rendererBuildId,
  };
}

function runtimeManifestFor({ identity, generation, buildId, rendererBuildId, records }) {
  return {
    schema: RUNTIME_SCHEMA,
    identity,
    generation,
    buildId,
    rendererBuildId,
    files: records.map((record) => ({ ...record })),
  };
}

function validateRuntimeManifest(manifest, generation, identity) {
  if (!isPlainObject(manifest) || manifest.schema !== RUNTIME_SCHEMA) {
    throw new Error('Invalid Pie runtime manifest.');
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
  for (const rawRecord of manifest.files) {
    if (!isPlainObject(rawRecord)) throw new Error('Invalid Pie runtime manifest file record.');
    const filePath = normalizeFileRecordPath(rawRecord.path);
    if (seen.has(filePath)) throw new Error(`Duplicate Pie runtime manifest file: ${filePath}`);
    seen.add(filePath);
    if (!SHA256_PATTERN.test(rawRecord.sha256)) throw new Error(`Invalid SHA256 for runtime file: ${filePath}`);
    if (!Number.isSafeInteger(rawRecord.size) || rawRecord.size < 0) throw new Error(`Invalid size for runtime file: ${filePath}`);
    records.push({ path: filePath, sha256: rawRecord.sha256, size: rawRecord.size });
  }
  records.sort((left, right) => left.path.localeCompare(right.path));
  for (const required of REQUIRED_RUNTIME_FILES) {
    if (!seen.has(required)) throw new Error(`Runtime manifest is missing ${required}.`);
  }
  return { records, buildId, rendererBuildId };
}

async function verifyStoredGeneration(generationDir, generation, identity) {
  assertGeneration(generation);
  const manifest = await readJson(path.join(generationDir, RUNTIME_MANIFEST_FILE));
  const validated = validateRuntimeManifest(manifest, generation, identity);
  const outDir = path.join(generationDir, 'out');
  const actualRecords = await collectFileRecords(outDir);
  const actualByPath = recordsByPath(actualRecords);
  if (actualByPath.size !== validated.records.length) {
    throw new Error('Pie runtime output does not match its manifest file set.');
  }

  for (const expected of validated.records) {
    const actual = actualByPath.get(expected.path);
    if (!actual || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new Error(`Pie runtime file checksum mismatch: ${expected.path}`);
    }
  }

  const actualGeneration = hashRecords(actualRecords);
  if (actualGeneration !== generation) throw new Error('Pie runtime content hash mismatch.');
  const buildIds = await verifyOutputShape(outDir);
  if (buildIds.buildId !== validated.buildId || buildIds.rendererBuildId !== validated.rendererBuildId) {
    throw new Error('Pie runtime build identity does not match its manifest.');
  }
  return {
    generation,
    outDir,
    buildId: buildIds.buildId,
    rendererBuildId: buildIds.rendererBuildId,
  };
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

async function listSelectionRecords(root, identity, { allowMissing = true } = {}) {
  const selectionsDir = path.join(root, SELECTIONS_DIRECTORY);
  let entries;
  try {
    entries = await fs.readdir(selectionsDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT' && allowMissing) return [];
    throw error;
  }

  const records = [];
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
      const generationDir = path.join(root, GENERATIONS_DIRECTORY, marker.generation);
      const verified = await verifyStoredGeneration(generationDir, marker.generation, identity);
      records.push({
        name: markerName,
        generation: marker.generation,
        outDir: verified.outDir,
        publishedAt: marker.publishedAt,
      });
    } catch {
      // A torn marker or damaged newest generation is deliberately skipped;
      // resolution continues with the next complete marker.
    }
  }

  records.sort((left, right) => right.publishedAt - left.publishedAt || right.name.localeCompare(left.name));
  return records;
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

async function cleanupRuntime(root, identity) {
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

  const records = await listSelectionRecords(root, identity, { allowMissing: false });
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

async function resolveRuntimeGenerationUnlocked(extensionDir, identity) {
  const root = runtimeRoot(extensionDir);
  const records = await listSelectionRecords(root, identity);
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
  const sourceSnapshot = await snapshotSource(sourceOutDir);
  const releaseLock = await acquireDirectoryLock(extensionDir);
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
      await verifyStoredGeneration(generationDir, generation, normalizedIdentity);
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
      await copyTree(sourceOutDir, path.join(stagingDir, 'out'));

      const stagedRecords = await collectFileRecords(path.join(stagingDir, 'out'));
      if (hashRecords(stagedRecords) !== generation) {
        throw new Error('Runtime source changed while it was being staged.');
      }
      const stagedBuildIds = await verifyOutputShape(path.join(stagingDir, 'out'));
      await fs.writeFile(
        path.join(stagingDir, RUNTIME_MANIFEST_FILE),
        `${JSON.stringify(runtimeManifestFor({
          identity: normalizedIdentity,
          generation,
          buildId: stagedBuildIds.buildId,
          rendererBuildId: stagedBuildIds.rendererBuildId,
          records: stagedRecords,
        }), null, 2)}\n`,
        { flag: 'wx' },
      );
      await verifyStoredGeneration(stagingDir, generation, normalizedIdentity);

      try {
        await fs.rename(stagingDir, generationDir);
        stagingDir = undefined;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(errorCode(error))) throw error;
        // Another publisher cannot normally win while this lock is held, but
        // never overwrite a directory if an external process did so anyway.
        await verifyStoredGeneration(generationDir, generation, normalizedIdentity);
      }
    }

    const previousSelections = await listSelectionRecords(root, normalizedIdentity, { allowMissing: false });
    const publishedAt = Math.max(Date.now(), (previousSelections[0]?.publishedAt ?? -1) + 1);
    await beforeSelect?.({ generation, outDir, publishedAt });

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

    try {
      await cleanupRuntime(root, normalizedIdentity);
    } catch (error) {
      // Selection is already durable. Retention is best effort so a transient
      // filesystem failure cannot turn a complete publication into a failure.
      console.warn(`[pie-runtime] retention cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { generation, outDir, publishedAt };
  } finally {
    if (stagingDir) await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    await releaseLock();
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
  const normalizedIdentity = assertIdentity(identity);
  const releaseLock = await acquireDirectoryLock(extensionDir);
  const root = runtimeRoot(extensionDir);
  let leasePath;
  let resolved;
  try {
    await Promise.all([
      fs.mkdir(path.join(root, GENERATIONS_DIRECTORY), { recursive: true }),
      fs.mkdir(path.join(root, SELECTIONS_DIRECTORY), { recursive: true }),
      fs.mkdir(path.join(root, LEASES_DIRECTORY), { recursive: true }),
    ]);
    resolved = await resolveRuntimeGenerationUnlocked(extensionDir, normalizedIdentity);
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
    await cleanupRuntime(root, normalizedIdentity);
  } catch (error) {
    if (leasePath) await fs.rm(leasePath, { force: true }).catch(() => undefined);
    await releaseLock();
    throw error;
  }
  await releaseLock();

  let released = false;
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
}

module.exports = {
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
