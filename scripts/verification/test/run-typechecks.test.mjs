import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArgs, resolveProjectCompiler, runWithConcurrency, selectProjects, TYPECHECK_PROJECTS } from '../run-typechecks.mjs';
import { resolveTypeScriptCompiler } from '../../lib/package-resolution.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('parseArgs accepts repeatable projects and concurrency', () => {
  assert.deepEqual(parseArgs(['--project', 'extension', '--project=analysis', '--concurrency', '2']), {
    ids: ['extension', 'analysis'], concurrency: 2, list: false, help: false,
  });
});

test('selectProjects deduplicates requested projects', () => {
  assert.deepEqual(selectProjects(['extension', 'extension']).map(({ id }) => id), ['extension']);
  assert.throws(() => selectProjects(['missing']), /Unknown typecheck project/);
});

test('subagent release config is a configured typecheck project', () => {
  const subagent = TYPECHECK_PROJECTS.find((project) => project.id === 'subagent');
  assert.ok(subagent, 'subagent must be a configured typecheck project');
  assert.equal(subagent.config, 'harness/tools/subagent/tsconfig.release.json');
});

test('detached application source projects resolve dependencies through the registered owner', () => {
  for (const id of ['extension', 'analytics-runtime', 'conversation-state']) {
    const project = TYPECHECK_PROJECTS.find((candidate) => candidate.id === id);
    assert.equal(project?.includeOwnerDependencies, true, `${id} uses the application dependency owner`);
  }
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

test('resolveProjectCompiler resolves the registry-declared compiler owner-relatively', (t) => {
  const extensionTsc = resolveProjectCompiler({ compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' });
  assert.equal(extensionTsc, resolveTypeScriptCompiler());
  assert.equal(path.isAbsolute(extensionTsc), true);
  assert.equal(
    resolveProjectCompiler({ compiler: 'analytics/analysis/node_modules/typescript/bin/tsc' }),
    resolveTypeScriptCompiler({ dependencyOwnerRoot: path.join(repoRoot, 'analytics/analysis') }),
  );

  // Absolute declarations (future-root proof projects) pass through unchanged.
  const absolute = path.join(os.tmpdir(), 'pie-tsc-proof', 'tsc');
  assert.equal(resolveProjectCompiler({ compiler: absolute }), absolute);

  // The owner is the complete path before the explicit compiler suffix, not
  // just the first directory component (future planned owner is nested).
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-nested-tsc-owner-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const nestedCompiler = path.join(fixtureRoot, 'application', 'hosts', 'vscode', 'node_modules', 'typescript', 'bin', 'tsc');
  mkdirSync(path.dirname(nestedCompiler), { recursive: true });
  writeFileSync(path.join(path.dirname(path.dirname(nestedCompiler)), 'package.json'), JSON.stringify({ name: 'typescript', version: '0.0.0-fixture' }));
  writeFileSync(nestedCompiler, '');
  assert.equal(
    resolveProjectCompiler({ compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' }, fixtureRoot),
    nestedCompiler,
  );

  // Invalid declarations fail validation, and valid owners still fail loudly
  // if they do not provide TypeScript instead of falling back to another copy.
  assert.throws(() => resolveProjectCompiler({ compiler: '' }), /non-empty path/);
  assert.throws(
    () => resolveProjectCompiler({ compiler: 'application/hosts/vscode/node_modules/typescript/tsc' }),
    /must end with/,
  );
  assert.throws(
    () => resolveProjectCompiler({ compiler: 'docs/node_modules/typescript/bin/tsc' }),
    /Cannot find module|Cannot find package|typescript/,
  );
});
