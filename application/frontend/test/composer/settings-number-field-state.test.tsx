/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();

import { render } from 'preact';
import { act } from 'preact/test-utils';
import { NumberField, Stepper } from '../../settings/number-field';

let target: HTMLDivElement;
let value = 30;
let patches: number[];
let disabled = false;
// Swappable consumer seam so tests can echo changes back either
// synchronously (an optimistic local settings update) or after a real
// delayed host round trip, like prefs applied by the host.
let onCommit: (next: number) => void = (next) => { patches.push(next); };
let echoTimers: ReturnType<typeof setTimeout>[] = [];

function renderField(): void {
  act(() => render(
    <NumberField
      label="Session timeout"
      value={value}
      min={1}
      max={60}
      disabled={disabled}
      onChange={(next) => onCommit(next)}
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

function stepByUserAgent(nextRaw: string): void {
  // The native stepping seam: arrow keys and spinners fire an input+change
  // pair per step with no blur, and the native value is already stepped.
  act(() => {
    field().value = nextRaw;
    field().dispatchEvent(new Event('input', { bubbles: true }));
    field().dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Echoes each accepted commit back through the prop after `delayMs`, the
 *  way a host that applies delayed prefs re-syncs the webview. */
function useDelayedEchoConsumer(delayMs = 30): void {
  onCommit = (next) => {
    patches.push(next);
    echoTimers.push(setTimeout(() => {
      value = next;
      renderField();
    }, delayMs));
  };
}
const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
  value = 30;
  patches = [];
  disabled = false;
  echoTimers = [];
  onCommit = (next) => { patches.push(next); };
  renderField();
});

afterEach(() => {
  for (const timer of echoTimers) clearTimeout(timer);
  echoTimers = [];
  act(() => render(null, target));
  target.remove();
});

test('coalesced middle echoes preserve the latest numeric commit and active draft', () => {
  changeTo('11');
  changeTo('12');
  changeTo('13');
  value = 12;
  renderField();
  assert.equal(field().value, '13');
  type('14');
  value = 13;
  renderField();
  assert.equal(field().value, '14');
  pressEnter();
  act(() => { field().dispatchEvent(new Event('blur')); });
  assert.deepEqual(patches, [11, 12, 13, 14]);
});

for (const echoes of [[11, 12, 11, 13], [11, 13], [12, 11, 13]]) {
  test(`duplicate numeric intents retain newest display through echoes ${echoes}`, () => {
    for (const next of ['11', '12', '11', '13']) changeTo(next);
    for (const echo of echoes) {
      value = echo;
      renderField();
      assert.equal(field().value, '13');
    }
    value = 25;
    renderField();
    assert.equal(field().value, '25', 'unrelated external truth resolves intent');
  });

  test(`duplicate numeric echoes preserve active editing ${echoes}`, () => {
    for (const next of ['11', '12', '11', '13']) changeTo(next);
    type('24');
    for (const echo of echoes) {
      value = echo;
      renderField();
      assert.equal(field().value, '24');
    }
    pressEnter();
    assert.deepEqual(patches, [11, 12, 11, 13, 24]);
  });

  test(`stepper duplicate intents retain newest display through echoes ${echoes}`, () => {
    value = 10;
    let step = 1;
    const paint = () => act(() => render(<Stepper label="Count" value={value} step={step}
      onChange={(next) => patches.push(next)} />, target));
    paint();
    for (const direction of [1, 1, 0, 1]) {
      if (patches.length === 3) { step = 2; paint(); }
      act(() => { (target.querySelectorAll('button')[direction] as HTMLButtonElement).click(); });
    }
    assert.deepEqual(patches, [11, 12, 11, 13]);
    for (const echo of echoes) {
      value = echo;
      paint();
      assert.equal(target.querySelector('.toolbar-settings-stepper-value')?.textContent, '13');
    }
    value = 25;
    paint();
    assert.equal(target.querySelector('.toolbar-settings-stepper-value')?.textContent, '25');
  });
}

test('duplicate pending numeric values acknowledge a coalesced prefix', () => {
  for (const next of ['11', '12', '11', '13']) changeTo(next);
  value = 11;
  renderField();
  assert.equal(field().value, '13');
  value = 13;
  renderField();
  assert.equal(field().value, '13');
  type('100');
  pressEnter();
  act(() => { field().dispatchEvent(new Event('blur')); });
  assert.deepEqual(patches, [11, 12, 11, 13, 60]);
});

for (const direction of [1, -1]) {
  test(`stepper rapid ${direction > 0 ? 'increments' : 'decrements'} build on pending intent`, () => {
    value = 10;
    const paint = () => act(() => render(<Stepper label="Count" value={value} min={7} max={13}
      disabled={disabled} onChange={(next) => patches.push(next)} />, target));
    const button = () => target.querySelectorAll('button')[direction > 0 ? 1 : 0] as HTMLButtonElement;
    paint();
    // Both clicks occur before a render, as well as before any host echo.
    act(() => { button().click(); button().click(); });
    assert.deepEqual(patches, [10 + direction, 10 + 2 * direction]);
    act(() => { button().click(); });
    assert.equal(button().disabled, true);
    act(() => { button().click(); });
    assert.equal(patches.length, 3, 'bound emits no redundant intent');
    value = 10 + 2 * direction;
    paint();
    assert.equal(target.querySelector('.toolbar-settings-stepper-value')?.textContent, String(10 + 3 * direction));
    value = 9;
    paint();
    assert.equal(target.querySelector('.toolbar-settings-stepper-value')?.textContent, '9', 'external override wins');
    disabled = true;
    paint();
    act(() => { button().click(); });
    assert.equal(patches.length, 3);
  });
}

test('blur restores a cleared input to the latest projected value without a patch', () => {
  changeTo('');
  act(() => { void field().dispatchEvent(new Event('blur')); });

  assert.equal(field().value, '30');
  assert.deepEqual(patches, []);
});

test('blur restores a rejected fractional timeout to the latest projected value', () => {
  changeTo('30.5');
  assert.deepEqual(patches, [], 'the timeout consumer rejects fractional values');
  assert.equal(field().value, '30', 'integer-step fields refuse fractional input locally, no re-render needed');
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

test('integer-step fields refuse fractional typed input locally, without an echo', () => {
  act(() => render(
    <NumberField label="Seconds" value={30} min={1} max={60} step={1} onChange={(next) => patches.push(next)} />,
    target,
  ));
  changeTo('30.5');
  assert.deepEqual(patches, [], 'no patch waits on a delayed host rejection');
  assert.equal(field().value, '30', 'the applied value is restored immediately');
});

test('fractional-step fields keep accepting fractional commits', () => {
  act(() => render(
    <NumberField label="Fraction" value={1.25} step={0.5} onChange={(next) => patches.push(next)} />,
    target,
  ));
  changeTo('1.75');
  assert.deepEqual(patches, [1.75]);
  assert.equal(field().value, '1.75');
});

test('bare typing emits nothing until blur or Enter commits it', () => {
  type('100');
  assert.deepEqual(patches, [], 'the typed draft stays raw while the user is editing');

  act(() => { void field().dispatchEvent(new Event('blur')); });
  assert.deepEqual(patches, [60], 'blur commits the typed draft with normalized clamp');
  assert.equal(field().value, '60', 'the normalized commit stays on display optimistically');

  value = 60;
  renderField();
  assert.equal(field().value, '60', 'the accepted echo converges the display');
});

test('Enter then blur deduplicates the normalized display while a delayed echo is pending', async () => {
  useDelayedEchoConsumer(30);
  type('100');
  pressEnter();
  assert.deepEqual(patches, [60], 'Enter commits the clamped value once');
  assert.equal(field().value, '60', 'the normalized value becomes the optimistic display');

  act(() => { void field().dispatchEvent(new Event('blur')); });
  assert.deepEqual(patches, [60], 'blur of the normalized display must not emit a duplicate');

  await wait(40);
  assert.deepEqual(patches, [60]);
  assert.equal(field().value, '60', 'the delayed echo converges without another commit');
});

test('Enter commits the typed draft once with normalized clamp', () => {
  type('40');
  assert.deepEqual(patches, [], 'typing alone never emits');
  pressEnter();
  assert.deepEqual(patches, [40]);
  assert.equal(field().value, '40', 'display keeps the normalized commit while the echo is pending');

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
  assert.equal(field().value, '45', 'the accepted commit stays on display');
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
  stepByUserAgent('31');
  assert.deepEqual(patches, [31], 'stepping emits immediately');
  assert.equal(field().value, '31', 'the stepped value is not reverted before the echo');

  value = 31;
  renderField();
  assert.equal(field().value, '31', 'echo converges without a visible snap');
});

test('accepted blur keeps its display through a delayed host echo', async () => {
  useDelayedEchoConsumer(30);
  changeTo('40');
  assert.deepEqual(patches, [40]);
  assert.equal(field().value, '40', 'no immediate snap back to the stale applied value');

  await wait(15);
  assert.equal(field().value, '40', 'the optimistic display outlasts a pending echo');

  await wait(25);
  assert.equal(field().value, '40', 'the delayed echo converges without a visible snap');
  assert.equal(field().value, '40', 'final display is the applied value');
});

test('pending Enter then ArrowUp: arrows step from the optimistic commit, not the stale value', async () => {
  useDelayedEchoConsumer(30);
  type('40');
  pressEnter();
  assert.deepEqual(patches, [40]);
  assert.equal(field().value, '40');

  // The user adjusts again before any echo arrives: the native ArrowUp seam
  // steps from the optimistic display 40 → 41 and commits immediately.
  stepByUserAgent('41');
  assert.deepEqual(patches, [40, 41], 'the stepped value builds on the optimistic commit');
  assert.equal(field().value, '41');

  await wait(20);
  assert.equal(field().value, '41', 'the older echoed 40 must not overwrite the newer 41');

  await wait(30);
  assert.equal(field().value, '41', 'the newer echo converges to 41 with no snap back');
});

test('a stale echo never overwrites a newer local commit', async () => {
  useDelayedEchoConsumer(30);
  changeTo('40');
  assert.deepEqual(patches, [40]);
  type('50');
  pressEnter();
  assert.deepEqual(patches, [40, 50]);
  assert.equal(field().value, '50', 'the newest local commit owns the display');

  await wait(20);
  assert.equal(field().value, '50', 'the echoed 40 is consumed without overwriting');

  await wait(30);
  assert.equal(field().value, '50', 'the echo of the newer commit converges the display');
});

test('a typed draft survives an echo that arrives mid-edit', async () => {
  useDelayedEchoConsumer(10);
  changeTo('40');
  assert.deepEqual(patches, [40]);
  type('4');
  assert.equal(field().value, '4', 'the keystroke is tracked in draft state');

  await wait(15);
  assert.equal(field().value, '4', 'the in-flight echo must not restore over the typed draft');

  type('46');
  assert.equal(field().value, '46');
  act(() => { void field().dispatchEvent(new Event('blur')); });
  assert.deepEqual(patches, [40, 46], 'the finished draft commits against the newest applied value');
  value = 46;
  renderField();
  assert.equal(field().value, '46');
});

test('retyping the stale applied value while an echo is pending emits an explicit revert', async () => {
  useDelayedEchoConsumer(30);
  changeTo('40');
  assert.deepEqual(patches, [40]);
  // The display shows the optimistic 40; the user types back the old 30.
  type('30');
  act(() => { void field().dispatchEvent(new Event('blur')); });
  assert.deepEqual(patches, [40, 30], 'the revert reaches the consumer instead of being swallowed');
  assert.equal(field().value, '30');

  await wait(20);
  assert.equal(field().value, '30', 'the stale echoed 40 is consumed without overwriting the revert');

  await wait(30);
  assert.equal(field().value, '30', 'the echoed revert converges the display');
});