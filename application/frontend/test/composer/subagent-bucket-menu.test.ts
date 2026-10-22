import assert from 'node:assert/strict';
import test from 'node:test';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { installDom } from '../helpers/dom';
installDom();
import { SubagentBucketMenu } from '../../composer/subagent-bucket-menu';
import { DEFAULT_CHAT_PREFS, type ChatPrefs } from '../../../lib/protocol/index.js';
import { SUBAGENT_BUCKET_TIERS } from '../../../../lib/subagent-bucket-policy.js';

const a = '/sessions/a.jsonl';
const b = '/sessions/b.jsonl';
const click = (node: Element) => act(() => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

test('bucket menu renders all seven subsets and disables only the last checked tier', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    for (let mask = 1; mask < 8; mask++) {
      const choices = { small: !!(mask & 1), medium: !!(mask & 2), frontier: !!(mask & 4) };
      act(() => render(h(SubagentBucketMenu, { sessionPath: a,
        prefs: { ...DEFAULT_CHAT_PREFS, subagentBucketTogglesBySession: { [a]: choices } }, onSetPrefs: () => {} }), container));
      const trigger = container.querySelector('button')!;
      assert.match(trigger.getAttribute('aria-label') ?? '', /Subagent buckets/);
      assert.ok(trigger.querySelector('svg[aria-hidden="true"]'));
      assert.equal(trigger.textContent?.trim(), '', 'icon trigger leaves the visible label to the overflow row');
      if (trigger.getAttribute('aria-expanded') !== 'true') click(trigger);
      const rows = [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
      assert.deepEqual(rows.map(row => row.textContent?.trim()), ['Small', 'Medium', 'Frontier']);
      rows.forEach((row, index) => {
        const checked = choices[SUBAGENT_BUCKET_TIERS[index]];
        assert.equal(row.getAttribute('aria-checked'), String(checked));
        assert.equal(row.disabled, checked && Object.values(choices).filter(Boolean).length === 1);
      });
    }
  } finally { act(() => render(null, container)); container.remove(); }
});

test('rapid toggles preserve intent through delayed/coalesced echoes and session switches', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: Partial<ChatPrefs>[] = [];
  const draw = (sessionPath: string | null, prefs: ChatPrefs) => act(() => render(h(SubagentBucketMenu,
    { sessionPath, prefs, onSetPrefs: patch => calls.push(patch) }), container));
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
  try {
    draw(a, DEFAULT_CHAT_PREFS);
    const trigger = container.querySelector('button')!;
    act(() => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    act(() => { click(rows()[0]); click(rows()[1]); click(rows()[2]); });
    assert.equal(calls.length, 2, 'last enabled tier cannot be unchecked even within a burst');
    assert.deepEqual(calls[1].subagentBucketTogglesBySession, { [a]: { small: false, medium: false, frontier: true } });
    draw(a, { ...DEFAULT_CHAT_PREFS, ...calls[0] });
    assert.deepEqual(rows().map(row => row.getAttribute('aria-checked')), ['false', 'false', 'true']);
    draw(a, { ...DEFAULT_CHAT_PREFS, ...calls[1] });
    click(rows()[0]);
    click(rows()[1]);
    draw(a, { ...DEFAULT_CHAT_PREFS, ...calls.at(-1) });
    assert.deepEqual(rows().map(row => row.getAttribute('aria-checked')), ['true', 'true', 'true']);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(container.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
    draw(b, { ...DEFAULT_CHAT_PREFS, ...calls[1] });
    click(container.querySelector('button')!);
    assert.deepEqual(rows().map(row => row.getAttribute('aria-checked')), ['true', 'true', 'true']);
    draw(b, { ...DEFAULT_CHAT_PREFS, ...calls[0] });
    click(rows()[0]);
    assert.deepEqual(Object.keys(calls.at(-1)!.subagentBucketTogglesBySession!), [b]);
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    assert.equal(container.querySelector('[role="dialog"]'), null);
    draw(null, DEFAULT_CHAT_PREFS);
    assert.equal(container.querySelector('button'), null);
  } finally { act(() => render(null, container)); container.remove(); }
});
