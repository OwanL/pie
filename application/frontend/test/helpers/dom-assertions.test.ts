import assert from 'node:assert/strict';
import legacyAssert from 'node:assert';
import { strictEqual as namedStrictEqual } from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import { installDom } from './dom';

installDom();

import { h, render } from 'preact';

function failure(run: () => void): InstanceType<typeof assert.AssertionError> {
  try { run(); } catch (error) {
    assert.ok(error instanceof assert.AssertionError);
    return error;
  }
  throw new Error('Expected assertion to fail');
}

test('DOM identity failures report bounded diagnostics without traversing the live graph', () => {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const Save = () => h('button', { id: 'save' }, 'Save');
  render(h('section', null, h(Save, {})), parent);
  const button = parent.querySelector('button')!;
  // Realistic bidirectional component/DOM references, plus a probe proving the
  // diagnostic never explores component state (not merely truncated output).
  let reads = 0;
  Object.defineProperty(button, 'componentState', {
    enumerable: true,
    get() { reads++; return { parent, button, document }; },
  });
  try {
    for (const equal of [assert.equal, assert.strictEqual, legacyAssert.strictEqual, namedStrictEqual]) {
      const error = failure(() => equal(button, null, 'save should be absent'));
      assert.equal(error.code, 'ERR_ASSERTION');
      assert.equal(error.operator, 'strictEqual');
      assert.match(error.message, /save should be absent/);
      assert.match(error.message, /BUTTON.*save/);
      assert.ok(error.message.length < 2000);
      assert.ok(JSON.stringify(error).length < 4000);
      assert.ok(inspect(error).length < 4000);
      assert.equal(reads, 0, 'assertion formatting must not visit component state');
      assert.ok(error.stack?.includes('dom-assertions.test.ts'));
    }
  } finally { render(null, parent); parent.remove(); }
});

test('DOM assertions preserve reference identity and distinguish identical-looking nodes', () => {
  const a = document.createElement('div');
  const b = document.createElement('div');
  assert.equal(a, a);
  assert.notEqual(a, b);
  const mismatch = failure(() => assert.equal(a, b));
  assert.notEqual(mismatch.actual, mismatch.expected, 'summaries identify different nodes');
  for (const notEqual of [assert.notEqual, assert.notStrictEqual, legacyAssert.notStrictEqual]) {
    const error = failure(() => notEqual(a, a));
    assert.equal(error.operator, 'notStrictEqual');
    assert.equal(error.actual, error.expected);
  }
  const reversed = failure(() => assert.equal(null, a));
  assert.equal(reversed.actual, null);
  assert.equal(typeof reversed.expected, 'string');
});

test('DOM diagnostics keep native validation, custom errors, and non-DOM assertions', () => {
  const node = document.createElement('div');
  const sentinel = new Error('caller error');
  assert.throws(() => assert.equal(node, null, sentinel), (error) => error === sentinel);
  assert.throws(() => (assert.equal as (...args: unknown[]) => void)(node), { code: 'ERR_MISSING_ARGS' });
  assert.equal(NaN, NaN);
  assert.notEqual(-0, 0);
  const actual = { value: 1 };
  const expected = { value: 2 };
  const error = failure(() => assert.equal(actual, expected));
  assert.equal(error.actual, actual);
  assert.equal(error.expected, expected);
  assert.deepEqual({ value: 1 }, { value: 1 });
  legacyAssert.equal(1, '1'); // Loose assertions are not replaced.
  const equal = assert.equal;
  installDom();
  assert.equal(assert.equal, equal, 'installation is idempotent');
});
