import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWriteText } from '../../shared/atomic-write';
import type { BillableInvocationRecord, BillableInvocationSummary } from '../../shared/billable-invocation';
import type { ActivityIntervalRecord } from '../../shared/activity-interval';

import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  coerceRunSnapshot,
  runRecencyMs,
  type RunSnapshot,
} from './index';
import { readOptionalText } from '../shared/checkpoint-io';
import { parseJsonOrThrow } from '../../shared/error-message';
import { readCheckpointSlots } from './checkpoint';
import {
  inferGlobalLogRoot,
  readGlobalSideChannels,
  type GlobalSideChannels,
} from './side-channel';

export interface RunAnalyticsQueryResult {
  completedRuns: RunSnapshot[];
  openRuns: RunSnapshot[];
}

export interface RunAnalyticsExportPayload extends RunAnalyticsQueryResult, GlobalSideChannels {
  schemaVersion: number;
  exportedAt: string;
  workspaceKey: string;
  /** Conserved usage authority. Legacy exports may omit these migration fields. */
  billableInvocations?: BillableInvocationRecord[];
  billableInvocationSummary?: BillableInvocationSummary;
  /** Correlated working-time authority. */
  activityIntervals?: ActivityIntervalRecord[];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonlObjects(filePath: string): Promise<unknown[]> {
  const raw = await readOptionalText(filePath);
  if (!raw) {
    return [];
  }

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return parseJsonOrThrow<unknown>(line, 'analytics line');
      } catch {
        return null;
      }
    })
    .filter((value): value is unknown => value !== null);
}

export async function queryRunAnalyticsStore(storageDir: string): Promise<RunAnalyticsQueryResult> {
  const [snapshotLines, checkpoint] = await Promise.all([
    readJsonlObjects(path.join(storageDir, 'run-snapshots.jsonl')),
    readCheckpointSlots(storageDir).then((resolved) => resolved.checkpoint),
  ]);

  const latestCompletedRuns = new Map<string, RunSnapshot>();
  for (const line of snapshotLines) {
    if (!isObjectRecord(line) || line.kind !== 'run_snapshot') {
      continue;
    }
    const snapshot = coerceRunSnapshot(line.run);
    if (!snapshot) {
      continue;
    }
    latestCompletedRuns.set(snapshot.runId, snapshot);
  }

  // The checkpoint's lastRun is the recovery source for a closed run whose
  // JSONL append was lost: merge it in as a fallback, only when the JSONL is
  // missing the runId or the checkpoint holds a strictly newer snapshot for it.
  for (const sessionState of Object.values(checkpoint?.sessions ?? {})) {
    const lastRun = sessionState.lastRun;
    if (!lastRun) {
      continue;
    }
    const existing = latestCompletedRuns.get(lastRun.runId);
    if (!existing || runRecencyMs(lastRun) > runRecencyMs(existing)) {
      latestCompletedRuns.set(lastRun.runId, lastRun);
    }
  }

  const openRuns = Object.values(checkpoint?.sessions ?? {})
    .map((sessionState) => sessionState.currentRun)
    .filter((run): run is RunSnapshot => run !== null);

  return {
    completedRuns: [...latestCompletedRuns.values()],
    openRuns,
  };
}

export async function exportRunAnalyticsStore(
  storageDir: string,
  targetPath: string,
  now: () => Date = () => new Date(),
  excludeSessionPaths?: ReadonlySet<string>,
  excludeSessionIds?: ReadonlySet<string>,
  billableInvocationExport?: Pick<RunAnalyticsExportPayload, 'billableInvocations' | 'billableInvocationSummary' | 'activityIntervals'>,
): Promise<RunAnalyticsExportPayload> {
  const result = await queryRunAnalyticsStore(storageDir);
  if (excludeSessionPaths && excludeSessionPaths.size > 0) {
    result.completedRuns = result.completedRuns.filter((run) => !excludeSessionPaths.has(run.sessionPath));
    result.openRuns = result.openRuns.filter((run) => !excludeSessionPaths.has(run.sessionPath));
  }
  const logRoot = inferGlobalLogRoot(storageDir);
  const sideChannels = await readGlobalSideChannels(logRoot);
  if (excludeSessionPaths || excludeSessionIds) {
    const pathExcluded = excludeSessionPaths ?? new Set<string>();
    const idExcluded = excludeSessionIds ?? new Set<string>();
    sideChannels.pruningDecisions = sideChannels.pruningDecisions.filter((entry) => !pathExcluded.has(entry.sessionPath) && !idExcluded.has(entry.sessionId));
    sideChannels.pruningEvents = sideChannels.pruningEvents.filter((entry) => !idExcluded.has(entry.sessionId));
    sideChannels.toolResultPruningEvents = sideChannels.toolResultPruningEvents.filter((entry) => !idExcluded.has(entry.sessionId));
    sideChannels.warmBashSummaries = sideChannels.warmBashSummaries.filter((entry) => !idExcluded.has(entry.sessionId));
  }
  const payload: RunAnalyticsExportPayload = {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    exportedAt: now().toISOString(),
    workspaceKey: path.basename(storageDir),
    ...result,
    ...sideChannels,
    ...(billableInvocationExport ?? {}),
  };

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await atomicWriteText(targetPath, JSON.stringify(payload, null, 2) + '\n');
  return payload;
}
