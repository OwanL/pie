import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveProviderConfigPaths, assertProviderManagementPathsOutsideGit } from '../provider-config-paths';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('path boundary rejects any Git ancestor including worktree .git files', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pie-provider-paths-'));
  try {
    const safe = { configDir: path.join(temp, 'private/providers'), configFile: path.join(temp, 'private/providers/providers.yaml'), modelCacheDir: path.join(temp, 'private/cache') };
    await assertProviderManagementPathsOutsideGit(safe);
    for (const gitKind of ['directory', 'file']) {
      const tree = path.join(temp, gitKind);
      await mkdir(tree);
      if (gitKind === 'directory') await mkdir(path.join(tree, '.git'));
      else await writeFile(path.join(tree, '.git'), 'gitdir: /not-read');
      for (const key of ['configDir', 'configFile', 'modelCacheDir'] as const) {
        await assert.rejects(assertProviderManagementPathsOutsideGit({ ...safe, [key]: path.join(tree, 'deep/missing/provider') }), /outside Git/);
      }
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('Windows defaults use LOCALAPPDATA for config and the resolved Pie data cache', () => {
  assert.deepEqual(resolveProviderConfigPaths({
    platform: 'win32',
    homeDir: 'C:\\Users\\alice',
    localAppDataDir: 'C:\\Users\\alice\\AppData\\Local',
    dataDir: 'D:\\PieData',
    environment: {},
  }), {
    configDir: 'C:\\Users\\alice\\AppData\\Local\\pie\\config',
    configFile: 'C:\\Users\\alice\\AppData\\Local\\pie\\config\\providers.yaml',
    modelCacheDir: 'D:\\PieData\\cache\\provider-models',
  });
});

test('normal Windows defaults share the existing OS-local data/cache root', () => {
  assert.deepEqual(resolveProviderConfigPaths({
    platform: 'win32', environment: {
      USERPROFILE: 'C:\\Users\\alice', LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
    },
  }), {
    configDir: 'C:\\Users\\alice\\AppData\\Local\\pie\\config',
    configFile: 'C:\\Users\\alice\\AppData\\Local\\pie\\config\\providers.yaml',
    modelCacheDir: 'C:\\Users\\alice\\AppData\\Local\\pie\\data\\cache\\provider-models',
  });
});

test('an explicit config directory and data root support a private profile pair', () => {
  assert.deepEqual(resolveProviderConfigPaths({
    platform: 'win32',
    configDir: 'E:\\profiles\\dev\\config',
    dataDir: 'E:\\profiles\\dev\\data',
    environment: {},
  }), {
    configDir: 'E:\\profiles\\dev\\config',
    configFile: 'E:\\profiles\\dev\\config\\providers.yaml',
    modelCacheDir: 'E:\\profiles\\dev\\data\\cache\\provider-models',
  });
});

test('Windows default config location rejects unavailable or relative LOCALAPPDATA', () => {
  for (const localAppDataDir of [undefined, '', 'relative\\appdata']) {
    assert.throws(() => resolveProviderConfigPaths({
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      localAppDataDir,
      environment: {},
    }), /LOCALAPPDATA/);
  }
});

test('an injected environment never falls back to the installed profile environment', () => {
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = 'C:\\installed-profile';
  try {
    assert.throws(() => resolveProviderConfigPaths({
      platform: 'win32', dataDir: 'D:\\private-data', environment: {},
    }), /LOCALAPPDATA/);
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  }
});

test('explicit configDir rejects empty and relative paths', () => {
  for (const configDir of ['', 'relative\\config']) {
    assert.throws(() => resolveProviderConfigPaths({
      platform: 'win32',
      configDir,
      dataDir: 'C:\\PieData',
      environment: {},
    }), /configDir.*absolute/);
  }
});

test('directory inputs reject NUL bytes consistently with the canonical data root resolver', () => {
  assert.throws(() => resolveProviderConfigPaths({
    platform: 'win32', configDir: 'C:\\private\u0000', dataDir: 'D:\\data', environment: {},
  }), /configDir.*NUL/);
  assert.throws(() => resolveProviderConfigPaths({
    platform: 'win32', localAppDataDir: 'C:\\local\u0000', dataDir: 'D:\\data', environment: {},
  }), /LOCALAPPDATA.*NUL/);
});

test('non-Windows supports explicit absolute configDir without defining a config default', () => {
  assert.deepEqual(resolveProviderConfigPaths({
    platform: 'linux',
    configDir: '/profiles/dev/config',
    dataDir: '/profiles/dev/data',
    homeDir: '/home/alice',
    environment: {},
  }), {
    configDir: '/profiles/dev/config',
    configFile: '/profiles/dev/config/providers.yaml',
    modelCacheDir: '/profiles/dev/data/cache/provider-models',
  });
  assert.throws(() => resolveProviderConfigPaths({
    platform: 'linux',
    dataDir: '/profiles/dev/data',
    homeDir: '/home/alice',
    environment: {},
  }), /only defined for Windows/);
});
