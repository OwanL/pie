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

const rootDir = path.dirname(url.fileURLToPath(import.meta.url));
const repoDir = path.resolve(rootDir, '../../..');
const srcDir = path.join(repoDir, 'extension', 'src');
const testDir = path.join(repoDir, 'extension', 'test');
const outDir = path.join(rootDir, 'out');

/**
 * Package imports resolve through the explicit dependency owner, never the
 * config's working directory: current and legacy Pi spellings map to the SDK's
 * nested graph (including the private pi-ai/TypeBox identity), and Preact
 * keeps its owner-installed files and subpaths. Native tools keep their own
 * sidecar owners and stay unaliased.
 */
const packageAliases = createViteAliases({ layout: 'planned' });

const webviewOutDir = path.join(outDir, 'webview', 'panel');
const BUILD_ID_SENTINEL = '__PIE_COMPILED_BUILD_ID_REPLACE__';

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const resolved = path.join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(resolved) : [resolved];
    });
}

/** Deterministic across the separately-started node and webview builds. */
function buildIdentityInputs(identityRoot = rootDir): string[] {
  // The explicit root parameter remains a fixture seam; production hashes
  // source at the repository root while emitting under the package owner.
  const production = identityRoot === rootDir;
  const sourceRoot = production ? srcDir : path.join(identityRoot, 'src');
  const helperRoot = production ? repoDir : path.dirname(identityRoot);
  const buildHelpers = path.join(helperRoot, 'scripts', 'build');
  return [
    ...sourceFiles(sourceRoot),
    ...(production ? sourceFiles(path.join(repoDir, 'shared')) : []),
    ...(production ? sourceFiles(path.join(identityRoot, 'runtime')) : []),
    ...(production && fs.existsSync(buildHelpers) ? sourceFiles(buildHelpers) : []),
    path.join(identityRoot, 'package.json'),
    path.join(identityRoot, 'package-lock.json'),
    path.join(identityRoot, 'tsconfig.json'),
    path.join(identityRoot, 'vite.config.ts'),
    path.join(helperRoot, 'scripts', 'lib', 'package-resolution.mjs'),
  ].filter((input) => fs.existsSync(input)).sort((left, right) => left.localeCompare(right));
}

function computeBuildId(inputs = buildIdentityInputs(), identityRoot = rootDir): string {
  const hash = crypto.createHash('sha256');
  for (const input of inputs) {
    hash.update(path.relative(identityRoot, input).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(input));
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
export function createBuildIdentityPlugin(identityRoot = rootDir): Plugin {
  let buildId = '';
  return {
    name: 'pie-build-identity',
    buildStart() {
      const inputs = buildIdentityInputs(identityRoot);
      buildId = computeBuildId(inputs, identityRoot);
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
      root: srcDir,
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
            extension: path.join(srcDir, 'extension.ts'),
            standalone: path.join(srcDir, 'standalone', 'index.ts'),
            backend: path.join(srcDir, 'backend', 'index.ts'),
            'worker-entry': path.join(srcDir, 'backend', 'worker-entry.ts'),
            // Spawned as separate worker scripts by the running host, so these
            // must stay emitted files rather than modules bundled only into
            // extension.js.
            'analytics-recorder-worker': path.join(srcDir, 'analytics', 'recorder-worker-entry.ts'),
            'analytics-query-worker': path.join(srcDir, 'analytics', 'query-worker-entry.ts'),
            'cold-browse-helper-entry': path.join(srcDir, 'backend', 'cold-browse-helper-entry.ts'),
            'initial-context-estimate-worker': path.join(srcDir, 'backend', 'initial-context-estimate-worker.ts'),
            'phase4-worker-command-extension': path.join(testDir, 'fixtures', 'phase4-worker-command-extension.ts'),
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
          { find: '@shared', replacement: path.join(srcDir, 'shared') },
          ...packageAliases,
        ],
      },
    };
  }

  return {
    root: srcDir,
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
        input: path.join(srcDir, 'webview', 'panel', 'panel.tsx'),
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
        { find: '@shared', replacement: path.join(srcDir, 'shared') },
        ...packageAliases,
      ],
    },
  };
});
