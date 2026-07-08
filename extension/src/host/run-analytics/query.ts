import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  coerceAgentReviewEntry,
  coerceOutcomeHistoryLogEntry,
  coerceRunSnapshot,
  type AgentReviewEntry,
  type OutcomeHistoryLogEntry,
  type RunCheckpoint,
  type RunSnapshot,
} from './index';
import { parseCheckpoint, readOptionalText } from '../shared/checkpoint-io';
import { parseJsonOrThrow } from '../../shared/error-message';
import { resolveCheckpointSlot } from '../shared/checkpoint-slots';

export interface RunAnalyticsQueryResult {
  completedRuns: RunSnapshot[];
  openRuns: RunSnapshot[];
  outcomes: OutcomeHistoryLogEntry[];
  /** Agent-authored session reviews (one per scored review), persisted to
   *  `agent-reviews.jsonl`. Joined to runs by `runId` / `sessionPath` on the
   *  read side. Empty when no reviews have been recorded (or for stores
   *  predating the field — the file is simply absent). */
  agentReviews: AgentReviewEntry[];
}

export interface RunAnalyticsExportPayload extends RunAnalyticsQueryResult {
  schemaVersion: number;
  exportedAt: string;
  workspaceKey: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Recency timestamp (ms) used to pick the newest snapshot for a runId: updatedAt, then finalizedAt, then startedAt. */
function runRecencyMs(snapshot: RunSnapshot): number {
  const updatedAt = Date.parse(snapshot.updatedAt);
  if (!Number.isNaN(updatedAt)) {
    return updatedAt;
  }
  if (snapshot.finalizedAt) {
    const finalizedAt = Date.parse(snapshot.finalizedAt);
    if (!Number.isNaN(finalizedAt)) {
      return finalizedAt;
    }
  }
  return Date.parse(snapshot.startedAt);
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

async function readCheckpoint(storageDir: string): Promise<RunCheckpoint | null> {
  const genPath = path.join(storageDir, 'open-runs.gen');
  const slotAPath = path.join(storageDir, 'open-runs.a.json');
  const slotBPath = path.join(storageDir, 'open-runs.b.json');

  const [genValue, slotA, slotB] = await Promise.all([
    readOptionalText(genPath),
    readOptionalText(slotAPath),
    readOptionalText(slotBPath),
  ]);

  const checkpointA = slotA ? parseCheckpoint(slotA) : null;
  const checkpointB = slotB ? parseCheckpoint(slotB) : null;
  return resolveCheckpointSlot(genValue, checkpointA, checkpointB).checkpoint;
}

export async function queryRunAnalyticsStore(storageDir: string): Promise<RunAnalyticsQueryResult> {
  const [snapshotLines, outcomeLines, reviewLines, checkpoint] = await Promise.all([
    readJsonlObjects(path.join(storageDir, 'run-snapshots.jsonl')),
    readJsonlObjects(path.join(storageDir, 'outcome-history.jsonl')),
    readJsonlObjects(path.join(storageDir, 'agent-reviews.jsonl')),
    readCheckpoint(storageDir),
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

  // The checkpoint's lastRun is the recovery source for a scored run whose
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

  const outcomes: OutcomeHistoryLogEntry[] = [];
  for (const line of outcomeLines) {
    const entry = coerceOutcomeHistoryLogEntry(line);
    if (entry) {
      outcomes.push(entry);
    }
  }

  const agentReviews: AgentReviewEntry[] = [];
  for (const line of reviewLines) {
    const entry = coerceAgentReviewEntry(line);
    if (entry) {
      agentReviews.push(entry);
    }
  }

  const openRuns = Object.values(checkpoint?.sessions ?? {})
    .map((sessionState) => sessionState.currentRun)
    .filter((run): run is RunSnapshot => run !== null);

  return {
    completedRuns: [...latestCompletedRuns.values()],
    openRuns,
    outcomes,
    agentReviews,
  };
}

export async function exportRunAnalyticsStore(
  storageDir: string,
  targetPath: string,
  now: () => Date = () => new Date(),
): Promise<RunAnalyticsExportPayload> {
  const result = await queryRunAnalyticsStore(storageDir);
  const payload: RunAnalyticsExportPayload = {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    exportedAt: now().toISOString(),
    workspaceKey: path.basename(storageDir),
    ...result,
  };

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  try {
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
  return payload;
}
