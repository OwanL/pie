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

test('compaction button explains and invokes its action when available', () => {
  let calls = 0;
  act(() => render(h(CompactionButton, { availability: 'available', onCompact: () => { calls += 1; } }), container));
  const button = container.querySelector('button') as HTMLButtonElement;
  assert.equal(button.getAttribute('aria-label'), 'Compact context — summarize older messages and keep recent work');
  act(() => button.click());
  assert.equal(calls, 1);
});

test('compaction button distinguishes no-session and busy disabled reasons', () => {
  let calls = 0;
  act(() => render(h(CompactionButton, { availability: 'no-session', onCompact: () => { calls += 1; } }), container));
  let button = container.querySelector('button') as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-label'), 'Open a conversation to compact its context');
  act(() => button.click());

  act(() => render(h(CompactionButton, { availability: 'busy', onCompact: () => { calls += 1; } }), container));
  button = container.querySelector('button') as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-label'), 'Wait for the current run or compaction to finish');
  act(() => button.click());
  assert.equal(calls, 0);
});

test('compaction button shows a live compacting state with a spinner', () => {
  let calls = 0;
  act(() => render(h(CompactionButton, { availability: 'compacting', onCompact: () => { calls += 1; } }), container));
  const button = container.querySelector('button') as HTMLButtonElement;
  assert.equal(button.disabled, true, 'compacting button is disabled');
  assert.equal(button.getAttribute('aria-label'), 'Compacting conversation history…');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.ok(button.classList.contains('compacting'), 'compacting class drives the accent styling');
  assert.ok(container.querySelector('.compaction-trigger-spinner'), 'spinner replaces the icon while compacting');
  assert.equal(container.querySelector('svg'), null, 'icon is hidden while compacting');
  act(() => button.click());
  assert.equal(calls, 0);
});
