/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();

import { render } from 'preact';
import { act } from 'preact/test-utils';
import { NumberField } from '../../settings/number-field';

let target: HTMLDivElement;
let value = 30;
let patches: number[];
let disabled = false;

function renderField(): void {
  act(() => render(
    <NumberField
      label="Session timeout"
      value={value}
      min={1}
      max={60}
      disabled={disabled}
      onChange={(next) => {
        if (Number.isInteger(next)) patches.push(next);
      }}
    />,
    target,
  ));
}

function field(): HTMLInputElement {
  const input = target.querySelector('input');
  assert.ok(input);
  return input;
}

function changeTo(raw: string): void {
  act(() => {
    field().value = raw;
    field().dispatchEvent(new Event('input', { bubbles: true }));
    field().dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function type(raw: string): void {
  // Bare typing: only the input event Preact binds onInput to, matching
  // production where a native change event only fires on commit.
  act(() => {
    field().value = raw;
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pressEnter(): void {
  act(() => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
  value = 30;
  patches = [];
  disabled = false;
  renderField();
});

afterEach(() => {
  act(() => render(null, target));
  target.remove();
});

test('blur restores a cleared input to the latest projected value without a patch', () => {
  changeTo('');
  act(() => { void field().dispatchEvent(new Event('blur')); });

  assert.equal(field().value, '30');
  assert.deepEqual(patches, []);
});

test('blur restores a rejected fractional timeout to the latest projected value', () => {
  changeTo('30.5');
  assert.deepEqual(patches, [], 'the timeout consumer rejects fractional values');
  renderField(); // Rejection projects the unchanged host value back into the component.
  act(() => { void field().dispatchEvent(new Event('blur')); });

  assert.equal(field().value, '30');
  assert.deepEqual(patches, []);
});

test('external projected changes replace a pending draft and valid changes keep clamping', () => {
  changeTo('40');
  assert.deepEqual(patches, [40]);

  value = 35;
  renderField();
  assert.equal(field().value, '35');

  changeTo('100');
  assert.deepEqual(patches, [40, 60]);
});

test('disabled fields discard drafts and do not emit changes', () => {
  changeTo('31.5');
  disabled = true;
  renderField();
  assert.equal(field().value, '30');
  assert.equal(field().disabled, true);
  changeTo('45');
  assert.deepEqual(patches, []);
});

test('step does not restrict fractional input accepted by a consumer', () => {
  act(() => render(
    <NumberField label="Fraction" value={1.25} step={1} onChange={(next) => patches.push(next)} />,
    target,
  ));
  changeTo('1.5');
  assert.deepEqual(patches, [1.5]);
});

test('bare typing emits nothing until blur or Enter commits it', () => {
  type('100');
  assert.deepEqual(patches, [], 'the typed draft stays raw while the user is editing');

  act(() => { void field().dispatchEvent(new Event('blur')); });
  assert.deepEqual(patches, [60], 'blur commits the typed draft with normalized clamp');
  assert.equal(field().value, '30', 'the rejected-over-max text reconciles to the applied value');

  value = 60;
  renderField();
  assert.equal(field().value, '60', 'the accepted echo converges the display');
});

test('Enter commits the typed draft once with normalized clamp', () => {
  type('40');
  assert.deepEqual(patches, [], 'typing alone never emits');
  pressEnter();
  assert.deepEqual(patches, [40]);
  assert.equal(field().value, '30', 'display keeps the applied value until the echo arrives');

  act(() => { void field().dispatchEvent(new Event('change', { bubbles: true })); });
  act(() => { void field().dispatchEvent(new Event('blur')); });
  assert.deepEqual(patches, [40], 'a committed burst emits exactly once');

  value = 40;
  renderField();
  assert.equal(field().value, '40');
});

test('blur and change commits do not double-emit while the echo is pending', () => {
  changeTo('45');
  assert.deepEqual(patches, [45]);
  act(() => { void field().dispatchEvent(new Event('blur')); });
  assert.deepEqual(patches, [45], 'the companion blur must not re-commit the same burst');
  value = 45;
  renderField();
  assert.equal(field().value, '45');
});

test('Enter reconciles a consumer-rejected fraction truthfully', () => {
  type('30.5');
  pressEnter();
  assert.deepEqual(patches, [], 'the timeout consumer rejects fractional values');
  assert.equal(field().value, '30', 'the applied value shows, not the rejected fraction');
});

test('Escape is deliberately inert: no commit, no reversion flow', () => {
  type('31.5');
  act(() => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.deepEqual(patches, []);
  assert.equal(field().value, '31.5', 'the typed draft stays as the user left it');
});

test('user-agent stepping commits immediately through its change event without blur', () => {
  // Mimic the real seam: arrow keys and spinners fire an input+change pair
  // per step with no blur, and the native value is already stepped.
  act(() => {
    field().value = '31';
    field().dispatchEvent(new Event('input', { bubbles: true }));
    field().dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.deepEqual(patches, [31], 'stepping emits immediately');
  assert.equal(field().value, '31', 'the stepped value is not reverted before the echo');

  value = 31;
  renderField();
  assert.equal(field().value, '31', 'echo converges without a visible snap');
});
