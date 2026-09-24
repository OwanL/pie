// Drift check for the single-source package registry
// (scripts/lib/test-packages.mjs). Fails if any runner (run-tests,
// run-fast-batched-tests, run-typechecks, run-test-files) or any root
// package.json script diverges from the registry — package ids, ordering,
// aliases, compiler differences, batching, and concurrency must all come from
// the registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
  packageOptionalTestRoots,
  packageSourceRoots,
  packageTestRoots,
  resolvePackageEntry,
  typecheckProjectFor,
  isGlobalTestInfra,
} from '../lib/test-packages.mjs';
import { PACKAGE_CONFIGS } from '../run-tests.mjs';
import { fastBatchDefinitions, resolveExistingBatchRoots, rootBatchDirs } from '../run-fast-batched-tests.mjs';
import { buildRunnerInvocation } from '../run-package-group.mjs';
import { classifyTestFile, inferRepoRoot } from '../run-test-files.mjs';
import { createTsconfigOverlay, resolvePackageRoots, resolveTypeScriptCompiler } from '../lib/package-resolution.mjs';
import { resolveProjectCompiler } from '../run-typechecks.mjs';
import { isProtectedDirectoryName } from '../lib/traversal-policy.mjs';

const repoRoot = inferRepoRoot();
const fwd = (p) => p.replace(/\\/g, '/');

function rootsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function assertNoCrossPackageRootOverlaps(entries) {
  const claimedRoots = [];
  for (const entry of entries) {
    const roots = [...packageSourceRoots(entry), ...packageTestRoots(entry)];
    for (const root of roots) {
      const conflict = claimedRoots.find((claimed) => claimed.id !== entry.id && rootsOverlap(claimed.root, root));
      assert.ok(!conflict, `conflicting package roots: ${conflict?.id}:${conflict?.root} overlaps ${entry.id}:${root}`);
      claimedRoots.push({ id: entry.id, root });
    }
  }
}

function globMatchesFile(glob, cwd, absoluteFile) {
  const pattern = glob.replace(/\\/g, '/').replace(/^\.\//u, '');
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
    }
  }
  expression += '$';
  const relative = fwd(path.relative(cwd, absoluteFile));
  return new RegExp(expression, 'u').test(relative);
}

function enumerateTestFiles(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && isProtectedDirectoryName(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) enumerateTestFiles(absolute, output);
    else if (/\.(?:test|spec)\.[^.]+$/u.test(entry.name)) output.push(absolute);
  }
  return output;
}

test('registry entries are well-formed and their directories exist', () => {
  const ids = new Set();
  const dirs = new Set();
  for (const entry of PACKAGE_REGISTRY) {
    assert.equal(ids.has(entry.id), false, `duplicate package id: ${entry.id}`);
    ids.add(entry.id);
    assert.equal(dirs.has(entry.dir), false, `duplicate package dir: ${entry.dir}`);
    dirs.add(entry.dir);
    assert.ok(statSync(path.join(repoRoot, entry.dir)).isDirectory(), `missing package dir: ${entry.dir}`);
    for (const ownedDir of entry.ownedDirs ?? []) {
      assert.ok(statSync(path.join(repoRoot, ownedDir)).isDirectory(), `missing owned source dir: ${ownedDir}`);
    }
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
  assert.deepEqual(PACKAGE_DIRECTIVES, PACKAGE_REGISTRY.flatMap((entry) => {
    const directives = [];
    const seen = new Set();
    for (const root of [...packageSourceRoots(entry), ...packageTestRoots(entry)]) {
      if (seen.has(root)) continue;
      seen.add(root);
      directives.push({ id: entry.id, dir: root });
    }
    return directives;
  }));
  // Roots owned by different verification ids must not overlap: routing is
  // first-match in registration order, so nested claims would misattribute files.
  // Ancestor overlap within one id remains valid (for example package dir/test root).
  assertNoCrossPackageRootOverlaps(PACKAGE_REGISTRY);
  for (const entry of PACKAGE_REGISTRY) {
    const optionalRoots = packageOptionalTestRoots(entry);
    for (const optionalRoot of optionalRoots) {
      assert.ok(packageTestRoots(entry).includes(optionalRoot), `${entry.id} optional root ${optionalRoot} must be a routed test root`);
    }
    // Every routed root of the entry must appear in the classification view.
    const directiveRoots = new Set(PACKAGE_DIRECTIVES.filter(({ id }) => id === entry.id).map(({ dir }) => dir));
    for (const root of [...packageSourceRoots(entry), ...packageTestRoots(entry)]) {
      assert.ok(directiveRoots.has(root), `${entry.id} root ${root} must appear in PACKAGE_DIRECTIVES`);
    }
    assert.ok(packageSourceRoots(entry)[0] === entry.dir, `${entry.id} must keep its install-owner dir as the first routed source root`);
  }
  // Every test file currently enumerated under each existing routed test root
  // must match a run-tests glob. Planned roots are checked once files land.
  for (const entry of PACKAGE_REGISTRY) {
    const config = PACKAGE_CONFIGS.find((candidate) => candidate.id === entry.id);
    assert.ok(config, `${entry.id} must have run-tests metadata`);
    for (const testRoot of packageTestRoots(entry)) {
      const absoluteRoot = path.join(repoRoot, testRoot);
      if (!existsSync(absoluteRoot)) continue;
      for (const testFile of enumerateTestFiles(absoluteRoot)) {
        assert.ok(
          config.testGlobs.some((glob) => globMatchesFile(glob, config.cwd, testFile)),
          `${entry.id} test file ${fwd(path.relative(repoRoot, testFile))} is not covered by any testGlob`,
        );
      }
    }
  }
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

test('root ownership guard rejects nested roots across ids but allows same-owner ancestors', () => {
  assert.doesNotThrow(() => assertNoCrossPackageRootOverlaps([
    { id: 'owner', dir: 'package', testDir: 'package/test' },
  ]));
  assert.throws(() => assertNoCrossPackageRootOverlaps([
    { id: 'parent', dir: 'package' },
    { id: 'nested', dir: 'package/test' },
  ]), /conflicting package roots/);
});

test('test glob coverage includes files under a root, not just a matching subfolder', () => {
  const testFiles = [
    path.join(repoRoot, 'extensions/example/test/unit/a.test.ts'),
    path.join(repoRoot, 'extensions/example/test/integration/b.test.ts'),
  ];
  const partialGlob = 'extensions/example/test/unit/**/*.test.ts';
  assert.equal(testFiles.every((file) => globMatchesFile(partialGlob, repoRoot, file)), false,
    'a glob scoped to one subfolder must not claim full-root coverage');
  const ancestorGlob = 'extensions/example/**/*.test.ts';
  assert.equal(testFiles.every((file) => globMatchesFile(ancestorGlob, repoRoot, file)), true,
    'a complete glob rooted at an ancestor must cover nested test files');
});

test('run-fast-batched-tests.mjs batch plans are registry-derived', () => {
  assert.deepEqual(
    rootBatchDirs,
    [...new Set(ROOT_BATCH_PACKAGE_IDS.flatMap((id) => packageTestRoots(resolvePackageEntry(id))))],
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
    assert.deepEqual(definition.dirs, metadata.testDirs, `${id} batch dirs must cover every routed test root`);
    assert.deepEqual(definition.optionalDirs, metadata.optionalTestDirs, `${id} optional batch roots must come from the registry`);
    assert.deepEqual(metadata.testDirs, packageTestRoots(resolvePackageEntry(id)), `${id} batch testDirs must come from the registry`);
    assert.deepEqual(metadata.optionalTestDirs, packageOptionalTestRoots(resolvePackageEntry(id)), `${id} optional roots must come from the registry`);
    assert.equal(definition.batches, metadata.batches, `${id} batch count`);
    assert.equal(definition.tsxConfig, metadata.tsxConfig, `${id} batch tsxConfig`);
    const expectedCwd = metadata.testCwd ? path.join(repoRoot, metadata.testCwd) : repoRoot;
    assert.equal(fwd(definition.cwd), fwd(expectedCwd), `${id} batch cwd`);
  }
});

test('fast batch root resolution skips only explicit optional roots', () => {
  const root = path.join(repoRoot, 'missing-root-fixture');
  const exists = (absolute) => path.basename(absolute) === 'required';
  assert.deepEqual(
    resolveExistingBatchRoots(['required', 'planned'], ['planned'], root, exists),
    ['required'],
  );
  assert.throws(
    () => resolveExistingBatchRoots(['required', 'missing'], ['planned'], root, exists),
    /Required fast-batch test root is missing: missing/,
  );
  assert.deepEqual(resolveExistingBatchRoots(['planned'], ['planned'], root, () => false), []);
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
    for (const testRoot of packageTestRoots(entry)) {
      // Declared planned roots classify before their directory exists.
      const descriptor = classifyTestFile(repoRoot, `${testRoot}/sample.test.ts`);
      assert.equal(descriptor.id, entry.id);
      const expectedCwd = entry.testCwd ? path.join(repoRoot, entry.testCwd) : repoRoot;
      assert.equal(fwd(descriptor.cwd), fwd(expectedCwd), `${entry.id} focused cwd`);
      assert.equal(descriptor.tsxConfig, entry.tsxConfig, `${entry.id} focused tsxConfig must come from the registry`);
    }
  }
});

test('root package.json extension scripts are the group adapter and all ids stay registry-valid', () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['extensions:test'], 'node ./scripts/run-package-group.mjs tests extensions');
  assert.equal(pkg.scripts['extensions:typecheck'], 'node ./scripts/run-package-group.mjs typechecks extensions');

  // Group membership is registry-derived and the adapter expands it exactly.
  assert.deepEqual(
    PACKAGE_GROUPS.extensions,
    PACKAGE_REGISTRY.filter((entry) =>
      entry.groups?.includes('extensions') ?? entry.dir.startsWith('extensions/'),
    ).map((entry) => entry.id),
  );
  assert.equal(resolvePackageEntry('ask-user')?.dir, 'tools/ask-user');
  assert.ok(PACKAGE_GROUPS.extensions.includes('ask-user'), 'tools/ask-user stays in the extensions group');
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
  for (const id of ['subagent', 'warm-bash', 'deferred-triggers', 'session-changes', 'computer-use', 'playwright']) {
    assert.ok(PACKAGE_GROUPS.extensions.includes(id), `${id} remains in the extensions test/typecheck group`);
  }
});

test('registry tsx configs run through generated owner-relative overlays', () => {
  const ownerRoot = resolvePackageRoots('current').dependencyOwnerRoot;
  const tsxConfigEntries = PACKAGE_REGISTRY.filter((entry) => entry.tsxConfig);
  assert.ok(tsxConfigEntries.length >= 4, 'expected the tsxConfig packages to stay registered');
  for (const entry of tsxConfigEntries) {
    const baseConfig = JSON.parse(readFileSync(path.join(repoRoot, entry.tsxConfig), 'utf8'));
    const overlay = createTsconfigOverlay(path.join(repoRoot, entry.tsxConfig));
    try {
      const parsed = JSON.parse(readFileSync(overlay.configPath, 'utf8'));
      assert.equal(parsed.extends, path.join(repoRoot, entry.tsxConfig), `${entry.id} overlay must extend the registry config`);
      // strict/include/exclude stay inherited from the checked-in base config.
      assert.equal(parsed.compilerOptions?.strict, undefined, `${entry.id} overlay must not duplicate strict`);
      assert.equal(parsed.compilerOptions?.include, undefined, `${entry.id} overlay must not duplicate include`);
      assert.equal(parsed.compilerOptions?.exclude, undefined, `${entry.id} overlay must not duplicate exclude`);
      const overlayPaths = parsed.compilerOptions?.paths ?? {};
      const basePaths = baseConfig.compilerOptions?.paths ?? {};
      // The overlay preserves the base redirection set exactly: every declared
      // alias keeps a redirection, helper-covered keys re-point to explicit
      // absolute owner paths, everything else stays verbatim, and no new
      // aliases appear (test-time module hooks keep their interception set).
      assert.deepEqual(Object.keys(overlayPaths).sort(), Object.keys(basePaths).sort(), `${entry.id} overlay redirection set`);
      for (const [specifier, targets] of Object.entries(basePaths)) {
        const overlayTargets = overlayPaths[specifier];
        if (path.isAbsolute(overlayTargets[0] ?? '')) {
          assert.ok(overlayTargets[0].startsWith(ownerRoot), `${entry.id}:${specifier} must resolve under the dependency owner`);
        } else {
          assert.deepEqual(overlayTargets, targets, `${entry.id}:${specifier} must keep its base target verbatim`);
        }
      }
      for (const spelling of ['@earendil-works/pi-ai', '@mariozechner/pi-ai', 'typebox']) {
        if (!basePaths[spelling]) continue;
        assert.ok(overlayPaths[spelling]?.[0]?.startsWith(ownerRoot), `${entry.id}:${spelling} must resolve under the dependency owner`);
      }
    } finally {
      overlay.dispose();
    }
  }
});

test('typecheck compiler selection agrees with the owner-relative helper resolution', () => {
  assert.equal(resolveTypeScriptCompiler(), path.join(repoRoot, 'extension/node_modules/typescript/bin/tsc'));
  assert.equal(
    resolveTypeScriptCompiler({ dependencyOwnerRoot: path.join(repoRoot, 'analysis') }),
    path.join(repoRoot, 'analysis/node_modules/typescript/bin/tsc'),
  );
  for (const project of TYPECHECK_PROJECTS) {
    assert.equal(resolveProjectCompiler(project), path.join(repoRoot, project.compiler), `compiler for ${project.id}`);
  }
});
