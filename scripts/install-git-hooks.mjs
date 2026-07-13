#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = process.platform === 'win32' ? 'git.exe' : 'git';
const result = spawnSync(git, ['config', '--local', 'core.hooksPath', '.githooks'], {
  cwd: root,
  encoding: 'utf8',
});

if (result.status !== 0) {
  const detail = (result.stderr || result.stdout || '').trim();
  console.warn(`install-git-hooks: skipped${detail ? ` (${detail})` : ''}`);
  process.exit(0);
}

console.log('install-git-hooks: configured core.hooksPath=.githooks');
