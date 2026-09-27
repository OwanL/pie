/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import test from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { MessageItemHeader } from '../../../transcript/message-item/header';

function renderHeader(customType?: string): string {
  return renderToString(h(MessageItemHeader, {
    role: 'user',
    isCurrentlyStreaming: false,
    durationMs: undefined,
    replyMeta: null,
    assistantMetaTooltip: null,
    actions: null,
    customType,
  }));
}

test('agent-originated user messages show a bot icon and Agent label', () => {
  const html = renderHeader('agent-message');
  assert.match(html, /session-tab-agent-icon compact/);
  assert.match(html, />Agent<\/span>/);
  assert.doesNotMatch(html, /Auto-resume/);
});

test('ordinary user messages remain unbadged and auto-resume keeps its existing label', () => {
  assert.doesNotMatch(renderHeader(), /session-tab-agent-icon|Auto-resume/);
  assert.match(renderHeader('auto-resume'), /Auto-resume/);
});
