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

/** Merge one displaced machine-local outcomes authority into the canonical one.
 * Open-run checkpoints and derived exports are intentionally not copied: only
 * durable completed snapshots, transcripts, reviews, and closure events move. */
export function mergeOutcomesStore({ sourceOutcomesRoot, destinationOutcomesRoot }) {
  const sourceRoot = path.resolve(sourceOutcomesRoot);
  const destinationRoot = path.resolve(destinationOutcomesRoot);
  if (normalizedPath(sourceRoot) === normalizedPath(destinationRoot) || !existsSync(sourceRoot)) {
    return { skipped: true, sourceRoot, destinationRoot };
  }

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
  const receipt = {
    migratedAt: new Date().toISOString(),
    sourceRoot,
    destinationRoot,
    sessions,
    reviews,
    closureActions,
    runStores,
  };
  mkdirSync(conflictDir, { recursive: true });
  writeFileSync(path.join(conflictDir, 'last-outcomes-migration.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { skipped: false, ...receipt };
}
