/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../helpers/dom';
installDom();
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { NumberField } from '../../settings/number-field';

test('number units describe the control without changing its name or numeric value', () => {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const updates: number[] = [];
  const paint = (unit?: string) => render(<NumberField label="Limit" ariaLabel="Configured limit"
    value={40} min={1} max={60} unit={unit} onChange={(value) => updates.push(value)} />, target);
  try {
    act(() => paint('%'));
    const input = target.querySelector<HTMLInputElement>('input')!;
    const id = input.getAttribute('aria-describedby')!;
    assert.equal(input.getAttribute('aria-label'), 'Configured limit');
    assert.equal(input.value, '40');
    assert.equal(document.getElementById(id)?.textContent, '%');
    act(() => paint('tokens'));
    assert.equal(input.getAttribute('aria-describedby'), id, 'description remains stable during unit changes');
    assert.equal(document.getElementById(id)?.textContent, 'tokens');
    assert.equal(input.value, '40');
    assert.deepEqual(updates, [], 'changing a display unit sends no numeric update');
    act(() => {
      input.value = '90';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.deepEqual(updates, [60], 'existing numeric clamping is unchanged');
    act(() => { input.focus(); input.blur(); });
    assert.equal(input.value, '40', 'blur still restores the authoritative projected value');
    act(() => paint());
    assert.equal(input.getAttribute('aria-describedby'), null);
    assert.equal(target.querySelector('.toolbar-settings-number-unit'), null);
  } finally {
    act(() => render(null, target));
    target.remove();
  }
});

test('each numeric unit describes its own input', () => {
  const target = document.createElement('div');
  document.body.appendChild(target);
  try {
    act(() => render(<><NumberField label="Timeout" value={30} unit="seconds" onChange={() => undefined} />
      <NumberField label="Retention" value={30000} unit="tokens" onChange={() => undefined} /></>, target));
    const inputs = [...target.querySelectorAll('input')];
    const ids = inputs.map((input) => input.getAttribute('aria-describedby'));
    assert.equal(new Set(ids).size, 2);
    assert.deepEqual(ids.map((id) => document.getElementById(id!)?.textContent), ['seconds', 'tokens']);
  } finally {
    act(() => render(null, target));
    target.remove();
  }
});
