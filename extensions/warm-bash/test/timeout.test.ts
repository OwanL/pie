import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const timeoutUrl = pathToFileURL(path.resolve(__dirname, '../src/timeout.ts')).href;

type TimeoutModule = {
  effectiveTimeout: (opts: { timeout: number | undefined; defaultTimeout: number; maxTimeout: number }) => number;
  parseDefaultTimeout: (raw: string | undefined, fallback: number, maxTimeout: number) => number;
};

async function load(): Promise<TimeoutModule> {
  const m = (await import(timeoutUrl)) as TimeoutModule;
  return m;
}

describe('effectiveTimeout', async () => {
  const { effectiveTimeout } = await load();

  test('uses default when timeout is undefined', () => {
    assert.equal(effectiveTimeout({ timeout: undefined, defaultTimeout: 60, maxTimeout: 600 }), 60);
  });

  test('uses default when timeout is 0 or negative', () => {
    assert.equal(effectiveTimeout({ timeout: 0, defaultTimeout: 60, maxTimeout: 600 }), 60);
    assert.equal(effectiveTimeout({ timeout: -5, defaultTimeout: 60, maxTimeout: 600 }), 60);
  });

  test('honours explicit caller timeout within range', () => {
    assert.equal(effectiveTimeout({ timeout: 5, defaultTimeout: 60, maxTimeout: 600 }), 5);
    assert.equal(effectiveTimeout({ timeout: 300, defaultTimeout: 60, maxTimeout: 600 }), 300);
  });

  test('caps explicit timeout at maxTimeout', () => {
    assert.equal(effectiveTimeout({ timeout: 900, defaultTimeout: 60, maxTimeout: 600 }), 600);
  });

  test('caps non-finite timeout at default', () => {
    assert.equal(effectiveTimeout({ timeout: NaN, defaultTimeout: 60, maxTimeout: 600 }), 60);
    assert.equal(effectiveTimeout({ timeout: Infinity, defaultTimeout: 60, maxTimeout: 600 }), 600);
  });
});

describe('parseDefaultTimeout', async () => {
  const { parseDefaultTimeout } = await load();

  test('returns parsed env value when valid', () => {
    assert.equal(parseDefaultTimeout('120', 60, 600), 120);
  });

  test('returns fallback when env is missing or invalid', () => {
    assert.equal(parseDefaultTimeout(undefined, 60, 600), 60);
    assert.equal(parseDefaultTimeout('', 60, 600), 60);
    assert.equal(parseDefaultTimeout('not-a-number', 60, 600), 60);
    assert.equal(parseDefaultTimeout('0', 60, 600), 60);
    assert.equal(parseDefaultTimeout('-10', 60, 600), 60);
  });

  test('returns fallback when env exceeds maxTimeout', () => {
    assert.equal(parseDefaultTimeout('900', 60, 600), 60);
  });
});
