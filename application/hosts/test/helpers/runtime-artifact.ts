import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PI_RUNTIME_PACKAGES,
  PI_RUNTIME_SDK_RELATIVE_PATH,
  writePiRuntimeManifest,
} from '../../../../scripts/lib/pi-runtime-artifact.mjs';

// Deliberately explicit fixture payload, independent of verifier requirements.
const SDK_ASSETS = [
  'dist/cli.js', 'dist/rpc-entry.js',
  'dist/modes/interactive/theme/dark.json',
  'dist/modes/interactive/theme/light.json',
  'dist/modes/interactive/theme/theme-schema.json',
  'dist/modes/interactive/assets/clankolas.png',
  'dist/core/export-html/template.html',
  'dist/core/export-html/template.css',
  'dist/core/export-html/template.js',
  'dist/core/export-html/vendor/marked.min.js',
  'dist/core/export-html/vendor/highlight.min.js',
];

export async function writeRuntimeArtifactFixture(
  artifactDir: string,
  target: { platform: string; arch: string; nodeAbi: string },
): Promise<void> {
  async function put(relative: string, contents: string): Promise<void> {
    const file = path.join(artifactDir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  for (const packageName of PI_RUNTIME_PACKAGES) {
    const prefix = `node_modules/${packageName}/`;
    await put(`${prefix}package.json`, JSON.stringify({ name: packageName, version: '0.80.6' }));
    await put(`${prefix}dist/index.js`, 'export {}\n');
    await put(`${prefix}LICENSE`, 'fixture license\n');
  }
  for (const relative of SDK_ASSETS) {
    await put(`${PI_RUNTIME_SDK_RELATIVE_PATH}/${relative}`, `fixture:${relative}\n`);
  }
  await writePiRuntimeManifest(artifactDir, {
    upstreamVersion: '0.80.6',
    upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b',
    sourceTreeSha256: 'a'.repeat(64),
    lockSha256: 'b'.repeat(64),
    target,
  });
}
