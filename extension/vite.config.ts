import { defineConfig } from 'vite';
import tailwindcssPostcss from '@tailwindcss/postcss';
import * as path from 'node:path';
import * as url from 'node:url';

const rootDir = path.dirname(url.fileURLToPath(import.meta.url));
const srcDir = path.join(rootDir, 'src');
const outDir = path.join(rootDir, 'out');

const webviewOutDir = path.join(outDir, 'webview', 'panel');

export default defineConfig(({ mode }) => {
  if (mode === 'node') {
    return {
      root: srcDir,
      publicDir: false,
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
