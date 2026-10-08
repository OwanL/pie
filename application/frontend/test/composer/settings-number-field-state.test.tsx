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
