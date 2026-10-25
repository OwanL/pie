import assert from 'node:assert/strict';
import test from 'node:test';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { installDom } from './dom';
import { focusSettingsHelp } from './settings-help';
import { SettingsHelp } from '../../settings/settings-help';

installDom();

for (const hasTooltip of [true, false]) {
  test(`controlled help focus restores window timers after ${hasTooltip ? 'success' : 'failure'}`, () => {
    const descriptors = {
      setTimeout: Object.getOwnPropertyDescriptor(window, 'setTimeout'),
      clearTimeout: Object.getOwnPropertyDescriptor(window, 'clearTimeout'),
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      act(() => render(hasTooltip
        ? h(SettingsHelp, { label: 'Timing', children: 'Real help content' })
        : h('button', { type: 'button' }, 'No tooltip'), container));
      const button = container.querySelector('button');
      assert.ok(button);
      if (hasTooltip) {
        focusSettingsHelp(button);
        const id = button.getAttribute('aria-describedby');
        assert.ok(id);
        assert.equal(document.getElementById(id)?.textContent, 'Real help content');
      } else {
        assert.throws(() => focusSettingsHelp(button), /focus schedules the SettingsHelp show delay/);
      }
      for (const key of ['setTimeout', 'clearTimeout'] as const) {
        assert.deepEqual(Object.getOwnPropertyDescriptor(window, key), descriptors[key]);
      }
    } finally {
      act(() => render(null, container));
      container.remove();
    }
  });
}
