import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import { installDom } from './dom';

const nativeEqual = assert.equal;
const nativeNotEqual = assert.notEqual;
installDom();

import { h, render } from 'preact';

test('installDom leaves native assertions unchanged', () => {
  assert.equal(assert.equal, nativeEqual);
  assert.equal(assert.notEqual, nativeNotEqual);
});

test('DOM presence and identity assertion failures stay bounded without traversing component state', () => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const Save = () => h('button', { id: 'save' }, 'Save');
  render(h('section', null, h(Save, {})), root);
  const button = root.querySelector('button')!;
  const other = document.createElement('button');
  let reads = 0;
  Object.defineProperty(button, 'componentState', {
    enumerable: true,
    get() { reads++; return { root, button, document }; },
  });
  try {
    // Exercise the same boolean predicates used by the component tests. Exact
    // identity and null checks must fail normally, without passing DOM operands
    // into Node's depth-1000 assertion formatter or reporter error metadata.
    assert.ok(root.querySelector('missing') === null);
    assert.ok(root.querySelector('button') === button);
    assert.ok(other !== button);
    const failures = [
      () => assert.ok(root.querySelector('button') === null, 'button should be absent'),
      () => assert.ok(root.querySelector('button') === other, 'button identity should match'),
      () => assert.ok(root.querySelector('button') !== button, 'button should be replaced'),
    ];
    for (const run of failures) {
      assert.throws(run, (error: unknown) => {
        assert.ok(error instanceof assert.AssertionError);
        assert.equal(error.code, 'ERR_ASSERTION');
        assert.equal(error.actual, false);
        assert.equal(error.expected, true);
        assert.match(error.message, /button/);
        assert.ok(error.message.length < 2000);
        assert.ok(JSON.stringify(error).length < 4000);
        assert.ok(inspect(error).length < 4000);
        return true;
      });
    }
    assert.equal(reads, 0, 'failure reporting must not inspect component state');
  } finally { render(null, root); root.remove(); }
});
