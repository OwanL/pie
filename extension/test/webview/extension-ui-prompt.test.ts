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

test('review metadata labels fixed and inline prompts without replacing reviewer routing', () => {
  const request = {
    id: 'review-request',
    method: 'input' as const,
    title: 'Describe what you observed',
    sessionPath: '/sessions/reviewer.jsonl',
    reviewMeta: {
      purpose: 'review_human_verification' as const,
      targetSessionId: 'reviewed-id',
      targetSessionPath: '/sessions/reviewed.jsonl',
      criterionId: 'criterion-1',
      domain: 'accessibility',
      expectedObservation: 'Keyboard interaction works.',
    },
  };

  for (const variant of ['strip', 'card'] as const) {
    const html = renderToString(h(ExtensionUIPrompt, {
      sessionPath: '/sessions/reviewer.jsonl',
      request,
      postMessage: () => undefined,
      variant,
      sourceLabel: 'Reviewer agent',
    }));
    assert.match(html, /Review · \/sessions\/reviewed.jsonl/);
    assert.doesNotMatch(html, /Reviewer agent/);
  }
});
