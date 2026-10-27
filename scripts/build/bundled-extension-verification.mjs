import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { TOOL_RUNTIME_DIRECTORY, TOOL_RUNTIME_MANIFEST, toolRuntimeManifest } from './tool-runtime-assets.mjs';
import { isDeepStrictEqual } from 'node:util';

export async function verifyToolRuntimeOutput(buildDir, { playwrightRuntimeIdentity } = {}) {
  const expected = toolRuntimeManifest({ playwrightRuntimeIdentity });
  const manifest = JSON.parse(await readFile(path.join(buildDir, TOOL_RUNTIME_MANIFEST), 'utf8'));
  if (!isDeepStrictEqual(manifest, expected)) {
    throw new Error(playwrightRuntimeIdentity === undefined
      ? 'Invalid code-only tool runtime manifest.'
      : 'Invalid prepared Playwright tool runtime manifest.');
  }
  for (const file of expected.files) {
    if (!(await stat(path.join(buildDir, TOOL_RUNTIME_DIRECTORY, file))).isFile()) {
      throw new Error(`Missing tool runtime asset: ${file}`);
    }
  }
}

/** Plain Node boundary: consume the emitted inventory, never import the TS catalog. */
export async function verifyBundledExtensionOutput(buildDir, expectedBuildId, { playwrightRuntimeIdentity } = {}) {
  await verifyToolRuntimeOutput(buildDir, { playwrightRuntimeIdentity });
  const buildId = (await readFile(path.join(buildDir, 'resources/bundled-extensions-build-id.txt'), 'utf8')).trim();
  if (buildId !== expectedBuildId) throw new Error(`Bundled extensions build identity mismatch (${buildId} != ${expectedBuildId}).`);
  const inventory = JSON.parse(await readFile(path.join(buildDir, 'resources/bundled-extensions.json'), 'utf8'));
  if (!inventory || inventory.version !== 1 || !Array.isArray(inventory.extensions) || inventory.extensions.length !== 12
    || Object.keys(inventory).sort().join(',') !== 'extensions,version') {
    throw new Error('Invalid bundled extension inventory version, shape, or count.');
  }
  const seen = new Set();
  for (const item of inventory.extensions) {
    if (!item || Object.keys(item).sort().join(',') !== 'entry,id'
      || typeof item.id !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(item.id)
      || item.entry !== `${item.id}.js` || seen.has(item.id)) {
      throw new Error('Invalid or duplicate bundled extension inventory entry.');
    }
    seen.add(item.id);
    if (!(await stat(path.join(buildDir, item.entry))).isFile()) throw new Error(`Missing bundled extension output: ${item.entry}`);
  }
}
