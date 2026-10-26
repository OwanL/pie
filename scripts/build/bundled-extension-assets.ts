import * as path from 'node:path';
import type { Plugin, UserConfig } from 'vite';
import { BUNDLED_EXTENSIONS } from '../../harness/tools/catalog/bundled-extensions.js';
import { createBundledExtensionInventory, BUNDLED_EXTENSION_INVENTORY_RELATIVE_PATH } from '../../harness/agent-instructions/application-resources.js';

export const BUNDLED_EXTENSIONS_BUILD_ID = 'resources/bundled-extensions-build-id.txt';
export const BUNDLED_EXTENSION_PEERS = [
  ...['@earendil-works', '@mariozechner'].flatMap(scope =>
    ['pi-coding-agent', 'pi-agent-core', 'pi-ai', 'pi-tui'].map(name => `${scope}/${name}`)),
  'typebox', '@sinclair/typebox',
];
export function isBundledExtensionPeer(id: string): boolean {
  return BUNDLED_EXTENSION_PEERS.some(name => id === name || id.startsWith(`${name}/`));
}

/** Exact wrapper inputs: never discover extensions by walking the checkout. */
export function bundledExtensionInputs(root: string): string[] {
  return BUNDLED_EXTENSIONS.map(entry => path.join(root, entry.entryPath));
}

export function createBundledExtensionAssetsPlugin(): Plugin {
  return {
    name: 'pie-bundled-extension-assets',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: BUNDLED_EXTENSION_INVENTORY_RELATIVE_PATH,
        source: `${JSON.stringify(createBundledExtensionInventory(), null, 2)}\n` });
    },
  };
}

/** Peers must stay bare runtime specifiers, including when Vite runs aliases
 * before its SSR resolver. The first alias prevents owner/SDK redirection. */
export function bundledExtensionPeerAliases() {
  return [{
    find: /^(?:@(?:earendil-works|mariozechner)\/pi-(?:coding-agent|agent-core|ai|tui)|@sinclair\/typebox|typebox)(?:\/.*)?$/u,
    replacement: '$&',
    customResolver(source: string) { return { id: source, external: true }; },
  }];
}

export function bundledExtensionBuildOptions(root: string, outDir: string,
  input = Object.fromEntries(BUNDLED_EXTENSIONS.map(entry => [entry.id, path.join(root, entry.entryPath)])),
): UserConfig {
  return {
    root, publicDir: false,
    plugins: [createBundledExtensionAssetsPlugin(), {
      name: 'pie-bundled-extension-cjs-module-paths',
      resolveImportMeta(property, { format }) {
        if (format !== 'cjs') return null;
        if (property === 'dirname') return '__dirname';
        if (property === 'filename') return '__filename';
        return null; // Preserve Rollup's native import.meta.url handling.
      },
    }],
    build: {
      target: 'node20', outDir, emptyOutDir: false, manifest: false,
      ssr: true, ssrEmitAssets: true,
      rollupOptions: {
        input,
        external: id => isBundledExtensionPeer(id) || id === 'vscode' || id.startsWith('node:')
          || id === 'bufferutil' || id === 'utf-8-validate'
          || id === '@picovoice/pvrecorder-node' || id === 'whisper-cpp-node' || id.startsWith('@whisper-cpp-node/'),
        output: { format: 'cjs', entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' },
      },
    },
    ssr: { noExternal: true },
    resolve: { alias: bundledExtensionPeerAliases() },
  };
}
