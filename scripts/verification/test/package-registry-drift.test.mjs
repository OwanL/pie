// Drift check for the single-source package registry
// (scripts/lib/test-packages.mjs). Fails if any runner (run-tests,
// run-typechecks, run-test-files) or any root
// package.json script diverges from the registry — package ids, ordering,
// aliases, compiler differences, and concurrency must all come from
// the registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import {
  ALL_PACKAGE_IDS,
  PACKAGE_DIRECTIVES,
  PACKAGE_GROUPS,
  PACKAGE_REGISTRY,
  TYPECHECK_PROJECTS,
  packageOptionalTestRoots,
  packageSourceRoots,
  packageTestFiles,
  packageTestRoots,
  resolvePackageEntry,
  typecheckProjectFor,
} from '../../lib/test-packages.mjs';
import { PACKAGE_CONFIGS, runPackage } from '../run-tests.mjs';
import { buildRunnerInvocation } from '../run-package-group.mjs';
import { classifyTestFile, inferRepoRoot, resolveLocalTsx } from '../run-test-files.mjs';
import { createTsconfigOverlay, createTsxResolution, resolvePackageRoots, resolveTypeScriptCompiler } from '../../lib/package-resolution.mjs';
import { resolveProjectCompiler } from '../run-typechecks.mjs';
import { isProtectedDirectoryName } from '../../lib/traversal-policy.mjs';

const repoRoot = inferRepoRoot();
const fwd = (p) => p.replace(/\\/g, '/');

function rootsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function assertNoCrossPackageRootOverlaps(entries) {
  const claimedRoots = [];
  for (const entry of entries) {
    const roots = [...packageSourceRoots(entry), ...packageTestRoots(entry), ...packageTestFiles(entry)];
    for (const root of roots) {
      const conflict = claimedRoots.find((claimed) => claimed.id !== entry.id && rootsOverlap(claimed.root, root));
      assert.ok(!conflict, `conflicting package roots: ${conflict?.id}:${conflict?.root} overlaps ${entry.id}:${root}`);
      claimedRoots.push({ id: entry.id, root });
    }
  }
}

function globMatchesFile(glob, cwd, absoluteFile) {
  // Resolve the literal parent segments first: ../** must stay beneath its
  // host root, not match another ../ segment and escape into application/lib.
  const pattern = fwd(path.resolve(cwd, glob));
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
  return new RegExp(expression, 'u').test(fwd(absoluteFile));
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
    if (entry.testCwd) {
      assert.ok(statSync(path.join(repoRoot, entry.testCwd)).isDirectory(), `missing test cwd: ${entry.testCwd}`);
    }
    for (const ownedDir of entry.ownedDirs ?? []) {
      assert.ok(statSync(path.join(repoRoot, ownedDir)).isDirectory(), `missing owned source dir: ${ownedDir}`);
    }
    if (entry.tsxConfig) assert.ok(existsSync(path.join(repoRoot, entry.tsxConfig)), `missing tsxConfig: ${entry.tsxConfig}`);
    if (entry.testTsx !== undefined) assert.equal(entry.testTsx, 'root', `${entry.id} testTsx must select a supported runner`);
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
    for (const root of [...packageSourceRoots(entry), ...packageTestRoots(entry), ...packageTestFiles(entry)]) {
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
    for (const root of [...packageSourceRoots(entry), ...packageTestRoots(entry), ...packageTestFiles(entry)]) {
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
    for (const relativeTestFile of packageTestFiles(entry)) {
      const testFile = path.join(repoRoot, relativeTestFile);
      assert.ok(existsSync(testFile), `${entry.id} explicit test file is missing: ${relativeTestFile}`);
      assert.ok(
        config.testGlobs.some((glob) => globMatchesFile(glob, config.cwd, testFile)),
        `${entry.id} explicit test file ${relativeTestFile} is not covered by any testGlob`,
      );
      assert.equal(classifyTestFile(repoRoot, relativeTestFile).id, entry.id, `${relativeTestFile} must route to ${entry.id}`);
    }
  }
});

test('extension tests run from the relocated package owner', () => {
  const entry = resolvePackageEntry('extension');
  assert.ok(entry);
  assert.equal(entry.testCwd, entry.dir);
  assert.equal(entry.dir, 'application/hosts/vscode');
});

// Evaluate the collector's actual eligibility predicate without loading its
// conversion dependencies or compiling an SDK. Fail closed if its seam changes.
function sourceCoverageMatcher({ root, cwd, includes }) {
  const source = readFileSync(new URL('../source-coverage.mjs', import.meta.url), 'utf8');
  const exclusions = source.match(/const excluded = new Set\(\[[\s\S]*?\]\);/u)?.[0];
  const predicate = source.match(/  const included = filename => \{[\s\S]*?\n  \};/u)?.[0];
  assert.ok(exclusions && predicate, 'source collector eligibility seam must exist');
  return runInNewContext(`${exclusions}\n${predicate}\nincluded`, { path, root, cwd, includes });
}

function assertCoverageOwnership(config, files) {
  const included = sourceCoverageMatcher({ root: repoRoot, cwd: config.cwd, includes: config.coverageIncludes });
  for (const file of files) assert.ok(included(path.join(repoRoot, file)), `${file} must reach the raw source collector`);
}

test('retained extension coverage follows relocated frontend and host implementations', async () => {
  const config = PACKAGE_CONFIGS.find((candidate) => candidate.id === 'extension');
  const originalIncludes = ['../../frontend/**/*.ts', '../../frontend/**/*.tsx',
    '**/*.ts', '**/*.tsx', '../**/*.ts', '../**/*.tsx'];
  const relocations = [
    ['application/frontend/composer/image-constraints.ts', 'application/lib/composer/image-constraints.ts'],
    ['application/frontend/composer/local-message-id.ts', 'application/lib/composer/local-message-id.ts'],
    ['application/frontend/session-tabs/tab-behavior.ts', 'application/lib/session-tabs/tab-behavior.ts'],
    ['application/frontend/transcript/message-parts.ts', 'application/lib/transcript/message-parts.ts'],
    ['application/frontend/transcript/pruning-totals.ts', 'application/lib/transcript/pruning-totals.ts'],
    ['application/frontend/transcript/render-signature.ts', 'application/lib/transcript/render-signature.ts'],
    ['application/hosts/lib/platform-contracts/browser-server-seam.ts', 'application/lib/platform-contracts/browser-server-seam.ts'],
    ['application/hosts/lib/platform-contracts/platform.ts', 'application/lib/platform-contracts/platform.ts'],
    ['application/hosts/lib/platform-contracts/session-platform.ts', 'application/lib/platform-contracts/session-platform.ts'],
    ['application/hosts/lib/renderer-delivery/renderer-view-state.ts', 'application/lib/renderer-delivery/renderer-view-state.ts'],
    ['application/hosts/lib/renderer-delivery/stream-telemetry.ts', 'application/lib/stream-telemetry.ts'],
  ];
  let collectorOptions;
  let captureEnv;
  await runPackage(config, false, false, [], undefined, { sdkPath: undefined }, {
    createOverlay: () => ({ configPath: 'unused-overlay', dispose() {} }),
    resolveTsx: () => 'unused-tsx',
    createCoverageScope: () => ({ directory: path.join(repoRoot, 'unused-capture'), dispose() {} }),
    runChild: async (_command, _args, cwd, _signal, env) => {
      assert.equal(cwd, config.cwd);
      captureEnv = env;
      return { stdout: '', stderr: '', exitCode: 0, signal: null, teardownConfirmed: true };
    },
    collectCoverage: async (options) => {
      collectorOptions = options;
      return { files: [{ path: 'stub' }] };
    },
  });
  assert.equal(collectorOptions.root, repoRoot);
  assert.equal(collectorOptions.cwd, config.cwd);
  assert.deepEqual(collectorOptions.includes, config.coverageIncludes);
  assert.equal(captureEnv.PIE_TEST_COVERAGE_ROOT, collectorOptions.root);
  assert.equal(captureEnv.PIE_TEST_COVERAGE_CWD, collectorOptions.cwd);
  assert.deepEqual(JSON.parse(captureEnv.PIE_TEST_COVERAGE_INCLUDES), collectorOptions.includes);
  assert.match(captureEnv.NODE_OPTIONS, /coverage-capture\.cjs/u);
  const included = sourceCoverageMatcher(collectorOptions);
  for (const [original, relocated] of relocations) {
    assert.ok(originalIncludes.some((glob) => globMatchesFile(glob, config.cwd, path.join(repoRoot, original))),
      `${original} was in the retained denominator`);
    const absolute = path.join(repoRoot, relocated);
    assert.ok(existsSync(absolute), `${relocated} implementation must exist`);
    assert.ok(!originalIncludes.some((glob) => globMatchesFile(glob, config.cwd, absolute)),
      `${relocated} escapes the old frontend/host roots and needs an explicit include`);
    assert.ok(config.coverageIncludes.some((glob) => globMatchesFile(glob, config.cwd, absolute)),
      `${relocated} must remain in the retained denominator`);
    assert.ok(included(absolute), `${relocated} must reach the pinned raw source collector`);
  }
  const movedTest = 'application/lib/test/renderer-delivery/renderer-view-state.test.ts';
  assert.ok(existsSync(path.join(repoRoot, movedTest)));
  assert.ok(config.testGlobs.some((glob) => globMatchesFile(glob, config.cwd, path.join(repoRoot, movedTest))),
    'the relocated renderer-view-state test must still run in the retained suite');
  assertCoverageOwnership(config, relocations.map(([, relocated]) => relocated));
  for (const copy of ['application/lib/composer/node_modules/image-constraints.ts',
    'application/lib/composer/out-dev/image-constraints.ts',
    'application/lib/composer/coverage/image-constraints.ts']) {
    assert.equal(included(path.join(repoRoot, copy)), false, `${copy} is not source coverage`);
  }
  assert.equal(included(path.resolve(repoRoot, '../application/lib/composer/image-constraints.ts')), false,
    'a copy outside the repository is not source coverage');
  assert.deepEqual(config.thresholds, { lines: 80, branches: 75 });
  // Backend extractions were outside the frontend/host glob scope; do not turn
  // this correction into a new general application/lib coverage gate.
  for (const file of ['application/lib/analytics/live-output-tokens.ts',
    'application/lib/protocol/token-rate.ts', 'application/lib/file-changes/contracts.ts']) {
    assert.ok(!config.coverageIncludes.some((glob) => globMatchesFile(glob, config.cwd, path.join(repoRoot, file))), file);
  }
});

test('retained coverage ownership rejects a mask that drops a relocated implementation', () => {
  const config = PACKAGE_CONFIGS.find((candidate) => candidate.id === 'extension');
  const file = 'application/lib/composer/image-constraints.ts';
  const coverageIncludes = config.coverageIncludes.filter((glob) =>
    !globMatchesFile(glob, config.cwd, path.join(repoRoot, file)));
  assert.ok(coverageIncludes.length > 0, 'the mutation retains unrelated coverage masks');
  assertCoverageOwnership(config, [file]);
  assert.throws(() => assertCoverageOwnership({ ...config, coverageIncludes }, [file]),
    /image-constraints\.ts must reach the raw source collector/u);
});

test('explicit retired source roots remain routed for rename/delete analysis', () => {
  const expectedRetiredRoots = [
    { id: 'extension', root: 'extension' },
    { id: 'analysis', root: 'analysis' },
    { id: 'subagent', root: 'tools/subagent' },
    { id: 'ask-user', root: 'tools/ask-user' },
    { id: 'warm-bash', root: 'tools/warm-bash' },
    { id: 'deferred-triggers', root: 'tools/deferred-triggers' },
    { id: 'session-changes', root: 'tools/session-changes' },
    { id: 'computer-use', root: 'tools/computer-use' },
    { id: 'playwright', root: 'tools/playwright' },
  ];
  const registeredRetiredRoots = PACKAGE_REGISTRY.flatMap((entry) =>
    (entry.retiredSourceDirs ?? []).map((root) => ({ id: entry.id, root })),
  );
  assert.deepEqual(registeredRetiredRoots, expectedRetiredRoots,
    'only known historical rename/delete routes may bypass live-root validation');
  for (const { id, root } of expectedRetiredRoots) {
    assert.equal(existsSync(path.join(repoRoot, root)), false, `${root} must remain an absent historical root`);
    assert.equal(classifyTestFile(repoRoot, `${root}/former-source.test.ts`).id, id, root);
  }
});

test('standalone host tests stay discoverable under the existing extension owner', () => {
  const testFile = 'application/hosts/standalone/test/standalone-host-coordinator.test.ts';
  const entry = resolvePackageEntry('extension');
  const config = PACKAGE_CONFIGS.find((candidate) => candidate.id === 'extension');

  assert.ok(entry);
  assert.ok(config);
  assert.ok(packageTestRoots(entry).includes('application/hosts/standalone/test'));
  assert.equal(classifyTestFile(repoRoot, testFile).id, 'extension');
  assert.ok(
    config.testGlobs.some((glob) => globMatchesFile(glob, config.cwd, path.join(repoRoot, testFile))),
    `${testFile} must be discovered by the existing extension package runner`,
  );
});

test('run-tests.mjs PACKAGE_CONFIGS match the registry exactly (ids, order, aliases, cwd, tsx, concurrency)', () => {
  assert.deepEqual(PACKAGE_CONFIGS.map((config) => config.id), ALL_PACKAGE_IDS, 'run-tests package ids/order must equal the registry');
  for (const [index, config] of PACKAGE_CONFIGS.entries()) {
    const entry = PACKAGE_REGISTRY[index];
    const expectedAliases = entry.aliases ?? [];
    assert.deepEqual(config.aliases ?? [], expectedAliases, `${config.id} aliases`);
    const expectedCwd = entry.testCwd ? path.join(repoRoot, entry.testCwd) : repoRoot;
    assert.equal(fwd(config.cwd), fwd(expectedCwd), `${config.id} test cwd`);
    assert.equal(config.tsxConfig, entry.tsxConfig, `${config.id} tsxConfig must come from the registry`);
    assert.equal(config.testTsx, entry.testTsx, `${config.id} test tsx selection must come from the registry`);
    assert.equal(config.includeOwnerDependencies, entry.includeOwnerDependencies || undefined, `${config.id} dependency owner resolution`);
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

test('run-typechecks.mjs projects cover every registry package with a TS project', () => {
  const expected = TYPECHECK_PROJECTS;
  const registryDerived = PACKAGE_REGISTRY.map(typecheckProjectFor).filter((project) => project !== null);
  assert.deepEqual(expected, registryDerived);
  assert.equal(expected.some((project) => project.id === 'shared'), false);
  assert.equal(existsSync(path.join(repoRoot, 'shared/tsconfig.json')), false);
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
      if (entry.testTsx === 'root') {
        assert.equal(descriptor.tsxBin, resolveLocalTsx(repoRoot), `${entry.id} must use the root tsx CLI`);
      }
      assert.equal(descriptor.includeOwnerDependencies, entry.includeOwnerDependencies || undefined, `${entry.id} focused dependency owner must come from the registry`);
    }
  }
});

test('root package.json extension scripts are the group adapter and all ids stay registry-valid', () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['extensions:test'], 'node ./scripts/verification/run-package-group.mjs tests extensions');
  assert.equal(pkg.scripts['extensions:typecheck'], 'node ./scripts/verification/run-package-group.mjs typechecks extensions');

  // Group membership is registry-derived and the adapter expands it exactly.
  assert.deepEqual(
    PACKAGE_GROUPS.extensions,
    PACKAGE_REGISTRY.filter((entry) =>
      entry.groups?.includes('extensions') ?? entry.dir.startsWith('extensions/'),
    ).map((entry) => entry.id),
  );
  assert.equal(resolvePackageEntry('ask-user')?.dir, 'harness/tools/ask-user');
  assert.ok(PACKAGE_GROUPS.extensions.includes('ask-user'), 'ask-user stays in the extensions group');
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

test('shared PNG processing stays in computer-use coverage', () => {
  const owner = PACKAGE_CONFIGS.find(({ id }) => id === 'computer-use');
  assert.ok(owner.coverageIncludes.includes('harness/tools/png-image.mjs'));
});

test('extension group membership remains stable', () => {
  for (const id of ['subagent', 'warm-bash', 'deferred-triggers', 'session-changes', 'computer-use', 'playwright']) {
    assert.ok(PACKAGE_GROUPS.extensions.includes(id), `${id} remains in the extensions test/typecheck group`);
  }
});

test('registry tsx configs preserve base paths without synthesizing unselected SDK aliases', () => {
  const ownerRoot = resolvePackageRoots('current').dependencyOwnerRoot;
  const helperPaths = createTsxResolution().paths;
  assert.equal(helperPaths['@earendil-works/pi-coding-agent'], undefined);
  assert.equal(helperPaths['@mariozechner/pi-ai'], undefined);
  assert.equal(helperPaths.typebox, undefined);
  assert.ok(helperPaths.preact, 'owner Preact aliases remain available without SDK selection');
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
      // The overlay preserves the base redirection set exactly: owner aliases
      // covered by the helper (notably Preact) become absolute owner paths,
      // while unselected SDK aliases retain their checked-in config targets.
      // No SDK aliases are added and test-time hooks keep their interception set.
      assert.deepEqual(Object.keys(overlayPaths).sort(), Object.keys(basePaths).sort(), `${entry.id} overlay redirection set`);
      for (const [specifier, targets] of Object.entries(basePaths)) {
        const overlayTargets = overlayPaths[specifier];
        if (path.isAbsolute(overlayTargets[0] ?? '')) {
          assert.ok(overlayTargets[0].startsWith(ownerRoot), `${entry.id}:${specifier} must resolve under the dependency owner`);
        } else {
          assert.deepEqual(overlayTargets, targets, `${entry.id}:${specifier} must keep its base target verbatim`);
        }
      }
      if (basePaths.preact) {
        assert.ok(overlayPaths.preact?.[0]?.startsWith(ownerRoot), `${entry.id}:preact must resolve under the dependency owner`);
      }
    } finally {
      overlay.dispose();
    }
  }
});

test('typecheck compiler selection agrees with the owner-relative helper resolution', () => {
  assert.equal(resolveTypeScriptCompiler(), path.join(repoRoot, 'application/hosts/vscode/node_modules/typescript/bin/tsc'));
  assert.equal(
    resolveTypeScriptCompiler({ dependencyOwnerRoot: path.join(repoRoot, 'analytics/analysis') }),
    path.join(repoRoot, 'analytics/analysis/node_modules/typescript/bin/tsc'),
  );
  for (const project of TYPECHECK_PROJECTS) {
    assert.equal(resolveProjectCompiler(project), path.join(repoRoot, project.compiler), `compiler for ${project.id}`);
  }
});
