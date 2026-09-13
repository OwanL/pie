import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createLegacyRestartEnvironment } from '../analytics-activation-helper.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const helperPath = path.join(repositoryRoot, 'scripts', 'analytics-activation-helper.mjs');

test('legacy restart forwards its nonce with a helper-owned terminal receipt path', () => {
  const stateDir = path.resolve(os.tmpdir(), 'pie-legacy-activation-state');
  const env = createLegacyRestartEnvironment({ stateDir }, 'legacy-diagnostic-nonce');
  assert.equal(env.PIE_ANALYTICS_RESTART_NONCE, 'legacy-diagnostic-nonce');
  assert.equal(
    env.PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH,
    path.join(stateDir, 'analytics-terminal-restart-receipt-v1.json'),
  );
  assert.equal(path.isAbsolute(env.PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH), true);
});

test('PREFLIGHT reports blockers and cannot create or mutate activation state', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-activation-preflight-'));
  const stateDir = path.join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  const phasePath = path.join(stateDir, 'analytics-activation-phases.json');
  const phaseBytes = '{"schemaVersion":1,"phases":[],"lastError":null}\n';
  writeFileSync(phasePath, phaseBytes);
  const planPath = path.join(root, 'plan.json');
  writeFileSync(planPath, JSON.stringify({ stateDir }));
  try {
    const result = spawnSync(process.execPath, [helperPath, '--preflight', '--plan', planPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 2);
    assert.equal(result.error, undefined);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'PREFLIGHT');
    assert.equal(report.status, 'blocked');
    assert.ok(report.blockers.includes('activation plan: generationId is missing'));
    assert.ok(report.blockers.includes('terminal restart receipt readiness is missing'));
    assert.deepEqual(report.destructiveActions, {
      activation: false,
      restart: false,
      shutdown: false,
      storageCutoff: false,
    });
    assert.equal(readFileSync(phasePath, 'utf8'), phaseBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
