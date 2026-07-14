import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  ensureAuthPathDirectory,
  ensureDir,
  getDefaultAuthDir,
  isInsideGitWorkTree,
  migrateAuthFile,
} from '../../../src/backend/auth-storage';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-auth-storage-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('isInsideGitWorkTree detects both .git directories and bare-repo .git files', async () => {
  await withTempDir(async (dir) => {
    const repoDir = path.join(dir, 'repo');
    const nestedFile = path.join(repoDir, 'src', 'index.ts');
    await fs.mkdir(path.join(repoDir, '.git'), { recursive: true });
    await fs.mkdir(path.dirname(nestedFile), { recursive: true });
    await fs.writeFile(nestedFile, 'export const value = 1;\n', 'utf8');
    assert.equal(await isInsideGitWorkTree(nestedFile), true);

    const bareRepoDir = path.join(dir, 'bare-repo');
    const bareNestedFile = path.join(bareRepoDir, 'src', 'index.ts');
    await fs.mkdir(path.dirname(bareNestedFile), { recursive: true });
    await fs.writeFile(path.join(bareRepoDir, '.git'), 'gitdir: ../.git/modules/bare-repo\n', 'utf8');
    await fs.writeFile(bareNestedFile, 'export const value = 2;\n', 'utf8');
    assert.equal(await isInsideGitWorkTree(bareNestedFile), true);

    const standaloneFile = path.join(dir, 'standalone', 'index.ts');
    await fs.mkdir(path.dirname(standaloneFile), { recursive: true });
    await fs.writeFile(standaloneFile, 'export const value = 3;\n', 'utf8');
    assert.equal(await isInsideGitWorkTree(standaloneFile), false);
  });
});

test('getDefaultAuthDir prefers LOCALAPPDATA on Windows and HOME or USERPROFILE elsewhere', () => {
  assert.equal(
    getDefaultAuthDir({ LOCALAPPDATA: 'C:/Users/test/AppData/Local', HOME: 'C:/ignored' }, 'win32'),
    path.join('C:/Users/test/AppData/Local', 'pie'),
  );
  assert.equal(
    getDefaultAuthDir({ HOME: '/home/tester' }, 'linux'),
    path.join('/home/tester', '.config', 'pie'),
  );
  assert.equal(
    getDefaultAuthDir({ USERPROFILE: 'C:/Users/profile-only' }, 'darwin'),
    path.join('C:/Users/profile-only', '.config', 'pie'),
  );
});

test('ensureDir and ensureAuthPathDirectory create missing parent directories', async () => {
  await withTempDir(async (dir) => {
    const nestedDir = path.join(dir, 'a', 'b', 'c');
    await ensureDir(nestedDir);
    const nestedAuthPath = path.join(dir, 'auth-root', 'nested', 'auth.json');
    await ensureAuthPathDirectory(nestedAuthPath);

    const nestedDirStat = await fs.stat(nestedDir);
    const nestedAuthDirStat = await fs.stat(path.dirname(nestedAuthPath));
    assert.equal(nestedDirStat.isDirectory(), true);
    assert.equal(nestedAuthDirStat.isDirectory(), true);
  });
});

test('migrateAuthFile returns false when the source is missing or the destination already exists', async () => {
  await withTempDir(async (dir) => {
    const missingSource = path.join(dir, 'missing-auth.json');
    const destination = path.join(dir, 'dest', 'auth.json');
    assert.equal(await migrateAuthFile(missingSource, destination), false);

    const source = path.join(dir, 'source-auth.json');
    await fs.writeFile(source, '{"token":"source"}\n', 'utf8');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, '{"token":"dest"}\n', 'utf8');
    assert.equal(await migrateAuthFile(source, destination), false);
    assert.equal(await fs.readFile(source, 'utf8'), '{"token":"source"}\n');
  });
});

test('migrateAuthFile preserves the source file when copy verification detects a mismatch', async () => {
  await withTempDir(async (dir) => {
    const source = path.join(dir, 'source-auth.json');
    const destination = path.join(dir, 'dest', 'auth.json');
    await fs.writeFile(source, '{"token":"source"}\n', 'utf8');

    const fsPromisesModule = require('node:fs/promises') as typeof import('node:fs/promises');
    const originalReadFile = fsPromisesModule.readFile;
    fsPromisesModule.readFile = (async (filePath: Parameters<typeof originalReadFile>[0], ...args: Parameters<typeof originalReadFile> extends [any, ...infer Rest] ? Rest : never) => {
      const value = await originalReadFile(filePath as any, ...(args as []));
      if (path.resolve(String(filePath)) === path.resolve(destination)) {
        return Buffer.from('mismatch');
      }
      return value;
    }) as typeof originalReadFile;

    try {
      assert.equal(await migrateAuthFile(source, destination), false);
    } finally {
      fsPromisesModule.readFile = originalReadFile;
    }

    assert.equal(await fs.readFile(source, 'utf8'), '{"token":"source"}\n');
    assert.equal(await fs.readFile(destination, 'utf8'), '{"token":"source"}\n');
  });
});


