import assert from 'node:assert/strict';
import test from 'node:test';

import { execFastPath } from '../src/fast-path.js';

const INHERITED_PIPE_HOLD_MS = 2_500;

/**
 * A short-lived launcher whose detached descendant inherits stdout/stderr.
 * The launcher exits immediately, but Node's ChildProcess `close` event is
 * delayed until the descendant releases those pipes.
 */
function inheritedPipeLauncherScript(emitContinuously = false): string {
  const descendantScript = emitContinuously
    ? `
      process.stdout.on('error', () => {});
      const writer = setInterval(() => process.stdout.write('.'), 25);
      setTimeout(() => { clearInterval(writer); process.exit(0); }, ${INHERITED_PIPE_HOLD_MS});
      process.send?.('ready', () => process.disconnect?.());
    `
    : `setTimeout(() => {}, ${INHERITED_PIPE_HOLD_MS})`;
  return `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], {
      detached: true,
      stdio: ${emitContinuously ? "['ignore', 'inherit', 'inherit', 'ipc']" : "['ignore', 'inherit', 'inherit']"},
      windowsHide: true,
    });
    const releaseLauncher = () => {
      descendant.unref();
      process.stdout.write('launcher-exiting\\n');
    };
    ${emitContinuously ? "descendant.once('message', releaseLauncher);" : "releaseLauncher();"}
  `;
}

test('fast path settles after the direct child exits even when a descendant inherits stdio', async () => {
  // Measure from the launcher's own exit marker, not from spawn: process
  // spawn + Node startup latency on a loaded machine is unrelated to the
  // executor's settlement behavior, and absolute-from-spawn budgets were
  // flaky under the parallel fast suite. A correct executor settles ~100ms
  // after the launcher exits (post-exit idle grace); one that waits for the
  // inherited pipes would hold until the descendant releases them
  // (INHERITED_PIPE_HOLD_MS later) and still fail this post-exit budget.
  let launcherExitedAt = -1;
  const result = await execFastPath({
    program: process.execPath,
    args: ['-e', inheritedPipeLauncherScript()],
    cwd: null,
    baseCwd: process.cwd(),
    env: process.env,
    onData: (data) => {
      if (data.toString().includes('launcher-exiting')) launcherExitedAt = Date.now();
    },
  });

  assert.equal(result.exitCode, 0);
  assert.ok(launcherExitedAt >= 0, 'launcher exit marker must be observed');
  assert.ok(
    Date.now() - launcherExitedAt < 1_500,
    'executor must not wait for the inherited pipe holder to exit',
  );
});

test('fast path abort settles after the launcher exits while its descendant still writes', async () => {
  const controller = new AbortController();
  let sawLauncherExitMarker: (() => void) | undefined;
  const launcherExitMarker = new Promise<void>((resolve) => { sawLauncherExitMarker = resolve; });
  const execution = execFastPath({
    program: process.execPath,
    args: ['-e', inheritedPipeLauncherScript(true)],
    cwd: null,
    baseCwd: process.cwd(),
    env: process.env,
    onData: (data) => {
      if (data.toString().includes('launcher-exiting')) sawLauncherExitMarker?.();
    },
    signal: controller.signal,
  });

  await launcherExitMarker;
  // The launcher waits for the descendant's IPC-ready signal before emitting
  // this marker and exiting. Its continuing output therefore keeps re-arming
  // the post-exit idle grace while we trigger cancellation.
  await new Promise((resolve) => setTimeout(resolve, 25));
  // Anchor the budget to the abort call, not spawn: the correct path settles
  // synchronously inside onAbort (killTree is fire-and-forget), so only
  // pre-abort spawn/startup latency is excluded. A broken executor that waits
  // for inherited pipes would hold until the descendant exits (~2.5s later).
  const abortedAt = Date.now();
  controller.abort();
  await assert.rejects(execution, /aborted/);
  assert.ok(Date.now() - abortedAt < 1_500, 'abort must not wait for inherited pipes');
});

test('fast path timeout settles while an exited launcher descendant holds active pipes', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    execFastPath({
      program: process.execPath,
      args: ['-e', inheritedPipeLauncherScript(true)],
      cwd: null,
      baseCwd: process.cwd(),
      env: process.env,
      onData: () => undefined,
      timeout: 0.4,
    }),
    /timeout:0\.4/,
  );
  // The timeout timer is armed at spawn, so this budget must include spawn
  // latency (unlike the sibling tests, which anchor to post-spawn events).
  // 2s still sits well under the 2.5s descendant hold that a pipe-waiting
  // executor would wait out before settling.
  assert.ok(Date.now() - startedAt < 2_000, 'timeout must not wait for inherited pipes');
});

test('immediate abort retains a spawn-error sink for an invalid cwd', async () => {
  const controller = new AbortController();
  const execution = execFastPath({
    program: process.execPath,
    args: ['--version'],
    cwd: null,
    baseCwd: `${process.cwd()}/definitely-missing-${Date.now()}`,
    env: process.env,
    onData: () => undefined,
    signal: controller.signal,
  });

  controller.abort();
  await assert.rejects(execution, /aborted/);
  // The asynchronous ChildProcess error arrives after local cancellation. If
  // its listener was removed, node:test would fail on the uncaught exception.
  await new Promise((resolve) => setTimeout(resolve, 50));
});
