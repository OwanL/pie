import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isActiveDirectoryLockError,
  mirrorDirectoryInPlace,
  syncActiveDestinationInPlace,
  writeFileIfChanged,
} from '../../../scripts/sync-output.mjs';
import { isHotReloadAssetFileName } from '../../../src/host/webview/hot-reload';

test('isHotReloadAssetFileName matches built assets and ignores sourcemaps', () => {
  assert.equal(isHotReloadAssetFileName('panel.js'), true);
  assert.equal(isHotReloadAssetFileName('panel-abc123.js'), true);
  assert.equal(isHotReloadAssetFileName('panel.css'), true);
  assert.equal(isHotReloadAssetFileName('index.html'), true);
  assert.equal(isHotReloadAssetFileName('.vite/manifest.json'), true);
  assert.equal(isHotReloadAssetFileName('/tmp/panel.js'), true);
  assert.equal(isHotReloadAssetFileName('panel.js.map'), false);
  assert.equal(isHotReloadAssetFileName(undefined), false);
});

test('build script stages and verifies rebuilt assets before replacing installed output', async () => {
  const buildScript = await readFile(new URL('../../../scripts/build.mjs', import.meta.url), 'utf8');

  assert.match(buildScript, /await verifyCoordinatedBuildIdentity\(\);/);
  assert.match(buildScript, /await cp\(outDir, staging, \{ recursive: true, force: true \}\);/);
  assert.match(buildScript, /await verifyCoordinatedBuildIdentity\(staging\);/);
  assert.match(buildScript, /await rename\(staging, dest\);/);
  assert.ok(
    buildScript.indexOf('await verifyCoordinatedBuildIdentity(staging);')
      < buildScript.indexOf('await rename(staging, dest);'),
    'staged output must be verified before it replaces the installed output',
  );
});

test('build script falls back to a verified in-place sync when active Windows processes lock the installed directory', async () => {
  const buildScript = await readFile(new URL('../../../scripts/build.mjs', import.meta.url), 'utf8');

  assert.match(buildScript, /isActiveDirectoryLockError, syncActiveDestinationInPlace/);
  assert.match(buildScript, /await syncActiveDestinationInPlace\(\{/);
  assert.match(buildScript, /verify: verifyCoordinatedBuildIdentity/);
});

test('active-directory lock detection is limited to Windows sharing errors', () => {
  for (const code of ['EACCES', 'EBUSY', 'EPERM']) {
    assert.equal(isActiveDirectoryLockError({ code }, 'win32'), true);
  }
  assert.equal(isActiveDirectoryLockError({ code: 'ENOENT' }, 'win32'), false);
  assert.equal(isActiveDirectoryLockError({ code: 'EPERM' }, 'linux'), false);
});

test('in-place mirror removes stale files and handles file-directory type changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-sync-output-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  try {
    await Promise.all([
      mkdir(path.join(source, 'directory'), { recursive: true }),
      mkdir(path.join(destination, 'file'), { recursive: true }),
      mkdir(destination, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(source, 'current.js'), 'new'),
      writeFile(path.join(source, 'directory', 'nested.js'), 'nested'),
      writeFile(path.join(source, 'file'), 'now-a-file'),
      writeFile(path.join(destination, 'current.js'), 'old'),
      writeFile(path.join(destination, 'directory'), 'was-a-file'),
      writeFile(path.join(destination, 'file', 'nested.js'), 'was-a-directory'),
      writeFile(path.join(destination, 'stale.js'), 'stale'),
    ]);

    await mirrorDirectoryInPlace(source, destination);

    assert.equal(await readFile(path.join(destination, 'current.js'), 'utf8'), 'new');
    assert.equal(await readFile(path.join(destination, 'directory', 'nested.js'), 'utf8'), 'nested');
    assert.equal(await readFile(path.join(destination, 'file'), 'utf8'), 'now-a-file');
    await assert.rejects(readFile(path.join(destination, 'stale.js')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed active-directory sync restores the verified previous output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-sync-rollback-'));
  const staging = path.join(root, 'staging');
  const destination = path.join(root, 'destination');
  const backup = path.join(root, 'backup');
  try {
    await Promise.all([mkdir(staging), mkdir(destination)]);
    await Promise.all([
      writeFile(path.join(staging, 'identity.txt'), 'new'),
      writeFile(path.join(destination, 'identity.txt'), 'old'),
    ]);

    const verify = async (directory: string) => {
      const identity = await readFile(path.join(directory, 'identity.txt'), 'utf8');
      if (directory === destination && identity === 'new') {
        throw new Error('reject new output');
      }
    };

    await assert.rejects(
      syncActiveDestinationInPlace({ staging, dest: destination, backup, verify, warn: () => {} }),
      /reject new output/,
    );

    assert.equal(await readFile(path.join(destination, 'identity.txt'), 'utf8'), 'old');
    await assert.rejects(readFile(staging), { code: 'ENOENT' });
    await assert.rejects(readFile(backup), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed rollback retains the previous output snapshot for manual recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-sync-failed-rollback-'));
  const staging = path.join(root, 'staging');
  const destination = path.join(root, 'destination');
  const backup = path.join(root, 'backup');
  try {
    await Promise.all([mkdir(staging), mkdir(destination)]);
    await Promise.all([
      writeFile(path.join(staging, 'identity.txt'), 'new'),
      writeFile(path.join(destination, 'identity.txt'), 'old'),
    ]);

    const verify = async (directory: string) => {
      if (directory === destination) throw new Error('destination verification failed');
      await readFile(path.join(directory, 'identity.txt'));
    };

    await assert.rejects(
      syncActiveDestinationInPlace({ staging, dest: destination, backup, verify, warn: () => {} }),
      (error: unknown) => error instanceof AggregateError && /snapshot retained/.test(error.message),
    );

    assert.equal(await readFile(path.join(backup, 'identity.txt'), 'utf8'), 'old');
    await assert.rejects(readFile(staging), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid backup aborts before mutating the active destination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-sync-invalid-backup-'));
  const staging = path.join(root, 'staging');
  const destination = path.join(root, 'destination');
  const backup = path.join(root, 'backup');
  try {
    await Promise.all([mkdir(staging), mkdir(destination)]);
    await Promise.all([
      writeFile(path.join(staging, 'identity.txt'), 'new'),
      writeFile(path.join(destination, 'identity.txt'), 'old'),
    ]);

    const verify = async (directory: string) => {
      if (directory === backup) throw new Error('invalid backup');
    };

    await assert.rejects(
      syncActiveDestinationInPlace({ staging, dest: destination, backup, verify, warn: () => {} }),
      /invalid backup/,
    );

    assert.equal(await readFile(path.join(destination, 'identity.txt'), 'utf8'), 'old');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeFileIfChanged leaves an identical installed manifest untouched', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-manifest-unchanged-'));
  const manifestPath = path.join(root, 'package.json');
  const contents = JSON.stringify({ publisher: 'owanl', name: 'pie', version: '1.2.3' }, null, 2);
  try {
    await writeFile(manifestPath, contents);
    const before = await stat(manifestPath);

    assert.equal(await writeFileIfChanged(manifestPath, contents), false);

    const after = await stat(manifestPath);
    assert.equal(after.mtimeMs, before.mtimeMs, 'unchanged manifest must not be rewritten or touched');
    assert.equal(await readFile(manifestPath, 'utf8'), contents);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeFileIfChanged rewrites a changed manifest and creates a missing one', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-manifest-changed-'));
  const manifestPath = path.join(root, 'package.json');
  const oldContents = JSON.stringify({ publisher: 'owanl', name: 'pie', version: '1.2.3' }, null, 2);
  const newContents = JSON.stringify({ publisher: 'owanl', name: 'pie', version: '1.2.4' }, null, 2);
  try {
    await writeFile(manifestPath, oldContents);

    assert.equal(await writeFileIfChanged(manifestPath, newContents), true);
    assert.equal(await readFile(manifestPath, 'utf8'), newContents);

    const missingPath = path.join(root, 'nested', 'package.json');
    await mkdir(path.dirname(missingPath), { recursive: true });
    assert.equal(await writeFileIfChanged(missingPath, newContents), true);
    assert.equal(await readFile(missingPath, 'utf8'), newContents);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('build script writes the installed manifest only when its content changed', async () => {
  const buildScript = await readFile(new URL('../../../scripts/build.mjs', import.meta.url), 'utf8');

  assert.match(
    buildScript,
    /await writeFileIfChanged\(path\.join\(extDir, 'package\.json'\), JSON\.stringify\(pkg, null, 2\)\);/,
  );
  assert.match(buildScript, /writeFileIfChanged } from '\.\/sync-output\.mjs';/);
  assert.doesNotMatch(
    buildScript,
    /await writeFile\(path\.join\(extDir, 'package\.json'\)/,
    'installed manifest must not be rewritten unconditionally during sync',
  );
});

test('watch mode waits for complete host and webview output before syncing', async () => {
  const buildScript = await readFile(new URL('../../../scripts/build.mjs', import.meta.url), 'utf8');

  assert.match(buildScript, /function createBuiltOutputWatcher\(\)/);
  assert.match(buildScript, /fsWatch\(outDir, \{ recursive: true \}/);
  assert.match(buildScript, /if \(mode === 'node'\) args\.push\('--emptyOutDir=false'\);/);

  const watchBranch = buildScript.slice(buildScript.indexOf('if (watchMode) {'));
  const initialSetup = watchBranch.slice(0, watchBranch.indexOf('const shutdown'));
  assert.doesNotMatch(initialSetup, /await syncToInstalledExtension\(\);/);
});

test('build script builds everything with Vite', async () => {
  const buildScript = await readFile(new URL('../../../scripts/build.mjs', import.meta.url), 'utf8');

  assert.match(buildScript, /function runViteBuild\(/);
  assert.match(buildScript, /node_modules', 'vite', 'bin', 'vite\.js'/);
  assert.match(buildScript, /await Promise\.all\(\[/);
  assert.match(buildScript, /function runViteWatch\(/);
  assert.match(buildScript, /const nodeViteProcess = runViteWatch\('node'\)/);
  assert.doesNotMatch(buildScript, /import esbuild from 'esbuild'/);
  assert.doesNotMatch(buildScript, /esbuild\.build\(/);
});
