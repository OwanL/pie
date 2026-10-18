import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';

import {
  buildWorkspaceAnalyticsId,
  getDataOutcomesRootPath,
  workspaceHash,
  type AnalyticsUriLike,
} from '../../legacy/privacy-storage.js';

function uri(scheme: string, value: string, fsPath?: string): AnalyticsUriLike {
  return {
    scheme,
    ...(fsPath === undefined ? {} : { fsPath }),
    toString: () => value,
  };
}

test('workspace analytics identity sorts multiple folders independently of input order', () => {
  const folderA = { uri: uri('file', 'file:///workspace/a', '/workspace/a') };
  const folderB = { uri: uri('file', 'file:///workspace/b', '/workspace/b') };
  const expected = JSON.stringify({ folders: ['file:/workspace/a', 'file:/workspace/b'] });

  assert.equal(buildWorkspaceAnalyticsId({ workspaceFolders: [folderA, folderB], noWorkspaceId: 'unused' }), expected);
  assert.equal(buildWorkspaceAnalyticsId({ workspaceFolders: [folderB, folderA], noWorkspaceId: 'unused' }), expected);
});

test('workspace analytics identity normalizes Windows paths case-insensitively but preserves POSIX case', () => {
  const windowsId = (workspacePath: string) => buildWorkspaceAnalyticsId({
    workspaceFolders: [{ uri: uri('file', `file:///${workspacePath}`, workspacePath) }],
    noWorkspaceId: 'unused',
    platform: 'win32',
  });
  assert.equal(windowsId('C:\\Users\\Alice\\Project'), windowsId('c:/users/alice/project'));

  const posixId = (workspacePath: string) => buildWorkspaceAnalyticsId({
    workspaceFolders: [{ uri: uri('file', `file://${workspacePath}`, workspacePath) }],
    noWorkspaceId: 'unused',
    platform: 'linux',
  });
  assert.notEqual(posixId('/Users/Alice/Project'), posixId('/users/alice/project'));
});

test('workspace file and no-workspace identities retain their legacy shapes', () => {
  const workspaceFile = uri('file', 'file:///workspace/demo.code-workspace', '/workspace/demo.code-workspace');
  assert.equal(
    buildWorkspaceAnalyticsId({ workspaceFile, noWorkspaceId: 'unused' }),
    JSON.stringify({ workspaceFile: 'file:/workspace/demo.code-workspace' }),
  );
  assert.equal(
    buildWorkspaceAnalyticsId({ noWorkspaceId: '  stable-id  ' }),
    JSON.stringify({ noWorkspaceId: 'stable-id' }),
  );
  assert.equal(buildWorkspaceAnalyticsId({ noWorkspaceId: '  ' }), JSON.stringify({ noWorkspaceId: 'default' }));
});

test('workspace hash remains the truncated SHA-256 legacy key', () => {
  assert.equal(workspaceHash('workspace-a'), '0dcf2d98505da17d');
  assert.notEqual(workspaceHash('workspace-a'), workspaceHash('workspace-b'));
});

test('outcomes root prefers PIE_ANALYTICS_DIR over configured and global roots, restoring the environment', (t) => {
  const original = process.env.PIE_ANALYTICS_DIR;
  t.after(() => {
    if (original === undefined) {
      delete process.env.PIE_ANALYTICS_DIR;
    } else {
      process.env.PIE_ANALYTICS_DIR = original;
    }
  });

  process.env.PIE_ANALYTICS_DIR = '  ./analytics-override  ';
  assert.equal(
    getDataOutcomesRootPath('/configured/root', '/global/storage'),
    path.resolve('./analytics-override'),
  );
});

test('outcomes root falls back from configured root to global storage', (t) => {
  const original = process.env.PIE_ANALYTICS_DIR;
  t.after(() => {
    if (original === undefined) {
      delete process.env.PIE_ANALYTICS_DIR;
    } else {
      process.env.PIE_ANALYTICS_DIR = original;
    }
  });
  delete process.env.PIE_ANALYTICS_DIR;

  assert.equal(
    getDataOutcomesRootPath('  /configured/root  ', '/global/storage'),
    path.join('/configured/root', 'data', 'outcomes'),
  );
  assert.equal(
    getDataOutcomesRootPath('  ', '/global/storage'),
    path.join('/global/storage', 'data', 'outcomes'),
  );
});
