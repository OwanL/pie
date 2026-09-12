import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// @ts-expect-error The collector is a qualification-only plain ESM script.
import { startWindowsProcessHandleCollector, validateWindowsProcessEvidence, validateWindowsProcessReceipt } from '../../scripts/windows-process-handle-collector.mjs';

const toy = fileURLToPath(new URL('./fixtures/windows-process-handle-collector-toy.cjs', import.meta.url));

function identity(index: number) {
  return {
    instanceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    pid: index,
    spawnedAtMs: Date.now(),
  };
}

test('native collector receipt validation rejects malformed final identity and counters', () => {
  const expected = identity(1234);
  const malformed = {
    requestKey: 'client:1',
    identity: expected,
    status: 'available',
    reason: null,
    memory: { peakWorkingSetBytes: 0, units: 'bytes' },
    cpu: { userCpuTimeMicros: 1, systemCpuTimeMicros: 0, units: 'microseconds' },
    final: { handleRetainedThroughExit: true, exitTime100ns: 'not-a-filetime' },
    handleRetainedThroughExit: true,
    handleClosed: false,
    registration: { creationWindowMatch: false },
  };
  const result = validateWindowsProcessReceipt(malformed, expected);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /working set|exit identity|registration|closure/u);
});

test('native collector evidence accepts an explicit unavailable race for the bound worker', () => {
  const expected = identity(1235);
  const evidence = {
    enabled: true,
    platform: 'win32',
    qualificationOnly: true,
    overhead: {
      collectorProcessExcludedFromWorkloadTotals: true,
      pairedBaselineRequired: true,
      protocolBytes: 100,
      protocolWrites: 1,
    },
    rejections: [],
    receipts: [{
      requestKey: 'client:1',
      identity: expected,
      status: 'unavailable',
      reason: 'registration-terminal-race',
      memory: null,
      cpu: null,
      handleRetainedThroughExit: false,
      handleClosed: true,
    }],
  };
  const result = validateWindowsProcessEvidence(evidence, [expected]);
  assert.equal(result.valid, true, result.errors.join('; '));
  evidence.receipts[0].handleRetainedThroughExit = true;
  const forged = validateWindowsProcessEvidence(evidence, [expected]);
  assert.equal(forged.valid, false);
  assert.match(forged.errors.join('; '), /retention through exit/u);
});

test('Windows collector records a forged terminal separately and preserves the valid handle', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const collector = await startWindowsProcessHandleCollector({ maxRequests: 4, maxActiveHandles: 1, maxDurationMs: 10_000 });
  assert.equal(collector.enabled, true, JSON.stringify(collector.snapshot()));
  const spawnedAtMs = Date.now();
  const child = spawn(process.execPath, [toy, 'natural'], { stdio: 'ignore', windowsHide: true });
  assert.ok(child.pid);
  const workerIdentity = { ...identity(1236), pid: child.pid, spawnedAtMs };
  const clientId = '00000000-0000-4000-8000-000000000201';
  try {
    assert.equal(collector.registerWorker({ phase: 'spawned', clientId, requestId: 1, identity: workerIdentity }), true);
    const forgedIdentity = { ...workerIdentity, instanceId: '00000000-0000-4000-8000-000000000202' };
    assert.equal(collector.recordTerminal({ phase: 'terminal', clientId, requestId: 1, identity: forgedIdentity, code: 0, signal: null }), false);
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    assert.equal(collector.recordTerminal({ phase: 'terminal', clientId, requestId: 1, identity: workerIdentity, code, signal }), true);
    const evidence = await collector.stop();
    assert.equal(evidence.rejections.length, 1, JSON.stringify(evidence));
    assert.equal(evidence.rejections[0].reason, 'terminal-identity-mismatch');
    assert.equal(evidence.receipts.length, 1, JSON.stringify(evidence));
    assert.equal(evidence.receipts[0].status, 'available', JSON.stringify(evidence));
    const validation = validateWindowsProcessEvidence(evidence, [workerIdentity]);
    assert.equal(validation.valid, true, validation.errors.join('; '));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await collector.stop();
  }
});

test('Windows collector binds owned natural and forced toy exits to final counters', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const collector = await startWindowsProcessHandleCollector({
    maxRequests: 4,
    maxActiveHandles: 2,
    maxDurationMs: 10_000,
  });
  assert.equal(collector.enabled, true, JSON.stringify(collector.snapshot()));
  const workers: Array<{ child: ReturnType<typeof spawn>; identity: ReturnType<typeof identity> }> = [];
  try {
    for (const [index, mode] of (['natural', 'forced'] as const).entries()) {
      const spawnedAtMs = Date.now();
      const child = spawn(process.execPath, [toy, mode], { stdio: 'ignore', windowsHide: true });
      assert.ok(child.pid);
      const worker = { child, identity: { ...identity(index + 1), pid: child.pid, spawnedAtMs } };
      workers.push(worker);
      const clientId = `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`;
      assert.equal(collector.registerWorker({ phase: 'spawned', clientId, requestId: 1, identity: worker.identity }), true);
      if (mode === 'forced') {
        await new Promise((resolve) => setTimeout(resolve, 200));
        child.kill();
      }
      const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
      assert.equal(collector.recordTerminal({ phase: 'terminal', clientId, requestId: 1, identity: worker.identity, code, signal }), true);
    }
    const evidence = await collector.stop();
    assert.equal(evidence.receipts.length, 2, JSON.stringify(evidence));
    assert.ok(evidence.receipts.every((receipt: any) => receipt.status === 'available'), JSON.stringify(evidence));
    assert.ok(evidence.receipts.every((receipt: any) => receipt.handleRetainedThroughExit === true && receipt.handleClosed === true), JSON.stringify(evidence));
    const validation = validateWindowsProcessEvidence(evidence, workers.map((worker) => worker.identity));
    assert.equal(validation.valid, true, validation.errors.join('; '));
    for (const receipt of evidence.receipts as any[]) {
      assert.ok(receipt.memory.peakWorkingSetBytes > 0);
      assert.ok(receipt.cpu.userCpuTimeMicros >= 0);
      assert.equal(receipt.registration.creationWindowMatch, true);
    }
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    }
    await collector.stop();
  }
});
