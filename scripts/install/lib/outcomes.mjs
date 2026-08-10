import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { mergeLegacySessions } from './sessions.mjs';

export const OUTCOMES_MIGRATION_SOURCES_FILE = 'outcomes-migration-sources.json';

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      try { return { raw, value: JSON.parse(raw) }; }
      catch { return { raw, value: null }; }
    });
}

function appendJsonLines(filePath, lines) {
  if (lines.length === 0) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function reviewKey(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 2) return null;
  if (value.kind === 'production' && typeof value.sessionId === 'string' && value.sessionId) {
    return `production:${value.sessionId}`;
  }
  if (value.kind === 'calibration' && typeof value.reviewId === 'string' && value.reviewId) {
    return `calibration:${value.reviewId}`;
  }
  return null;
}

function mergeReviews(sourceFile, destinationFile, conflictsFile) {
  const destination = readJsonLines(destinationFile);
  const destinationLines = new Set(destination.map((entry) => entry.raw));
  const canonical = new Map();
  for (const entry of destination) {
    const key = reviewKey(entry.value);
    if (key && !canonical.has(key)) canonical.set(key, entry.raw);
  }

  const appended = [];
  const existingConflicts = new Set(readJsonLines(conflictsFile).map((entry) => entry.raw));
  const conflicts = [];
  let conflictCount = 0;
  let identical = 0;
  let invalid = 0;
  for (const entry of readJsonLines(sourceFile)) {
    const key = reviewKey(entry.value);
    if (!key) {
      invalid += 1;
      continue;
    }
    const existing = canonical.get(key);
    if (existing === undefined) {
      canonical.set(key, entry.raw);
      destinationLines.add(entry.raw);
      appended.push(entry.raw);
    } else if (destinationLines.has(entry.raw)) {
      identical += 1;
    } else {
      conflictCount += 1;
      const conflict = JSON.stringify({
        sourceFile,
        reason: 'canonical_review_key_conflict',
        key,
        record: entry.value,
      });
      if (!existingConflicts.has(conflict)) {
        // Append the incoming candidate after the existing record as a fallback.
        // Every consumer selects the first *valid* production review, so this
        // rescues a valid review when a malformed earlier envelope reused its
        // sessionId without replacing an already-valid canonical review.
        destinationLines.add(entry.raw);
        appended.push(entry.raw);
        existingConflicts.add(conflict);
        conflicts.push(conflict);
      }
    }
  }

  appendJsonLines(destinationFile, appended);
  appendJsonLines(conflictsFile, conflicts);
  return { appended: appended.length, identical, conflicts: conflictCount, quarantined: conflicts.length, invalid };
}

function mergeClosureActions(sourceFile, destinationFile) {
  const existing = new Set(readJsonLines(destinationFile).map((entry) => entry.raw));
  const appended = [];
  let identical = 0;
  for (const entry of readJsonLines(sourceFile)) {
    if (!entry.value) continue;
    if (existing.has(entry.raw)) {
      identical += 1;
      continue;
    }
    existing.add(entry.raw);
    appended.push(entry.raw);
  }
  appendJsonLines(destinationFile, appended);
  return { appended: appended.length, identical };
}

function runId(entry) {
  const value = entry?.value;
  return value && typeof value === 'object'
    && value.kind === 'run_snapshot'
    && value.run && typeof value.run === 'object'
    && typeof value.run.runId === 'string'
    ? value.run.runId
    : null;
}

function runRecency(entry) {
  const run = entry?.value?.run;
  for (const candidate of [run?.finalizedAt, run?.updatedAt, entry?.value?.recordedAt, run?.startedAt]) {
    const parsed = typeof candidate === 'string' ? Date.parse(candidate) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function mergeRunSnapshots(sourceFile, destinationFile) {
  const latest = new Map();
  for (const entry of readJsonLines(destinationFile)) {
    const id = runId(entry);
    if (id) latest.set(id, entry);
  }

  const appended = [];
  let identical = 0;
  let older = 0;
  let invalid = 0;
  for (const entry of readJsonLines(sourceFile)) {
    const id = runId(entry);
    if (!id) {
      invalid += 1;
      continue;
    }
    const existing = latest.get(id);
    if (!existing) {
      latest.set(id, entry);
      appended.push(entry.raw);
    } else if (existing.raw === entry.raw) {
      identical += 1;
    } else if (runRecency(entry) > runRecency(existing)) {
      latest.set(id, entry);
      appended.push(entry.raw);
    } else {
      older += 1;
    }
  }
  appendJsonLines(destinationFile, appended);
  return { appended: appended.length, identical, older, invalid };
}

function readMigrationRegistry(destinationRoot) {
  const file = path.join(destinationRoot, 'migration-conflicts', OUTCOMES_MIGRATION_SOURCES_FILE);
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.sources)) return [];
    return value.sources.filter((source) => source
      && typeof source.sourceRoot === 'string'
      && (typeof source.scanStartedAt === 'string' || typeof source.lastMigratedAt === 'string'));
  } catch {
    return [];
  }
}

/** Registered displaced authorities are bounded migration receipts, not roots
 * for normal runtime scanning. Doctor uses them to detect a producer that kept
 * writing after its one-time migration. */
export function readRegisteredOutcomeSources(destinationOutcomesRoot) {
  const destinationRoot = path.resolve(destinationOutcomesRoot);
  const registered = readMigrationRegistry(destinationRoot);
  if (registered.length > 0) return registered;

  // Backward compatibility for migrations performed before the source registry
  // existed: retain the last receipt as the first registered source.
  try {
    const receipt = JSON.parse(readFileSync(path.join(destinationRoot, 'migration-conflicts', 'last-outcomes-migration.json'), 'utf8'));
    return typeof receipt?.sourceRoot === 'string' && typeof receipt?.migratedAt === 'string'
      ? [{
        sourceRoot: receipt.sourceRoot,
        scanStartedAt: typeof receipt.migrationStartedAt === 'string' ? receipt.migrationStartedAt : receipt.migratedAt,
        lastMigratedAt: receipt.migratedAt,
      }]
      : [];
  } catch {
    return [];
  }
}

function registerMigrationSource(conflictDir, sourceRoot, scanStartedAt, migratedAt) {
  const destinationRoot = path.dirname(conflictDir);
  // Seed from the public compatibility reader so the first registry write
  // preserves a pre-registry source recorded only in the legacy receipt.
  const sources = readRegisteredOutcomeSources(destinationRoot);
  const sourceKey = normalizedPath(sourceRoot);
  const next = sources.filter((source) => normalizedPath(source.sourceRoot) !== sourceKey);
  next.push({ sourceRoot, scanStartedAt, lastMigratedAt: migratedAt });
  next.sort((left, right) => normalizedPath(left.sourceRoot).localeCompare(normalizedPath(right.sourceRoot)));
  writeFileSync(
    path.join(conflictDir, OUTCOMES_MIGRATION_SOURCES_FILE),
    `${JSON.stringify({ schemaVersion: 1, sources: next }, null, 2)}\n`,
    'utf8',
  );
}

/** Merge one displaced machine-local outcomes authority into the canonical one.
 * Open-run checkpoints and derived exports are intentionally not copied: only
 * durable completed snapshots, transcripts, reviews, and closure events move. */
export function mergeOutcomesStore({ sourceOutcomesRoot, destinationOutcomesRoot }) {
  const sourceRoot = path.resolve(sourceOutcomesRoot);
  const destinationRoot = path.resolve(destinationOutcomesRoot);
  if (normalizedPath(sourceRoot) === normalizedPath(destinationRoot) || !existsSync(sourceRoot)) {
    return { skipped: true, sourceRoot, destinationRoot };
  }

  // Drift detection uses the scan start, not completion, as its baseline. A
  // producer write racing any part of this merge is therefore conservatively
  // reported and reconciled by the next idempotent pass rather than missed.
  const migrationStartedAt = new Date().toISOString();
  mkdirSync(destinationRoot, { recursive: true });
  const sessions = mergeLegacySessions({
    sources: [{ path: path.join(sourceRoot, 'sessions'), recursive: true }],
    destination: path.join(destinationRoot, 'sessions'),
  }).totals;

  const conflictDir = path.join(destinationRoot, 'migration-conflicts');
  const reviews = mergeReviews(
    path.join(sourceRoot, 'session-reviews', 'reviews.jsonl'),
    path.join(destinationRoot, 'session-reviews', 'reviews.jsonl'),
    path.join(conflictDir, 'reviews.jsonl'),
  );
  const closureActions = mergeClosureActions(
    path.join(sourceRoot, 'session-reviews', 'closure-actions.jsonl'),
    path.join(destinationRoot, 'session-reviews', 'closure-actions.jsonl'),
  );

  const runStores = [];
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{16}$/i.test(entry.name)) continue;
    const sourceFile = path.join(sourceRoot, entry.name, 'run-snapshots.jsonl');
    if (!existsSync(sourceFile)) continue;
    const destinationFile = path.join(destinationRoot, entry.name, 'run-snapshots.jsonl');
    runStores.push({ workspaceKey: entry.name, ...mergeRunSnapshots(sourceFile, destinationFile) });
  }

  // Leave a small durable receipt without embedding review/session content.
  const migratedAt = new Date().toISOString();
  const receipt = {
    migrationStartedAt,
    migratedAt,
    sourceRoot,
    destinationRoot,
    sessions,
    reviews,
    closureActions,
    runStores,
  };
  mkdirSync(conflictDir, { recursive: true });
  // Register before replacing the legacy last-receipt fallback; otherwise the
  // first registry write would see only this new source and forget the prior
  // displaced authority.
  registerMigrationSource(conflictDir, sourceRoot, migrationStartedAt, migratedAt);
  writeFileSync(path.join(conflictDir, 'last-outcomes-migration.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { skipped: false, ...receipt };
}
