/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import test from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { MessageItemHeader } from '../../../transcript/message-item/header';
import { createSessionControlSender } from '../../../../../harness/agent-processes/lib/rpc/session-control-attribution.js';

function renderHeader(customType?: string, sender?: ReturnType<typeof createSessionControlSender>): string {
  return renderToString(h(MessageItemHeader, {
    role: 'user',
    isCurrentlyStreaming: false,
    durationMs: undefined,
    replyMeta: null,
    assistantMetaTooltip: null,
    actions: null,
    customType,
    sender,
  }));
}

test('agent-originated user messages show a bot icon and Agent label', () => {
  const html = renderHeader('agent-message');
  assert.match(html, /session-tab-agent-icon compact/);
  assert.match(html, />Agent<\/span>/);
  assert.doesNotMatch(html, /Auto-resume/);
});

test('agent-originated messages show the assigned sender beside the existing Agent cue', () => {
  const sender = createSessionControlSender({ sessionId: 'source-session', identityFallback: false }, 'Source session');
  const html = renderHeader('agent-message', sender);

  assert.match(html, /Agent<span/);
  assert.match(html, /· Source session/);
});

test('unnamed agent senders remain identifiable beside the Agent cue', () => {
  const sender = createSessionControlSender({ sessionId: 'unnamed-source', identityFallback: true });
  const html = renderHeader('agent-message', sender);

  assert.match(html, /Agent<span/);
  assert.match(html, /Unnamed session/);
});

test('ordinary user messages remain unbadged and auto-resume keeps its existing label', () => {
  assert.doesNotMatch(renderHeader(), /session-tab-agent-icon|Auto-resume/);
  assert.match(renderHeader('auto-resume'), /Auto-resume/);
});
