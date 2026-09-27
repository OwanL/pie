import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { buildCommandPlan } from '../bootstrap.mjs';
import { repoRoot } from '../toolchain.mjs';

test('bootstrap command plan uses current script locations and host build cwd', () => {
  const plan = buildCommandPlan({ packageSources: ['npm:fixture-package'] });
  const nodeSteps = plan.filter(({ command }) => command === process.execPath);

  assert.deepEqual(nodeSteps.map(({ args }) => args), [
    ['scripts/model-config/sync-models.mjs', '--check'],
    ['scripts/diagnostics/doctor.mjs', '--skip-model-check'],
  ]);
  for (const { args, cwd } of nodeSteps) {
    assert.ok(existsSync(path.resolve(cwd, args[0])), `missing bootstrap script: ${args[0]}`);
  }

  assert.ok(plan.some(({ command, args }) => command === 'pi' && args[0] === 'install' && args[1] === 'npm:fixture-package'));
  assert.ok(plan.some(({ command, args, cwd }) =>
    command === 'npm'
    && args[0] === 'run'
    && args[1] === 'build'
    && cwd === path.join(repoRoot, 'application', 'hosts', 'vscode')));
  assert.equal(plan.at(-1).cwd, repoRoot);
});
