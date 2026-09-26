// B1 inventory enforcement for the repository organization migration
// (docs/plans/REPOSITORY_ORGANIZATION_PLAN.md §B0/B1, manifest
// docs/plans/repository-organization-migration-manifest.json).
//
// Validates that the migration manifest still covers the current working-tree
// inventory while preserving its original source identities:
//  - every extant tracked file and every relevant untracked source/config/docs
//    file is either a record source or an explicitly declared current location
//    (new files are reported, never exempted or self-mapped by this test);
//  - each record source or one of its declared current locations exists; moved
//    sources without an extant current location fail;
//  - target collisions are only allowed when documented in resolvedCollisions
//    (fails on unintended collisions);
//  - explicit `retain` records keep a single self-target (retain exception),
//    and no record source lives under a protected top-level tree
//    (generated protection);
//  - every baseline test-enumeration record is retained (still tracked) or
//    mapped (present as a record source), and routing stays subordinate to
//    scripts/lib/test-packages.mjs (sole routing authority): unknown code
//    ownership fails here instead of silently classifying zero files.
//
// The manifest preserves original source identities and planned targets. For
// settled moves, `currentLocations` maps those original sources to extant
// working-tree paths. Other planned targets are not required to exist yet.
//
// Enumeration is Git-aware (`git ls-files`); no protected tree is traversed.
// Untracked relevance filters to source/config/docs extensions and drops
// top-level protected directories; gitignore (via --exclude-standard) already
// excludes the tracked-ignore runtime/generated trees in this repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_PACKAGE_IDS,
  classifyFileToPackage,
  isUnownedCodeSource,
} from '../../lib/test-packages.mjs';
import { isProtectedDirectoryName } from '../../lib/traversal-policy.mjs';
import { withoutGitRepositoryEnv } from '../../lib/git-environment.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fwd = (p) => p.replace(/\\/g, '/');

/** The manifest under enforcement. */
const MANIFEST_PATH = 'docs/plans/repository-organization-migration-manifest.json';

/** Extensions that make an untracked file relevant inventory (source/config/docs). */
const RELEVANT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx',
  '.json', '.yaml', '.yml', '.toml',
  '.md', '.ps1', '.bat', '.cmd', '.sh',
]);

/** Record actions accepted by the B0 manifest contract. */
const RECORD_ACTIONS = new Set(['move', 'split', 'retain', 'consolidate']);

/**
 * Repo-relative forward-slash path of this test file, used only to annotate
 * the expected "new own file, pending parent mapping" report. It is not an
 * exemption: the file still fails the unmapped check until the parent maps it.
 */
const OWN_TEST_FILE = fwd(path.relative(repoRoot, fileURLToPath(import.meta.url)));

/** Git-aware tracked-file enumeration for the repo (never traverses ignored trees). */
function listGitFiles(args) {
  const stdout = execFileSync('git', args, {
    cwd: repoRoot,
    env: withoutGitRepositoryEnv({ ...process.env }),
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.toString().split('\0').filter(Boolean).map(fwd);
}

/** True if a path's top-level segment is a protected directory name. */
function isTopLevelProtected(relativePath) {
  const [topSegment] = relativePath.split('/');
  return isProtectedDirectoryName(topSegment);
}

/**
 * Untracked relevance: source/config/docs files outside protected top-level
 * trees. `git ls-files --others --exclude-standard` already drops everything
 * gitignored (node_modules, data/, out/, coverage, ...), so the explicit
 * top-level check only guards against ignore drift for generated trees.
 * @param {string} relativePath - repo-relative path with forward slashes
 * @returns {boolean}
 */
export function isRelevantUntrackedFile(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false;
  if (isTopLevelProtected(relativePath)) return false;
  const extension = path.extname(relativePath).toLowerCase();
  return RELEVANT_EXTENSIONS.has(extension);
}

/**
 * Collect the migration inventory: extant tracked files plus relevant
 * untracked files, as sorted repo-relative forward-slash path lists.
 * @returns {{ tracked: string[], untracked: string[] }}
 */
export function collectMigrationInventory() {
  // `git ls-files` includes paths deleted from the working tree. Exclude those
  // so the validator can distinguish original source identities from current
  // locations recorded for settled moves.
  const tracked = listGitFiles(['ls-files', '-z'])
    .filter((file) => existsSync(path.join(repoRoot, file)))
    .sort();
  const untracked = new Set(listGitFiles(['ls-files', '--others', '--exclude-standard', '-z'])
    .filter(isRelevantUntrackedFile));
  // Some explicitly moved package assets (for example .vscodeignore and the
  // VS Code icon) are ignored by generic untracked relevance rules. Include
  // only their exact manifest-declared current paths; this is not a tree scan
  // or an exemption for unrelated ignored/unmapped files.
  for (const locations of Object.values(loadMigrationManifest().currentLocations ?? {})) {
    if (!Array.isArray(locations)) continue;
    for (const location of locations) {
      if (typeof location === 'string' && !tracked.includes(location) && existsSync(path.join(repoRoot, location))) {
        untracked.add(location);
      }
    }
  }
  return { tracked, untracked: [...untracked].sort() };
}

/**
 * Load the migration manifest from the working tree.
 * @returns {object} parsed manifest
 */
export function loadMigrationManifest() {
  return JSON.parse(readFileSync(path.join(repoRoot, MANIFEST_PATH), 'utf8'));
}

/** Build one well-formed synthetic manifest record for regression tests. */
function syntheticRecord(overrides = {}) {
  return {
    source: 'extension/src/feature.ts',
    targets: ['harness/feature.ts'],
    action: 'move',
    owner: 'harness',
    batch: 'B5',
    verification: ['Run focused tests via the registered target-owner test group.'],
    reason: 'synthetic regression record',
    ...overrides,
  };
}

/** Build a minimal well-formed synthetic manifest for regression tests. */
function syntheticManifest(records, resolvedCollisions = [], trackedTestFilesByPackage = {}) {
  return {
    manifestVersion: 1,
    recordCount: records.length,
    records,
    resolvedCollisions,
    currentLocations: {},
    testEnumeration: {
      registryPackageIds: [...ALL_PACKAGE_IDS],
      trackedTestFilesByPackage,
      packages: [],
    },
  };
}

/**
 * Pure validator for the migration manifest against an inventory.
 *
 * Accumulates every problem (grouped by check id) instead of failing fast so
 * a single run reports the complete drift picture.
 *
 * @param {object} manifest - parsed migration manifest
 * @param {{ tracked: string[], untracked: string[] }} inventory - repo-relative paths
 * @returns {{ ok: boolean, problems: { check: string, detail: string }[], unmappedFiles: string[] }}
 */
export function validateMigrationInventory(manifest, inventory) {
  const problems = [];
  const add = (check, detail) => problems.push({ check, detail });
  const inventorySet = new Set([...inventory.tracked, ...inventory.untracked]);
  const recordSources = new Set();

  // --- manifest shape -------------------------------------------------------
  const records = manifest.records;
  if (!Array.isArray(records) || records.length === 0) {
    add('manifest-shape', 'manifest.records must be a non-empty array');
  } else {
    if (manifest.recordCount !== records.length) {
      add('manifest-shape', `recordCount ${manifest.recordCount} does not match records.length ${records.length}`);
    }
    const seenSources = new Set();
    for (const record of records) {
      const { source, targets, action, owner, batch } = record;
      if (typeof source !== 'string' || source.length === 0) {
        add('manifest-shape', `record with missing/empty source: ${JSON.stringify(record.source)}`);
        continue;
      }
      if (seenSources.has(source)) {
        add('duplicate-source', `duplicate record source: ${source}`);
      }
      seenSources.add(source);
      recordSources.add(source);
      if (!Array.isArray(targets) || targets.length === 0 || targets.some((t) => typeof t !== 'string' || t.length === 0)) {
        add('manifest-shape', `record ${source}: targets must be a non-empty array of non-empty strings`);
      }
      if (!RECORD_ACTIONS.has(action)) {
        add('manifest-shape', `record ${source}: unknown action ${JSON.stringify(action)}`);
      }
      if (typeof owner !== 'string' || owner.length === 0) {
        add('manifest-shape', `record ${source}: every source needs a named owner`);
      }
      if (typeof batch !== 'string' || !/^B\d+(?:\/B\d+)*$/u.test(batch)) {
        add('manifest-shape', `record ${source}: batch ${JSON.stringify(batch)} is not a migration batch id`);
      }
    }
  }

  // --- settled current locations --------------------------------------------
  const currentLocationOwners = new Map();
  const documentedCurrentLocationSources = new Map();
  for (const collision of manifest.resolvedCollisions ?? []) {
    const sources = new Set((collision.sources ?? []).map((entry) => entry.split(' (')[0].trim()));
    for (const target of String(collision.target).split(' + ')) {
      documentedCurrentLocationSources.set(target.trim(), sources);
    }
  }
  const currentLocations = manifest.currentLocations ?? {};
  const validCurrentLocations = currentLocations && typeof currentLocations === 'object' && !Array.isArray(currentLocations);
  if (!validCurrentLocations) {
    add('current-location-integrity', 'currentLocations must be an object keyed by original record source');
  } else {
    for (const [source, locations] of Object.entries(currentLocations)) {
      if (!recordSources.has(source)) {
        add('current-location-integrity', `currentLocations source has no manifest record: ${source}`);
      }
      if (!Array.isArray(locations) || locations.length === 0 || locations.some((location) => typeof location !== 'string' || location.length === 0)) {
        add('current-location-integrity', `currentLocations for ${source} must be a non-empty array of non-empty paths`);
        continue;
      }
      for (const location of locations) {
        const protectedLocation = isTopLevelProtected(location);
        if (protectedLocation) {
          add('current-location-integrity', `current location sits under a protected top-level tree: ${location}`);
        }
        if (recordSources.has(source) && !protectedLocation) {
          const owner = currentLocationOwners.get(location);
          if (owner) {
            const documentedSources = documentedCurrentLocationSources.get(location);
            if (!documentedSources?.has(owner) || !documentedSources.has(source)) {
              add('current-location-collision', `current location ${location} is claimed by both ${owner} and ${source}`);
            }
          } else {
            currentLocationOwners.set(location, source);
          }
        }
        if (!inventorySet.has(location)) {
          add('stale-current-location', `settled current location is absent from the working-tree inventory: ${source} -> ${location}`);
        }
      }
      if (inventorySet.has(source) && !locations.includes(source)) {
        add('duplicate-current-source', `original source and settled current location both exist: ${source} -> ${locations.join(', ')}`);
      }
    }
  }

  // --- coverage: unmapped inventory files -----------------------------------
  const unmappedFiles = [];
  for (const file of inventory.tracked) {
    if (!recordSources.has(file) && !currentLocationOwners.has(file)) {
      unmappedFiles.push(file);
      add('unmapped-tracked', `tracked file has no manifest record: ${file}`);
    }
  }
  for (const file of inventory.untracked) {
    if (!recordSources.has(file) && !currentLocationOwners.has(file)) {
      unmappedFiles.push(file);
      add('unmapped-untracked', `relevant untracked file has no manifest record: ${file}`);
    }
  }

  // --- stale sources (deleted / renamed away without a record) ---------------
  for (const source of recordSources) {
    const current = validCurrentLocations ? currentLocations[source] ?? [] : [];
    if (!inventorySet.has(source) && !(Array.isArray(current) && current.some((location) => inventorySet.has(location)))) {
      add('stale-source', `manifest record source and all declared current locations are absent from the inventory: ${source}`);
    }
  }

  // --- collisions (documented resolutions only) ------------------------------
  const targetSources = new Map();
  for (const record of records ?? []) {
    for (const target of record.targets ?? []) {
      const existing = targetSources.get(target) ?? [];
      existing.push(record.source);
      targetSources.set(target, existing);
    }
  }
  const documentedTargets = new Map();
  for (const collision of manifest.resolvedCollisions ?? []) {
    for (const part of String(collision.target).split(' + ')) {
      documentedTargets.set(part.trim(), collision);
    }
  }
  for (const [target, sources] of targetSources) {
    if (sources.length < 2) continue;
    const collision = documentedTargets.get(target);
    if (!collision) {
      add('undocumented-collision', `target ${target} is claimed by ${sources.length} records with no resolvedCollisions entry: ${sources.join(', ')}`);
      continue;
    }
    const documentedSources = (collision.sources ?? []).map((entry) => entry.split(' (')[0].trim());
    for (const source of sources) {
      if (!documentedSources.includes(source)) {
        add('undocumented-collision', `collision on ${target} cites source ${source} that its resolvedCollisions entry does not document`);
      }
    }
  }
  for (const collision of manifest.resolvedCollisions ?? []) {
    for (const entry of collision.sources ?? []) {
      const source = entry.split(' (')[0].trim();
      if (!recordSources.has(source)) {
        add('resolved-collision-integrity', `resolvedCollisions entry ${collision.target} cites source that has no manifest record: ${source}`);
      }
    }
    for (const part of String(collision.target).split(' + ')) {
      const target = part.trim();
      if (!targetSources.has(target)) {
        add('resolved-collision-integrity', `resolvedCollisions target is no record target: ${target}`);
      }
    }
  }

  // --- retain exceptions -----------------------------------------------------
  for (const record of records ?? []) {
    if (record.action === 'retain') {
      if (record.targets?.length !== 1 || record.targets[0] !== record.source) {
        add('retain-disposition', `retain record must keep a single self-target: ${record.source} -> ${JSON.stringify(record.targets)}`);
      }
    } else if (RECORD_ACTIONS.has(record.action) && (record.targets ?? []).every((t) => t === record.source)) {
      add('retain-disposition', `action ${record.action} must change or split the path; a file kept in place needs an explicit retain record: ${record.source}`);
    }
  }

  // --- generated protection --------------------------------------------------
  for (const record of records ?? []) {
    if (typeof record.source === 'string' && isTopLevelProtected(record.source)) {
      add('generated-protection', `record source sits under a protected top-level tree: ${record.source}`);
    }
  }
  for (const file of inventory.tracked) {
    if (isTopLevelProtected(file)) {
      add('generated-protection', `tracked file sits under a protected top-level tree: ${file}`);
    }
  }

  // --- registry routing authority -------------------------------------------
  const testEnumeration = manifest.testEnumeration ?? {};
  const declaredIds = testEnumeration.registryPackageIds;
  if (JSON.stringify(declaredIds) !== JSON.stringify([...ALL_PACKAGE_IDS])) {
    add('registry-routing', `manifest registryPackageIds must equal the registry package ids in order (registry is the sole routing authority): ${JSON.stringify(declaredIds)}`);
  }
  const declaredPackages = testEnumeration.packages ?? [];
  for (const baseline of Object.keys(testEnumeration.trackedTestFilesByPackage ?? {})) {
    if (!ALL_PACKAGE_IDS.includes(baseline)) {
      add('registry-routing', `trackedTestFilesByPackage key is not a registered package id: ${baseline}`);
    }
  }
  for (const declared of declaredPackages) {
    if (declared?.id !== undefined && !ALL_PACKAGE_IDS.includes(declared.id)) {
      add('registry-routing', `testEnumeration package id is not registered: ${declared.id}`);
    }
    if (typeof declared?.trackedTestFiles === 'number') {
      const baseline = testEnumeration.trackedTestFilesByPackage?.[declared.id];
      if (Array.isArray(baseline) && baseline.length !== declared.trackedTestFiles) {
        add('registry-routing', `declared trackedTestFiles ${declared.trackedTestFiles} does not match the baseline array length ${baseline.length} for ${declared.id}`);
      }
    }
  }

  // --- baseline test records: retained or mapped ------------------------------
  for (const [packageId, files] of Object.entries(testEnumeration.trackedTestFilesByPackage ?? {})) {
    for (const file of files) {
      if (inventorySet.has(file)) {
        // Retained: must still route to its registered package.
        if (classifyFileToPackage(file) !== packageId) {
          add('baseline-test-record', `baseline test record routes to ${JSON.stringify(classifyFileToPackage(file))} instead of ${packageId}: ${file}`);
        }
      } else if (!recordSources.has(file)) {
        add('baseline-test-record', `baseline test record is neither retained nor mapped: ${packageId}:${file}`);
      }
    }
  }

  // --- unknown code ownership (fail/broaden, never zero) ---------------------
  for (const file of [...inventory.tracked, ...inventory.untracked]) {
    // A settled location inherits the routing identity of its original source;
    // this keeps test ownership stable without exempting unrelated new paths.
    const routingIdentity = currentLocationOwners.get(file) ?? file;
    if (isUnownedCodeSource(routingIdentity)) {
      add('unknown-ownership', `code file under no registered root (must broaden verification, not silently zero-classify): ${file}${routingIdentity !== file ? ` (original source: ${routingIdentity})` : ''}`);
    }
  }

  return { ok: problems.length === 0, problems, unmappedFiles };
}

/** Format validation problems as a single clear multi-line report. */
function formatProblems(result) {
  const lines = [`repository migration inventory validation failed with ${result.problems.length} problem(s):`];
  const grouped = new Map();
  for (const problem of result.problems) {
    const list = grouped.get(problem.check) ?? [];
    list.push(problem.detail);
    grouped.set(problem.check, list);
  }
  for (const [check, details] of grouped) {
    lines.push(`  ${check} (${details.length}):`);
    for (const detail of details) {
      const annotation = detail.includes(OWN_TEST_FILE) ? ' [expected: own new test file, pending parent mapping]' : '';
      lines.push(`    - ${detail}${annotation}`);
    }
  }
  lines.push('New own files are reported, not exempted and not self-mapped: the parent owns manifest record updates.');
  return lines.join('\n');
}

// --- real inventory -----------------------------------------------------------

test('migration manifest declares an existing plan', () => {
  const manifest = loadMigrationManifest();
  assert.equal(typeof manifest.plan, 'string');
  assert.ok(existsSync(path.join(repoRoot, manifest.plan)), `declared plan does not exist: ${manifest.plan}`);
});

test('migration manifest covers the exact tracked and relevant untracked inventory', () => {
  const manifest = loadMigrationManifest();
  const inventory = collectMigrationInventory();
  const result = validateMigrationInventory(manifest, inventory);
  assert.equal(result.ok, true, formatProblems(result));
});

// --- synthetic regressions ------------------------------------------------------

test('synthetic: tracked file without a record is reported as unmapped', () => {
  const manifest = syntheticManifest([syntheticRecord()]);
  const result = validateMigrationInventory(manifest, {
    tracked: ['extension/src/feature.ts', 'extension/src/stray.ts'],
    untracked: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.check === 'unmapped-tracked' && p.detail.includes('extension/src/stray.ts')));
  assert.deepEqual(result.unmappedFiles, ['extension/src/stray.ts']);
});

test('synthetic: relevant untracked file fails while protected/generated untracked files stay out of inventory', () => {
  assert.equal(isRelevantUntrackedFile('extension/src/new-thing.ts'), true);
  assert.equal(isRelevantUntrackedFile('docs/new-note.md'), true);
  assert.equal(isRelevantUntrackedFile('out/generated.ts'), false);
  assert.equal(isRelevantUntrackedFile('data/queries.json'), false);
  const manifest = syntheticManifest([syntheticRecord()]);
  const result = validateMigrationInventory(manifest, {
    tracked: ['extension/src/feature.ts'],
    untracked: ['extension/src/new-thing.ts'],
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.check === 'unmapped-untracked' && p.detail.includes('extension/src/new-thing.ts')));
});

test('synthetic: deleted record source is reported as stale', () => {
  const manifest = syntheticManifest([
    syntheticRecord(),
    syntheticRecord({ source: 'extension/src/gone.ts', targets: ['harness/gone.ts'] }),
  ]);
  const result = validateMigrationInventory(manifest, {
    tracked: ['extension/src/feature.ts'],
    untracked: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.check === 'stale-source' && p.detail.includes('extension/src/gone.ts')));
});

test('synthetic: explicit current location accounts for a moved source without suppressing unmapped files', () => {
  const manifest = syntheticManifest([
    syntheticRecord({ targets: ['extension/src/current-feature.ts'], owner: 'extension' }),
  ]);
  manifest.currentLocations = {
    'extension/src/feature.ts': ['extension/src/current-feature.ts'],
  };

  const moved = validateMigrationInventory(manifest, {
    tracked: [],
    untracked: ['extension/src/current-feature.ts'],
  });
  assert.equal(moved.ok, true, formatProblems(moved));

  const withUnmapped = validateMigrationInventory(manifest, {
    tracked: [],
    untracked: ['extension/src/current-feature.ts', 'extension/src/unmapped.ts'],
  });
  assert.equal(withUnmapped.ok, false);
  assert.deepEqual(withUnmapped.unmappedFiles, ['extension/src/unmapped.ts']);

  const missingCurrent = validateMigrationInventory(manifest, { tracked: [], untracked: [] });
  assert.ok(missingCurrent.problems.some((p) => p.check === 'stale-current-location'));
  assert.ok(missingCurrent.problems.some((p) => p.check === 'stale-source'));

  const orphanMapping = syntheticManifest([syntheticRecord()]);
  orphanMapping.currentLocations = {
    'extension/src/no-record.ts': ['extension/src/unmapped.ts'],
  };
  const orphanResult = validateMigrationInventory(orphanMapping, {
    tracked: ['extension/src/feature.ts'],
    untracked: ['extension/src/unmapped.ts'],
  });
  assert.ok(orphanResult.problems.some((p) => p.check === 'current-location-integrity'));
  assert.ok(orphanResult.problems.some((p) => p.check === 'unmapped-untracked'));
});

test('synthetic: rename without a record flags both the stale old path and the unmapped new path', () => {
  const manifest = syntheticManifest([syntheticRecord({ source: 'extension/src/old-name.ts' })]);
  const result = validateMigrationInventory(manifest, {
    tracked: ['extension/src/renamed.ts'],
    untracked: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.check === 'stale-source' && p.detail.includes('extension/src/old-name.ts')));
  assert.ok(result.problems.some((p) => p.check === 'unmapped-tracked' && p.detail.includes('extension/src/renamed.ts')));
});

test('synthetic: undocumented duplicate target fails; documented collision is accepted', () => {
  const undocumented = syntheticManifest([
    syntheticRecord({ source: 'extension/src/a.ts' }),
    syntheticRecord({ source: 'extension/src/b.ts', action: 'consolidate' }),
  ]);
  const undocumentedResult = validateMigrationInventory(undocumented, {
    tracked: ['extension/src/a.ts', 'extension/src/b.ts'],
    untracked: [],
  });
  assert.equal(undocumentedResult.ok, false);
  assert.ok(undocumentedResult.problems.some((p) => p.check === 'undocumented-collision' && p.detail.includes('harness/feature.ts')));

  const documented = syntheticManifest(
    [
      syntheticRecord({ source: 'extension/src/a.ts' }),
      syntheticRecord({ source: 'extension/src/b.ts', action: 'consolidate' }),
    ],
    [{
      target: 'harness/feature.ts',
      sources: ['extension/src/a.ts (move, canonical implementation)', 'extension/src/b.ts (consolidate, shim absorbed)'],
      resolution: 'synthetic documented survivor',
    }],
  );
  const documentedResult = validateMigrationInventory(documented, {
    tracked: ['extension/src/a.ts', 'extension/src/b.ts'],
    untracked: [],
  });
  assert.equal(documentedResult.problems.filter((p) => p.check === 'undocumented-collision').length, 0);
});

test('synthetic: documented consolidation may share one current location', () => {
  const target = 'extension/src/shared-result.ts';
  const manifest = syntheticManifest(
    [
      syntheticRecord({ source: 'extension/src/a.ts', targets: [target] }),
      syntheticRecord({ source: 'extension/src/b.ts', action: 'consolidate', targets: [target] }),
    ],
    [{
      target,
      sources: ['extension/src/a.ts (move, canonical implementation)', 'extension/src/b.ts (consolidate, shim absorbed)'],
      resolution: 'synthetic documented survivor',
    }],
  );
  manifest.currentLocations = {
    'extension/src/a.ts': [target],
    'extension/src/b.ts': [target],
  };
  const result = validateMigrationInventory(manifest, { tracked: [target], untracked: [] });
  assert.equal(result.problems.filter((problem) => problem.check === 'current-location-collision').length, 0);
});

test('synthetic: retain records must be explicit single self-targets; other actions may not retain in place', () => {
  const retainOk = syntheticManifest([
    syntheticRecord(),
    syntheticRecord({ source: 'config/kept.json', targets: ['config/kept.json'], action: 'retain' }),
  ]);
  const retainOkResult = validateMigrationInventory(retainOk, {
    tracked: ['extension/src/feature.ts', 'config/kept.json'],
    untracked: [],
  });
  assert.equal(retainOkResult.ok, true);

  const badRetain = syntheticManifest([
    syntheticRecord({ source: 'config/kept.json', targets: ['config/kept.json', 'future/kept.json'], action: 'retain' }),
  ]);
  const badRetainResult = validateMigrationInventory(badRetain, {
    tracked: ['config/kept.json'],
    untracked: [],
  });
  assert.ok(badRetainResult.problems.some((p) => p.check === 'retain-disposition'));

  const moveInPlace = syntheticManifest([
    syntheticRecord({ source: 'extension/src/feature.ts', targets: ['extension/src/feature.ts'] }),
  ]);
  const moveInPlaceResult = validateMigrationInventory(moveInPlace, {
    tracked: ['extension/src/feature.ts'],
    untracked: [],
  });
  assert.ok(moveInPlaceResult.problems.some((p) => p.check === 'retain-disposition'));
});

test('synthetic: baseline test record must be retained or mapped', () => {
  const retained = syntheticManifest(
    [syntheticRecord(), syntheticRecord({ source: 'scripts/test/kept.test.mjs', targets: ['scripts/test/kept.test.mjs'], action: 'retain' })],
    [],
    { scripts: ['scripts/test/kept.test.mjs'] },
  );
  const retainedResult = validateMigrationInventory(retained, {
    tracked: ['extension/src/feature.ts', 'scripts/test/kept.test.mjs'],
    untracked: [],
  });
  assert.equal(retainedResult.ok, true);

  // Mapped: the baseline identity remains its original record source while
  // the actual test file is represented at its declared current location.
  const mapped = syntheticManifest(
    [syntheticRecord(), syntheticRecord({ source: 'old/test/location.test.mjs', targets: ['harness/test/location.test.mjs'] })],
    [],
    { scripts: ['old/test/location.test.mjs'] },
  );
  mapped.currentLocations = {
    'old/test/location.test.mjs': ['extension/test/location.test.mjs'],
  };
  const mappedResult = validateMigrationInventory(mapped, {
    tracked: ['extension/src/feature.ts'],
    untracked: ['extension/test/location.test.mjs'],
  });
  assert.equal(mappedResult.problems.filter((p) => p.check === 'baseline-test-record').length, 0);

  const stale = syntheticManifest(
    [syntheticRecord()],
    [],
    { scripts: ['scripts/test/deleted-without-record.test.mjs'] },
  );
  const staleResult = validateMigrationInventory(stale, {
    tracked: ['extension/src/feature.ts'],
    untracked: [],
  });
  assert.equal(staleResult.ok, false);
  assert.ok(staleResult.problems.some((p) => p.check === 'baseline-test-record' && p.detail.includes('deleted-without-record')));
});

test('synthetic: registry is the sole routing authority', () => {
  const drifted = syntheticManifest([syntheticRecord()], [], {});
  drifted.testEnumeration.registryPackageIds = [...ALL_PACKAGE_IDS.slice(0, -1)];
  const driftedResult = validateMigrationInventory(drifted, {
    tracked: ['extension/src/feature.ts'],
    untracked: [],
  });
  assert.ok(driftedResult.problems.some((p) => p.check === 'registry-routing'));

  const misrouted = syntheticManifest([syntheticRecord()], [], { scripts: ['extension/src/feature.ts'] });
  const misroutedResult = validateMigrationInventory(misrouted, {
    tracked: ['extension/src/feature.ts'],
    untracked: [],
  });
  assert.ok(misroutedResult.problems.some((p) => p.check === 'baseline-test-record' && p.detail.includes('instead of scripts')));

  const unregisteredKey = syntheticManifest([syntheticRecord()], [], { 'not-a-package': ['extension/src/feature.ts'] });
  const unregisteredResult = validateMigrationInventory(unregisteredKey, {
    tracked: ['extension/src/feature.ts'],
    untracked: [],
  });
  assert.ok(unregisteredResult.problems.some((p) => p.check === 'registry-routing' && p.detail.includes('not-a-package')));
});

test('synthetic: unknown code ownership fails instead of silently classifying zero', () => {
  const manifest = syntheticManifest([
    syntheticRecord(),
    syntheticRecord({ source: 'mystery/code.ts', targets: ['harness/mystery/code.ts'], owner: 'harness/mystery' }),
  ]);
  const result = validateMigrationInventory(manifest, {
    tracked: ['extension/src/feature.ts', 'mystery/code.ts'],
    untracked: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.check === 'unknown-ownership' && p.detail.includes('mystery/code.ts')));
});

test('synthetic: duplicate record sources and manifest shape drift fail', () => {
  const duplicateSource = syntheticManifest([
    syntheticRecord(),
    syntheticRecord({ targets: ['harness/other.ts'] }),
  ]);
  const duplicateResult = validateMigrationInventory(duplicateSource, {
    tracked: ['extension/src/feature.ts'],
    untracked: [],
  });
  assert.ok(duplicateResult.problems.some((p) => p.check === 'duplicate-source'));

  const driftedCount = syntheticManifest([syntheticRecord()]);
  driftedCount.recordCount = 99;
  const driftedResult = validateMigrationInventory(driftedCount, {
    tracked: ['extension/src/feature.ts'],
    untracked: [],
  });
  assert.ok(driftedResult.problems.some((p) => p.check === 'manifest-shape' && p.detail.includes('recordCount')));

  const unnamedOwner = syntheticManifest([syntheticRecord({ owner: '' })]);
  const unnamedResult = validateMigrationInventory(unnamedOwner, {
    tracked: ['extension/src/feature.ts'],
    untracked: [],
  });
  assert.ok(unnamedResult.problems.some((p) => p.check === 'manifest-shape' && p.detail.includes('named owner')));
});