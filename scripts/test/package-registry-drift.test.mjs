// Drift check for the single-source package registry
// (scripts/lib/test-packages.mjs). Fails if any runner (run-tests,
// run-fast-batched-tests, run-typechecks, run-test-files) or any root
// package.json script diverges from the registry — package ids, ordering,
// aliases, compiler differences, batching, and concurrency must all come from
// the registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_PACKAGE_IDS,
  PACKAGE_DIRECTIVES,
  PACKAGE_GROUPS,
  PACKAGE_REGISTRY,
  ROOT_BATCH_PACKAGE_IDS,
  TYPECHECK_PROJECTS,
  fastBatchMetadata,
  packageTestDir,
  resolvePackageEntry,
  typecheckProjectFor,
  isGlobalTestInfra,
} from '../lib/test-packages.mjs';
import { PACKAGE_CONFIGS } from '../run-tests.mjs';
import { fastBatchDefinitions, rootBatchDirs } from '../run-fast-batched-tests.mjs';
import { buildRunnerInvocation } from '../run-package-group.mjs';
import { classifyTestFile, inferRepoRoot } from '../run-test-files.mjs';

const repoRoot = inferRepoRoot();
const fwd = (p) => p.replace(/\\/g, '/');

test('registry entries are well-formed and their directories exist', () => {
  const ids = new Set();
  const dirs = new Set();
  for (const entry of PACKAGE_REGISTRY) {
    assert.equal(ids.has(entry.id), false, `duplicate package id: ${entry.id}`);
    ids.add(entry.id);
    assert.equal(dirs.has(entry.dir), false, `duplicate package dir: ${entry.dir}`);
    dirs.add(entry.dir);
    assert.ok(statSync(path.join(repoRoot, entry.dir)).isDirectory(), `missing package dir: ${entry.dir}`);
    if (entry.tsxConfig) assert.ok(existsSync(path.join(repoRoot, entry.tsxConfig)), `missing tsxConfig: ${entry.tsxConfig}`);
    if (entry.typecheck) {
      assert.ok(existsSync(path.join(repoRoot, entry.typecheck.config)), `missing typecheck config: ${entry.typecheck.config}`);
      assert.ok(existsSync(path.join(repoRoot, entry.typecheck.compiler)), `missing tsc compiler: ${entry.typecheck.compiler}`);
    }
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        assert.equal(resolvePackageEntry(alias)?.id, entry.id, `alias ${alias} must resolve to ${entry.id}`);
      }
    }
    if (entry.fastConcurrency !== undefined) {
      assert.ok(Number.isInteger(entry.fastConcurrency) && entry.fastConcurrency >= 1, `${entry.id} fastConcurrency must be a positive integer`);
    }
  }
  assert.deepEqual(ALL_PACKAGE_IDS, [...ids]);
  assert.deepEqual(PACKAGE_DIRECTIVES, PACKAGE_REGISTRY.map(({ id, dir }) => ({ id, dir })));
});

test('run-tests.mjs PACKAGE_CONFIGS match the registry exactly (ids, order, aliases, cwd, tsx, batching, concurrency)', () => {
  assert.deepEqual(PACKAGE_CONFIGS.map((config) => config.id), ALL_PACKAGE_IDS, 'run-tests package ids/order must equal the registry');
  for (const [index, config] of PACKAGE_CONFIGS.entries()) {
    const entry = PACKAGE_REGISTRY[index];
    const expectedAliases = entry.aliases ?? [];
    assert.deepEqual(config.aliases ?? [], expectedAliases, `${config.id} aliases`);
    const expectedCwd = entry.testCwd ? path.join(repoRoot, entry.testCwd) : repoRoot;
    assert.equal(fwd(config.cwd), fwd(expectedCwd), `${config.id} test cwd`);
    assert.equal(config.tsxConfig, entry.tsxConfig, `${config.id} tsxConfig must come from the registry`);
    assert.equal(config.fastBatchMode, entry.fastBatch ? entry.id : undefined, `${config.id} fastBatchMode`);
    assert.equal(config.fastConcurrency, entry.fastConcurrency, `${config.id} fastConcurrency`);
    assert.ok(config.testGlobs.length > 0, `${config.id} must declare testGlobs`);
  }
  // The alias flag path (`--package analytics`) must resolve through PACKAGE_CONFIGS.
  assert.ok(PACKAGE_CONFIGS.some((config) => config.id === 'analysis' && config.aliases?.includes('analytics')));
});

test('run-fast-batched-tests.mjs batch plans are registry-derived', () => {
  assert.deepEqual(
    rootBatchDirs,
    ROOT_BATCH_PACKAGE_IDS.map((id) => packageTestDir(resolvePackageEntry(id))),
  );
  const expectedModes = Object.fromEntries(
    PACKAGE_REGISTRY
      .map((entry) => [entry.id, fastBatchMetadata(entry)])
      .filter(([, metadata]) => metadata !== null),
  );
  assert.deepEqual(Object.keys(fastBatchDefinitions).sort(), Object.keys(expectedModes).sort());
  for (const [id, metadata] of Object.entries(expectedModes)) {
    const definition = fastBatchDefinitions[id];
    assert.equal(fwd(definition.dir), metadata.testDir, `${id} batch dir`);
    assert.equal(definition.batches, metadata.batches, `${id} batch count`);
    assert.equal(definition.tsxConfig, metadata.tsxConfig, `${id} batch tsxConfig`);
    const expectedCwd = metadata.testCwd ? path.join(repoRoot, metadata.testCwd) : repoRoot;
    assert.equal(fwd(definition.cwd), fwd(expectedCwd), `${id} batch cwd`);
  }
});

test('run-typechecks.mjs projects cover shared plus every registry package with a TS project', () => {
  assert.equal(TYPECHECK_PROJECTS[0].id, 'shared');
  const expected = TYPECHECK_PROJECTS;
  const registryDerived = [
    expected[0],
    ...PACKAGE_REGISTRY.map(typecheckProjectFor).filter((project) => project !== null),
  ];
  assert.deepEqual(expected, registryDerived);
  const ids = new Set(expected.map((project) => project.id));
  assert.equal(ids.size, expected.length, 'typecheck project ids must be unique');
  for (const project of expected) {
    assert.ok(existsSync(path.join(repoRoot, project.config)), `missing typecheck tsconfig: ${project.config}`);
    assert.ok(existsSync(path.join(repoRoot, project.compiler)), `missing compiler: ${project.compiler}`);
  }
  for (const entry of PACKAGE_REGISTRY) {
    if (entry.typecheck) {
      assert.ok(ids.has(entry.id), `registry package ${entry.id} has a tsconfig but no typecheck project`);
    } else {
      assert.equal(ids.has(entry.id), false, `registry package ${entry.id} has no tsconfig but a typecheck project exists`);
    }
  }
});

test('run-test-files.mjs focused classification uses the registry tsxConfig and test cwd', () => {
  for (const entry of PACKAGE_REGISTRY) {
    const descriptor = classifyTestFile(repoRoot, `${entry.dir}/test/sample.test.ts`);
    assert.equal(descriptor.id, entry.id);
    const expectedCwd = entry.testCwd ? path.join(repoRoot, entry.testCwd) : repoRoot;
    assert.equal(fwd(descriptor.cwd), fwd(expectedCwd), `${entry.id} focused cwd`);
    assert.equal(descriptor.tsxConfig, entry.tsxConfig, `${entry.id} focused tsxConfig must come from the registry`);
  }
});

test('root package.json extension scripts are the group adapter and all ids stay registry-valid', () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['extensions:test'], 'node ./scripts/run-package-group.mjs tests extensions');
  assert.equal(pkg.scripts['extensions:typecheck'], 'node ./scripts/run-package-group.mjs typechecks extensions');

  // Group membership is registry-derived and the adapter expands it exactly.
  assert.deepEqual(
    PACKAGE_GROUPS.extensions,
    PACKAGE_REGISTRY.filter((entry) => entry.dir.startsWith('extensions/')).map((entry) => entry.id),
  );
  const expectedTestFlags = PACKAGE_GROUPS.extensions.flatMap((id) => ['--package', id]);
  assert.deepEqual(buildRunnerInvocation('tests', ['extensions']).args, expectedTestFlags);
  const expectedProjectFlags = PACKAGE_GROUPS.extensions.flatMap((id) => ['--project', id]);
  assert.deepEqual(buildRunnerInvocation('typechecks', ['extensions']).args, expectedProjectFlags);
  assert.throws(() => buildRunnerInvocation('tests', ['nope']), /Unknown package group/);

  // Every other --package/--project reference in root scripts must be a valid
  // registry id (or alias) / typecheck project id.
  const validPackages = new Set(ALL_PACKAGE_IDS.concat(PACKAGE_REGISTRY.flatMap((entry) => entry.aliases ?? [])));
  const validProjects = new Set(TYPECHECK_PROJECTS.map((project) => project.id));
  for (const [name, script] of Object.entries(pkg.scripts)) {
    for (const match of String(script).matchAll(/--package[= ]([a-z0-9-]+)/gu)) {
      assert.ok(validPackages.has(match[1]), `script ${name} references unknown --package ${match[1]}`);
    }
    for (const match of String(script).matchAll(/--project[= ]([a-z0-9-]+)/gu)) {
      assert.ok(validProjects.has(match[1]), `script ${name} references unknown --project ${match[1]}`);
    }
  }
});

test('runner scripts and the group adapter stay classified as global test infrastructure', () => {
  for (const script of [
    'scripts/run-tests.mjs',
    'scripts/run-test-files.mjs',
    'scripts/run-affected-tests.mjs',
    'scripts/run-fast-extension-tests.mjs',
    'scripts/run-fast-batched-tests.mjs',
    'scripts/run-package-group.mjs',
    'scripts/test-reporter.mjs',
  ]) {
    assert.equal(isGlobalTestInfra(script), true, `${script} must select all packages when changed`);
  }
  assert.equal(isGlobalTestInfra('scripts/lib/test-packages.mjs'), true);
});