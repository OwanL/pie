import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWriteText } from '../../shared/atomic-write';

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
): Promise<RunAnalyticsExportPayload> {
  const result = await queryRunAnalyticsStore(storageDir);
  const logRoot = inferGlobalLogRoot(storageDir);
  const sideChannels = await readGlobalSideChannels(logRoot);
  const payload: RunAnalyticsExportPayload = {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    exportedAt: now().toISOString(),
    workspaceKey: path.basename(storageDir),
    ...result,
    ...sideChannels,
  };

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await atomicWriteText(targetPath, JSON.stringify(payload, null, 2) + '\n');
  return payload;
}
