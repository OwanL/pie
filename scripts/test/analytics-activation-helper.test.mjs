import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createLegacyRestartEnvironment } from '../analytics-activation-helper.mjs';
import { ANALYTICS_CUTOVER_PLAN_REFERENCE } from '../../extension/src/host/analytics-cutover-orchestrator.ts';

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

test('PREFLIGHT storage-cutoff authorization binds the production orchestrator plan marker', () => {
  const runPreflight = (plan) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pie-preflight-cutoff-'));
    const planPath = path.join(root, 'plan.json');
    writeFileSync(planPath, JSON.stringify({
      stateDir: path.join(root, 'state'),
      cutoverMode: 'storage-cutoff',
      workspaceId: 'preflight-workspace',
      ...plan,
    }));
    try {
      return spawnSync(process.execPath, [helperPath, '--preflight', '--plan', planPath], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        windowsHide: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const authorization = {
    schemaVersion: 1,
    approved: true,
    commitSha: 'a'.repeat(40),
  };

  // The authoritative marker is exactly the production orchestrator constant;
  // the preflight must not demand a different authorization envelope.
  const accepted = runPreflight({
    authorization: { ...authorization, plan: ANALYTICS_CUTOVER_PLAN_REFERENCE },
  });
  assert.equal(accepted.status, 2);
  const acceptedReport = JSON.parse(accepted.stdout);
  assert.equal(acceptedReport.status, 'blocked');
  assert.equal(acceptedReport.readiness.storageCutoff, false);
  assert.ok(!acceptedReport.blockers.includes('production analytics cutover is not explicitly authorized'));

  // A divergent plan marker (the old preflight-only docs reference) fails the
  // mandatory preflight closed.
  const divergent = runPreflight({
    authorization: { ...authorization, plan: 'docs/ANALYTICS_REWORK_PLAN.md#116-final-cutover' },
  });
  assert.equal(divergent.status, 2);
  const divergentReport = JSON.parse(divergent.stdout);
  assert.ok(divergentReport.blockers.includes('production analytics cutover is not explicitly authorized'));
});
