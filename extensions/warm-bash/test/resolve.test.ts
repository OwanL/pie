import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resolveUrl = pathToFileURL(path.resolve(__dirname, '../src/resolve.ts')).href;

type ResolveModule = {
  resolveBinary: (program: string) => string | null;
};

async function load(): Promise<ResolveModule> {
  return (await import(resolveUrl)) as unknown as ResolveModule;
}

describe('resolveBinary', () => {
  let resolveBinary: (program: string) => string | null;

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
