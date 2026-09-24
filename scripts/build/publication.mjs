import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

export const PUBLISHED_GENERATIONS_DIR = 'pie-generations';
export const PUBLISHED_SELECTIONS_DIR = 'selections';
export const RETAINED_RENDERER_GENERATIONS = 2;

const ACTIVATION_RETRY_GUIDANCE = 'Close all Pie-using VS Code windows first (finished sessions/chat tabs are insufficient for Windows locks), then from an external terminal at the repository root run `npm run extension:activate` and retry.';

let selectionCounter = 0;

async function acquirePublicationLock(extensionDir) {
  const lockDir = path.join(extensionDir, '.pie-publication-lock');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lockDir);
      await writeFile(path.join(lockDir, 'owner.json'), `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
      try {
        const owner = await readJson(path.join(lockDir, 'owner.json'));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('invalid lock owner');
        try {
          process.kill(owner.pid, 0);
        } catch (livenessError) {
          if (livenessError && typeof livenessError === 'object' && 'code' in livenessError && livenessError.code === 'ESRCH') {
            await rm(lockDir, { recursive: true, force: true });
            continue;
          }
          throw livenessError;
        }
      } catch (readError) {
        if (readError && typeof readError === 'object' && 'code' in readError && readError.code !== 'ENOENT') {
          throw new Error(`Cannot verify the existing Pie publication lock at ${lockDir}.`, { cause: readError });
        }
        try {
          const lockStat = await stat(lockDir);
          if (Date.now() - lockStat.mtimeMs > 1_000) {
            await rm(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (!(statError && typeof statError === 'object' && 'code' in statError && statError.code === 'ENOENT')) {
            throw new Error(`Cannot inspect the Pie publication lock at ${lockDir}.`, { cause: statError });
          }
        }
        // The winning publisher may be between mkdir and its tiny owner write.
        // Retry malformed/missing fresh metadata; a crashed stale shell is
        // removed above.
        await delay(25);
        continue;
      }
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for the Pie publication lock at ${lockDir}.`);
}

function extensionIdentity(pkg) {
  return `${pkg.publisher}.${pkg.name}`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function manifestMatches(workspacePkg, installedPkg) {
  return installedPkg
    && installedPkg.publisher === workspacePkg.publisher
    && installedPkg.name === workspacePkg.name
    && installedPkg.version === workspacePkg.version;
}

export async function writeFileIfChanged(filePath, contents) {
  try {
    const existing = await readFile(filePath, 'utf8');
    if (existing === contents) return false;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await writeFile(filePath, contents);
  return true;
}

async function listTopLevelNodeBundles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return {
      names: entries
        .map((entry) => entry.name)
        .filter((name) => name.endsWith('.js'))
        .sort(),
      error: null,
    };
  } catch (error) {
    return {
      names: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readNodeBundleContents(directory, names, readBundleFile) {
  const contents = new Map();
  const unreadable = [];
  await Promise.all(names.map(async (name) => {
    try {
      const value = await readBundleFile(path.join(directory, name));
      contents.set(name, Buffer.from(value));
    } catch {
      unreadable.push(name);
    }
  }));
  unreadable.sort();
  return { contents, unreadable };
}

/**
 * Compare the flat top-level Node output emitted by Vite with the installed
 * output. This deliberately reads bundle bytes rather than trusting the
 * coordinated build identity, which also includes renderer inputs and does
 * not cover every shared Node input. The comparison is read-only.
 */
export async function compareNodeBundles({
  builtOutDir,
  installedOutDir,
  readFile: readBundleFile = readFile,
}) {
  const [builtListing, installedListing] = await Promise.all([
    listTopLevelNodeBundles(builtOutDir),
    listTopLevelNodeBundles(installedOutDir),
  ]);
  const [builtRead, installedRead] = await Promise.all([
    readNodeBundleContents(builtOutDir, builtListing.names, readBundleFile),
    readNodeBundleContents(installedOutDir, installedListing.names, readBundleFile),
  ]);

  const installedNames = new Set(installedListing.names);
  const builtNames = new Set(builtListing.names);
  const missingInstalled = builtListing.names.filter((name) => !installedNames.has(name));
  const extraInstalled = installedListing.names.filter((name) => !builtNames.has(name));
  const mismatched = builtListing.names.filter((name) => {
    const built = builtRead.contents.get(name);
    const installed = installedRead.contents.get(name);
    return built && installed && !built.equals(installed);
  });

  return {
    builtFiles: builtListing.names,
    installedFiles: installedListing.names,
    missingInstalled,
    extraInstalled,
    mismatched,
    unreadableBuilt: builtRead.unreadable,
    unreadableInstalled: installedRead.unreadable,
    builtDirectoryError: builtListing.error,
    installedDirectoryError: installedListing.error,
    current: builtListing.error === null
      && installedListing.error === null
      && builtListing.names.length > 0
      && builtRead.unreadable.length === 0
      && installedRead.unreadable.length === 0
      && missingInstalled.length === 0
      && extraInstalled.length === 0
      && mismatched.length === 0,
  };
}

function formatBundleNames(names) {
  if (names.length === 0) return '(none)';
  const preview = names.slice(0, 6).join(', ');
  return names.length > 6 ? `${preview}, … (${names.length} files)` : preview;
}

/**
 * Format a bounded, on-disk-only host status. It never implies that VS Code
 * has loaded the installed files.
 */
export function formatNodeBundleStatus({ status, builtOutDir, installedOutDir }) {
  const lines = [
    '[build] Host/backend status (top-level Node .js bundles on disk; running code not verified):',
    `  built: ${status.builtFiles.length} bundles in ${builtOutDir}`,
    `  installed: ${status.installedFiles.length} bundles in ${installedOutDir}`,
  ];
  if (status.builtDirectoryError) lines.push(`  built directory unreadable: ${status.builtDirectoryError}`);
  if (status.installedDirectoryError) lines.push(`  installed directory unreadable: ${status.installedDirectoryError}`);
  if (status.unreadableBuilt.length > 0) lines.push(`  unreadable built files: ${formatBundleNames(status.unreadableBuilt)}`);
  if (status.unreadableInstalled.length > 0) lines.push(`  unreadable installed files: ${formatBundleNames(status.unreadableInstalled)}`);

  if (status.current) {
    lines.push('[build] Host/backend bundles match installed files on disk. This is not proof that the matching code is running.');
  } else {
    if (status.missingInstalled.length > 0) lines.push(`  missing from installed: ${formatBundleNames(status.missingInstalled)}`);
    if (status.extraInstalled.length > 0) lines.push(`  installed-only files: ${formatBundleNames(status.extraInstalled)}`);
    if (status.mismatched.length > 0) lines.push(`  different contents: ${formatBundleNames(status.mismatched)}`);
    const unknown = status.builtDirectoryError || status.installedDirectoryError
      || status.unreadableBuilt.length > 0 || status.unreadableInstalled.length > 0
      || status.builtFiles.length === 0;
    lines.push(unknown
      ? '[build] HOST INSTALL STATUS UNKNOWN: could not verify the installed host/backend bundles.'
      : '[build] HOST INSTALL PENDING: host/backend changes are NOT installed.');
    lines.push('[build] Restarting or rebooting alone will not install host changes. After running work finishes, close all Pie-using VS Code windows (finished sessions/chat tabs are insufficient for Windows locks), then run `npm run extension:activate` from an external terminal at the repository root.');
  }
  return lines.join('\n');
}

/**
 * Select only an installed directory whose folder and manifest both identify
 * this exact workspace extension version. Publication must never "repair" a
 * prefix match by rewriting its manifest.
 */
export async function findCompatibleInstalledExtensionDir(extensionRoots, pkg) {
  const id = extensionIdentity(pkg);
  const allowedFolderNames = new Set([id, `${id}-${pkg.version}`]);
  for (const extensionRoot of extensionRoots) {
    let entries;
    try {
      entries = await readdir(extensionRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !allowedFolderNames.has(entry.name)) continue;
      const candidate = path.join(extensionRoot, entry.name);
      try {
        const installedPkg = await readJson(path.join(candidate, 'package.json'));
        if (manifestMatches(pkg, installedPkg)) return candidate;
      } catch {
        // An unreadable/malformed manifest is not a compatible installation.
      }
    }
  }
  return null;
}

function assertSafeGeneration(generation) {
  if (!/^[0-9a-f]{20}$/u.test(generation)) {
    throw new Error(`Invalid Pie renderer generation: ${generation}`);
  }
}

async function collectManifestFiles(sourceDir) {
  const manifest = await readJson(path.join(sourceDir, '.vite', 'manifest.json'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Invalid Vite manifest at ${path.join(sourceDir, '.vite', 'manifest.json')}`);
  }
  const files = new Set();
  let entryCount = 0;
  for (const [chunkName, chunk] of Object.entries(manifest)) {
    if (!chunk || typeof chunk !== 'object' || typeof chunk.file !== 'string' || chunk.file.length === 0) {
      throw new Error(`Invalid Vite manifest chunk: ${chunkName}`);
    }
    if (chunk.isEntry === true) entryCount += 1;
    files.add(chunk.file);
    for (const field of ['css', 'assets']) {
      const values = chunk[field] ?? [];
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length === 0)) {
        throw new Error(`Invalid Vite manifest ${field} list: ${chunkName}`);
      }
      for (const relativePath of values) files.add(relativePath);
    }
    for (const field of ['imports', 'dynamicImports']) {
      const references = chunk[field] ?? [];
      if (!Array.isArray(references) || references.some((value) => typeof value !== 'string' || !manifest[value])) {
        throw new Error(`Invalid Vite manifest ${field} reference: ${chunkName}`);
      }
    }
  }
  if (entryCount !== 1) {
    throw new Error(`Expected one Vite entry chunk in ${path.join(sourceDir, '.vite', 'manifest.json')}`);
  }
  return files;
}

export async function verifyRendererGeneration(directory, expectedGeneration) {
  assertSafeGeneration(expectedGeneration);
  const actualGeneration = (await readFile(path.join(directory, 'pie-build-id.txt'), 'utf8')).trim();
  if (actualGeneration !== expectedGeneration) {
    throw new Error(`Renderer generation mismatch (${actualGeneration} != ${expectedGeneration}).`);
  }
  const files = await collectManifestFiles(directory);
  const base = `${path.resolve(directory)}${path.sep}`;
  await Promise.all([...files].map((relativePath) => {
    const absolute = path.resolve(directory, relativePath);
    if (!absolute.startsWith(base)) throw new Error(`Renderer manifest path escapes its generation: ${relativePath}`);
    return stat(absolute);
  }));

  // Vite does not list ?worker&url output in its manifest. Verify the strict
  // hashed worker literals emitted by trusted JavaScript chunks as well.
  const javascriptFiles = [...files].filter((relativePath) => relativePath.endsWith('.js'));
  for (const relativePath of javascriptFiles) {
    const source = await readFile(path.resolve(directory, relativePath), 'utf8');
    const workerPattern = /["']\/assets\/([A-Za-z0-9_-]+-worker-[A-Za-z0-9_-]+\.js)["']/gu;
    for (const match of source.matchAll(workerPattern)) {
      await stat(path.join(directory, 'assets', match[1]));
    }
  }
}

function selectionName(generation, now, pid) {
  selectionCounter = (selectionCounter + 1) % 1_000_000;
  return `${String(now).padStart(13, '0')}-${String(pid).padStart(10, '0')}-${String(selectionCounter).padStart(6, '0')}-${generation}.json`;
}

async function listSelectionRecords(panelDir) {
  const selectionsDir = path.join(panelDir, PUBLISHED_GENERATIONS_DIR, PUBLISHED_SELECTIONS_DIR);
  let names;
  try {
    names = await readdir(selectionsDir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names.sort().reverse()) {
    if (!name.endsWith('.json') || name.startsWith('.pie-staging-')) continue;
    try {
      const record = await readJson(path.join(selectionsDir, name));
      if (!record || typeof record.generation !== 'string') continue;
      assertSafeGeneration(record.generation);
      const generationDir = path.join(panelDir, PUBLISHED_GENERATIONS_DIR, record.generation);
      await verifyRendererGeneration(generationDir, record.generation);
      records.push({ name, generation: record.generation, generationDir });
    } catch {
      // A torn/invalid newest marker is ignored so the prior generation stays usable.
    }
  }
  return records;
}

/** Resolve the newest complete publication, falling back to the packaged flat bundle. */
export async function resolvePublishedRendererGeneration(panelDir) {
  const records = await listSelectionRecords(panelDir);
  if (records[0]) return records[0];
  return { name: null, generation: null, generationDir: panelDir };
}

async function cleanupOldRendererGenerations(panelDir, warn) {
  const publicationRoot = path.join(panelDir, PUBLISHED_GENERATIONS_DIR);
  const selectionsDir = path.join(publicationRoot, PUBLISHED_SELECTIONS_DIR);
  const records = await listSelectionRecords(panelDir);
  const retainedGenerations = [];
  const retainedMarkers = new Set();
  for (const record of records) {
    if (retainedGenerations.includes(record.generation)) continue;
    retainedGenerations.push(record.generation);
    retainedMarkers.add(record.name);
    if (retainedGenerations.length >= RETAINED_RENDERER_GENERATIONS) break;
  }
  const retained = new Set(retainedGenerations);
  try {
    for (const name of await readdir(selectionsDir)) {
      if (!retainedMarkers.has(name)) await rm(path.join(selectionsDir, name), { force: true });
    }
    for (const entry of await readdir(publicationRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === PUBLISHED_SELECTIONS_DIR || retained.has(entry.name)) continue;
      await rm(path.join(publicationRoot, entry.name), { recursive: true, force: true });
    }
  } catch (error) {
    warn(`[build] Renderer retention cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Publish one immutable renderer generation, then select it by atomically
 * creating a new append-only marker. No host/backend file or package manifest
 * is touched. `beforeSelect` is a deterministic failure seam for acceptance.
 */
export async function publishRendererGeneration({
  sourceDir,
  extensionDir,
  now = Date.now(),
  pid = process.pid,
  beforeSelect,
  warn = console.warn,
}) {
  const generation = (await readFile(path.join(sourceDir, 'pie-build-id.txt'), 'utf8')).trim();
  assertSafeGeneration(generation);
  await verifyRendererGeneration(sourceDir, generation);
  const releaseLock = await acquirePublicationLock(extensionDir);

  const panelDir = path.join(extensionDir, 'out', 'webview', 'panel');
  const publicationRoot = path.join(panelDir, PUBLISHED_GENERATIONS_DIR);
  const selectionsDir = path.join(publicationRoot, PUBLISHED_SELECTIONS_DIR);
  const generationDir = path.join(publicationRoot, generation);
  const staging = path.join(publicationRoot, `.pie-staging-${pid}-${selectionCounter + 1}-${generation}`);

  try {
    await mkdir(selectionsDir, { recursive: true });
    await rm(staging, { recursive: true, force: true });
    try {
      await verifyRendererGeneration(generationDir, generation);
    } catch {
      await cp(sourceDir, staging, { recursive: true, force: true });
      await verifyRendererGeneration(staging, generation);
      try {
        await rename(staging, generationDir);
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && ['EEXIST', 'ENOTEMPTY'].includes(error.code))) throw error;
        await verifyRendererGeneration(generationDir, generation);
      }
    }

    await beforeSelect?.({ generation, generationDir });

    const markerName = selectionName(generation, now, pid);
    const markerPath = path.join(selectionsDir, markerName);
    const markerStaging = path.join(selectionsDir, `.pie-staging-${markerName}`);
    await writeFile(markerStaging, `${JSON.stringify({ generation, publishedAt: now })}\n`, { flag: 'wx' });
    await rename(markerStaging, markerPath);

    await cleanupOldRendererGenerations(panelDir, warn);
    return { generation, generationDir, markerPath };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await releaseLock();
  }
}

/**
 * Explicit host/backend activation. It uses directory replacement only: a
 * locked active destination fails instead of degrading to mixed in-place files.
 */
export async function activateInstalledOutput({ sourceOutDir, extensionDir, verify }) {
  const releaseLock = await acquirePublicationLock(extensionDir);
  const dest = path.join(extensionDir, 'out');
  const staging = `${dest}.pie-activation-staging-${process.pid}`;
  const backup = `${dest}.pie-activation-backup-${process.pid}`;
  try {
    await Promise.all([
      rm(staging, { recursive: true, force: true }),
      rm(backup, { recursive: true, force: true }),
    ]);
    await cp(sourceOutDir, staging, { recursive: true, force: true });
    await verify(staging);

    let movedExisting = false;
    try {
      try {
        await rename(dest, backup);
        movedExisting = true;
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      await rename(staging, dest);
      await verify(dest);
    } catch (error) {
      if (movedExisting) {
        try {
          await rm(dest, { recursive: true, force: true });
          await rename(backup, dest);
          await verify(dest);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Pie host/backend activation failed and rollback could not restore the prior output. Recovery copy retained at ${backup}. ${ACTIVATION_RETRY_GUIDANCE}`,
          );
        }
      }
      throw new Error(
        `Pie host/backend activation failed without using an in-place fallback. ${ACTIVATION_RETRY_GUIDANCE} ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await releaseLock();
  }
}
