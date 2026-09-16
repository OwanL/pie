import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
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

const PREFLIGHT_RUNTIME_IDENTITY = { publisher: 'test-publisher', name: 'test-pie', version: '0.0.1' };

/** Seed a real lifecycle registry for read-only preflight census tests. */
function seedPreflightRegistry(stateDir, rows) {
  const require = createRequire(import.meta.url);
  const { SessionLifecycleStore } = require('../../extension/out/session-lifecycle-store.js');
  const store = new SessionLifecycleStore(path.join(stateDir, 'session-lifecycle.sqlite'));
  try {
    for (const row of rows) {
      store.registerAnalyticsHost({
        hostInstanceId: row.hostInstanceId,
        workspaceId: row.workspaceId,
        generationId: row.generationId ?? row.hostInstanceId,
        buildId: '0123456789abcdef0123',
        processId: row.processId,
        capabilities: ['authenticated-control', 'writer-fence', 'host-discovery', 'host-status'],
        endpointName: `\\\\.\\pipe\\preflight-test-${row.hostInstanceId}`,
        state: 'registered',
        registeredAtMs: Date.now().toString(),
      });
      if (row.state && row.state !== 'registered') {
        store.markAnalyticsHostState(row.hostInstanceId, row.processId, row.generationId ?? row.hostInstanceId, row.state, Date.now());
      }
    }
  } finally {
    store.close();
  }
}

function runFirstActivationPreflight(seedRows) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-preflight-first-activation-'));
  try {
    const stateDir = path.join(root, 'state');
    mkdirSync(stateDir, { recursive: true });
    const runtimeRoot = path.join(root, 'runtime');
    mkdirSync(path.join(runtimeRoot, 'leases'), { recursive: true });
    if (seedRows) seedPreflightRegistry(stateDir, seedRows);
    const planPath = path.join(root, 'plan.json');
    writeFileSync(planPath, JSON.stringify({
      stateDir,
      cutoverMode: 'analytics-activation',
      workspaceId: JSON.stringify({ folders: ['file:c:/dev'] }),
      runtimeRootPath: runtimeRoot,
      runtimeIdentity: PREFLIGHT_RUNTIME_IDENTITY,
      hostHandoffKeysPath: path.join(root, 'owner-keys.json'),
    }));
    const result = spawnSync(process.execPath, [helperPath, '--preflight', '--plan', planPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { report: JSON.parse(result.stdout) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('PREFLIGHT first activation does not demand an existing canonical generation', () => {
  const { report } = runFirstActivationPreflight();
  assert.equal(report.status, 'blocked');
  assert.ok(!report.blockers.some((blocker) => blocker.includes('canonical active analytics generation is missing')),
    `first activation must not require an existing generation: ${JSON.stringify(report.blockers)}`);
  assert.equal(report.evidence.activeGenerationId, null);
});

test('PREFLIGHT first activation census mirrors the fence census', () => {
  const workspaceId = JSON.stringify({ folders: ['file:c:/dev'] });
  const liveHost = '11111111-1111-4111-8111-111111111111';
  const { report } = runFirstActivationPreflight([
    { hostInstanceId: liveHost, workspaceId, processId: process.pid },
    { hostInstanceId: '22222222-2222-4222-8222-222222222222', workspaceId, processId: 999_999, state: 'stopped' },
  ]);
  assert.ok(!report.blockers.some((blocker) => blocker.includes('canonical active analytics generation is missing')));
  // The live registered host is required by the census even without a key,
  // lease, or backend owner; a durably stopped stale row is ignored exactly
  // like the production fence ignores it.
  assert.ok(report.blockers.some((blocker) => blocker.includes('host census blocker:')),
    `expected live-host census blockers: ${JSON.stringify(report.blockers)}`);
  const hostBlockers = report.blockers.filter((blocker) => blocker.includes('host census blocker:'));
  assert.ok(hostBlockers.every((blocker) => !blocker.includes('22222222')),
    `stopped host must not be a census blocker: ${JSON.stringify(hostBlockers)}`);
  assert.ok(hostBlockers.some((blocker) => blocker.includes('11111111')),
    `live registered host must be censused: ${JSON.stringify(hostBlockers)}`);
  assert.ok(report.blockers.includes('host handoff key file is missing'));
  const discovery = report.evidence.hostDiscovery;
  assert.equal(discovery.hostCount, 1);
  assert.ok(!discovery.reasonCodes.includes('backend-analytics-descriptor-missing'),
    `first activation must waive the absent descriptor: ${JSON.stringify(discovery.reasonCodes)}`);
  assert.ok(discovery.reasonCodes.includes('host-backend-owner-missing'));
});
