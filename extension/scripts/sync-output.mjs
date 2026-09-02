import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

export function isActiveDirectoryLockError(error, platform = process.platform) {
  return platform === 'win32'
    && error
    && typeof error === 'object'
    && 'code' in error
    && ['EACCES', 'EBUSY', 'EPERM'].includes(error.code);
}

function entriesHaveSameKind(sourceEntry, destinationEntry) {
  return sourceEntry.isDirectory() === destinationEntry.isDirectory();
}

async function prepareDestinationEntryTypes(sourceDir, destinationDir) {
  const [sourceEntries, destinationEntries] = await Promise.all([
    readdir(sourceDir, { withFileTypes: true }),
    readdir(destinationDir, { withFileTypes: true }),
  ]);
  const destinationByName = new Map(destinationEntries.map((entry) => [entry.name, entry]));

  await Promise.all(sourceEntries.map(async (sourceEntry) => {
    const destinationEntry = destinationByName.get(sourceEntry.name);
    if (!destinationEntry) return;

    const destinationPath = path.join(destinationDir, sourceEntry.name);
    if (!entriesHaveSameKind(sourceEntry, destinationEntry)) {
      await rm(destinationPath, { recursive: true, force: true });
      return;
    }
    if (sourceEntry.isDirectory()) {
      await prepareDestinationEntryTypes(path.join(sourceDir, sourceEntry.name), destinationPath);
    }
  }));
}

async function removeDestinationEntriesMissingFromSource(sourceDir, destinationDir) {
  const [sourceEntries, destinationEntries] = await Promise.all([
    readdir(sourceDir, { withFileTypes: true }),
    readdir(destinationDir, { withFileTypes: true }),
  ]);
  const sourceByName = new Map(sourceEntries.map((entry) => [entry.name, entry]));

  await Promise.all(destinationEntries.map(async (destinationEntry) => {
    const sourceEntry = sourceByName.get(destinationEntry.name);
    const destinationPath = path.join(destinationDir, destinationEntry.name);
    if (!sourceEntry) {
      await rm(destinationPath, { recursive: true, force: true });
      return;
    }
    if (sourceEntry.isDirectory() && destinationEntry.isDirectory()) {
      await removeDestinationEntriesMissingFromSource(path.join(sourceDir, sourceEntry.name), destinationPath);
    }
  }));
}

export async function mirrorDirectoryInPlace(sourceDir, destinationDir) {
  await mkdir(destinationDir, { recursive: true });
  await prepareDestinationEntryTypes(sourceDir, destinationDir);
  await cp(sourceDir, destinationDir, { recursive: true, force: true });
  await removeDestinationEntriesMissingFromSource(sourceDir, destinationDir);
}

export async function syncActiveDestinationInPlace({ staging, dest, backup, verify, warn = console.warn }) {
  warn('[build] Installed output is active; syncing files in place instead of replacing the directory.');
  await rm(backup, { recursive: true, force: true });

  let backupReady = false;
  let preserveBackup = false;
  try {
    await cp(dest, backup, { recursive: true, force: true });
    await verify(backup);
    backupReady = true;

    await mirrorDirectoryInPlace(staging, dest);
    await verify(dest);
  } catch (syncError) {
    if (!backupReady) throw syncError;

    try {
      await mirrorDirectoryInPlace(backup, dest);
      await verify(dest);
    } catch (rollbackError) {
      preserveBackup = true;
      throw new AggregateError(
        [syncError, rollbackError],
        `Installed output sync failed and its rollback also failed; recovery snapshot retained at ${backup}.`,
      );
    }
    throw syncError;
  } finally {
    const cleanup = async (target, label) => {
      try {
        await rm(target, { recursive: true, force: true });
      } catch (error) {
        warn(`[build] Could not remove ${label} ${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await cleanup(staging, 'sync staging directory');
    if (preserveBackup) {
      warn(`[build] Retained recovery snapshot after failed rollback: ${backup}`);
    } else {
      await cleanup(backup, 'sync backup directory');
    }
  }
}
