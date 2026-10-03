// Focused unit tests for scripts/diagnostics/doctor-pi-runtime.mjs — the
// default and explicit doctor routes. Fixtures are isolated materialized
// artifacts in OS temp directories; no live doctor, auth or repo-data root is
// exercised, and the fixture artifacts are never modified on this route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdtemp, realpath, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  PI_RUNTIME_PACKAGES,
  PI_RUNTIME_SDK_RELATIVE_PATH,
  writePiRuntimeManifest,
} from '../../lib/pi-runtime-artifact.mjs';
import { verifyPiRuntimeArtifact } from '../../../lib/pi-runtime/artifact.mjs';
import { collectPiRuntimeArtifactRoute, parsePiRuntimeRoute, resolvePiRuntimeRoute } from '../doctor-pi-runtime.mjs';

const executingTarget = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
const provenance = {
  upstreamVersion: '0.80.6',
  upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b',
  sourceTreeSha256: 'a'.repeat(64),
  lockSha256: 'b'.repeat(64),
  target: executingTarget,
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

const fixtureSources = () => {
  const files = [];
  for (const name of PI_RUNTIME_PACKAGES) {
    const prefix = `node_modules/${name}/`;
    files.push([`${prefix}package.json`, JSON.stringify({ name, version: '0.80.6', type: 'module', main: './dist/index.js' })]);
    files.push([`${prefix}dist/index.js`, 'export default 1;\n']);
    files.push([`${prefix}LICENSE`, 'MIT License\n']);
  }
  for (const file of sdkAssets) files.push([`${PI_RUNTIME_SDK_RELATIVE_PATH}/${file}`, `fixture:${file}\n`]);
  files.push(['node_modules/typebox/package.json', JSON.stringify({ name: 'typebox', version: '1.1.38', type: 'module' })]);
  files.push(['node_modules/typebox/index.js', 'export const Type = {};\n']);
  files.push(['node_modules/typebox/LICENSE', 'MIT third-party fixture\n']);
  return files;
};

// Materialize an isolated complete artifact (payload + fixture-only manifest)
// entirely inside an OS temp directory. Returns the writePiRuntimeManifest
// result so tests can compare reported identity against the known verifier.
async function materializeFixture(t, { manifestProvenance = provenance } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pie-doctor-pi-runtime-'));
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const root = path.join(parent, 'pi-runtime');
  for (const [relative, text] of fixtureSources()) await put(root, relative, text);
  await writePiRuntimeManifest(root, manifestProvenance);
  return root;
}

async function put(root, relative, text) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

// Byte-and-mtime snapshot proving the collect route never mutates the artifact.
async function snapshot(root) {
  const result = {};
  const walk = async (dir = '') => {
    for (const entry of (await readdir(path.join(root, dir))).sort()) {
      const relative = dir ? `${dir}/${entry}` : entry;
      const absolute = path.join(root, relative);
      const stat = await lstat(absolute);
      result[relative] = { size: stat.size, mtimeMs: stat.mtimeMs };
      if (!stat.isDirectory()) {
        result[relative].sha256 = createHash('sha256').update(await readFile(absolute)).digest('hex');
      } else await walk(relative);
    }
  };
  await walk();
  return result;
}

test('parsePiRuntimeRoute accepts an absolute value in both spelling forms', () => {
  const dir = path.join(os.tmpdir(), 'artifact-root');
  assert.deepEqual(parsePiRuntimeRoute(['--ci', '--pi-runtime', dir, '--skip-model-check']), {
    artifactDir: dir, selected: true, usageError: undefined,
  });
  assert.deepEqual(parsePiRuntimeRoute([`--pi-runtime=${dir}`]), {
    artifactDir: dir, selected: true, usageError: undefined,
  });
});

test('parsePiRuntimeRoute ignores doctor flags and unrelated argv', () => {
  assert.deepEqual(parsePiRuntimeRoute(['--ci', '--skip-model-check']), {
    artifactDir: undefined, selected: false, usageError: undefined,
  });
});

test('resolvePiRuntimeRoute selects the checkout-built artifact by default', () => {
  const root = path.join(os.tmpdir(), 'pie-checkout');
  assert.deepEqual(resolvePiRuntimeRoute(parsePiRuntimeRoute(['--ci']), root), {
    artifactDir: path.join(root, 'application', 'hosts', 'vscode', 'out', 'pi-runtime'),
    selected: true,
    explicit: false,
  });
});

test('resolvePiRuntimeRoute honors an explicit artifact override', () => {
  const root = path.join(os.tmpdir(), 'pie-checkout');
  const artifactDir = path.join(os.tmpdir(), 'explicit-pi-runtime');
  assert.deepEqual(resolvePiRuntimeRoute(parsePiRuntimeRoute(['--pi-runtime', artifactDir]), root), {
    artifactDir, selected: true, explicit: true, usageError: undefined,
  });
});

test('parsePiRuntimeRoute requires an artifact path and an absolute root', () => {
  assert.deepEqual(parsePiRuntimeRoute(['--pi-runtime']), {
    artifactDir: undefined, selected: true,
    usageError: '--pi-runtime requires an artifact path.',
  });
  assert.deepEqual(parsePiRuntimeRoute(['--pi-runtime', '--ci']), {
    artifactDir: undefined, selected: true,
    usageError: '--pi-runtime requires an artifact path.',
  });
  assert.deepEqual(parsePiRuntimeRoute(['--pi-runtime=pi-runtime']), {
    artifactDir: undefined, selected: true,
    usageError: '--pi-runtime requires an absolute artifact root.',
  });
  const relative = parsePiRuntimeRoute(['--pi-runtime', 'pi-runtime']);
  assert.equal(relative.selected, true);
  assert.equal(relative.usageError, '--pi-runtime requires an absolute artifact root.');
  assert.equal(relative.artifactDir, undefined, 'a rejected value must not select any artifact');
});

test('parsePiRuntimeRoute rejects a duplicate selection without naming an artifact', () => {
  const result = parsePiRuntimeRoute([`--pi-runtime=${os.tmpdir()}`, '--pi-runtime', os.tmpdir()]);
  assert.equal(result.selected, true);
  assert.equal(result.usageError, '--pi-runtime may be specified only once.');
  assert.equal(result.artifactDir, undefined);
  const resolved = resolvePiRuntimeRoute(result, path.join(os.tmpdir(), 'pie-checkout'));
  assert.equal(resolved.explicit, true);
  assert.equal(resolved.artifactDir, undefined, 'an invalid explicit request must not fall back to the checkout artifact');
});

test('collectPiRuntimeArtifactRoute verifies the fixture read-only for this Node target', async (t) => {
  const root = await materializeFixture(t);
  const before = await snapshot(root);
  const route = await collectPiRuntimeArtifactRoute({ artifactDir: root });
  assert.equal(route.status, 'ready');
  assert.equal(route.version, '0.80.6');
  assert.equal(route.upstreamVersion, '0.80.6');
  assert.deepEqual(route.target, executingTarget);
  assert.equal(route.sdkPath, path.join(route.artifactDir, PI_RUNTIME_SDK_RELATIVE_PATH));
  assert.equal(await realpath(route.artifactDir), route.artifactDir, 'artifactDir must be canonical (realpath)');
  assert.equal(route.identity, (await verifyPiRuntimeArtifact(root)).identity);
  assert.deepEqual(await snapshot(root), before, 'verification must never mutate the artifact');
});

test('collectPiRuntimeArtifactRoute injects the executing Node target into the verifier', async (t) => {
  const root = await materializeFixture(t);
  const calls = [];
  const route = await collectPiRuntimeArtifactRoute({
    artifactDir: root,
    verify: (artifactDir, options) => {
      calls.push({ artifactDir, target: options.target });
      return verifyPiRuntimeArtifact(artifactDir, options);
    },
  });
  assert.equal(route.status, 'ready');
  assert.deepEqual(calls, [{ artifactDir: root, target: executingTarget }]);
});

test('collectPiRuntimeArtifactRoute reports verification failure without falling back', async (t) => {
  const crossTarget = { platform: 'linux', arch: 'riscv64', nodeAbi: '137' };
  const root = await materializeFixture(t, { manifestProvenance: { ...provenance, target: crossTarget } });
  const route = await collectPiRuntimeArtifactRoute({ artifactDir: root });
  assert.equal(route.status, 'failed');
  assert.match(route.detail, /target\.(arch|platform|nodeAbi) mismatch/);
  assert.equal(route.identity, undefined);
  assert.equal(route.version, undefined);
});

test('missing default artifact is reported as failed without looking elsewhere', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pie-doctor-missing-runtime-'));
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const selected = resolvePiRuntimeRoute(parsePiRuntimeRoute([]), parent);
  const route = await collectPiRuntimeArtifactRoute({ artifactDir: selected.artifactDir });
  assert.equal(route.status, 'failed');
  assert.match(route.detail, /ENOENT|no such file/i);
  assert.equal(route.artifactDir, selected.artifactDir);
});

test('collectPiRuntimeArtifactRoute rejects a relative artifact directory outright', async () => {
  await assert.rejects(
    collectPiRuntimeArtifactRoute({ artifactDir: 'pi-runtime' }),
    /absolute artifact directory/,
  );
});

test('doctor wires explicit and default routes without global-Pi fallback', () => {
  const source = readFileSync(new URL('../doctor.mjs', import.meta.url), 'utf8');
  assert.match(source, /resolvePiRuntimeRoute\(parsePiRuntimeRoute\(process\.argv\), repoRoot\)/);
  assert.match(source, /collectPiRuntimeArtifactRoute\(\{ artifactDir: piRuntimeRoute\.artifactDir \}\)/);
  assert.match(source, /Build the checkout's VS Code application under normal safe conditions, or pass --pi-runtime/);
  assert.match(source, /if \(piRuntimeRoute\.usageError\)[\s\S]*?else if \(ci && !piRuntimeRoute\.explicit\)/);
  assert.match(source, /explicit pi-runtime artifact route; no global pi CLI lookup or fallback/);
  assert.doesNotMatch(source, /npm", \["root", "-g"\]/);
  assert.doesNotMatch(source, /globalPiManifest|installedPi/);
});