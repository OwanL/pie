import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';

import { canonicalFilePath } from '../../../src/shared/file-path';

// canonicalFilePath produces a stable IDENTITY key for a file path so that the
// same file reached through different spellings (relative/absolute, `./` prefix,
// separator/case variants) collapses to one entry. It is NOT a display path —
// callers keep the original spelling for display and use this only as a Map/Set
// key and for manifest lookup.

const CASE_INSENSITIVE = os.platform() === 'win32' || os.platform() === 'darwin';

test('canonicalFilePath: relative path resolves against cwd', () => {
  const key = canonicalFilePath('src/x.ts', '/proj');
  assert.equal(key, canonicalFilePath('/proj/src/x.ts', '/proj'));
});

test('canonicalFilePath: `./` prefix collapses to the same key as bare relative', () => {
  assert.equal(
    canonicalFilePath('src/x.ts', '/proj'),
    canonicalFilePath('./src/x.ts', '/proj'),
  );
});

test('canonicalFilePath: `..` segments normalize', () => {
  assert.equal(
    canonicalFilePath('src/../src/x.ts', '/proj'),
    canonicalFilePath('src/x.ts', '/proj'),
  );
});

test('canonicalFilePath: absolute path is independent of cwd when cwd omitted', () => {
  // No cwd → normalize in place; an absolute path keeps its identity.
  assert.equal(
    canonicalFilePath('/proj/src/x.ts'),
    canonicalFilePath('/proj/src/x.ts'),
  );
});

test('canonicalFilePath: absolute path matches the same file spelled relative to its cwd', () => {
  // Both calls share the cwd so resolution is consistent across platforms
  // (on Windows a bare `/proj` is drive-relative and only picks up a drive
  // letter when passed through path.resolve alongside a cwd).
  assert.equal(
    canonicalFilePath('/proj/src/x.ts', '/proj'),
    canonicalFilePath('src/x.ts', '/proj'),
  );
});

test('canonicalFilePath: trailing separator on cwd does not change identity', () => {
  const sep = path.sep;
  assert.equal(
    canonicalFilePath('src/x.ts', `/proj${sep}`),
    canonicalFilePath('src/x.ts', '/proj'),
  );
});

test('canonicalFilePath: backslash separator matches forward slash', () => {
  // On all platforms the canonical key uses '/' so `src\x.ts` and `src/x.ts`
  // are the same file.
  assert.equal(
    canonicalFilePath('src\\x.ts', '/proj'),
    canonicalFilePath('src/x.ts', '/proj'),
  );
});

test('canonicalFilePath: case-insensitive on Windows/macOS, case-sensitive elsewhere', () => {
  const a = canonicalFilePath('src/X.ts', '/proj');
  const b = canonicalFilePath('src/x.ts', '/proj');
  if (CASE_INSENSITIVE) {
    assert.equal(a, b);
  } else {
    assert.notEqual(a, b);
  }
});

test('canonicalFilePath: empty string passes through', () => {
  assert.equal(canonicalFilePath(''), '');
});

test('canonicalFilePath: a sibling sharing the cwd name prefix is NOT the same file', () => {
  // `/proj-sibling/x.ts` must not collide with `/proj/x.ts`.
  assert.notEqual(
    canonicalFilePath('/proj-sibling/x.ts', '/proj'),
    canonicalFilePath('x.ts', '/proj'),
  );
});
