import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  PI_RUNTIME_PACKAGES,
  PI_RUNTIME_SDK_RELATIVE_PATH,
  verifyPiRuntimeArtifact,
  type GenerationPiRuntimeDescriptor,
  type PiRuntimeTarget,
} from '../../../../../lib/pi-runtime/artifact.mjs';
import { writePiRuntimeManifest } from '../../../../../scripts/lib/pi-runtime-artifact.mjs';
import { verifySdkRuntimeArtifactDescriptor } from '../sdk-runtime-artifact';

const target: PiRuntimeTarget = {
  platform: process.platform,
  arch: process.arch,
  nodeAbi: process.versions.modules,
};
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

async function fixture(t: TestContext, artifactTarget: PiRuntimeTarget = target) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pie-sdk-runtime-artifact-'));
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const artifactDir = path.join(parent, 'pi-runtime');
  for (const packageName of PI_RUNTIME_PACKAGES) {
    const prefix = `node_modules/${packageName}/`;
    await put(artifactDir, `${prefix}package.json`, JSON.stringify({ name: packageName, version: '0.80.6' }));
    await put(artifactDir, `${prefix}dist/index.js`, 'export {}\n');
    await put(artifactDir, `${prefix}LICENSE`, 'fixture license\n');
  }
  for (const relative of sdkAssets) {
    await put(artifactDir, `${PI_RUNTIME_SDK_RELATIVE_PATH}/${relative}`, `fixture:${relative}\n`);
  }
  await writePiRuntimeManifest(artifactDir, { ...provenance, target: artifactTarget });
  return { parent, artifactDir };
}

async function descriptorFor(artifactDir: string, backendTarget: PiRuntimeTarget): Promise<GenerationPiRuntimeDescriptor> {
  const verified = await verifyPiRuntimeArtifact(artifactDir, { target: backendTarget });
  const sdkPath = await realpath(verified.sdkPath);
  const cliPath = await realpath(path.join(sdkPath, 'dist', 'cli.js'));
  return {
    schemaVersion: 1,
    artifactDir: verified.artifactDir,
    sdkPath,
    cliPath,
    identity: verified.identity,
    manifest: verified.manifest,
  };
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

test('consumer verifies a portable descriptor against an explicit backend target without writing', async (t) => {
  const backendTarget = { ...target, nodeAbi: target.nodeAbi === '99999' ? '99998' : '99999' };
  const { artifactDir } = await fixture(t, backendTarget);
  const descriptor = JSON.parse(JSON.stringify(await descriptorFor(artifactDir, backendTarget))) as GenerationPiRuntimeDescriptor;
  const before = await snapshot(artifactDir);

  const verified = await verifySdkRuntimeArtifactDescriptor(descriptor, backendTarget);

  assert.deepEqual(verified, descriptor);
  assert.equal(verified.manifest.target.nodeAbi, backendTarget.nodeAbi);
  assert.deepEqual(await snapshot(artifactDir), before);
});

test('consumer rejects malformed shapes, untrusted hashes, and noncanonical paths', async (t) => {
  const { artifactDir } = await fixture(t);
  const descriptor = await descriptorFor(artifactDir, target);
  const discrepancies: unknown[] = [
    { ...descriptor, extra: true },
    { ...descriptor, schemaVersion: 2 },
    { ...descriptor, artifactDir: `${descriptor.artifactDir}${path.sep}.` },
    { ...descriptor, sdkPath: descriptor.artifactDir },
    { ...descriptor, cliPath: descriptor.sdkPath },
    { ...descriptor, identity: '0'.repeat(64) },
    { ...descriptor, manifest: { ...descriptor.manifest, extra: true } },
    { ...descriptor, manifest: { ...descriptor.manifest, payloadSha256: '0'.repeat(64) } },
    {
      ...descriptor,
      manifest: {
        ...descriptor.manifest,
        packages: {
          ...descriptor.manifest.packages,
          [PI_RUNTIME_PACKAGES[0]]: {
            ...descriptor.manifest.packages[PI_RUNTIME_PACKAGES[0]],
            treeSha256: '0'.repeat(64),
          },
        },
      },
    },
  ];
  for (const discrepancy of discrepancies) {
    await assert.rejects(verifySdkRuntimeArtifactDescriptor(discrepancy, target), /Invalid Pi runtime descriptor/);
  }
});

test('consumer requires the target and re-verifies materialized payload hashes', async (t) => {
  const { artifactDir } = await fixture(t);
  const descriptor = await descriptorFor(artifactDir, target);
  await assert.rejects(
    verifySdkRuntimeArtifactDescriptor(descriptor, undefined as unknown as PiRuntimeTarget),
    /explicit backend target is required/,
  );
  await assert.rejects(
    verifySdkRuntimeArtifactDescriptor(descriptor, {
      ...target,
      platform: target.platform === 'linux' ? 'darwin' : 'linux',
    }),
    /target\.platform mismatch/,
  );

  await put(artifactDir, `${PI_RUNTIME_SDK_RELATIVE_PATH}/dist/cli.js`, 'tampered after descriptor creation');
  await assert.rejects(verifySdkRuntimeArtifactDescriptor(descriptor, target), /package hash mismatch/);
});
