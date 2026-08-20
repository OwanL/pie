import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: { supports: () => false },
});

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { InlineEditor } from '../../../src/webview/panel/transcript/inline-editor';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

test('InlineEditor confirms at most once when Save and Enter both submit', () => {
  const confirmations: Array<{ text: string; inputCount: number }> = [];

  act(() => {
    render(h(InlineEditor, {
      initialText: 'edited question',
      initialInputs: [],
      capturedHeight: null,
      onConfirm: (text, inputs) => confirmations.push({ text, inputCount: inputs.length }),
      onCancel: () => {},
    }), container);
  });

  const save = container.querySelector<HTMLButtonElement>('button.primary');
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
  assert.ok(save);
  assert.ok(textarea);

  act(() => {
    save.click();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  });

  assert.deepEqual(confirmations, [{ text: 'edited question', inputCount: 0 }]);
});