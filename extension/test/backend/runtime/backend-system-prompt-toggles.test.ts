import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendServer } from '../../../src/backend/server';

interface SystemPromptToggleServerPort {
  applySystemPromptToggles(sessionPath: string, disabledEntries: readonly string[]): Promise<void>;
  applySystemPromptTogglesNow(sessionPath: string, disabledEntries: readonly string[]): Promise<void>;
}

test('BackendServer serializes persistence and prompt rebuilds for one session', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/workspace' }) as unknown as SystemPromptToggleServerPort;
  const calls: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstReady = new Promise<void>((resolve) => { releaseFirst = resolve; });

  server.applySystemPromptTogglesNow = async (_sessionPath, disabledEntries) => {
    const label = disabledEntries[0]!;
    calls.push(`start:${label}`);
    if (label === 'first') await firstReady;
    calls.push(`end:${label}`);
  };

  const first = server.applySystemPromptToggles('/sessions/one.jsonl', ['first']);
  await Promise.resolve();
  const second = server.applySystemPromptToggles('/sessions/one.jsonl', ['second']);
  await Promise.resolve();

  assert.deepEqual(calls, ['start:first'], 'the second prompt rebuild waits for the first persistence/rebuild');
  releaseFirst!();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['start:first', 'end:first', 'start:second', 'end:second']);
});
