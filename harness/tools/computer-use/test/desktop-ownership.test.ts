import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DesktopCoordinator } from '../desktop-ownership.js';

async function testDirectory(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'pie-computer-claim-test-'));
}

function ownerLabel(error: unknown, label: string): boolean {
  return (error as { code?: string; message?: string }).code === 'DESKTOP_BUSY'
    && (error as { message?: string }).message?.includes(label) === true;
}

test('desktop claim is globally exclusive and busy errors name the human owner without waiting', async () => {
  const dir = await testDirectory();
  const coordinator = new DesktopCoordinator(path.join(dir, 'claim.lock'));
  const owner = coordinator.primary(path.join(dir, 'primary-session.jsonl'), 'Pie session “Design review”');
  const contender = coordinator.primary(path.join(dir, 'other-session.jsonl'), 'Pie session “Other”');
  try {
    await coordinator.run(owner, async () => undefined);
    await assert.rejects(
      coordinator.run(contender, async () => undefined),
      (error) => ownerLabel(error, 'Pie session “Design review”'),
    );
    const claim = JSON.parse(await readFile(path.join(dir, 'claim.lock'), 'utf8'));
    assert.equal(claim.ownerLabel, 'Pie session “Design review”');
    await coordinator.settle(owner, async () => {});
    await coordinator.run(contender, async () => undefined);
    await coordinator.settle(contender, async () => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shutdown of an already-closed primary scope cannot release the current turn controller', async () => {
  const dir = await testDirectory();
  const sessionPath = path.join(dir, 'primary-session.jsonl');
  const coordinator = new DesktopCoordinator(path.join(dir, 'claim.lock'));
  let heldByCurrentController = false;
  let oldCleanupCount = 0;
  try {
    const oldScope = coordinator.beginPrimary(sessionPath, 'Old primary turn');
    await coordinator.run(oldScope, async () => {});
    await coordinator.settle(oldScope, async () => { oldCleanupCount += 1; });

    const currentScope = coordinator.beginPrimary(sessionPath, 'Current primary turn');
    await coordinator.run(currentScope, async () => { heldByCurrentController = true; });
    await coordinator.shutdown(oldScope, async () => {
      oldCleanupCount += 1;
      heldByCurrentController = false;
    });

    assert.equal(oldCleanupCount, 1, 'the closed scope cleanup is not run a second time');
    assert.equal(heldByCurrentController, true, 'stale teardown cannot release input owned by the current scope');
    const contender = coordinator.primary(path.join(dir, 'other-session.jsonl'), 'Other controller');
    await assert.rejects(
      coordinator.run(contender, async () => {}),
      (error) => ownerLabel(error, 'Current primary turn'),
    );
    await coordinator.shutdown(currentScope, async () => { heldByCurrentController = false; });
    assert.equal(heldByCurrentController, false, 'the active scope still performs its own cleanup');
  } finally {
    await coordinator.shutdownAll(async () => { heldByCurrentController = false; });
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancellation drains the operation but retains ownership until confirmed cleanup', async () => {
  const dir = await testDirectory();
  const coordinator = new DesktopCoordinator(path.join(dir, 'claim.lock'));
  const owner = coordinator.primary(path.join(dir, 'primary-session.jsonl'), 'Primary agent — task A');
  const contender = coordinator.primary(path.join(dir, 'child-session.jsonl'), 'Sub-agent “Inspect dialog”');
  const controller = new AbortController();
  let entered!: () => void;
  const operationEntered = new Promise<void>((resolve) => { entered = resolve; });
  try {
    const operation = coordinator.run(owner, async () => await new Promise<void>((_resolve, reject) => {
      entered();
      controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true });
    }));
    await operationEntered;
    controller.abort();
    await assert.rejects(operation, (error: any) => error.code === 'CANCELLED');
    await assert.rejects(
      coordinator.run(contender, async () => undefined),
      (error) => ownerLabel(error, 'Primary agent — task A'),
    );
    await coordinator.settle(owner, async () => {});
    await coordinator.run(contender, async () => undefined);
    await coordinator.settle(contender, async () => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('settlement fences late calls and waits for active operations before cleanup releases ownership', async () => {
  const dir = await testDirectory();
  const coordinator = new DesktopCoordinator(path.join(dir, 'claim.lock'));
  const owner = coordinator.primary(path.join(dir, 'primary-session.jsonl'), 'Pie session “Active tool drain”');
  const contender = coordinator.primary(path.join(dir, 'other-session.jsonl'), 'Other agent');
  let entered!: () => void;
  let finishOperation!: () => void;
  const operationEntered = new Promise<void>((resolve) => { entered = resolve; });
  const operationGate = new Promise<void>((resolve) => { finishOperation = resolve; });
  let cleanupFinished = false;
  try {
    const operation = coordinator.run(owner, async () => {
      entered();
      await operationGate;
    });
    await operationEntered;
    const cleanup = coordinator.settle(owner, async () => { cleanupFinished = true; });
    await assert.rejects(
      coordinator.run(owner, async () => undefined),
      (error: any) => error.code === 'DESKTOP_OWNER_CLOSED',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cleanupFinished, false, 'settlement waits while the active tool callback is still running');
    await assert.rejects(
      coordinator.run(contender, async () => undefined),
      (error) => ownerLabel(error, 'Pie session “Active tool drain”'),
    );
    finishOperation();
    await operation;
    await cleanup;
    assert.equal(cleanupFinished, true);
    await coordinator.run(contender, async () => undefined);
    await coordinator.settle(contender, async () => {});
  } finally {
    finishOperation();
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed cleanup retains the claim and blocks every contender with actionable ownership', async () => {
  const dir = await testDirectory();
  const claimPath = path.join(dir, 'claim.lock');
  const coordinator = new DesktopCoordinator(claimPath);
  const owner = coordinator.primary(path.join(dir, 'primary-session.jsonl'), 'Pie session “Held key recovery”');
  const contender = coordinator.primary(path.join(dir, 'other-session.jsonl'), 'Other Pie agent');
  try {
    await coordinator.run(owner, async () => undefined);
    await assert.rejects(
      coordinator.settle(owner, async () => { throw Object.assign(new Error('held key W remains down'), { code: 'RELEASE_FAILED' }); }),
      (error: any) => error.code === 'DESKTOP_CLEANUP_BLOCKED'
        && /ownership is retained/.test(error.message)
        && /held key W remains down/.test(error.message)
        && error.message.includes(claimPath),
    );
    assert.ok(await readFile(claimPath, 'utf8'), 'failed cleanup leaves the atomic claim in place');
    await assert.rejects(
      coordinator.run(contender, async () => undefined),
      (error) => ownerLabel(error, 'Pie session “Held key recovery”'),
    );
  } finally {
    // This is an isolated claim created by this test; remove only this test's
    // temporary directory, never the real user desktop coordination location.
    await rm(dir, { recursive: true, force: true });
  }
});

test('orphan claim records fail closed without PID-based stale recovery', async () => {
  const dir = await testDirectory();
  const claimPath = path.join(dir, 'claim.lock');
  const orphan = { version: 1, claimId: 'crashed-process-claim', ownerLabel: 'Sub-agent “Crashed UI controller”', pid: -1 };
  await writeFile(claimPath, JSON.stringify(orphan));
  const coordinator = new DesktopCoordinator(claimPath);
  const contender = coordinator.primary(path.join(dir, 'new-session.jsonl'), 'New Pie agent');
  try {
    await assert.rejects(
      coordinator.run(contender, async () => undefined),
      (error: any) => error.code === 'DESKTOP_BUSY'
        && error.message.includes('Sub-agent “Crashed UI controller”')
        && error.message.includes(claimPath),
    );
    assert.deepEqual(JSON.parse(await readFile(claimPath, 'utf8')), orphan, 'a presumed dead PID never authorizes automatic claim removal');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent first claim publication exposes complete owner metadata to the losing process', async () => {
  const dir = await testDirectory();
  const claimPath = path.join(dir, 'claim.lock');
  const modulePath = path.resolve('harness/tools/computer-use/desktop-ownership.ts');
  const labels = [
    'Pie session “First contender A”',
    'Sub-agent “First contender B”',
    'Pie session “First contender C”',
    'Sub-agent “First contender D”',
  ];
  const source = `
    import { pathToFileURL } from 'node:url';
    const { DesktopCoordinator } = await import(pathToFileURL(process.env.PIE_DESKTOP_MODULE).href);
    const coordinator = new DesktopCoordinator(process.env.PIE_DESKTOP_CLAIM);
    const label = process.env.PIE_DESKTOP_LABEL;
    const scope = coordinator.primary(process.env.PIE_DESKTOP_SESSION, label);
    process.stdout.write(JSON.stringify({ kind: 'ready' }) + '\\n');
    await new Promise((resolve) => process.stdin.once('data', resolve));
    try {
      await coordinator.run(scope, async () => {
        process.stdout.write(JSON.stringify({ kind: 'claimed', label }) + '\\n');
        await new Promise((resolve) => process.stdin.once('data', resolve));
      });
      await coordinator.settle(scope, async () => {});
    } catch (error) {
      process.stdout.write(JSON.stringify({ kind: 'busy', code: error.code, message: error.message }) + '\\n');
    }
  `;
  const candidates = labels.map((label, index) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PIE_DESKTOP_MODULE: modulePath,
        PIE_DESKTOP_CLAIM: claimPath,
        PIE_DESKTOP_LABEL: label,
        PIE_DESKTOP_SESSION: path.join(dir, `session-${index}.jsonl`),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const state = { child, stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { state.stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { state.stderr += chunk; });
    return state;
  });
  const messages = (state: (typeof candidates)[number]) => state.stdout
    .split(/\r?\n/)
    .flatMap((line) => {
      try { return [JSON.parse(line) as { kind: string; code?: string; label?: string; message?: string }]; }
      catch { return []; }
    });
  const waitFor = async (
    state: (typeof candidates)[number],
    predicate: (records: ReturnType<typeof messages>) => boolean,
    description: string,
  ): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!predicate(messages(state))) {
      if (state.child.exitCode !== null) throw new Error(`subprocess exited before ${description}: ${state.stderr}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${description}: stdout=${state.stdout}; stderr=${state.stderr}`);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        once(state.child.stdout, 'data'),
        once(state.child, 'close'),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
      ]);
      if (timer) clearTimeout(timer);
    }
  };

  let winner: (typeof candidates)[number] | undefined;
  try {
    await Promise.all(candidates.map(async (state) => await waitFor(state, (records) => records.some((record) => record.kind === 'ready'), 'readiness')));
    for (const state of candidates) state.child.stdin.write('start\\n');
    await Promise.all(candidates.map(async (state) => await waitFor(
      state,
      (records) => records.some((record) => record.kind === 'claimed' || record.kind === 'busy'),
      'first-acquire result',
    )));

    const outcomes = candidates.map((state) => messages(state).find((record) => record.kind === 'claimed' || record.kind === 'busy'));
    assert.equal(outcomes.filter((outcome) => outcome?.kind === 'claimed').length, 1, 'exactly one simultaneous first acquirer publishes the claim');
    assert.equal(outcomes.filter((outcome) => outcome?.kind === 'busy').length, labels.length - 1, 'all other first acquirers report busy');
    const winnerIndex = outcomes.findIndex((outcome) => outcome?.kind === 'claimed');
    winner = candidates[winnerIndex];
    const claimed = outcomes[winnerIndex];
    const busyOutcomes = outcomes.filter((outcome) => outcome?.kind === 'busy');
    const claim = JSON.parse(await readFile(claimPath, 'utf8')) as { version: number; claimId: string; ownerLabel: string; pid: number; acquiredAt: string };
    assert.equal(claim.version, 1);
    assert.equal(claim.ownerLabel, claimed?.label);
    assert.equal(claim.pid, winner.child.pid);
    assert.ok(claim.claimId.length > 0);
    assert.ok(Number.isFinite(Date.parse(claim.acquiredAt)));
    for (const busy of busyOutcomes) {
      assert.equal(busy?.code, 'DESKTOP_BUSY');
      assert.ok(busy?.message?.includes(claim.ownerLabel), 'each losing process read and identified the fully published owner record');
    }
  } finally {
    winner?.child.stdin.write('release\\n');
    for (const { child } of candidates) child.stdin.end();
    await Promise.all(candidates.map(async ({ child }) => {
      if (child.exitCode !== null) return;
      await Promise.race([once(child, 'close'), new Promise((resolve) => setTimeout(resolve, 10_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }));
    await rm(dir, { recursive: true, force: true });
  }
  for (const { child, stderr } of candidates) assert.equal(child.exitCode, 0, `subprocess exit ${child.exitCode}; stderr=${stderr}`);
});

test('an independent process cannot take over a live exclusive desktop claim', async () => {
  const dir = await testDirectory();
  const claimPath = path.join(dir, 'claim.lock');
  const modulePath = path.resolve('harness/tools/computer-use/desktop-ownership.ts');
  const source = `
    import { pathToFileURL } from 'node:url';
    const { DesktopCoordinator } = await import(pathToFileURL(process.env.PIE_DESKTOP_MODULE).href);
    const coordinator = new DesktopCoordinator(process.env.PIE_DESKTOP_CLAIM);
    const scope = coordinator.primary(process.env.PIE_DESKTOP_SESSION, 'Sub-agent “Independent process task”');
    await coordinator.run(scope, async () => {
      process.stdout.write('CLAIMED\\n');
      await new Promise((resolve) => process.stdin.once('data', resolve));
    });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PIE_DESKTOP_MODULE: modulePath,
      PIE_DESKTOP_CLAIM: claimPath,
      PIE_DESKTOP_SESSION: path.join(dir, 'subagent-session.jsonl'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  try {
    const deadline = Date.now() + 10_000;
    while (!stdout.includes('CLAIMED\n')) {
      if (Date.now() > deadline) throw new Error(`subprocess did not claim desktop; stdout=${stdout}; stderr=${stderr}`);
      if (child.exitCode !== null) throw new Error(`subprocess exited early (${child.exitCode}): ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const independent = new DesktopCoordinator(claimPath);
    const contender = independent.primary(path.join(dir, 'other-session.jsonl'), 'Pie session “Independent contender”');
    await assert.rejects(
      independent.run(contender, async () => undefined),
      (error: any) => error.code === 'DESKTOP_BUSY'
        && error.message.includes('Sub-agent “Independent process task”')
        && error.message.includes(claimPath),
    );
  } finally {
    child.stdin.write('release\n');
    child.stdin.end();
    await Promise.race([once(child, 'close'), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
  assert.ok(child.exitCode === 0, `subprocess exit ${child.exitCode}; stderr=${stderr}`);
});
