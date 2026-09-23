import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resolveUrl = pathToFileURL(path.resolve(__dirname, '../src/resolve.ts')).href;

type ResolveModule = {
  resolveBinary: (program: string, env?: NodeJS.ProcessEnv) => string | null;
  clearResolveCache: () => void;
  pathKey: (env?: NodeJS.ProcessEnv) => string;
};

async function load(): Promise<ResolveModule> {
  return (await import(resolveUrl)) as unknown as ResolveModule;
}

describe('resolveBinary', () => {
  let resolveBinary: (program: string, env?: NodeJS.ProcessEnv) => string | null;

  test.before(async () => {
    const m = await load();
    resolveBinary = m.resolveBinary;
  });

  test('returns null for a clearly-missing program', () => {
    const result = resolveBinary('this-program-definitely-does-not-exist-12345');
    assert.equal(result, null);
  });

  test('returns a non-empty absolute path for a known binary when available', () => {
    const result = resolveBinary('node');
    if (result === null) {
      // node is not guaranteed on PATH in every test environment; skip the
      // absolute-path assertion rather than fail spuriously.
      return;
    }
    assert.ok(path.isAbsolute(result), `expected absolute path, got ${result}`);
    assert.ok(result.length > 0, 'resolved path must be non-empty');
    assert.ok(
      result.toLowerCase().includes('node'),
      `resolved path should contain the program name: ${result}`,
    );
  });

  test('returns null for an empty program name', () => {
    // An empty string is neither absolute/relative nor found on PATH.
    assert.equal(resolveBinary(''), null);
  });

  test('returns null for whitespace-only program names', () => {
    assert.equal(resolveBinary('   '), null);
    assert.equal(resolveBinary('\t\n'), null);
  });
});

describe('resolveBinary with a custom execution env PATH', () => {
  let resolveBinary: ResolveModule['resolveBinary'];
  let clearResolveCache: ResolveModule['clearResolveCache'];

  // A temp dir tree dedicated to these cases so the fake binary is NOT on
  // process.env.PATH — proving resolution honours the env's PATH, not the
  // process's.
  let root: string;
  let dirWithBin: string;
  let dirWithoutBin: string;
  const PROGRAM = 'pifakebin-test-7f3a';

  test.before(async () => {
    const m = await load();
    resolveBinary = m.resolveBinary;
    clearResolveCache = m.clearResolveCache;
    root = mkdtempSync(path.join(tmpdir(), 'warm-bash-resolve-'));
    dirWithBin = path.join(root, 'has-bin');
    dirWithoutBin = path.join(root, 'no-bin');
    mkdirSync(dirWithBin, { recursive: true });
    mkdirSync(dirWithoutBin, { recursive: true });
    // An empty file named exactly `PROGRAM`; the "" extension entry means
    // resolveBinary matches it on both POSIX and Windows (no exec needed — we
    // only assert resolution, not execution).
    writeFileSync(path.join(dirWithBin, PROGRAM), '');
  });
  test.after(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  /** Build a minimal env carrying only the given PATH under the platform key. */
  function envWithPath(dir: string): NodeJS.ProcessEnv {
    return { [platformPathKey()]: dir };
  }

  test('resolves a program found only on the env PATH (not process.env.PATH)', () => {
    clearResolveCache();
    const result = resolveBinary(PROGRAM, envWithPath(dirWithBin));
    assert.equal(result, path.join(dirWithBin, PROGRAM));
    // Sanity: it is genuinely absent from process.env.PATH, so the only way we
    // could resolve it is by honouring the passed env.
    assert.ok(
      !(process.env.PATH ?? '').split(delimiter).includes(dirWithBin),
      'precondition: dirWithBin must not already be on process.env.PATH',
    );
  });

  test('returns null when the program is absent from the env PATH', () => {
    clearResolveCache();
    const result = resolveBinary(PROGRAM, envWithPath(dirWithoutBin));
    assert.equal(result, null);
  });

  test('is PATH-sensitive: same program resolves differently under different PATHs', () => {
    clearResolveCache();
    const found = resolveBinary(PROGRAM, envWithPath(dirWithBin));
    const missing = resolveBinary(PROGRAM, envWithPath(dirWithoutBin));
    assert.equal(found, path.join(dirWithBin, PROGRAM));
    assert.equal(missing, null);
  });

  test('caches per (program, PATH): a stale hit survives file deletion until cleared', () => {
    clearResolveCache();
    const isolated = mkdtempSync(path.join(root, 'cache-'));
    const binPath = path.join(isolated, PROGRAM);
    writeFileSync(binPath, '');
    const env = envWithPath(isolated);

    // First resolution stat-checks the file and caches the hit.
    assert.equal(resolveBinary(PROGRAM, env), binPath);
    rmSync(binPath, { force: true });
    assert.ok(!existsSync(binPath), 'precondition: file removed');

    // Same (program, PATH) → cache hit; no re-stat, so the stale path returns.
    assert.equal(resolveBinary(PROGRAM, env), binPath);

    // Clearing forces a re-stat → now null (file is gone).
    clearResolveCache();
    assert.equal(resolveBinary(PROGRAM, env), null);

    rmSync(isolated, { recursive: true, force: true });
  });

  test('falls back to process.env when no env is passed', () => {
    clearResolveCache();
    // No env → scans process.env.PATH. `node` is on the test runner's PATH.
    const result = resolveBinary('node');
    if (result === null) return; // not guaranteed in every environment
    assert.ok(path.isAbsolute(result));
  });
});

describe('pathKey', () => {
  let pathKey: ResolveModule['pathKey'];

  test.before(async () => {
    pathKey = (await load()).pathKey;
  });

  test('matches "PATH" case-insensitively', () => {
    assert.equal(pathKey({ PATH: 'x' }), 'PATH');
    assert.equal(pathKey({ Path: 'x' }), 'Path');
    assert.equal(pathKey({ path: 'x' }), 'path');
  });

  test('defaults to "PATH" when no path-like key is present', () => {
    assert.equal(pathKey({ HOME: '/x', USER: 'me' }), 'PATH');
    assert.equal(pathKey({}), 'PATH');
  });

  test('returns the first path-like key found (insertion order)', () => {
    // A real env never carries both, but the behaviour is deterministic: the
    // first key (by Object.keys order) wins, matching pi's getShellEnv.
    assert.equal(pathKey({ Path: 'a', PATH: 'b' }), 'Path');
    assert.equal(pathKey({ PATH: 'b', Path: 'a' }), 'PATH');
  });
});

/** The PATH key pi/this resolver use on the current platform. */
function platformPathKey(): string {
  return Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
}
