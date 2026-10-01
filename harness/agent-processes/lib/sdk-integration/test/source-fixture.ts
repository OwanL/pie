import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageNames = {
  ai: '@earendil-works/pi-ai',
  agent: '@earendil-works/pi-agent-core',
  tui: '@earendil-works/pi-tui',
  codingAgent: '@earendil-works/pi-coding-agent',
} as const;

type SourcePackageRoots = Record<keyof typeof packageNames, string>;

function packageRootFromEntry(entry: string, packageName: string): string {
  let directory = path.dirname(realpathSync(entry));
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as { name?: string };
      if (manifest.name === packageName) return realpathSync(directory);
    } catch {
      // Keep walking toward the package root; the alias target may be several levels deep.
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Could not find ${packageName} package root above tsconfig alias target ${entry}`);
}

function candidateGraphFromTsxConfig(): { piRoot: string; packageRoots: SourcePackageRoots } | undefined {
  const tsconfigPath = process.env.TSX_TSCONFIG_PATH;
  if (!tsconfigPath) return undefined;

  const tsconfig = JSON.parse(readFileSync(path.resolve(tsconfigPath), 'utf8')) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const paths = tsconfig.compilerOptions?.paths;
  // The focused test group's ordinary tsconfig has no TypeBox alias. The
  // test-runner adds it only when --sdk-path selects an explicit SDK graph.
  if (!paths?.typebox) return undefined;

  const packageRoots = Object.fromEntries(
    Object.entries(packageNames).map(([key, packageName]) => {
      const entry = paths[packageName]?.[0];
      if (!entry || !path.isAbsolute(entry)) {
        throw new Error(`Candidate SDK tsconfig is missing an absolute ${packageName} alias`);
      }
      return [key, packageRootFromEntry(entry, packageName)];
    }),
  ) as SourcePackageRoots;
  const piRoot = realpathSync(path.resolve(packageRoots.codingAgent, '../../..'));

  for (const key of Object.keys(packageNames) as Array<keyof typeof packageNames>) {
    const packageName = packageNames[key];
    const expectedRoot = realpathSync(path.join(piRoot, 'node_modules', ...packageName.split('/')));
    if (packageRoots[key] !== expectedRoot) {
      throw new Error(`Candidate ${packageName} is outside the materialized SDK graph: ${packageRoots[key]}`);
    }
  }

  return { piRoot, packageRoots };
}

function workspaceGraph(): { piRoot: string; packageRoots: SourcePackageRoots } {
  const piRoot = realpathSync(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../pi',
  ));
  return {
    piRoot,
    packageRoots: {
      ai: realpathSync(path.join(piRoot, 'packages/ai')),
      agent: realpathSync(path.join(piRoot, 'packages/agent')),
      tui: realpathSync(path.join(piRoot, 'packages/tui')),
      codingAgent: realpathSync(path.join(piRoot, 'packages/coding-agent')),
    },
  };
}

/**
 * Source-only SDK tests default to the checked-out Pi workspace. When the
 * focused test runner receives --sdk-path, its TSX config overlay supplies the
 * explicit materialized graph and this fixture binds all imports and guards to
 * that graph instead.
 */
export const sourceFixture = candidateGraphFromTsxConfig() ?? workspaceGraph();
