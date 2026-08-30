import { defineConfig, type Plugin } from 'vite';
import tailwindcssPostcss from '@tailwindcss/postcss';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const rootDir = path.dirname(url.fileURLToPath(import.meta.url));
const srcDir = path.join(rootDir, 'src');
const outDir = path.join(rootDir, 'out');

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
function buildIdentityInputs(): string[] {
  return [
    ...sourceFiles(srcDir),
    path.join(rootDir, 'package.json'),
    path.join(rootDir, 'package-lock.json'),
    path.join(rootDir, 'tsconfig.json'),
    path.join(rootDir, 'vite.config.ts'),
  ].filter((input) => fs.existsSync(input)).sort((left, right) => left.localeCompare(right));
}

function computeBuildId(): string {
  const hash = crypto.createHash('sha256');
  for (const input of buildIdentityInputs()) {
    hash.update(path.relative(rootDir, input).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(input));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 20);
}

/**
 * Replace the compile sentinel at emission time, not config-load time. Vite
 * watch keeps one config alive, while an in-place rebuild must mint a new id
 * so a running old host cannot accept a newly emitted renderer. Watching the
 * complete identity input set also makes both bundle graphs rebuild before a
 * window reload, even when a changed file is exclusive to the other graph.
 */
function buildIdentityPlugin(): Plugin {
  let buildId = '';
  return {
    name: 'pie-build-identity',
    buildStart() {
      buildId = computeBuildId();
      for (const input of buildIdentityInputs()) this.addWatchFile(input);
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
      plugins: [buildIdentityPlugin()],
      build: {
        target: 'node20',
        outDir,
        emptyOutDir: true,
        manifest: false,
        ssr: true,
        rollupOptions: {
          input: {
            extension: path.join(srcDir, 'extension.ts'),
            backend: path.join(srcDir, 'backend', 'index.ts'),
            'worker-entry': path.join(srcDir, 'backend', 'worker-entry.ts'),
            'cold-browse-helper-entry': path.join(srcDir, 'backend', 'cold-browse-helper-entry.ts'),
            'initial-context-estimate-worker': path.join(srcDir, 'backend', 'initial-context-estimate-worker.ts'),
            'phase4-worker-command-extension': path.join(rootDir, 'test', 'fixtures', 'phase4-worker-command-extension.ts'),
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
        alias: {
          '@shared': path.join(srcDir, 'shared'),
        },
      },
    };
  }

  return {
    root: srcDir,
    publicDir: false,
    define,
    plugins: [buildIdentityPlugin()],
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
      alias: {
        '@shared': path.join(srcDir, 'shared'),
      },
    },
  };
});
