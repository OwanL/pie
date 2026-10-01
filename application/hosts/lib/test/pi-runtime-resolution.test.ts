import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PI_RUNTIME_PACKAGES,
  PI_RUNTIME_SDK_RELATIVE_PATH,
  writePiRuntimeManifest,
} from '../../../../scripts/lib/pi-runtime-artifact.mjs';
import {
  GenerationPiRuntimePolicyError,
  resolveGenerationPiRuntime,
  type ResolveGenerationPiRuntimeOptions,
} from '../pi-runtime-resolution';

const target = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
const provenance = {
  upstreamVersion: '0.80.6',
  upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b',
  sourceTreeSha256: 'a'.repeat(64),
  lockSha256: 'b'.repeat(64),
  target,
};
const sdkAssets = [
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

async function put(root: string, relative: string, contents: string): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function fixture(t: TestContext, name = 'pi-runtime') {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pie-generation-pi-runtime-'));
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const artifactDir = path.join(parent, name);
  for (const packageName of PI_RUNTIME_PACKAGES) {
    const prefix = `node_modules/${packageName}/`;
    await put(artifactDir, `${prefix}package.json`, JSON.stringify({ name: packageName, version: '0.80.6' }));
    await put(artifactDir, `${prefix}dist/index.js`, 'export {}\n');
    await put(artifactDir, `${prefix}LICENSE`, 'fixture license\n');
  }
  for (const relative of sdkAssets) {
    await put(artifactDir, `${PI_RUNTIME_SDK_RELATIVE_PATH}/${relative}`, `fixture:${relative}\n`);
  }
  await writePiRuntimeManifest(artifactDir, provenance);
  return { parent, artifactDir };
}

async function snapshot(root: string): Promise<Record<string, { mtimeMs: number; size: number; bytes?: string }>> {
  const result: Record<string, { mtimeMs: number; size: number; bytes?: string }> = {};
  async function walk(relative = ''): Promise<void> {
    for (const entry of (await readdir(path.join(root, relative))).sort()) {
      const name = relative ? `${relative}/${entry}` : entry;
      const absolute = path.join(root, name);
      const stat = await lstat(absolute);
      result[name] = { mtimeMs: stat.mtimeMs, size: stat.size };
      if (stat.isDirectory()) await walk(name);
      else result[name].bytes = (await readFile(absolute)).toString('base64');
    }
  }
  await walk();
  return result;
}

test('generation resolver defaults only to runtimeOutDir/pi-runtime and returns a portable descriptor', async (t) => {
  const { parent, artifactDir } = await fixture(t);
  // Model the backend Node ABI explicitly; it need not equal the editor process ABI.
  const backendTarget = { ...target, nodeAbi: target.nodeAbi === '99999' ? '99998' : '99999' };
  await writePiRuntimeManifest(artifactDir, { ...provenance, target: backendTarget });
  const before = await snapshot(artifactDir);

  const descriptor = await resolveGenerationPiRuntime({ runtimeOutDir: parent, target: backendTarget });

  assert.equal(descriptor.schemaVersion, 1);
  assert.equal(descriptor.artifactDir, await realpath(artifactDir));
  assert.equal(descriptor.sdkPath, await realpath(path.join(artifactDir, PI_RUNTIME_SDK_RELATIVE_PATH)));
  assert.equal(descriptor.cliPath, await realpath(path.join(artifactDir, PI_RUNTIME_SDK_RELATIVE_PATH, 'dist/cli.js')));
  assert.equal(descriptor.manifest.target.nodeAbi, backendTarget.nodeAbi);
  assert.match(descriptor.identity, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(JSON.stringify(descriptor)), descriptor);
  assert.deepEqual(await snapshot(artifactDir), before);
});

test('generation resolver rejects a missing default artifact and target mismatch', async (t) => {
  const missing = await mkdtemp(path.join(os.tmpdir(), 'pie-generation-pi-missing-'));
  t.after(() => rm(missing, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  await assert.rejects(resolveGenerationPiRuntime({ runtimeOutDir: missing, target }));

  const { parent } = await fixture(t);
  await assert.rejects(
    resolveGenerationPiRuntime({ runtimeOutDir: parent, target: { ...target, platform: target.platform === 'linux' ? 'darwin' : 'linux' } }),
    /target\.platform mismatch/,
  );
});

test('generation resolver preserves identity after relocation and rejects absent backend targets', async (t) => {
  const { parent, artifactDir } = await fixture(t);
  const original = await resolveGenerationPiRuntime({ runtimeOutDir: parent, target });
  const relocatedOut = path.join(parent, 'relocated-out');
  await mkdir(relocatedOut);
  await rename(artifactDir, path.join(relocatedOut, 'pi-runtime'));
  const relocated = await resolveGenerationPiRuntime({ runtimeOutDir: relocatedOut, target });
  assert.equal(relocated.identity, original.identity);
  assert.equal(relocated.artifactDir, await realpath(path.join(relocatedOut, 'pi-runtime')));
  for (const missingTarget of [undefined, null]) {
    await assert.rejects(resolveGenerationPiRuntime({
      runtimeOutDir: relocatedOut,
      target: missingTarget,
    } as unknown as ResolveGenerationPiRuntimeOptions), /explicit backend Node target is required/);
  }
});

test('invalid explicit overrides never fall back to a valid default artifact', async (t) => {
  const { parent } = await fixture(t);
  for (const artifactDir of [undefined, path.join(parent, 'missing'), parent]) {
    await assert.rejects(resolveGenerationPiRuntime({
      runtimeOutDir: parent,
      target,
      developmentOverride: { artifactDir, allowDevelopmentRuntime: true },
    } as unknown as ResolveGenerationPiRuntimeOptions));
  }
});

test('generation resolver rejects tampered payloads', async (t) => {
  const { parent, artifactDir } = await fixture(t);
  await put(artifactDir, `${PI_RUNTIME_SDK_RELATIVE_PATH}/dist/cli.js`, 'tampered');
  await assert.rejects(resolveGenerationPiRuntime({ runtimeOutDir: parent, target }), /package hash mismatch/);
});

test('development override requires explicit opt-in and verifies the absolute artifact', async (t) => {
  const { parent, artifactDir } = await fixture(t, 'development-runtime');
  const missingOptIn = {
    runtimeOutDir: parent,
    target,
    developmentOverride: { artifactDir },
  } as unknown as ResolveGenerationPiRuntimeOptions;
  await assert.rejects(
    resolveGenerationPiRuntime(missingOptIn),
    (error: unknown) => error instanceof GenerationPiRuntimePolicyError
      && error.code === 'development-override-not-opted-in',
  );
  await assert.rejects(
    resolveGenerationPiRuntime({
      runtimeOutDir: parent,
      target,
      developmentOverride: { artifactDir: 'relative/pi-runtime', allowDevelopmentRuntime: true },
    }),
    /Pi runtime artifact path must be absolute/,
  );

  const descriptor = await resolveGenerationPiRuntime({
    runtimeOutDir: parent,
    target,
    developmentOverride: { artifactDir, allowDevelopmentRuntime: true },
  });
  assert.equal(descriptor.artifactDir, await realpath(artifactDir));
});
