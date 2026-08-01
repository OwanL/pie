// Focused unit tests for scripts/install/lib/auth.mjs — the split-brain auth
// merge and content-detection helpers shared by both shell installers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { authHasContent, authProviderNames, mergeAuthProviders, readAuthProviders, relocateAuthFile } from '../install/lib/auth.mjs';

function withTempDir(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-install-auth-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('mergeAuthProviders adds new providers and overwrites conflicting ones (in-tree wins)', () => {
  const secure = { anthropic: { apiKey: 'old' }, openai: { apiKey: 'keep' } };
  const inTree = { anthropic: { apiKey: 'fresh' }, google: { apiKey: 'new' } };
  const { secure: merged, mergedCount } = mergeAuthProviders(inTree, secure);
  assert.equal(mergedCount, 2);
  assert.equal(merged.anthropic.apiKey, 'fresh');
  assert.equal(merged.google.apiKey, 'new');
  // Untouched provider retained.
  assert.equal(merged.openai.apiKey, 'keep');
});

test('mergeAuthProviders skips providers whose creds are identical', () => {
  const secure = { anthropic: { apiKey: 'same' } };
  const inTree = { anthropic: { apiKey: 'same' } };
  const { mergedCount } = mergeAuthProviders(inTree, secure);
  assert.equal(mergedCount, 0);
});

test('mergeAuthProviders treats a missing secure provider as a merge (not a skip)', () => {
  const { secure, mergedCount } = mergeAuthProviders({ umans: { key: 'k' } }, {});
  assert.equal(mergedCount, 1);
  assert.deepEqual(secure.umans, { key: 'k' });
});

test('readAuthProviders returns {} for missing or malformed files', () => withTempDir((root) => {
  assert.deepEqual(readAuthProviders(path.join(root, 'missing.json')), {});
  const bad = path.join(root, 'bad.json');
  writeFileSync(bad, '{not json');
  assert.deepEqual(readAuthProviders(bad), {});
  const empty = path.join(root, 'empty.json');
  writeFileSync(empty, '{}');
  assert.deepEqual(readAuthProviders(empty), {});
  const ok = path.join(root, 'ok.json');
  writeFileSync(ok, '{"anthropic":{"apiKey":"x"}}');
  assert.deepEqual(readAuthProviders(ok), { anthropic: { apiKey: 'x' } });
}));

test('authHasContent / authProviderNames distinguish real credentials from {}', () => {
  assert.equal(authHasContent({}), false);
  assert.equal(authHasContent({}), false);
  assert.equal(authHasContent({ anthropic: { key: 'k' } }), true);
  assert.deepEqual(authProviderNames({ anthropic: { k: 1 }, openai: { k: 2 } }), ['anthropic', 'openai']);
  assert.deepEqual(authProviderNames({}), []);
});

// ---------------------------------------------------------------------------
// relocateAuthFile - atomic copy + SHA-256 verify (install.bat's first-time
// credential relocation core; the wrapper owns ACL/setx/breadcrumb afterwards)
// ---------------------------------------------------------------------------

test('relocateAuthFile copies src to dest and verifies with SHA-256', () => withTempDir((root) => {
  const src = path.join(root, 'tree', 'auth.json');
  mkdirSync(path.dirname(src), { recursive: true });
  const payload = JSON.stringify({ anthropic: { apiKey: 'sk-ant-xyz' } });
  writeFileSync(src, payload);
  const dest = path.join(root, 'secure', 'pie', 'auth.json');
  const res = relocateAuthFile({ src, dest });
  assert.equal(res.ok, true);
  assert.equal(res.dest, dest);
  // Byte-for-byte identical copy.
  assert.equal(readFileSync(dest, 'utf8'), payload);
}));

test('relocateAuthFile creates the destination directory tree when missing', () => withTempDir((root) => {
  const src = path.join(root, 'auth.json');
  writeFileSync(src, '{"umans":{"key":"k"}}');
  const dest = path.join(root, 'a', 'b', 'c', 'auth.json');
  assert.equal(existsSync(path.dirname(dest)), false);
  const res = relocateAuthFile({ src, dest });
  assert.equal(res.ok, true);
  assert.equal(existsSync(dest), true);
}));

test('relocateAuthFile leaves the source untouched (it is a copy, not a move)', () => withTempDir((root) => {
  const src = path.join(root, 'auth.json');
  const payload = '{"google":{"apiKey":"g"}}';
  writeFileSync(src, payload);
  const dest = path.join(root, 'secure', 'auth.json');
  relocateAuthFile({ src, dest });
  assert.equal(existsSync(src), true);
  assert.equal(readFileSync(src, 'utf8'), payload);
}));

test('relocateAuthFile overwrites an existing dest and still verifies', () => withTempDir((root) => {
  const src = path.join(root, 'auth.json');
  writeFileSync(src, '{"anthropic":{"apiKey":"fresh"}}');
  const dest = path.join(root, 'secure', 'auth.json');
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, 'STALE');
  const res = relocateAuthFile({ src, dest });
  assert.equal(res.ok, true);
  assert.equal(readFileSync(dest, 'utf8'), '{"anthropic":{"apiKey":"fresh"}}');
}));

test('relocateAuthFile does not throw on win32 and skips the POSIX chmod', () => withTempDir((root) => {
  const src = path.join(root, 'auth.json');
  writeFileSync(src, '{"anthropic":{"apiKey":"k"}}');
  const dest = path.join(root, 'secure', 'auth.json');
  // Explicit platform: 'win32' => no chmod attempt; should not throw even on a
  // POSIX test host.
  const res = relocateAuthFile({ src, dest, platform: 'win32' });
  assert.equal(res.ok, true);
}));

test('relocateAuthFile on POSIX chmods the destination 600 (best-effort)', () => withTempDir((root) => {
  const src = path.join(root, 'auth.json');
  writeFileSync(src, '{"anthropic":{"apiKey":"k"}}');
  const dest = path.join(root, 'secure', 'auth.json');
  relocateAuthFile({ src, dest, platform: 'posix' });
  // On POSIX the owner-read/write bits should be set and group/other cleared
  // (modulo filesystem support). On Windows this assertion is skipped.
  if (process.platform !== 'win32') {
    const mode = statSync(dest).mode & 0o777;
    assert.equal(mode & 0o077, 0, `dest should be owner-only; got ${mode.toString(8)}`);
    assert.ok(mode & 0o600, 'owner read/write bits set');
  }
}));
