import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  AnalyticsHostRecord,
} from '../../src/backend/session-lifecycle-store.js';
import {
  discoverAnalyticsHostWriters,
  parseWindowsProcessCreationDate,
  parseWindowsProcessOwnerRows,
  readRuntimeLeaseEvidence,
  readWindowsProcessOwners,
  type BackendProcessOwnerEvidence,
  type ProcessOwnerReadResult,
  type RuntimeGenerationIdentity,
  type RuntimeLeaseEvidence,
} from '../../src/host/analytics-handoff-discovery.js';

const IDENTITY: RuntimeGenerationIdentity = {
  publisher: 'pie-publisher', name: 'pie', version: '1.0.0',
};
const RUNTIME_GENERATION_A = 'a'.repeat(64);
const RUNTIME_GENERATION_B = 'b'.repeat(64);

function host(
  hostInstanceId: string,
  processId: number,
  generationId: string,
): AnalyticsHostRecord {
  return {
    hostInstanceId,
    workspaceId: 'workspace-discovery',
    generationId,
    buildId: 'build-discovery',
    processId,
    capabilities: ['authenticated-control'],
    state: 'registered',
    registeredAtMs: '100',
    heartbeatAtMs: '200',
    updatedAtMs: '200',
  };
}

function lease(
  processId: number,
  runtimeGeneration: string,
  leaseCreatedAtMs = 50_000,
): RuntimeLeaseEvidence {
  return {
    leaseFileName: `${runtimeGeneration}-${processId}-0123456789abcdef0123456789abcdef.json`,
    runtimeGeneration,
    processId,
    leaseCreatedAtMs,
    identity: { ...IDENTITY },
  };
}

function backend(
  backendProcessId: number,
  hostProcessId: number,
  hostCreatedAtMs: number | null,
  backendCreatedAtMs: number | null,
  hostInstanceId: string,
  generationId: string,
): BackendProcessOwnerEvidence {
  return {
    backendProcessId,
    hostProcessId,
    hostCreatedAtMs,
    backendCreatedAtMs,
    backendGeneration: 1,
    analyticsHostInstanceId: hostInstanceId,
    analyticsGenerationId: generationId,
  };
}

function processEvidence(processIds: Array<[number, number | null]>): ProcessOwnerReadResult {
  return {
    processes: processIds.map(([processId, processCreatedAtMs]) => ({ processId, processCreatedAtMs })),
    backendOwners: [],
    complete: true,
    reasons: [],
  };
}

function registryReader(records: readonly AnalyticsHostRecord[]) {
  return {
    listAnalyticsHosts: (_workspaceId: string, options: { limit?: number; cursor?: string } = {}) => {
      const limit = options.limit ?? records.length;
      const start = options.cursor ? records.findIndex((record) => record.hostInstanceId === options.cursor) + 1 : 0;
      const selected = records.slice(start, start + limit);
      const truncated = start + limit < records.length;
      return {
        hosts: selected,
        truncated,
        ...(truncated ? { nextCursor: selected[selected.length - 1]!.hostInstanceId } : {}),
      };
    },
  };
}

test('runtime lease reader validates the file identity without treating lease time as process birth', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-discovery-leases-'));
  const leasesPath = path.join(root, 'leases');
  mkdirSync(leasesPath, { recursive: true });
  const name = `${RUNTIME_GENERATION_A}-501-0123456789abcdef0123456789abcdef.json`;
  writeFileSync(path.join(leasesPath, name), `${JSON.stringify({
    schema: 1,
    identity: IDENTITY,
    generation: RUNTIME_GENERATION_A,
    pid: 501,
    createdAt: 1_000,
  })}\n`);
  try {
    const result = await readRuntimeLeaseEvidence(root, IDENTITY);
    assert.equal(result.complete, true);
    assert.deepEqual(result.leases.map(({ processId, leaseCreatedAtMs }) => ({ processId, leaseCreatedAtMs })), [
      { processId: 501, leaseCreatedAtMs: 1_000 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discovery reconciles two host leases and backend owners with true process birth evidence', async () => {
  const hosts = [
    host('host-a', 501, 'process-generation-a'),
    host('host-b', 502, 'process-generation-b'),
  ];
  const processResult: ProcessOwnerReadResult = {
    ...processEvidence([[501, 10_000], [502, 20_000], [601, 11_000], [602, 21_000]]),
    backendOwners: [
      backend(601, 501, 10_000, 11_000, 'host-a', 'analytics-generation'),
      backend(602, 502, 20_000, 21_000, 'host-b', 'analytics-generation'),
    ],
  };
  const result = await discoverAnalyticsHostWriters({
    workspaceId: 'workspace-discovery',
    registry: registryReader(hosts),
    runtimeRootPath: 'unused-injected-root',
    runtimeIdentity: IDENTITY,
    analyticsGenerationId: 'analytics-generation',
    readRuntimeLeases: async () => ({
      leases: [lease(501, RUNTIME_GENERATION_A), lease(502, RUNTIME_GENERATION_B)],
      complete: true,
      reasons: [],
    }),
    readProcessOwners: async () => processResult,
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.hosts.map(({ hostInstanceId, status, runtimeGeneration, backendProcessId }) => ({
    hostInstanceId, status, runtimeGeneration, backendProcessId,
  })), [
    { hostInstanceId: 'host-a', status: 'reconciled', runtimeGeneration: RUNTIME_GENERATION_A, backendProcessId: 601 },
    { hostInstanceId: 'host-b', status: 'reconciled', runtimeGeneration: RUNTIME_GENERATION_B, backendProcessId: 602 },
  ]);
});

test('old unregistered runtime leases and backend owners remain explicit unsupported evidence', async () => {
  const registered = host('host-current', 501, 'process-generation-current');
  const oldLease = lease(26828, RUNTIME_GENERATION_B);
  const oldBackend = backend(26829, 26828, 30_000, 31_000, 'old-host', 'old-analytics');
  const result = await discoverAnalyticsHostWriters({
    workspaceId: 'workspace-discovery',
    registry: registryReader([registered]),
    runtimeRootPath: 'unused-injected-root',
    runtimeIdentity: IDENTITY,
    analyticsGenerationId: 'analytics-current',
    readRuntimeLeases: async () => ({ leases: [lease(501, RUNTIME_GENERATION_A), oldLease], complete: true, reasons: [] }),
    readProcessOwners: async () => ({
      processes: [
        { processId: 501, processCreatedAtMs: 10_000 },
        { processId: 26828, processCreatedAtMs: 30_000 },
        { processId: 26829, processCreatedAtMs: 31_000 },
      ],
      backendOwners: [oldBackend],
      complete: true,
      reasons: [],
    }),
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.unregisteredRuntimeLeases.map(({ processId }) => processId), [26828]);
  assert.deepEqual(result.unregisteredBackendOwners.map(({ backendProcessId }) => backendProcessId), [26829]);
  assert.ok(result.reasons.some(({ code, processId }) => code === 'runtime-lease-process-unregistered' && processId === 26828));
  assert.ok(result.reasons.some(({ code, processId }) => code === 'backend-owner-unregistered' && processId === 26829));
  assert.ok(result.reasons.some(({ code }) => code === 'host-backend-owner-missing'));
});

test('discovery fails closed for missing birth, stale lease ordering, and missing backend descriptor', async () => {
  const registered = host('host-unknown', 501, 'process-generation-unknown');
  const result = await discoverAnalyticsHostWriters({
    workspaceId: 'workspace-discovery',
    registry: registryReader([registered]),
    runtimeRootPath: 'unused-injected-root',
    runtimeIdentity: IDENTITY,
    analyticsGenerationId: 'analytics-unknown',
    readRuntimeLeases: async () => ({ leases: [lease(501, RUNTIME_GENERATION_A, 100)], complete: true, reasons: [] }),
    readProcessOwners: async () => ({
      processes: [{ processId: 501, processCreatedAtMs: 200 }, { processId: 601, processCreatedAtMs: null }],
      backendOwners: [{
        backendProcessId: 601,
        hostProcessId: 501,
        hostCreatedAtMs: 200,
        backendCreatedAtMs: null,
        backendGeneration: 1,
      }],
      complete: true,
      reasons: [],
    }),
  });
  assert.equal(result.complete, false);
  assert.deepEqual(new Set(result.hosts[0]!.reasons.map(({ code }) => code)), new Set([
    'runtime-lease-birth-after-lease-write',
    'backend-process-birth-unavailable',
    'backend-analytics-descriptor-missing',
  ]));
});

test('Windows process birth parser accepts WMI DMTF and rejects unavailable values', () => {
  assert.equal(parseWindowsProcessCreationDate('20260913120000.000000+000'), Date.UTC(2026, 8, 13, 12));
  assert.equal(parseWindowsProcessCreationDate('not-a-creation-date'), null);
  assert.equal(parseWindowsProcessCreationDate(null), null);
});

test('recognized backend with incomplete ownership is incomplete and never emitted', () => {
  const result = parseWindowsProcessOwnerRows([
    {
      ProcessId: 9001,
      ProcessCreatedAtMs: 1_000,
      CommandLine: 'node backend.js --sdkPath C:\\pie --hostPid 9000',
    },
  ]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.backendOwners, []);
  assert.deepEqual(result.reasons, [{ code: 'backend-owner-identity-invalid', processId: 9001 }]);
});

test('Windows process census reports a finite plausible birth for this process', { skip: process.platform !== 'win32' }, async () => {
  const result = await readWindowsProcessOwners();
  assert.equal(result.complete, true);
  const own = result.processes.find(({ processId }) => processId === process.pid);
  assert.ok(own, 'current process must appear in the read-only census');
  assert.ok(own.processCreatedAtMs !== null);
  assert.ok(own.processCreatedAtMs > 0 && own.processCreatedAtMs <= Date.now());
});
