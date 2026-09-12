import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadedGenerationMatchesRestart,
  readLoadedGeneration,
} from '../analytics-activation-recovery.mjs';

const plan = { generationId: 'generation-a', buildId: 'build-a' };

function writeLoaded(stateDir, overrides = {}) {
  writeFileSync(path.join(stateDir, 'analytics-loaded-generation-v1.json'), `${JSON.stringify({
    schemaVersion: 1,
    generationId: plan.generationId,
    buildId: plan.buildId,
    restartNonce: 'nonce-a',
    hostInstanceId: 'host-a',
    loadedAt: '2026-09-13T00:00:01.000Z',
    ...overrides,
  })}\n`);
}

test('loaded-generation evidence rejects stale, same-host, and malformed markers', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'pie-activation-recovery-'));
  try {
    const restart = {
      requestedAtMs: Date.parse('2026-09-13T00:00:00.000Z'),
      restartNonce: 'nonce-a',
      previousHostInstanceId: 'host-old',
    };
    writeLoaded(stateDir, { loadedAt: '2026-09-12T23:59:59.000Z' });
    assert.equal(loadedGenerationMatchesRestart(readLoadedGeneration(stateDir), plan, restart), false);
    writeLoaded(stateDir, { hostInstanceId: 'host-old' });
    assert.equal(loadedGenerationMatchesRestart(readLoadedGeneration(stateDir), plan, restart), false);
    writeLoaded(stateDir, { restartNonce: 'other-nonce' });
    assert.equal(loadedGenerationMatchesRestart(readLoadedGeneration(stateDir), plan, restart), false);
    writeFileSync(path.join(stateDir, 'analytics-loaded-generation-v1.json'), '{"generationId":"generation-a"}\n');
    assert.equal(readLoadedGeneration(stateDir), null);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('loaded-generation evidence accepts only a fresh marker from a changed host', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'pie-activation-recovery-'));
  try {
    const restart = {
      requestedAtMs: Date.parse('2026-09-13T00:00:00.000Z'),
      restartNonce: 'nonce-a',
      previousHostInstanceId: 'host-old',
    };
    writeLoaded(stateDir, { hostInstanceId: 'host-new' });
    assert.equal(loadedGenerationMatchesRestart(readLoadedGeneration(stateDir), plan, restart), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
