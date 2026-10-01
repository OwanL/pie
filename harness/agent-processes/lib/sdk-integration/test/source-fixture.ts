import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { GenerationPiRuntimeDescriptor } from '../../../../../lib/pi-runtime/artifact.mjs';
import { after } from 'node:test';
import { verifySdkRuntimeArtifactDescriptor } from '../sdk-runtime-artifact.js';

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

function candidateGraphFromTsxConfig(): { piRoot: string; packageRoots: SourcePackageRoots } {
  const tsconfigPath = process.env.TSX_TSCONFIG_PATH;
  if (!tsconfigPath) throw new Error('Source SDK tests require a verified candidate graph via TSX_TSCONFIG_PATH (--sdk-path).');

  const tsconfig = JSON.parse(readFileSync(path.resolve(tsconfigPath), 'utf8')) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const paths = tsconfig.compilerOptions?.paths;
  if (!paths?.typebox) throw new Error('Source SDK tests require explicit candidate SDK and TypeBox aliases (--sdk-path).');

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

const graph = candidateGraphFromTsxConfig();
export const sourceBackendTarget = {
  platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules,
};

// These fixtures have synchronous importers. Verify in the same Node executable
// before exposing any paths, rather than letting an SDK import race verification.
const verifierUrl = pathToFileURL(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../../../../lib/pi-runtime/artifact.mjs',
)).href;
const verified = JSON.parse(execFileSync(process.execPath, [
  '--input-type=module', '--eval', `
    import { verifyPiRuntimeArtifact } from ${JSON.stringify(verifierUrl)};
    const artifact = await verifyPiRuntimeArtifact(process.argv[1], {
      target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
    });
    process.stdout.write(JSON.stringify(artifact));
  `, graph.piRoot,
], { encoding: 'utf8', timeout: 60_000 })) as {
  artifactDir: string; sdkPath: string; identity: string;
  manifest: GenerationPiRuntimeDescriptor['manifest'];
};
if (verified.artifactDir !== graph.piRoot || verified.sdkPath !== graph.packageRoots.codingAgent) {
  throw new Error('Verified artifact and candidate package graph disagree.');
}
export const sourceDescriptor: GenerationPiRuntimeDescriptor = {
  schemaVersion: 1,
  artifactDir: verified.artifactDir,
  sdkPath: verified.sdkPath,
  cliPath: realpathSync(path.join(verified.sdkPath, 'dist/cli.js')),
  identity: verified.identity,
  manifest: verified.manifest,
};
export const sourceLoadMode = {
  mode: 'source-artifact' as const,
  descriptor: sourceDescriptor,
  backendTarget: sourceBackendTarget,
  surface: 'full' as const,
};

/** Only the explicitly selected, verified immutable artifact graph is allowed. */
export const sourceFixture = graph;

after(async () => {
  // Rehash the candidate, not merely the manifest, after every fixture consumer.
  await verifySdkRuntimeArtifactDescriptor(sourceDescriptor, sourceBackendTarget);
});
