import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import DOMPurify from 'dompurify';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';
import { render } from 'preact';
import { act } from 'preact/test-utils';

import { installDom } from './helpers/dom';
import { ExtensionUIPrompt } from '../composer/extension-ui-prompt';
import type { ExtensionUIRequestPayload, ExtensionUIResponsePayload } from '../../lib/protocol/index.js';

DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

installDom();

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  document.querySelectorAll('.ext-prompt').forEach((element) => element.remove());
});

const sessionPath = '/session/test';

const selectRequest = (overrides: Partial<ExtensionUIRequestPayload> = {}): ExtensionUIRequestPayload => ({
  id: 'request-1',
  method: 'select',
  title: 'Choose an approach',
  options: ['Approach A', 'Approach B'],
  sessionPath,
  ...overrides,
} as ExtensionUIRequestPayload);

const key = (target: Element, init: KeyboardEventInit) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};

test('select prompt renders a custom answer control from explicit metadata', () => {
  const html = renderToString(h(ExtensionUIPrompt, {
    sessionPath,
    request: selectRequest({ id: 'request-1', allowCustom: true }),
    postMessage: () => undefined,
  }));

  assert.match(html, />Approach A<\/button>/);
  assert.match(html, /class="ext-prompt-option custom"[^>]*>Custom…<\/button>/);
});

test('generic select prompt does not gain a custom answer control', () => {
  const html = renderToString(h(ExtensionUIPrompt, {
    sessionPath,
    request: selectRequest({ id: 'request-2', options: ['Approach A'] }),
    postMessage: () => undefined,
  }));

  assert.doesNotMatch(html, /ext-prompt-option custom/);
});

test('confirm prompt: Enter on the body confirms and Escape denies, IME composition guards both', () => {
  const responses: ExtensionUIResponsePayload[] = [];
  act(() => {
    render(h(ExtensionUIPrompt, {
      sessionPath,
      request: { id: 'confirm-1', method: 'confirm', title: 'Allow?', message: 'Allow rm -rf?', sessionPath },
      postMessage: (msg) => { responses.push((msg as { response: ExtensionUIResponsePayload }).response); },
    }), container);
  });

  const prompt = container.querySelector('.ext-prompt')!;
  key(prompt, { key: 'Enter', isComposing: true });
  key(prompt, { key: 'Enter', keyCode: 229 });
  key(prompt, { key: 'Escape', isComposing: true });
  assert.deepEqual(responses, [], 'composition must never submit or cancel');

  key(prompt, { key: 'Enter' });
  assert.deepEqual(responses, [{ id: 'confirm-1', confirmed: true }]);

  key(prompt, { key: 'Escape' });
  assert.deepEqual(responses, [
    { id: 'confirm-1', confirmed: true },
    { id: 'confirm-1', confirmed: false },
  ]);

  // A focused button already owns Enter via its native click; the container
  // handler must stay out of the way so denying denies.
  const deny = container.querySelector<HTMLButtonElement>('.ext-prompt-btn.secondary')!;
  const onButton = key(deny, { key: 'Enter' });
  assert.equal(onButton.defaultPrevented, false, 'button-owned Enter is not hijacked');
  assert.equal(responses.length, 2);
});

test('input prompt: typed value submits on Enter, IME composition guards submit and cancel', () => {
  const responses: ExtensionUIResponsePayload[] = [];
  act(() => {
    render(h(ExtensionUIPrompt, {
      sessionPath,
      request: { id: 'input-1', method: 'input', title: 'Name it', placeholder: 'e.g. plan-b', sessionPath },
      postMessage: (msg) => { responses.push((msg as { response: ExtensionUIResponsePayload }).response); },
    }), container);
  });

  const input = container.querySelector<HTMLInputElement>('.ext-prompt-input')!;
  assert.equal(document.activeElement, input, 'input prompt opens with the field focused');

  act(() => {
    input.value = '  spaced name  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  key(input, { key: 'Enter', isComposing: true });
  key(input, { key: 'Enter', keyCode: 229 });
  key(input, { key: 'Escape', isComposing: true });
  assert.deepEqual(responses, [], 'composition must never submit or cancel');

  key(input, { key: 'Escape' });
  assert.deepEqual(responses, [{ id: 'input-1', cancelled: true }]);
});

test('select custom answer: Enter submits only with text and only outside composition', () => {
  const responses: ExtensionUIResponsePayload[] = [];
  act(() => {
    render(h(ExtensionUIPrompt, {
      sessionPath,
      request: selectRequest({ id: 'select-1', allowCustom: true }),
      postMessage: (msg) => { responses.push((msg as { response: ExtensionUIResponsePayload }).response); },
    }), container);
  });

  assert.equal(document.activeElement, container.querySelector('.ext-prompt-option'), 'roving focus starts on the first option');

  const custom = Array.from(container.querySelectorAll<HTMLButtonElement>('.ext-prompt-option'))
    .find((el) => el.classList.contains('custom'))!;
  act(() => { custom.click(); });
  const input = container.querySelector<HTMLInputElement>('.ext-prompt-input')!;
  assert.ok(input, 'choosing Custom opens the free-form control');

  act(() => {
    input.value = '  my answer  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  key(input, { key: 'Enter', isComposing: true });
  key(input, { key: 'Enter', keyCode: 229 });
  assert.deepEqual(responses, [], 'composition must never submit');

  key(input, { key: 'Enter' });
  assert.deepEqual(responses, [{ id: 'select-1', value: 'my answer' }]);
});

test('select option arrows and Home/End are choice keys guarded from composition', () => {
  act(() => {
    render(h(ExtensionUIPrompt, {
      sessionPath,
      request: selectRequest({ id: 'select-2', options: ['A', 'B'] }),
      postMessage: () => undefined,
    }), container);
  });

  const options = document.querySelectorAll<HTMLButtonElement>('.ext-prompt-option');
  const listbox = document.querySelector('.ext-prompt-options')!;
  key(listbox, { key: 'ArrowDown', isComposing: true });
  key(listbox, { key: 'ArrowDown', keyCode: 229 });
  assert.equal(document.activeElement, options[0], 'composed arrow keys must not move roving focus');
  key(listbox, { key: 'ArrowDown' });
  assert.equal(document.activeElement, options[1], 'plain arrow keys move roving focus');
  key(listbox, { key: 'Home', isComposing: true });
  assert.equal(document.activeElement, options[1], 'composed Home must not re-home');
});

test('same-method replacement resets state and focus and answers the new request only', () => {
  const responses: ExtensionUIResponsePayload[] = [];
  act(() => {
    render(h(ExtensionUIPrompt, {
      sessionPath,
      request: selectRequest({ id: 'req-a', allowCustom: true }),
      postMessage: (msg) => { responses.push((msg as { response: ExtensionUIResponsePayload }).response); },
    }), container);
  });

  // Leave prior-answer state behind: type into the custom control on req-a.
  const customA = Array.from(container.querySelectorAll<HTMLButtonElement>('.ext-prompt-option'))
    .find((el) => el.classList.contains('custom'))!;
  act(() => { customA.click(); });
  act(() => {
    const inputA = container.querySelector<HTMLInputElement>('.ext-prompt-input')!;
    inputA.value = 'stale answer';
    inputA.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // Host cancels req-a and issues a fresh select with the same method.
  act(() => {
    render(h(ExtensionUIPrompt, {
      sessionPath,
      request: selectRequest({ id: 'req-b', options: ['Option One'] , allowCustom: true }),
      postMessage: (msg) => { responses.push((msg as { response: ExtensionUIResponsePayload }).response); },
    }), container);
  });

  assert.equal(container.querySelector('.ext-prompt-custom-row'), null, 'custom-input mode must not leak into the replacement');
  const options = container.querySelectorAll('.ext-prompt-option');
  assert.equal(options.length, 2, 'one option plus Custom');
  assert.equal(document.activeElement, options[0], 'roving focus restarts on the first option of the replacement');

  const prompt = document.querySelector('.ext-prompt')!;
  key(prompt, { key: 'Escape' });
  assert.deepEqual([...responses], [{ id: 'req-b', cancelled: true }], 'only the replacement request answers');

  // Rapid replacement again: input prompt must also drop prior text.
  act(() => {
    render(h(ExtensionUIPrompt, {
      sessionPath,
      request: { id: 'input-a', method: 'input', title: 'Name it', sessionPath },
      postMessage: (msg) => { responses.push((msg as { response: ExtensionUIResponsePayload }).response); },
    }), container);
  });
  act(() => {
    const inputA = container.querySelector<HTMLInputElement>('.ext-prompt-input')!;
    inputA.value = 'transient';
    inputA.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    render(h(ExtensionUIPrompt, {
      sessionPath,
      request: { id: 'input-b', method: 'input', title: 'Name it', sessionPath },
      postMessage: (msg) => { responses.push((msg as { response: ExtensionUIResponsePayload }).response); },
    }), container);
  });
  const inputB = container.querySelector<HTMLInputElement>('.ext-prompt-input')!;
  assert.ok(inputB);
  assert.equal(inputB!.value, '', 'typed draft must not survive same-method replacement');
  assert.equal(document.activeElement, inputB, 'replacement input takes focus again');
  act(() => {
    container.querySelector<HTMLButtonElement>('.ext-prompt-btn.primary')!.click();
  });
  assert.equal(
    responses.some((r) => r.id === 'input-b' && 'cancelled' in r),
    false,
    'empty replacement input must not auto-cancel on click',
  );
});

test('confirm rapid replacement: keyboard answers only carry the current request id', () => {
  const responses: ExtensionUIResponsePayload[] = [];
  act(() => {
    render(h(ExtensionUIPrompt, {
      sessionPath,
      request: { id: 'confirm-a', method: 'confirm', title: 'A', message: 'Allow A?', sessionPath },
      postMessage: (msg) => { responses.push((msg as { response: ExtensionUIResponsePayload }).response); },
    }), container);
  });
  act(() => {
    render(h(ExtensionUIPrompt, {
      sessionPath,
      request: { id: 'confirm-b', method: 'confirm', title: 'B', message: 'Allow B?', sessionPath },
      postMessage: (msg) => { responses.push((msg as { response: ExtensionUIResponsePayload }).response); },
    }), container);
  });

  key(document.querySelector('.ext-prompt')!, { key: 'Enter' });
  assert.deepEqual(
    responses.filter((r) => 'confirmed' in r),
    [{ id: 'confirm-b', confirmed: true }],
    'no stale confirm-* response may leak through rapid replacement',
  );
});