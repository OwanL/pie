import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writePiRuntimeManifest } from '../../lib/pi-runtime-artifact.mjs';

// Stateless writers: each caller owns its temp paths and cleanup.
function write(root, relative, content) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const runtimePackages = [
  '@earendil-works/pi-tui',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-coding-agent',
];
const sdkAssets = [
  'dist/cli.js', 'dist/rpc-entry.js',
  'dist/modes/interactive/theme/dark.json', 'dist/modes/interactive/theme/light.json',
  'dist/modes/interactive/theme/theme-schema.json', 'dist/modes/interactive/assets/clankolas.png',
  'dist/core/export-html/template.html', 'dist/core/export-html/template.css', 'dist/core/export-html/template.js',
  'dist/core/export-html/vendor/marked.min.js', 'dist/core/export-html/vendor/highlight.min.js',
];

export async function makeRuntimeArtifact(root) {
  for (const name of runtimePackages) {
    const sdk = name === '@earendil-works/pi-coding-agent';
    write(root, `node_modules/${name}/package.json`, JSON.stringify({
      name, version: '0.80.6', type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.js' } },
    }) + '\n');
    write(root, `node_modules/${name}/LICENSE`, 'MIT License\n');
    write(root, `node_modules/${name}/dist/index.js`, sdk ? "export function candidateOnly() { return 'candidate-sdk'; }\n" : 'export {}\n');
    write(root, `node_modules/${name}/dist/index.d.ts`, sdk ? "export declare function candidateOnly(): 'candidate-sdk';\n" : 'export {};\n');
    if (sdk) for (const asset of sdkAssets) write(root, `node_modules/${name}/${asset}`, `fixture asset: ${asset}\n`);
  }
  write(root, 'node_modules/typebox/package.json', JSON.stringify({
    name: 'typebox', version: '1.0.0', type: 'module', main: './index.js', types: './index.d.ts',
    exports: { '.': { types: './index.d.ts', import: './index.js', require: './index.js' } },
  }) + '\n');
  write(root, 'node_modules/typebox/index.js', 'export {};\n');
  write(root, 'node_modules/typebox/index.d.ts', 'export {};\n');
  return writePiRuntimeManifest(root, {
    upstreamVersion: '0.80.6',
    upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b',
    sourceTreeSha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64),
    target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
  });
}

export function installFakeAcquisition(repo, sourceArtifact, counter) {
  write(repo, 'scripts/build/pi-runtime.mjs', `
    import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    import { verifyPiRuntimeArtifact } from '../lib/pi-runtime-artifact.mjs';
    const source = ${JSON.stringify(sourceArtifact)};
    const counterFile = ${JSON.stringify(counter)};
    export async function buildPiRuntime({ output }) {
      await mkdir(output, { recursive: true });
      let count = 0;
      try { count = Number(await readFile(counterFile, 'utf8')); } catch {}
      await writeFile(counterFile, String(count + 1));
      const artifactDir = path.join(output, 'pi-runtime');
      await cp(source, artifactDir, { recursive: true });
      return verifyPiRuntimeArtifact(artifactDir);
    }
  `);
}

