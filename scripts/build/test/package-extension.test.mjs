import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { packageExtension } from '../package-extension.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'pie-package-extension-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const hostRoot = path.join(root, 'application', 'hosts', 'vscode');
  const outputBuildDir = path.join(hostRoot, 'out');
  const scratchParent = path.join(base, 'scratch-parent');
  const put = async (file, bytes) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  };
  await put(path.join(hostRoot, 'package.json'), JSON.stringify({ name: 'pie', version: '0.3.0' }));
  await put(path.join(hostRoot, '.vscodeignore'), 'ignore source\n');
  await put(path.join(hostRoot, 'media/icon.svg'), '<svg/>');
  await put(path.join(hostRoot, 'runtime/bootstrap.cjs'), 'bootstrap bytes');
  await put(path.join(outputBuildDir, 'pi-runtime/manifest.json'), '{}');
  await put(path.join(outputBuildDir, 'extension.js'), 'delivery output');
  await put(path.join(root, 'LICENSE'), 'root license\r\n');
  await put(path.join(root, 'COPYRIGHT'), 'root copyright\r\n');
  await mkdir(scratchParent);
  const calls = [];
  const deps = {
    root,
    hostRoot,
    createTemp: () => mkdtemp(path.join(scratchParent, 'private-')),
    resolveVsce: async owner => {
      calls.push(['resolve', owner]);
      return 'fake-vsce';
    },
    runVsce: async (vsce, args, options) => {
      calls.push(['package', vsce, args, options]);
    },
  };
  return { base, root, hostRoot, outputBuildDir, scratchParent, calls, deps };
}

test('direct packaging stages the existing delivery output and license notices privately without rebuilding', async t => {
  const f = await fixture(t);
  const originalManifest = await readFile(path.join(f.hostRoot, 'package.json'));
  const originalOutput = await readFile(path.join(f.outputBuildDir, 'extension.js'));
  let scratch;
  f.deps.runVsce = async (vsce, args, { cwd }) => {
    scratch = path.dirname(cwd);
    f.calls.push(['package']);
    assert.equal(vsce, 'fake-vsce');
    assert.equal(path.relative(f.scratchParent, scratch).startsWith('..'), false);
    assert.equal(await readFile(path.join(cwd, 'LICENSE'), 'utf8'), 'root license\r\n');
    assert.equal(await readFile(path.join(cwd, 'COPYRIGHT'), 'utf8'), 'root copyright\r\n');
    assert.equal(await readFile(path.join(cwd, 'out', 'extension.js'), 'utf8'), 'delivery output');
    assert.deepEqual(args, ['package', '--no-dependencies', '--allow-missing-repository', '--target', 'win32-x64']);
    await writeFile(path.join(cwd, 'pie-0.3.0-win32-x64.vsix'), 'package bytes');
  };

  const result = await packageExtension(['--target', 'win32-x64'], f.deps);
  assert.equal(result.output, path.join(f.hostRoot, 'pie-0.3.0-win32-x64.vsix'));
  assert.equal(await readFile(result.output, 'utf8'), 'package bytes');
  assert.equal(await readFile(path.join(f.hostRoot, 'package.json')).then(bytes => bytes.equals(originalManifest)), true);
  assert.equal(await readFile(path.join(f.outputBuildDir, 'extension.js')).then(bytes => bytes.equals(originalOutput)), true);
  assert.deepEqual(await readdir(f.scratchParent), []);
  assert.deepEqual(f.calls.map(call => call[0]), ['resolve', 'package']);
});

test('relative --out arguments retain host-package-relative output semantics', async t => {
  const f = await fixture(t);
  const result = await packageExtension(['-o', 'release/custom.vsix'], {
    ...f.deps,
    runVsce: async (_vsce, args) => {
      assert.deepEqual(args, ['package', '--no-dependencies', '--allow-missing-repository', '-o', path.join(f.hostRoot, 'release/custom.vsix')]);
      await mkdir(path.dirname(path.join(f.hostRoot, 'release/custom.vsix')), { recursive: true });
      await writeFile(path.join(f.hostRoot, 'release/custom.vsix'), 'explicit package');
    },
  });
  assert.equal(result.output, path.join(f.hostRoot, 'release/custom.vsix'));
  assert.equal(await readFile(result.output, 'utf8'), 'explicit package');
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('package script routes preserve the build lifecycle and use the staging CLI', async () => {
  const root = fileURLToPath(new URL('../../../package.json', import.meta.url));
  const host = fileURLToPath(new URL('../../../application/hosts/vscode/package.json', import.meta.url));
  const rootManifest = JSON.parse(await readFile(root, 'utf8'));
  const hostManifest = JSON.parse(await readFile(host, 'utf8'));
  assert.equal(rootManifest.scripts['extension:package'], 'npm --prefix application/hosts/vscode run package --');
  assert.equal(hostManifest.scripts.prepackage, 'node ../../../scripts/build/build.mjs --delivery --no-sync');
  assert.equal(hostManifest.scripts.package, 'node ../../../scripts/build/package-extension.mjs');
  assert.doesNotMatch(hostManifest.scripts.package, /skip-license/u);
});
