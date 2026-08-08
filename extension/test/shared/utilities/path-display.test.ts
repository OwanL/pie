import assert from 'node:assert/strict';
import test from 'node:test';

import { formatPathWithParentDepth } from '../../../src/shared/path-utils';

test('formatPathWithParentDepth keeps only the configured parent suffix', () => {
  const path = 'dira/dirb/dirc/file.ts';
  assert.equal(formatPathWithParentDepth(path, 0), 'file.ts');
  assert.equal(formatPathWithParentDepth(path, 1), 'dirc/file.ts');
  assert.equal(formatPathWithParentDepth(path, 2), 'dirb/dirc/file.ts');
  assert.equal(formatPathWithParentDepth(path, 8), path);
});

test('formatPathWithParentDepth normalizes Windows and UNC separators for display', () => {
  assert.equal(formatPathWithParentDepth('C:\\repo\\src\\file.ts', 1), 'src/file.ts');
  assert.equal(formatPathWithParentDepth('\\\\server\\share\\dir\\file.ts', 2), 'share/dir/file.ts');
});

test('formatPathWithParentDepth preserves bare filenames and empty values', () => {
  assert.equal(formatPathWithParentDepth('README.md', 0), 'README.md');
  assert.equal(formatPathWithParentDepth('', 1), '');
});
