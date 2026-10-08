import assert from 'node:assert/strict';
import test from 'node:test';

import DOMPurify from 'dompurify';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { installDom } from '../../helpers/dom';
import { clearCollapsibleCache } from '../../../transcript/use-collapsible-open';
installDom();

import { DEFAULT_CHAT_PREFS, type ToolCall } from '../../../../lib/protocol/index.js';
import type { ToolRendererProps } from '../../../transcript/registry';

// Keep markdown output deterministic in the isolated DOM fixture.
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

// Trigger side-effect renderer registration.
require('../../../transcript/register-builtins');
const registryModule: typeof import('../../../transcript/registry') =
  require('../../../transcript/registry');

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
  clearCollapsibleCache();
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => render(h(Renderer as any, props), container));
  assert.equal(container.querySelector('.tool-call-toggle')?.getAttribute('aria-expanded'), 'false');
  act(() => (container.querySelector('.tool-call-toggle') as HTMLButtonElement).click());
  const html = container.innerHTML;
  act(() => render(null, container));
  container.remove();
  return html;
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
    /aria-label="Use the proposed flow, selected answer"/,
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
