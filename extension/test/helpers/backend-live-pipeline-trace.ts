import * as fs from 'node:fs/promises';

import {
  flushBackendLivePipelineTrace,
  getBackendLivePipelineTraceHmacKey,
  getBackendLivePipelineTracePath,
  getBackendLivePipelineTraceRunId,
} from '../../src/backend/live-pipeline-trace-runtime';
import { createHardenedLivePipelineTraceIdentifier } from '../../src/shared/live-pipeline-trace';

/** Hash an identifier exactly as the shared canonical trace store does. */
export function hashBackendTraceIdentifier(identifier: string): string {
  return createHardenedLivePipelineTraceIdentifier(identifier, getBackendLivePipelineTraceHmacKey());
}

/**
 * Return the `backend.request` phase records appended since `before` for the
 * given request ids, in file order. Records are persisted with HMACed
 * identities, so the filter matches only the exact request identities this
 * test generated (restricted to this process's run identity). Records
 * appended by concurrent trace-producing tests — other processes, or other
 * suites sharing this process — can never match, so the asserted sequences
 * stay truthful regardless of interleaving. The before-slice scopes to this
 * run's window; the canonical trace file accumulates across runs.
 */
export async function readBackendRequestTracePhases(before: string, requestIds: string[]): Promise<string[]> {
  await flushBackendLivePipelineTrace();
  const runHash = hashBackendTraceIdentifier(getBackendLivePipelineTraceRunId());
  const requestHashes = new Set(requestIds.map(hashBackendTraceIdentifier));
  const after = await fs.readFile(getBackendLivePipelineTracePath(), 'utf8').catch(() => '');
  const appended = after.startsWith(before) ? after.slice(before.length) : after;
  return appended
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) =>
      record.stage === 'backend.request'
      && record.runIdHash === runHash
      && typeof record.requestHash === 'string'
      && requestHashes.has(record.requestHash))
    .map((record) => `${record.phase}:${record.kind}`);
}
