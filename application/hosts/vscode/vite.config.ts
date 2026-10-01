import { defineConfig, type Plugin } from 'vite';
import tailwindcssPostcss from '@tailwindcss/postcss';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
// The shared resolver is JavaScript-only and intentionally has no production
// TypeScript dependency. Keep the config seam typed at its use site.
// @ts-expect-error The repository build helper is an ESM .mjs module without a declaration file.
import { createViteAliases } from '../../../scripts/lib/package-resolution.mjs';
// @ts-expect-error The plain-Node traversal adapter is an ESM .mjs module without declarations.
import { isProtectedDirectoryName } from '../../../scripts/lib/traversal-policy.mjs';

const rootDir = path.dirname(url.fileURLToPath(import.meta.url));
const repoDir = path.resolve(rootDir, '../../..');
const vscodeHostDir = path.join(repoDir, 'application', 'hosts', 'vscode');
const hostsDir = path.join(repoDir, 'application', 'hosts');
const frontendDir = path.join(repoDir, 'application', 'frontend');
// Internal propagation from build.mjs's validated --output-dir boundary.
const isolatedOutputDir = process.env.PIE_BUILD_OUTPUT_DIR;
const isolatedPiRuntimeSdkPath = isolatedOutputDir ? process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH || undefined : undefined;
const isolatedPiRuntimeIdentity = isolatedOutputDir ? process.env.PIE_BUILD_PI_RUNTIME_IDENTITY || undefined : undefined;
const outDir = isolatedOutputDir || path.join(rootDir, 'out');

/**
 * Package imports resolve through the explicit dependency owner, never the
 * config's working directory: current and legacy Pi spellings map to the SDK's
 * nested graph (including the private pi-ai/TypeBox identity), and Preact
 * keeps its owner-installed files and subpaths. Native tools keep their own
 * sidecar owners and stay unaliased. The Node host and browser renderer use
 * their respective package export conditions so Node-only dependencies such
 * as ws never resolve to a browser stub in the host bundle.
 */
const packageAliases = createViteAliases({
  layout: 'planned',
  ...(isolatedPiRuntimeSdkPath ? { sdkPath: isolatedPiRuntimeSdkPath } : {}),
});
const nodePackageAliases = createViteAliases({
  layout: 'planned',
  conditions: ['node', 'require', 'import', 'default'],
  ...(isolatedPiRuntimeSdkPath ? { sdkPath: isolatedPiRuntimeSdkPath } : {}),
});

const webviewOutDir = path.join(outDir, 'webview', 'panel');
const BUILD_ID_SENTINEL = '__PIE_COMPILED_BUILD_ID_REPLACE__';

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) return isProtectedDirectoryName(entry.name) ? [] : sourceFiles(resolved);
      return entry.isFile() ? [resolved] : [];
    });
}

/** Deterministic across the separately-started node and webview builds. */
function buildIdentityInputs(identityRoot = rootDir): string[] {
  // The explicit root parameter remains a fixture seam; production hashes
  // source at the repository root while emitting under the package owner.
  const production = identityRoot === rootDir;
  const applicationFrontendRoot = production ? frontendDir : path.join(identityRoot, 'frontend');
  const helperRoot = production ? repoDir : path.dirname(identityRoot);
  const buildHelpers = path.join(helperRoot, 'scripts', 'build');
  const harnessInstructions = path.join(repoDir, 'harness', 'agent-instructions');
  const harnessTools = path.join(production ? repoDir : identityRoot, 'harness', 'tools');
  const harnessModelProviders = path.join(production ? repoDir : identityRoot, 'harness', 'model-providers');
  const toolAndSkillSelection = path.join(production ? repoDir : identityRoot, 'harness', 'tool-and-skill-selection');
  const harnessSessionStorage = path.join(production ? repoDir : identityRoot, 'harness', 'session-storage');
  const harnessAgentProcesses = path.join(production ? repoDir : identityRoot, 'harness', 'agent-processes');
  const applicationBackend = path.join(production ? repoDir : identityRoot, 'application', 'backend');
  const applicationHosts = path.join(production ? repoDir : identityRoot, 'application', 'hosts');
  const applicationLib = path.join(production ? repoDir : identityRoot, 'application', 'lib');
  const rootLib = path.join(production ? repoDir : identityRoot, 'lib');
  return [
    ...(production && fs.existsSync(harnessInstructions) ? sourceFiles(harnessInstructions) : []),
    ...(fs.existsSync(harnessTools) ? sourceFiles(harnessTools) : []),
    ...(fs.existsSync(harnessModelProviders) ? sourceFiles(harnessModelProviders) : []),
    ...(fs.existsSync(toolAndSkillSelection) ? sourceFiles(toolAndSkillSelection) : []),
    ...(fs.existsSync(harnessSessionStorage) ? sourceFiles(harnessSessionStorage) : []),
    ...(fs.existsSync(harnessAgentProcesses) ? sourceFiles(harnessAgentProcesses) : []),
    ...(production && fs.existsSync(applicationBackend) ? sourceFiles(applicationBackend) : []),
    ...(fs.existsSync(applicationHosts) ? sourceFiles(applicationHosts) : []),
    ...(production && fs.existsSync(applicationFrontendRoot) ? sourceFiles(applicationFrontendRoot) : []),
    ...(production && fs.existsSync(applicationLib) ? sourceFiles(applicationLib) : []),
    ...(fs.existsSync(rootLib) ? sourceFiles(rootLib) : []),
    ...(fs.existsSync(path.join(identityRoot, 'runtime')) ? sourceFiles(path.join(identityRoot, 'runtime')) : []),
    ...(production && fs.existsSync(buildHelpers) ? sourceFiles(buildHelpers) : []),
    path.join(identityRoot, 'package.json'),
    path.join(identityRoot, 'package-lock.json'),
    path.join(identityRoot, 'tsconfig.json'),
    path.join(identityRoot, 'vite.config.ts'),
    path.join(helperRoot, 'scripts', 'lib', 'package-resolution.mjs'),
    path.join(helperRoot, 'scripts', 'lib', 'traversal-policy.mjs'),
    path.join(helperRoot, 'scripts', 'lib', 'native-owner.mjs'),
  ].filter((input) => fs.existsSync(input)).sort((left, right) => left.localeCompare(right));
}

function computeBuildId(inputs = buildIdentityInputs(), identityRoot = rootDir, runtimeIdentity?: string): string {
  const hash = crypto.createHash('sha256');
  for (const input of inputs) {
    hash.update(path.relative(identityRoot, input).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(input));
    hash.update('\0');
  }
  if (runtimeIdentity) {
    hash.update('verified-pi-runtime\0');
    hash.update(runtimeIdentity);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 20);
}

/**
 * Replace the compile sentinel at emission time, not config-load time. Vite
 * watch keeps one config alive, while every emission needs an identity for
 * diagnostics and coordinated-output verification. Watching the complete
 * identity input set also makes both bundle graphs rebuild together, even when
 * a changed file is exclusive to the other graph.
 */
export function createBuildIdentityPlugin(
  identityRoot = rootDir,
  runtimeIdentity = identityRoot === rootDir ? isolatedPiRuntimeIdentity : undefined,
): Plugin {
  let buildId = '';
  return {
    name: 'pie-build-identity',
    buildStart() {
      const inputs = buildIdentityInputs(identityRoot);
      buildId = computeBuildId(inputs, identityRoot, runtimeIdentity);
      for (const input of inputs) this.addWatchFile(input);
    },
    renderChunk(code) {
      const replaced = code.replaceAll(BUILD_ID_SENTINEL, buildId);
      return replaced === code ? null : { code: replaced, map: null };
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'pie-build-id.txt', source: `${buildId}\n` });
    },
  };
}

export default defineConfig(({ mode }) => {
  const define = {
    __PIE_BUILD_ID__: JSON.stringify(BUILD_ID_SENTINEL),
  };
  if (mode === 'node') {
    return {
      root: vscodeHostDir,
      ...(isolatedOutputDir ? { cacheDir: path.join(outDir, '.cache', 'vite-node') } : {}),
      publicDir: false,
      define,
      plugins: [createBuildIdentityPlugin()],
      build: {
        target: 'node20',
        outDir,
        emptyOutDir: true,
        manifest: false,
        ssr: true,
        rollupOptions: {
          input: {
            extension: path.join(vscodeHostDir, 'activation', 'extension.ts'),
            standalone: path.join(hostsDir, 'standalone', 'index.ts'),
            backend: path.join(repoDir, 'harness', 'agent-processes', 'coordinator', 'index.ts'),
            'worker-entry': path.join(repoDir, 'harness', 'agent-processes', 'workers', 'worker-entry.ts'),
            // Spawned as separate worker scripts by the running host, so these
            // must stay emitted files rather than modules bundled only into
            // extension.js.
            'analytics-recorder-worker': path.join(repoDir, 'analytics', 'recording', 'recorder-worker-entry.ts'),
            'analytics-query-worker': path.join(repoDir, 'analytics', 'queries', 'query-worker-entry.ts'),
            'cold-browse-helper-entry': path.join(repoDir, 'harness', 'agent-processes', 'cold-browse-helper', 'cold-browse-helper-entry.ts'),
            'initial-context-estimate-worker': path.join(repoDir, 'harness', 'agent-processes', 'context-inventory', 'initial-context-estimate-worker.ts'),
            'phase4-worker-command-extension': path.join(repoDir, 'harness', 'agent-processes', 'lib', 'sdk-integration', 'test', 'fixtures', 'phase4-worker-command-extension.ts'),
          },
          output: {
            entryFileNames: '[name].js',
            chunkFileNames: '[name]-[hash].js',
            assetFileNames: 'assets/[name]-[hash][extname]',
            format: 'cjs',
          },
          // `ws`'s optional native deps are NOT installed. Vite stubs
          // unresolvable optional peer deps with empty objects, which defeats
          // ws's `try { require('bufferutil') } catch {}` fallback and crashes
          // on masked frames >= 32 bytes (`bufferUtil$1.unmask is not a
          // function`). Keep them as runtime requires so the require throws
          // and ws falls back to its pure-JS implementation.
          external: (id) => id === 'vscode' || id.startsWith('node:') || id === 'bufferutil' || id === 'utf-8-validate',
        },
      },
      ssr: {
        noExternal: true,
      },
      resolve: {
        alias: [
          ...nodePackageAliases,
        ],
      },
    };
  }

  return {
    root: frontendDir,
    ...(isolatedOutputDir ? { cacheDir: path.join(outDir, '.cache', 'vite-webview') } : {}),
    publicDir: false,
    define,
    plugins: [createBuildIdentityPlugin()],
    build: {
      target: 'es2022',
      outDir: webviewOutDir,
      emptyOutDir: true,
      manifest: true,
      cssCodeSplit: true,
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: path.join(frontendDir, 'shell', 'panel.tsx'),
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'preact',
    },
    css: {
      postcss: {
        plugins: [tailwindcssPostcss()],
      },
    },
    resolve: {
      alias: [
        ...packageAliases,
      ],
    },
  };
});
