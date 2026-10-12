import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { DEFAULT_CHAT_PREFS, type ChatPrefs } from '../../../lib/protocol/index.js';
import { SoundSection } from '../../settings/settings-menu-sound';

for (const [volume, label] of [[0, 'Off'], [35, '35%']] as const) {
  test(`sound volume exposes ${label} and keeps its value beside the range`, () => {
    const container = document.createElement('div');
    const patches: Partial<ChatPrefs>[] = [];
    const paint = (completionSoundVolume: number) => render(h(SoundSection, {
      prefs: { ...DEFAULT_CHAT_PREFS, completionSoundVolume },
      onSetPrefs: (patch) => { patches.push(patch); },
    }), container);
    try {
      act(() => paint(volume));
      const controls = container.querySelector('.toolbar-settings-sound-controls')!;
      const range = controls.querySelector<HTMLInputElement>('input[type="range"]')!;
      const value = controls.querySelector('.toolbar-settings-control-value')!;
      const preview = controls.querySelector<HTMLButtonElement>('button')!;
      assert.equal(range.nextElementSibling, value);
      assert.equal(value.textContent, label);
      assert.equal(range.getAttribute('aria-valuetext'), label);
      assert.equal(preview.disabled, volume === 0);
      assert.equal(controls.querySelector<HTMLButtonElement>('[aria-label="Test question sound"]')!.disabled, volume === 0);
      assert.equal(range.getAttribute('aria-label'), 'Notification sound volume');
      assert.deepEqual(patches, []);
      act(() => {
        range.value = '60';
        range.dispatchEvent(new Event('input', { bubbles: true }));
      });
      assert.deepEqual(patches, [{ completionSoundVolume: 60 }]);
      assert.equal(value.textContent, label, 'displayed value waits for host-projected preferences');
      act(() => paint(60));
      assert.equal(range.getAttribute('aria-valuetext'), '60%');
      assert.equal(value.textContent, '60%');
      assert.equal(preview.disabled, false);
      // Do not activate preview audio in this DOM-only test.
    } finally {
      act(() => render(null, container));
    }
  });
}
