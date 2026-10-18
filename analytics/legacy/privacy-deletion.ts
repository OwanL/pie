/** Deletion only: never initializes, restores, queries, or exports legacy stores. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteText } from '../../lib/temporary-files/atomic-write';
import { withFileUpdateLock } from '../../lib/temporary-files/settings-json-update';

type ObjectRecord = Record<string, unknown>;

function object(value: unknown): ObjectRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ObjectRecord
    : undefined;
}

async function readExisting(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Preserve unclassified JSONL bytes, including torn lines and line endings. */
function filterLines(raw: string, remove: (value: unknown) => boolean): string {
  return raw.replace(/[^\n]*(?:\n|$)/g, (line) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return line; }
    return remove(value) ? '' : line;
  });
}

/** Only changed, existing files acquire the shared accounting lock. Missing
 * files/directories cause no writes (not even lock or temporary files). Re-read
 * under the lock so concurrent explicit deletions cannot resurrect each other. */
async function scrubFile(
  storageDir: string,
  name: string,
  transform: (raw: string) => string,
): Promise<void> {
  const filePath = path.join(storageDir, name);
  const raw = await readExisting(filePath);
  if (raw === undefined || transform(raw) === raw) return;
  await withFileUpdateLock(path.join(storageDir, '.accounting'), async () => {
    const current = await readExisting(filePath);
    if (current === undefined) return;
    const next = transform(current);
    if (next !== current) await atomicWriteText(filePath, next);
  });
}

/** Remove only records attributed by exact session path OR stable ID from
 * preserved legacy formats. Called only at explicit private close and its
 * existing post-disposal scrub; no privacy-on-open or startup sweep. */
export async function forgetLegacyAnalyticsForStorageDirs(
  storageDirs: readonly string[],
  sessionPath: string,
  sessionId?: string,
): Promise<void> {
  if (!sessionPath) return;
  const belongs = (value: unknown): boolean => {
    const record = object(value);
    return record !== undefined && (record.sessionPath === sessionPath
      || (!!sessionId && record.sessionId === sessionId));
  };
  const sideChannelBelongs = (value: unknown): boolean => {
    const record = object(value);
    return belongs(value) || (record !== undefined && (
      record.sessionId === sessionPath
      || record.rootSessionId === sessionPath
      || (!!sessionId && record.rootSessionId === sessionId)
    ));
  };
  const filterArray = (raw: string): string => {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Legacy analytics snapshot must be an array.');
    const kept = parsed.filter((value) => !belongs(value));
    return kept.length === parsed.length ? raw : `${JSON.stringify(kept, null, 2)}\n`;
  };
  for (const storageDir of new Set(storageDirs)) {
    await scrubFile(storageDir, 'run-snapshots.jsonl', (raw) => (
      filterLines(raw, (value) => belongs(object(value)?.run))
    ));
    for (const slot of ['a', 'b']) {
      await scrubFile(storageDir, `open-runs.${slot}.json`, (raw) => {
        const parsed = object(JSON.parse(raw));
        if (!parsed) throw new Error('Legacy run checkpoint must be an object.');
        const sessions = object(parsed.sessions);
        if (!sessions) return raw;
        let changed = false;
        for (const [storedPath, state] of Object.entries(sessions)) {
          if (storedPath === sessionPath || belongs(object(state)?.currentRun) || belongs(object(state)?.lastRun)) {
            delete sessions[storedPath];
            changed = true;
          }
        }
        return changed ? `${JSON.stringify(parsed, null, 2)}\n` : raw;
      });
    }
    await scrubFile(storageDir, 'billable-invocations.jsonl', (raw) => filterLines(raw, belongs));
    await scrubFile(storageDir, 'activity-intervals.json', filterArray);
    // Full-record journal deltas and recovery reset markers must stay in order.
    await scrubFile(storageDir, 'activity-intervals.journal.jsonl', (raw) => filterLines(raw, belongs));
    // Retired privacy fences themselves contain session identifiers. Do not
    // create new fences or retain the deleted subject in an existing one.
    await scrubFile(storageDir, 'accounting-private-sessions.json', filterArray);
    await scrubFile(storageDir, 'run-analytics.json', (raw) => {
      const parsed = object(JSON.parse(raw));
      if (!parsed) throw new Error('Legacy analytics export must be an object.');
      let changed = false;
      for (const field of ['completedRuns', 'openRuns', 'billableInvocations', 'activityIntervals',
        'pruningDecisions', 'pruningEvents', 'toolResultPruningEvents', 'warmBashSummaries']) {
        const values = parsed[field];
        if (!Array.isArray(values)) continue;
        const remove = ['pruningDecisions', 'pruningEvents', 'toolResultPruningEvents', 'warmBashSummaries'].includes(field)
          ? sideChannelBelongs : belongs;
        const kept = values.filter((value) => !remove(value));
        if (kept.length === values.length) continue;
        parsed[field] = kept;
        changed = true;
      }
      if (!changed) return raw;
      // This mixed-session aggregate cannot survive a subject deletion. Drop
      // it rather than rebuilding a historical summary/export.
      delete parsed.billableInvocationSummary;
      return `${JSON.stringify(parsed, null, 2)}\n`;
    });
  }
}
