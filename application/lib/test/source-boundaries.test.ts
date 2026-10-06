import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

declare const __dirname: string;

const repoRoot = resolve(__dirname, '..', '..', '..');
const sourceExtensions = /\.(?:[cm]?[jt]sx?)$/u;

interface ImportEdge {
  specifier: string;
  typeOnly: boolean;
}

function sourceFiles(owners: readonly string[]): string[] {
  const output = execFileSync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...owners,
  ], { cwd: repoRoot, encoding: 'utf8' });
  return output.split('\0')
    .filter((file) => sourceExtensions.test(file)
      && !/(?:^|\/)test(?:\/|$)|\.test\./u.test(file)
      && existsSync(resolve(repoRoot, file)))
    .sort();
}

function importEdges(source: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const fromClause = /\b(import|export)\s+(type\s+)?([^;'"]*?)\s+from\s*(['"])([^'"]+)\4/g;
  for (const match of source.matchAll(fromClause)) {
    const clause = match[3].trim();
    const namedBindings = clause.startsWith('{') && clause.endsWith('}')
      ? clause.slice(1, -1).split(',').map((binding) => binding.trim()).filter(Boolean)
      : [];
    const onlyTypeBindings = namedBindings.length > 0
      && namedBindings.every((binding) => binding.startsWith('type '));
    edges.push({ specifier: match[5], typeOnly: Boolean(match[2]) || onlyTypeBindings });
  }

  const literalImports = [
    /\bimport\s*(['"])([^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ];
  for (const pattern of literalImports) {
    for (const match of source.matchAll(pattern)) {
      edges.push({ specifier: match[2], typeOnly: false });
    }
  }
  return edges;
}

function resolvesUnder(importer: string, specifier: string, owner: string): boolean {
  const portableSpecifier = specifier.replaceAll('\\', '/');
  let target: string;
  if (portableSpecifier.startsWith('.')) {
    target = resolve(repoRoot, dirname(importer), portableSpecifier);
  } else if (/^(?:application|analytics|harness|lib)\//u.test(portableSpecifier)) {
    target = resolve(repoRoot, portableSpecifier);
  } else {
    return false;
  }

  const ownerPath = resolve(repoRoot, owner);
  const ownerRelative = relative(ownerPath, target);
  return ownerRelative === ''
    || (ownerRelative !== '..' && !ownerRelative.startsWith(`..${sep}`) && !isAbsolute(ownerRelative));
}

function violations(
  owners: readonly string[],
  targetOwner: string,
  { runtimeOnly = false, excludedOwners = [] }: {
    runtimeOnly?: boolean;
    excludedOwners?: readonly string[];
  } = {},
): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(owners)) {
    if (excludedOwners.some((owner) => file === owner || file.startsWith(`${owner}/`))) continue;
    const source = readFileSync(resolve(repoRoot, file), 'utf8');
    for (const edge of importEdges(source)) {
      if ((!runtimeOnly || !edge.typeOnly) && resolvesUnder(file, edge.specifier, targetOwner)) {
        found.push(`${file} -> ${edge.specifier}`);
      }
    }
  }
  return found.sort();
}

test('backend and shared-host production source do not depend on frontend modules', () => {
  assert.deepEqual(
    violations(['application/backend', 'application/hosts/lib'], 'application/frontend'),
    [],
  );
});

test('frontend production source has no backend runtime imports', () => {
  assert.deepEqual(
    violations(['application/frontend'], 'application/backend', { runtimeOnly: true }),
    [],
  );
});

test('analytics core production source has no harness imports, including types', () => {
  assert.deepEqual(
    violations(['analytics'], 'harness', {
      // Analysis is a separate Moon owner; legacy and contract wrappers remain core source.
      excludedOwners: ['analytics/analysis'],
    }),
    [],
  );
});

test('declared Moon project dependencies reference known projects and are acyclic', () => {
  const workspace = parseYaml(readFileSync(resolve(repoRoot, '.moon/workspace.yml'), 'utf8')) as {
    projects: { sources: Record<string, string> };
  };
  const graph = new Map<string, string[]>();
  for (const [id, source] of Object.entries(workspace.projects.sources)) {
    const config = parseYaml(readFileSync(resolve(repoRoot, source, 'moon.yml'), 'utf8')) as {
      dependsOn?: string[];
    };
    // Only declared project edges count, not task deps (including pi:build) or test inputs.
    graph.set(id, config.dependsOn ?? []);
  }
  for (const [id, dependencies] of graph) {
    for (const dependency of dependencies) {
      assert.ok(graph.has(dependency), `${id} depends on unknown Moon project: ${dependency}`);
    }
  }

  const visited = new Set<string>();
  const path: string[] = [];
  function visit(id: string): void {
    const cycleStart = path.indexOf(id);
    assert.equal(cycleStart, -1,
      `Moon project dependency cycle: ${[...path.slice(cycleStart), id].join(' -> ')}`);
    if (visited.has(id)) return;
    path.push(id);
    for (const dependency of graph.get(id)!) visit(dependency);
    path.pop();
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id);
});
