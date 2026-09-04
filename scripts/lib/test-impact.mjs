import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { PACKAGE_DIRECTIVES, classifyFileToPackage, isGlobalTestInfra } from './test-packages.mjs';
import { isProtectedDirectoryName } from './traversal-policy.mjs';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx', '.json', '.css', '.sql', '.yaml', '.yml'];
const SCAN_EXTENSIONS = new Set(SOURCE_EXTENSIONS);
const TEST_FILE = /(?:\.test\.(?:ts|tsx|mts|mjs|js)|\.spec\.(?:ts|tsx|mts|mjs|js))$/u;
const PACKAGE_CONFIG = /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig(?:\.[^/]*)?\.json)$/u;
const MODEL_CONFIG_PATHS = new Set(['models.yaml', 'models.json', 'model-profiles.yaml', 'models.schema.json', 'settings.json']);
const MODEL_CONFIG_TESTS = [
  'extension/test/integration/model-config-sync.test.ts',
  'extension/test/integration/model-profile-coverage.test.ts',
];

function normalize(value) {
  return value.replace(/\\/gu, '/');
}

function walkFiles(repoRoot, relativeDir, output) {
  const absoluteDir = path.join(repoRoot, relativeDir);
  if (!existsSync(absoluteDir)) return;
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    if (entry.isDirectory() && isProtectedDirectoryName(entry.name)) continue;
    const relativePath = normalize(path.posix.join(relativeDir, entry.name));
    if (entry.isDirectory()) walkFiles(repoRoot, relativePath, output);
    else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) output.push(relativePath);
  }
}

export function extractRelativeDependencies(source) {
  const dependencies = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/gu,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]?.startsWith('.')) dependencies.add(match[1]);
    }
  }
  return [...dependencies];
}

function dependencyCandidates(importer, specifier) {
  const base = normalize(path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier)));
  const extension = path.posix.extname(base);
  if (extension) {
    const stem = base.slice(0, -extension.length);
    if (extension === '.js' || extension === '.jsx') return [base, `${stem}.ts`, `${stem}.tsx`];
    if (extension === '.mjs') return [base, `${stem}.mts`];
    if (extension === '.cjs') return [base, `${stem}.cts`];
    return [base];
  }
  return [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
}

export function buildReverseDependencyGraph(files, readSource) {
  const known = new Set(files.map(normalize));
  const reverse = new Map();
  for (const importer of known) {
    let source;
    try { source = readSource(importer); } catch { continue; }
    for (const specifier of extractRelativeDependencies(source)) {
      const dependency = dependencyCandidates(importer, specifier).find((candidate) => known.has(candidate));
      if (!dependency) continue;
      const importers = reverse.get(dependency) ?? new Set();
      importers.add(importer);
      reverse.set(dependency, importers);
    }
  }
  return reverse;
}

export function impactedTestsForChanges({ files, testFiles, changedFiles, readSource }) {
  const normalizedFiles = new Set(files.map(normalize));
  const tests = new Set(testFiles.map(normalize));
  const changed = [...changedFiles].map(normalize);
  const graphFiles = new Set([...normalizedFiles, ...changed]);
  const reverse = buildReverseDependencyGraph([...graphFiles], readSource);
  const impacted = new Set();
  const uncovered = [];

  for (const changedFile of changed) {
    if (tests.has(changedFile)) {
      impacted.add(changedFile);
      continue;
    }
    const queue = [changedFile];
    const visited = new Set(queue);
    let reachedTest = false;
    while (queue.length > 0) {
      const dependency = queue.shift();
      for (const importer of reverse.get(dependency) ?? []) {
        if (visited.has(importer)) continue;
        visited.add(importer);
        if (tests.has(importer)) {
          impacted.add(importer);
          reachedTest = true;
        } else {
          queue.push(importer);
        }
      }
    }
    if (!reachedTest) uncovered.push(changedFile);
  }
  return { testFiles: [...impacted].sort(), uncovered };
}

function owningPackage(file) {
  return classifyFileToPackage(file) ?? (file.startsWith('scripts/') && file.endsWith('.mjs') ? 'scripts' : null);
}

export function planAffectedTests(repoRoot, changedFiles) {
  const normalizedChanges = changedFiles.map(normalize);
  if (normalizedChanges.some(isGlobalTestInfra)) return { mode: 'full', testFiles: [], reasons: ['global test infrastructure changed'] };

  const files = [];
  for (const { dir } of PACKAGE_DIRECTIVES) walkFiles(repoRoot, dir, files);
  walkFiles(repoRoot, 'scripts', files);
  const uniqueFiles = [...new Set(files)];
  const testFiles = uniqueFiles.filter((file) => TEST_FILE.test(file));
  const modelConfigChanged = normalizedChanges.some((file) => MODEL_CONFIG_PATHS.has(file));
  const relevantChanges = normalizedChanges.filter((file) => owningPackage(file) !== null);
  if (relevantChanges.length === 0 && !modelConfigChanged) return { mode: 'none', testFiles: [], reasons: [] };

  const allForPackages = new Set(relevantChanges.filter((file) => PACKAGE_CONFIG.test(file)).map(owningPackage));
  const dependencyChanges = relevantChanges.filter((file) => !allForPackages.has(owningPackage(file)));
  const impact = impactedTestsForChanges({
    files: uniqueFiles,
    testFiles,
    changedFiles: dependencyChanges,
    readSource: (file) => readFileSync(path.join(repoRoot, file), 'utf8'),
  });

  const selected = new Set(impact.testFiles);
  if (modelConfigChanged) {
    for (const testFile of MODEL_CONFIG_TESTS) {
      if (testFiles.includes(testFile)) selected.add(testFile);
    }
  }
  for (const packageId of allForPackages) {
    for (const testFile of testFiles) {
      if (owningPackage(testFile) === packageId) selected.add(testFile);
    }
  }
  for (const uncovered of impact.uncovered) {
    const packageId = owningPackage(uncovered);
    for (const testFile of testFiles) {
      if (owningPackage(testFile) === packageId) selected.add(testFile);
    }
  }
  return {
    mode: selected.size > 0 ? 'files' : 'none',
    testFiles: [...selected].sort(),
    reasons: impact.uncovered.map((file) => `no dependency edge for ${file}; selected its package`),
  };
}
