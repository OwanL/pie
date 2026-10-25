import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { DEFAULT_CHAT_PREFS } from '../../../lib/protocol/index.js';
import { SubagentBucketMenu } from '../../composer/subagent-bucket-menu';
import { SubagentProviderMenu } from '../../composer/subagent-provider-menu';

const sessionPath = '/session/focus.jsonl';
const disclosures = {
  buckets: () => h(SubagentBucketMenu, { sessionPath, prefs: DEFAULT_CHAT_PREFS, onSetPrefs: () => {} }),
  providers: () => h(SubagentProviderMenu, { sessionPath,
    prefs: { ...DEFAULT_CHAT_PREFS, subagentProviderDefaults: { anthropic: true, openai: true } },
    availableModels: [], onSetPrefs: () => {} }),
};

for (const [name, disclosure] of Object.entries(disclosures)) {
  test(`${name}: concrete outside focus dismisses without stealing focus; rows and trigger retain disclosure`, () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      act(() => render(h('div', null, h('button', { id: 'before' }, 'Before'), disclosure(),
        h('button', { id: 'after' }, 'After')), container));
      const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
      const popup = () => container.querySelector('[role="dialog"]');
      const focus = (element: HTMLElement) => {
        act(() => element.focus());
        assert.ok(document.activeElement === element);
      };
      const open = () => {
        focus(trigger);
        act(() => trigger.click());
        assert.ok(popup());
      };
      open();
      const rows = [...popup()!.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
      assert.ok(rows.length >= 2);
      focus(rows[0]);
      focus(rows[1]);
      assert.ok(popup(), 'forward row focus retains popup');
      focus(rows[0]);
      focus(trigger);
      assert.ok(popup(), 'backward focus to own trigger retains popup');
      act(() => trigger.blur());
      act(() => { void window.dispatchEvent(new Event('blur')); });
      assert.ok(popup(), 'null focus and window blur are not concrete destinations');
      focus(container.querySelector<HTMLButtonElement>('#before')!);
      assert.ok(popup() === null);
      open();
      focus(popup()!.querySelector<HTMLButtonElement>('[role="checkbox"]')!);
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      act(() => { void document.activeElement!.dispatchEvent(tab); });
      assert.equal(tab.defaultPrevented, false);
      focus(container.querySelector<HTMLButtonElement>('#after')!);
      assert.ok(popup() === null);
      open();
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      assert.ok(popup() === null);
      assert.ok(document.activeElement === trigger, 'existing Escape focus ownership is preserved');
    } finally {
      act(() => render(null, container));
      container.remove();
    }
  });
}
