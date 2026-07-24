import assert from 'node:assert/strict';
import test from 'node:test';

import DOMPurify from 'dompurify';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { DEFAULT_CHAT_PREFS, type ToolCall } from '../../../../src/shared/protocol';
import type { ToolRendererProps } from '../../../../src/webview/panel/transcript/registry';

// Keep markdown output deterministic without requiring a browser DOM.
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

// Trigger side-effect renderer registration.
require('../../../../src/webview/panel/transcript/register-builtins');
const registryModule: typeof import('../../../../src/webview/panel/transcript/registry') =
  require('../../../../src/webview/panel/transcript/registry');

const noop = () => undefined;
const noopContextMenu = () => undefined;
const noopRenderToolCall = () => null;

function renderAskUser(toolCall: ToolCall): string {
  const Renderer = registryModule.getToolRenderer('ask_user');
  assert.ok(Renderer, 'ask_user renderer should be registered');
  const props: ToolRendererProps = {
    toolCall,
    prefs: DEFAULT_CHAT_PREFS,
    workingDirectory: null,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: noopRenderToolCall,
  };
  return renderToString(h(Renderer as any, props));
}

test('completed ask_user preserves the prompt options and marks the selected answer', () => {
  const html = renderAskUser({
    id: 'ask-1',
    name: 'ask_user',
    status: 'completed',
    input: {
      question: 'Which implementation should we use?',
      options: ['Keep the current flow', 'Use the proposed flow'],
      context: 'The proposed flow keeps the transcript **auditable**.',
      allowCustom: true,
    },
    result: {
      content: [{ type: 'text', text: 'Use the proposed flow' }],
      details: {
        answer: 'Use the proposed flow',
        source: 'option',
        cancelled: false,
      },
      isError: false,
    },
  });

  assert.match(html, /Which implementation should we use\?/);
  assert.match(html, /The proposed flow keeps the transcript <strong>auditable<\/strong>\./);
  assert.match(html, /aria-label="Proposed answers"/);
  assert.match(html, />Keep the current flow<\/span>/);
  assert.match(
    html,
    /aria-label="Use the proposed flow, selected answer" class="ask-user-option ask-user-option-selected">Use the proposed flow<\/span>/,
  );
  assert.match(html, /ask-user-answer-label">Answer:<\/span>/);
  assert.match(html, /ask-user-answer-text">Use the proposed flow<\/span>/);
});

test('completed ask_user omits the options row when no preset options were proposed', () => {
  const html = renderAskUser({
    id: 'ask-empty-options',
    name: 'ask_user',
    status: 'completed',
    input: {
      question: 'What should we name this?',
      options: [],
      allowCustom: true,
    },
    result: {
      answer: 'Transcript archive',
      source: 'custom',
      cancelled: false,
    },
  });

  assert.doesNotMatch(html, /ask-user-options/);
  assert.match(html, /ask-user-answer-text">Transcript archive<\/span>/);
});

test('completed ask_user keeps proposed options when the answer is custom', () => {
  const html = renderAskUser({
    id: 'ask-2',
    name: 'ask_user',
    status: 'completed',
    input: {
      question: 'Choose a deployment window',
      options: ['Today', 'Tomorrow'],
      allowCustom: true,
    },
    result: {
      answer: 'Next Monday',
      source: 'custom',
      cancelled: false,
    },
  });

  assert.match(html, />Today<\/span>/);
  assert.match(html, />Tomorrow<\/span>/);
  assert.doesNotMatch(html, /ask-user-option-selected/);
  assert.match(html, /ask-user-answer-text">Next Monday<\/span>/);
});

test('completed ask_user retains the reviewed-session label from durable input metadata', () => {
  const html = renderAskUser({
    id: 'ask-review',
    name: 'ask_user',
    status: 'completed',
    input: {
      question: 'Can the form be completed with a keyboard?',
      options: ['Yes', 'No'],
      reviewMeta: {
        purpose: 'review_human_verification',
        targetSessionId: 'reviewed-id',
        targetSessionPath: '/sessions/reviewed.jsonl',
        criterionId: 'criterion-accessibility',
        domain: 'accessibility',
        expectedObservation: 'Keyboard interaction works.',
      },
    },
    result: {
      answer: 'Yes',
      source: 'option',
      cancelled: false,
      targetSessionId: 'reviewed-id',
    },
  });

  assert.match(html, /ask-user-review-target">Review · \/sessions\/reviewed.jsonl<\/div>/);
  assert.match(html, /ask-user-answer-text">Yes<\/span>/);
});
