import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PieDataRootResolutionError,
  resolvePieDataPaths,
  resolvePieDataRoot,
  resolvePieDataSubdirectory,
} from '../../../shared/pie-data-root';

test('PIE_DATA_DIR absolute override is canonical and category paths stay under it', () => {
  const paths = resolvePieDataPaths({
    dataDir: '/var/lib/pie-data/../pie-data',
    platform: 'linux',
    homeDir: '/home/alice',
    environment: {},
  });

  assert.equal(paths.rootDir, '/var/lib/pie-data');
  assert.equal(paths.analyticsDir, '/var/lib/pie-data/analytics');
  assert.equal(paths.sessionsDir, '/var/lib/pie-data/sessions');
  assert.equal(paths.artifactsDir, '/var/lib/pie-data/artifacts');
  assert.equal(paths.cacheDir, '/var/lib/pie-data/cache');
  assert.equal(resolvePieDataSubdirectory(paths.rootDir, 'state', 'linux'), paths.stateDir);
});

test('relative PIE_DATA_DIR is rooted at the normalized agent directory, not cwd', () => {
  assert.equal(
    resolvePieDataRoot({
      dataDir: 'runtime-data',
      agentDir: '~/agent',
      platform: 'linux',
      homeDir: '/home/alice',
      environment: {},
    }),
    '/home/alice/agent/runtime-data',
  );
  assert.throws(
    () => resolvePieDataRoot({
      dataDir: 'runtime-data',
      platform: 'linux',
      homeDir: '/home/alice',
      environment: {},
    }),
    (error: unknown) => error instanceof PieDataRootResolutionError
      && error.message.includes('relative PIE_DATA_DIR'),
  );
});

test('OS defaults use local app data and XDG/application-support authorities', () => {
  assert.equal(
    resolvePieDataRoot({
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      localAppDataDir: 'C:\\Users\\alice\\AppData\\Local',
      environment: {},
    }),
    'C:\\Users\\alice\\AppData\\Local\\pie\\data',
  );
  assert.equal(
    resolvePieDataRoot({
      platform: 'darwin',
      homeDir: '/Users/alice',
      environment: {},
    }),
    '/Users/alice/Library/Application Support/pie/data',
  );
  assert.equal(
    resolvePieDataRoot({
      platform: 'linux',
      homeDir: '/home/alice',
      xdgDataHome: '/mnt/xdg',
      environment: {},
    }),
    '/mnt/xdg/pie/data',
  );
});

test('Windows default never silently falls back when LOCALAPPDATA is unavailable', () => {
  assert.throws(
    () => resolvePieDataRoot({
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      environment: {},
    }),
    (error: unknown) => error instanceof PieDataRootResolutionError
      && error.message.includes('LOCALAPPDATA'),
  );
});
