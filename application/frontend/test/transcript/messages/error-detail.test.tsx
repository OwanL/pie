/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import type { ChatMessage } from '../../../../lib/protocol/index.js';
import { NoticeContext } from '../../../lib/hooks/notice-context';
import { ErrorDetail, ErrorDetailWithFallback } from '../../../transcript/message-item/error-detail';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

function dismissButton(): HTMLButtonElement {
  const buttons = container.querySelectorAll<HTMLButtonElement>('button');
  assert.ok(buttons.length > 0, 'expected action buttons');
  return buttons[buttons.length - 1];
}

test('dismiss hides the detail and a rerender with the same detail stays dismissed', () => {
  act(() => render(h(ErrorDetail, { detail: 'first error' }), container));
  assert.match(container.textContent ?? '', /first error/);

  act(() => dismissButton().click());
  assert.equal(container.querySelector('.message-error-detail'), null);

  act(() => render(h(ErrorDetail, { detail: 'first error' }), container));
  assert.equal(container.querySelector('.message-error-detail'), null);
});

test('a newly evolved detail surfaces again while the dismissed error stays scoped to its text', () => {
  act(() => render(h(ErrorDetail, { detail: 'first error' }), container));
  act(() => dismissButton().click());
  assert.equal(container.querySelector('.message-error-detail'), null);

  act(() => render(h(ErrorDetail, { detail: 'second error' }), container));
  assert.match(container.textContent ?? '', /second error/);

  act(() => render(h(ErrorDetail, { detail: 'first error' }), container));
  assert.equal(container.querySelector('.message-error-detail'), null);
});

test('per-message errorDetail dismisses locally without a host dismiss callback', () => {
  let hostDismisses = 0;
  act(() => render(
    h(NoticeContext.Provider, {
      value: { notice: null, sessionPath: null, dismiss: () => { hostDismisses += 1; } },
    }, h(ErrorDetailWithFallback, { message: { errorDetail: 'per-message error' } as ChatMessage })),
    container,
  ));
  assert.match(container.textContent ?? '', /per-message error/);

  act(() => dismissButton().click());
  assert.equal(container.querySelector('.message-error-detail'), null);
  assert.equal(hostDismisses, 0);
});

test('notice fallback dismissal dispatches the host dismiss instead of hiding locally', () => {
  let hostDismisses = 0;
  act(() => render(
    h(NoticeContext.Provider, {
      value: { notice: 'notice error', sessionPath: null, dismiss: () => { hostDismisses += 1; } },
    }, h(ErrorDetailWithFallback, { message: {} as ChatMessage })),
    container,
  ));

  act(() => dismissButton().click());
  assert.equal(hostDismisses, 1);
  assert.match(container.textContent ?? '', /notice error/);

  act(() => render(
    h(NoticeContext.Provider, {
      value: { notice: null, sessionPath: null, dismiss: null },
    }, h(ErrorDetailWithFallback, { message: {} as ChatMessage })),
    container,
  ));
  assert.equal(container.querySelector('.message-error-detail'), null);
});

test('a fallback switch after local dismissal surfaces the new error', () => {
  act(() => render(h(ErrorDetailWithFallback, { message: { errorDetail: 'first error' } as ChatMessage }), container));
  act(() => dismissButton().click());
  assert.equal(container.querySelector('.message-error-detail'), null);

  let hostDismisses = 0;
  act(() => render(
    h(NoticeContext.Provider, {
      value: { notice: 'second error', sessionPath: null, dismiss: () => { hostDismisses += 1; } },
    }, h(ErrorDetailWithFallback, { message: {} as ChatMessage })),
    container,
  ));
  assert.match(container.textContent ?? '', /second error/);
  act(() => dismissButton().click());
  assert.equal(hostDismisses, 1);
});