import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { parseCommandPredicateResult } from '../../../../harness/tools/deferred-triggers/wake-conditions';
import {
  createCommandPredicateRunner,
  resolveCommandPredicateShell,
} from '../../deferred-triggers/command-predicate';
// @ts-expect-error The shared process watchdog is a JavaScript-only helper without a declaration.
import { watchChildProcess as watchChildProcessUntyped } from '../../../../scripts/lib/process-watchdog.mjs';

interface ProcessTreeCleanupResult {
  gone: boolean;
  survivors: number[];
  diagnostics?: string[];
}

interface ChildProcessWatchdog {
  settle(): Promise<ProcessTreeCleanupResult>;
}

type WatchChildProcess = (
  child: ChildProcess,
  options: { timeoutMs: number; label: string },
) => ChildProcessWatchdog;

const watchChildProcess = watchChildProcessUntyped as unknown as WatchChildProcess;

interface TrackedChildProcess {
  child: ChildProcess;
  closed: Promise<void>;
  watchdog: ReturnType<typeof watchChildProcess>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function shellAvailable(): boolean {
  const selection = resolveCommandPredicateShell();
  if (process.platform !== 'win32') return true;
  return selection.shellPath !== 'bash.exe' && fs.existsSync(selection.shellPath);
}

const processTest = shellAvailable() ? test : test.skip;

processTest('real command predicates use exit status and time out as bounded failures', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-command-predicate-test-'));
  const spawnedChildren: TrackedChildProcess[] = [];
  const runner = createCommandPredicateRunner({
    killGraceMs: 100,
    spawnProcess: ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      const watchdog = watchChildProcess(child, {
        timeoutMs: 0,
        label: `command-predicate fixture child ${child.pid ?? 'unknown'}`,
      });
      spawnedChildren.push({ child, closed, watchdog });
      return child;
    }) as typeof spawn,
  });
  let testFailed = false;
  let testError: unknown;
  try {
    const satisfiedResult = await runner({
      kind: 'command',
      command: 'printf not-a-boolean; exit 0',
      cwd,
      intervalMs: 1_000,
      timeoutMs: 1_000,
    });
    assert.equal(satisfiedResult.exitCode, 0);
    assert.deepEqual(parseCommandPredicateResult(satisfiedResult), { satisfied: true });

    const notYetResult = await runner({
      kind: 'command',
      command: 'printf not-a-boolean; exit 1',
      cwd,
      intervalMs: 1_000,
      timeoutMs: 1_000,
    });
    assert.equal(notYetResult.exitCode, 1);
    assert.deepEqual(parseCommandPredicateResult(notYetResult), { satisfied: false });

    const errorResult = await runner({
      kind: 'command',
      command: 'exit 2',
      cwd,
      intervalMs: 1_000,
      timeoutMs: 1_000,
    });
    assert.equal(errorResult.exitCode, 2);
    assert.match(parseCommandPredicateResult(errorResult).error ?? '', /code 2/);

    const timeoutResult = await runner({
      kind: 'command',
      command: 'sleep 2; exit 0',
      cwd,
      intervalMs: 1_000,
      timeoutMs: 50,
    });
    assert.equal(timeoutResult.timedOut, true);
    assert.equal(parseCommandPredicateResult(timeoutResult).satisfied, false);
    assert.match(parseCommandPredicateResult(timeoutResult).error ?? '', /timed out/);
  } catch (error) {
    testFailed = true;
    testError = error;
  }

  const cleanupResults = await Promise.allSettled(
    spawnedChildren.map(({ watchdog }) => watchdog.settle()),
  );
  const cleanupIssues = cleanupResults.flatMap((result, index) => {
    const child = spawnedChildren[index].child;
    const label = `pid ${child.pid ?? 'unknown'}`;
    if (typeof child.pid !== 'number' || !Number.isInteger(child.pid) || child.pid <= 0) {
      return [`${label} spawned child ownership could not be established`];
    }
    if (result.status === 'rejected') return [`${label} watchdog failed: ${describeError(result.reason)}`];
    if (!result.value?.gone) {
      return [`${label} process tree not verified gone: survivors=${JSON.stringify(result.value?.survivors ?? [])}; diagnostics=${JSON.stringify(result.value?.diagnostics ?? [])}`];
    }
    return [];
  });

  if (cleanupIssues.length === 0) {
    await Promise.all(spawnedChildren.map(({ closed }) => closed));
  } else {
    const bodyFailure = testFailed ? ` Test body also failed: ${describeError(testError)}.` : '';
    throw new Error(
      `Refusing to remove command-predicate test cwd ${cwd}; child cleanup is uncertain: ${cleanupIssues.join('; ')}.${bodyFailure}`,
    );
  }

  try {
    fs.rmSync(cwd, { recursive: true, force: true });
  } catch (error) {
    const bodyFailure = testFailed ? ` Test body also failed: ${describeError(testError)}.` : '';
    throw new Error(
      `Failed to remove command-predicate test cwd ${cwd} after verifying child trees are gone: ${describeError(error)}.${bodyFailure}`,
    );
  }
  if (testFailed) throw testError;
});
