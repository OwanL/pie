import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ContextMenu } from '../../../src/webview/panel/components/context-menu';
import type { ChatPrefs } from '../../../src/shared/protocol';

const prefs = {} as ChatPrefs;
let container: HTMLDivElement;

test('file-path context menu offers Open File and Copy Path without Copy raw', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  const opened: string[] = [];

  act(() => {
    render(h(ContextMenu, {
      menu: {
        type: 'filePath',
        rawData: '/workspace/pie/reveal/docs/foo.md',
        selectionText: '',
        x: 10,
        y: 10,
        triggerEl: null,
      },
      prefs,
      onSetPrefs: () => {},
      onOpenFile: (path: string) => opened.push(path),
      onClose: () => {},
    }), container);
  });

  const labels = Array.from(container.querySelectorAll('button')).map((button) => button.textContent?.trim());
  assert.deepEqual(labels, ['Open File', 'Copy Path']);

  act(() => {
    (container.querySelector('button') as HTMLButtonElement).click();
  });
  assert.deepEqual(opened, ['/workspace/pie/reveal/docs/foo.md']);

  render(null, container);
  container.remove();
});
