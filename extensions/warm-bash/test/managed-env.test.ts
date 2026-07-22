import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { delimiter } from 'node:path';
import { prependManagedBinDir } from '../src/managed-env.js';

/** The PATH key this platform uses inside process.env (Path on Windows,
 *  PATH on POSIX). pi's managed-bin prepend targets this key. */
function platformPathKey(): string {
  return Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
}

describe('prependManagedBinDir', () => {
  test('prepends binDir ahead of the existing PATH', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = { [key]: ['/usr/bin', '/bin'].join(delimiter) };
    const out = prependManagedBinDir(env, '/managed/bin');
    const entries = (out[key] ?? '').split(delimiter);
    assert.equal(entries[0], '/managed/bin', 'binDir must be first');
    assert.ok(entries.includes('/usr/bin'), 'original entries preserved');
    assert.equal(entries.length, 3);
  });

  test('is idempotent: binDir already present leaves PATH unchanged', () => {
    const key = platformPathKey();
    const original = ['/managed/bin', '/usr/bin'].join(delimiter);
    const env: NodeJS.ProcessEnv = { [key]: original };
    const out = prependManagedBinDir(env, '/managed/bin');
    assert.equal(out[key], original);
  });

  test('is idempotent when binDir appears mid-PATH (not just first)', () => {
    const key = platformPathKey();
    const original = ['/usr/bin', '/managed/bin', '/bin'].join(delimiter);
    const env: NodeJS.ProcessEnv = { [key]: original };
    const out = prependManagedBinDir(env, '/managed/bin');
    assert.equal(out[key], original, 'must not prepend a duplicate');
  });

  test('preserves unrelated env vars', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = { [key]: '/usr/bin', HOME: '/home/x', FOO: 'bar' };
    const out = prependManagedBinDir(env, '/managed/bin');
    assert.equal(out.HOME, '/home/x');
    assert.equal(out.FOO, 'bar');
    assert.ok((out[key] ?? '').startsWith('/managed/bin'));
  });

  test('does not mutate the input env', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = { [key]: '/usr/bin' };
    const before = env[key];
    prependManagedBinDir(env, '/managed/bin');
    assert.equal(env[key], before, 'input env must be untouched');
  });

  test('prepends to the Windows-style "Path" key when that is what the env carries', () => {
    // Simulate a Windows env where the key is "Path" (capital P, lowercase ath)
    // rather than "PATH". The prepend must target "Path" — NOT invent a "PATH"
    // — so the spawned shell sees one PATH with the managed dir first.
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows;C:\\System32' };
    const out = prependManagedBinDir(env, 'C:\\pi\\agent\\bin');
    assert.equal(out.Path, 'C:\\pi\\agent\\bin;C:\\Windows;C:\\System32');
    assert.equal(out.PATH, undefined, 'must not fabricate a separate PATH key');
  });

  test('defaults to the PATH key when the env has no path-like key', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/home/x' };
    const out = prependManagedBinDir(env, '/managed/bin');
    assert.equal(out.PATH, '/managed/bin');
    assert.equal(out.HOME, '/home/x');
  });

  test('handles an empty/missing PATH by setting it to just binDir', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = { [key]: '' };
    const out = prependManagedBinDir(env, '/managed/bin');
    assert.equal(out[key], '/managed/bin');
  });
});
