import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { CompactionButton } from '../../../src/webview/panel/composer/compaction-button';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

test('compaction button invokes its action when enabled', () => {
  let calls = 0;
  act(() => render(h(CompactionButton, { disabled: false, onCompact: () => { calls += 1; } }), container));
  const button = container.querySelector('button') as HTMLButtonElement;
  assert.equal(button.getAttribute('aria-label'), 'Compact conversation context');
  act(() => button.click());
  assert.equal(calls, 1);
});

test('compaction button cannot be invoked while disabled', () => {
  let calls = 0;
  act(() => render(h(CompactionButton, { disabled: true, onCompact: () => { calls += 1; } }), container));
  const button = container.querySelector('button') as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-label'), 'Compaction is unavailable while the session is running');
  act(() => button.click());
  assert.equal(calls, 0);
});
