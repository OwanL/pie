import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs, runWithConcurrency, selectProjects, TYPECHECK_PROJECTS } from '../run-typechecks.mjs';

test('parseArgs accepts repeatable projects and concurrency', () => {
  assert.deepEqual(parseArgs(['--project', 'extension', '--project=shared', '--concurrency', '2']), {
    ids: ['extension', 'shared'], concurrency: 2, list: false, help: false,
  });
});

test('selectProjects deduplicates requested projects', () => {
  assert.deepEqual(selectProjects(['shared', 'shared']).map(({ id }) => id), ['shared']);
  assert.throws(() => selectProjects(['missing']), /Unknown typecheck project/);
});

test('subagent release config is a configured typecheck project', () => {
  const subagent = TYPECHECK_PROJECTS.find((project) => project.id === 'subagent');
  assert.ok(subagent, 'subagent must be a configured typecheck project');
  assert.equal(subagent.config, 'extensions/subagent/tsconfig.release.json');
});

test('runWithConcurrency preserves order and limits active work', async () => {
  const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  let active = 0;
  let peak = 0;
  const results = await runWithConcurrency(projects, 2, async (project) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return project.id;
  });
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.equal(peak, 2);
});
