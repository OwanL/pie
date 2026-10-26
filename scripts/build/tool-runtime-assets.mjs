import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const TOOL_RUNTIME_DIRECTORY = 'resources/tool-runtimes';
export const TOOL_RUNTIME_MANIFEST = `${TOOL_RUNTIME_DIRECTORY}/manifest.json`;
export const TOOL_RUNTIME_FILES = Object.freeze([
  'harness/tools/computer-use/sidecar.mjs',
  'harness/tools/computer-use/backend.mjs',
  'harness/tools/computer-use/sidecar-core.mjs',
  'harness/tools/computer-use/dependency-owner.mjs',
  'harness/tools/computer-use/image.mjs',
  'harness/tools/computer-use/keys.mjs',
  'harness/tools/computer-use/launch-resolve.mjs',
  'harness/tools/computer-use/sequence.mjs',
  'harness/tools/computer-use/win32-focus.mjs',
  'harness/tools/playwright/sidecar.mjs',
  'harness/tools/playwright/backend.mjs',
  'harness/tools/playwright/sidecar-core.mjs',
  'harness/tools/playwright/dependency-owner.mjs',
  'harness/tools/playwright/image.mjs',
  'harness/tools/playwright/snapshots.mjs',
  'harness/tools/png-image.mjs',
  'scripts/lib/native-owner.mjs',
]);

export function toolRuntimeManifest() {
  return { version: 1, codeOnly: true, entries: {
    'computer-use': 'harness/tools/computer-use/sidecar.mjs',
    playwright: 'harness/tools/playwright/sidecar.mjs',
  }, files: [...TOOL_RUNTIME_FILES] };
}

/** Parse static and literal dynamic imports without evaluating sidecar/native code. */
export function readToolRuntimeAssets(root) {
  const require = createRequire(new URL('../../application/hosts/vscode/package.json', import.meta.url));
  const ts = require('typescript');
  const assets = TOOL_RUNTIME_FILES.map(file => ({ file, source: fs.readFileSync(path.join(root, file)) }));
  const files = new Set(TOOL_RUNTIME_FILES);
  const edges = new Map();
  for (const { file, source } of assets) {
    const imports = [];
    const parsed = ts.createSourceFile(file, source.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (parsed.parseDiagnostics.length) throw new Error(`Invalid tool runtime JavaScript: ${file}`);
    function visit(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.text));
        if (!files.has(target)) throw new Error(`Tool runtime import outside curated closure: ${file} -> ${specifier.text}`);
        imports.push(target);
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    edges.set(file, imports);
  }
  const reachable = new Set();
  function visit(file) {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const target of edges.get(file)) visit(target);
  }
  for (const entry of Object.values(toolRuntimeManifest().entries)) visit(entry);
  if (reachable.size !== files.size) throw new Error('Curated tool runtime list contains unreachable assets.');
  return assets;
}

export function createToolRuntimeAssetsPlugin(root) {
  return {
    name: 'pie-tool-runtime-assets',
    buildStart() {
      this.addWatchFile(fileURLToPath(new URL('./tool-runtime-assets.mjs', import.meta.url)));
      for (const file of TOOL_RUNTIME_FILES) this.addWatchFile(path.join(root, file));
    },
    generateBundle() {
      for (const { file, source } of readToolRuntimeAssets(root)) {
        this.emitFile({ type: 'asset', fileName: `${TOOL_RUNTIME_DIRECTORY}/${file}`, source });
      }
      this.emitFile({ type: 'asset', fileName: TOOL_RUNTIME_MANIFEST, source: `${JSON.stringify(toolRuntimeManifest(), null, 2)}\n` });
    },
  };
}
