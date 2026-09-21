import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { parseCommandPredicateResult } from '../../../../shared/wake-conditions';
import {
  createCommandPredicateRunner,
  resolveCommandPredicateShell,
} from '../../../src/host/deferred-triggers/command-predicate';

function shellAvailable(): boolean {
  const selection = resolveCommandPredicateShell();
  if (process.platform !== 'win32') return true;
  return selection.shellPath !== 'bash.exe' && fs.existsSync(selection.shellPath);
}

const processTest = shellAvailable() ? test : test.skip;

processTest('real command predicates use exit status and time out as bounded failures', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-command-predicate-test-'));
  try {
    const runner = createCommandPredicateRunner({ killGraceMs: 100 });
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
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
