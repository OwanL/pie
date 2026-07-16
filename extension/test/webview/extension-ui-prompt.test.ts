import assert from 'node:assert/strict';
import test from 'node:test';

import DOMPurify from 'dompurify';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { ExtensionUIPrompt } from '../../src/webview/panel/extension-ui-prompt';

DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

test('select prompt renders a custom answer control from explicit metadata', () => {
  const html = renderToString(h(ExtensionUIPrompt, {
    sessionPath: '/session/test',
    request: {
      id: 'request-1',
      method: 'select',
      title: 'Choose an approach',
      options: ['Approach A', 'Approach B'],
      allowCustom: true,
      sessionPath: '/session/test',
    },
    postMessage: () => undefined,
  }));

  assert.match(html, />Approach A<\/button>/);
  assert.match(html, /class="ext-prompt-option custom"[^>]*>Custom…<\/button>/);
});

test('generic select prompt does not gain a custom answer control', () => {
  const html = renderToString(h(ExtensionUIPrompt, {
    sessionPath: '/session/test',
    request: {
      id: 'request-2',
      method: 'select',
      title: 'Choose an approach',
      options: ['Approach A'],
      sessionPath: '/session/test',
    },
    postMessage: () => undefined,
  }));

  assert.doesNotMatch(html, /ext-prompt-option custom/);
});
