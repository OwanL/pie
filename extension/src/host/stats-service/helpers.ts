import * as crypto from 'node:crypto';

import type { ActiveRunSummary, ComposerInput } from '../../shared/protocol';
import {
  type PersistedSessionRunState,
  type RunSnapshot,
  type TaskBoundaryIntent,
} from '../run-analytics';

export function defaultNow(): Date {
  return new Date();
}

export function defaultCreateId(): string {
  return crypto.randomUUID();
}

export function workspaceHash(workspaceId: string): string {
  return crypto.createHash('sha256').update(workspaceId).digest('hex').slice(0, 16);
}

export function summarizeInputs(run: RunSnapshot, inputs: ComposerInput[]): void {
  const kindsUsed = new Set<ComposerInput['kind']>(run.inputKindsUsed);

  for (const input of inputs) {
    kindsUsed.add(input.kind);
    switch (input.kind) {
      case 'filesystemPathRef':
        run.filesystemPathRefCount += 1;
        break;
      case 'imageBlob':
        run.imageInputCount += 1;
        run.imageInputBytes += input.sizeBytes;
        break;
      case 'fileBlob':
        run.unsupportedInputCount += 1;
        break;
    }
  }

  run.inputKindsUsed = [...kindsUsed];
}

export function toActiveRunSummary(
  run: RunSnapshot | null,
  nextSendStartsNewTask = false,
): ActiveRunSummary | null {
  if (!run) {
    return null;
  }

  return nextSendStartsNewTask
    ? {
        runId: run.runId,
        status: run.status,
        scored: run.scored,
        nextSendStartsNewTask: true,
      }
    : {
        runId: run.runId,
        status: run.status,
        scored: run.scored,
      };
}

interface PersistableSessionState {
  currentRun: RunSnapshot | null;
  lastRun: RunSnapshot | null;
  nextTaskIntent: TaskBoundaryIntent;
  queuedUnsupportedInputCount: number;
  busyStartedAt: string | null;
}

export function toPersistedSessionState(state: PersistableSessionState): PersistedSessionRunState {
  return {
    currentRun: state.currentRun,
    lastRun: state.lastRun,
    nextTaskIntent: state.nextTaskIntent,
    queuedUnsupportedInputCount: state.queuedUnsupportedInputCount,
    busyStartedAt: state.busyStartedAt,
  };
}

export function appendUnique<TValue>(values: TValue[], nextValues: TValue[]): TValue[] {
  return [...new Set([...values, ...nextValues])];
}

export function areStringArraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const lhs = left ?? [];
  const rhs = right ?? [];
  if (lhs.length !== rhs.length) {
    return false;
  }

  return lhs.every((value, index) => value === rhs[index]);
}
