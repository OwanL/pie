import assert from 'node:assert/strict';
import test from 'node:test';

import { withoutGitRepositoryEnv } from '../lib/git-environment.mjs';

test('withoutGitRepositoryEnv prevents hook-local Git state leaking into test fixtures', () => {
  const source = {
    PATH: 'tools',
    GIT_DIR: 'real-worktree-git-dir',
    GIT_INDEX_FILE: 'real-worktree-index',
    GIT_WORK_TREE: 'real-worktree',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '.githooks',
    GIT_AUTHOR_NAME: 'Keep Author',
  };

  assert.deepEqual(withoutGitRepositoryEnv(source), {
    PATH: 'tools',
    GIT_AUTHOR_NAME: 'Keep Author',
  });
  assert.equal(source.GIT_DIR, 'real-worktree-git-dir');
});
