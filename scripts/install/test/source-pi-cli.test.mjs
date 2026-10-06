// Focused tests for the explicit, verified local Pi CLI launcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

import { preparePiRuntimeManifest, PI_RUNTIME_PACKAGES } from '../../../lib/pi-runtime/artifact.mjs';
import { collectChild } from './source-pi-cli-test-helpers.mjs';
import { createSourcePiCli } from '../lib/source-pi-cli.mjs';

const UPSTREAM_COMMIT = '2b3fda9921b5590f285165287bd442a25817f17b';
const FIXTURE_CLI = 'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exitCode = 23;\n';

function currentTarget() {
  return { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
}

async function withTempDirAsync(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-source-pi-cli-'));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFile(root, relative, content) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

async function createArtifact(root, target, cliSource = FIXTURE_CLI) {
  for (const name of PI_RUNTIME_PACKAGES) {
    const packageRoot = path.join(root, 'node_modules', name);
    writeFile(root, path.relative(root, path.join(packageRoot, 'package.json')), JSON.stringify({ name, version: '0.80.6' }));
    writeFile(root, path.relative(root, path.join(packageRoot, 'LICENSE')), 'fixture license\n');
    writeFile(root, path.relative(root, path.join(packageRoot, 'dist', 'index.js')), 'export {};\n');
  }

  const sdk = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const sdkFiles = [
    ['dist/cli.js', cliSource],
    ['dist/rpc-entry.js', 'export {};\n'],
    ['dist/modes/interactive/theme/dark.json', '{}\n'],
    ['dist/modes/interactive/theme/light.json', '{}\n'],
    ['dist/modes/interactive/theme/theme-schema.json', '{}\n'],
    ['dist/modes/interactive/assets/clankolas.png', Buffer.from('fixture image')],
    ['dist/core/export-html/template.html', '<html></html>\n'],
    ['dist/core/export-html/template.css', '/* fixture */\n'],
    ['dist/core/export-html/template.js', '/* fixture */\n'],
    ['dist/core/export-html/vendor/marked.min.js', '/* fixture */\n'],
    ['dist/core/export-html/vendor/highlight.min.js', '/* fixture */\n'],
  ];
  for (const [relative, content] of sdkFiles) writeFile(root, path.relative(root, path.join(sdk, relative)), content);

  const manifest = await preparePiRuntimeManifest(root, {
    upstreamVersion: '0.80.6',
    upstreamCommit: UPSTREAM_COMMIT,
    sourceTreeSha256: 'a'.repeat(64),
    lockSha256: 'b'.repeat(64),
    target,
  });
  writeFile(root, 'manifest.json', `${JSON.stringify(manifest.manifest, null, 2)}\n`);
  return { cliPath: await realpath(path.join(sdk, 'dist', 'cli.js')) };
}

function snapshotTree(root) {
  const snapshot = {};
  function visit(relative = '') {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) visit(name);
      else snapshot[name.split(path.sep).join('/')] = readFileSync(path.join(root, name)).toString('base64');
    }
  }
  visit();
  return snapshot;
}

test('requires an explicit target and absolute Node executable before spawning', async () => withTempDirAsync(async (root) => {
  await createArtifact(root, currentTarget());
  let spawnCount = 0;
  const spawn = () => { spawnCount += 1; return new EventEmitter(); };

  await assert.rejects(createSourcePiCli({ nodeExecutable: process.execPath, target: currentTarget(), spawn }), /artifactDir must explicitly/);
  await assert.rejects(createSourcePiCli({ artifactDir: root, nodeExecutable: process.execPath, spawn }), /target must explicitly/);
  await assert.rejects(createSourcePiCli({ artifactDir: root, nodeExecutable: 'node', target: currentTarget(), spawn }), /absolute executable path/);
  assert.equal(spawnCount, 0);
}));

test('invalid manifest, tampered payload, and wrong explicit target fail before spawn', async () => withTempDirAsync(async (root) => {
  const target = currentTarget();
  let spawnCount = 0;
  const spawn = () => { spawnCount += 1; return new EventEmitter(); };

  const invalidRoot = path.join(root, 'invalid');
  await createArtifact(invalidRoot, target);
  writeFile(invalidRoot, 'manifest.json', '{invalid json');
  await assert.rejects(createSourcePiCli({ artifactDir: invalidRoot, nodeExecutable: process.execPath, target, spawn }), /cannot read manifest/);

  const tamperedRoot = path.join(root, 'tampered');
  const { cliPath } = await createArtifact(tamperedRoot, target);
  writeFileSync(cliPath, `${FIXTURE_CLI}// changed after manifest\n`);
  await assert.rejects(createSourcePiCli({ artifactDir: tamperedRoot, nodeExecutable: process.execPath, target, spawn }), /hash mismatch/);

  const wrongTarget = { ...target, nodeAbi: String(Number(target.nodeAbi) + 1) };
  const validRoot = path.join(root, 'wrong-target');
  await createArtifact(validRoot, target);
  await assert.rejects(createSourcePiCli({ artifactDir: validRoot, nodeExecutable: process.execPath, target: wrongTarget, spawn }), /target\.nodeAbi mismatch/);
  assert.equal(spawnCount, 0);
}));

test('reusable launcher passes raw Windows-special arguments and caller options unchanged without mutation', async () => withTempDirAsync(async (root) => {
  const target = currentTarget();
  const { cliPath } = await createArtifact(root, target);
  const before = snapshotTree(root);
  const calls = [];
  const child = new EventEmitter();
  const spawn = (executable, args, options) => {
    calls.push({ executable, args, options });
    return child;
  };
  const launcher = await createSourcePiCli({ artifactDir: root, nodeExecutable: process.execPath, target, spawn });
  const args = ['space arg', 'quote"and\\slash', '&|<>^()%!; (group)', 'C:\\Program Files\\Node\\node.exe', '雪', ''];
  const env = { AUTH_MODE: 'caller-owned', PATH: 'do-not-resolve-anything' };
  const cwd = path.join(root, 'working directory');
  const stdio = ['ignore', 'pipe', 'pipe'];
  mkdirSync(cwd);

  assert.equal(launcher.run(args, { env, cwd, stdio }), child);
  assert.equal(launcher.run(['second call'], { env, cwd, stdio }), child);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].executable, process.execPath);
  assert.deepEqual(calls[0].args, [cliPath, ...args]);
  assert.deepEqual(calls[1].args, [cliPath, 'second call']);
  assert.strictEqual(calls[0].options.env, env);
  assert.strictEqual(calls[0].options.stdio, stdio);
  assert.equal(calls[0].options.cwd, cwd);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(snapshotTree(root), before);
}));

test('returns the real child unchanged so CLI argument delivery and exit status propagate', async () => withTempDirAsync(async (root) => {
  const target = currentTarget();
  await createArtifact(root, target);
  const launcher = await createSourcePiCli({ artifactDir: root, nodeExecutable: process.execPath, target });
  const args = ['one two', 'a"b', '&|<>^()%!', 'C:\\path with spaces\\x', '☃'];
  const env = { ...process.env, SOURCE_PI_CLI_TEST: 'preserved' };
  const child = launcher.run(args, { cwd: root, env, stdio: 'pipe' });
  const result = await collectChild(child);

  assert.equal(result.code, 23);
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout), args);
}));

test('preserves native spawn errors from the returned child', async () => withTempDirAsync(async (root) => {
  const target = currentTarget();
  await createArtifact(root, target);
  const missingNode = path.join(root, 'missing node executable');
  const launcher = await createSourcePiCli({ artifactDir: root, nodeExecutable: missingNode, target });
  const child = launcher.run([]);
  await new Promise((resolve, reject) => {
    child.once('error', (error) => {
      try {
        assert.equal(error.code, 'ENOENT');
        resolve();
      } catch (assertionError) { reject(assertionError); }
    });
    child.once('close', (code) => reject(new Error(`expected spawn error, got close ${code}`)));
  });
}));
