import assert from 'node:assert/strict';
import test from 'node:test';

import DOMPurify from 'dompurify';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { TranscriptMessageList } from '../../../../src/webview/panel/transcript/transcript-message-list.tsx';
import { DEFAULT_CHAT_PREFS, type ChatMessage } from '../../../../src/shared/protocol';

DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

const noop = () => undefined;
const noopContextMenu = () => undefined;
const noopRenderToolCall = () => null;

function userMessage(id: string, markdown: string): ChatMessage {
  return {
    id,
    role: 'user',
    createdAt: '2026-01-01T12:30:00.000Z',
    markdown,
    status: 'completed',
  };
}

function assistantMessage(id: string, markdown: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    createdAt: '2026-01-01T12:34:56.000Z',
    markdown,
    parts: [{ kind: 'text', text: markdown }],
    status: 'completed',
    modelId: 'claude-sonnet-4-5:cloud',
    thinkingLevel: 'high',
  };
}

function render(extra: Record<string, unknown> = {}) {
  return renderToString(
    h(TranscriptMessageList, {
      messages: [assistantMessage('m1', 'First reply'), assistantMessage('m2', 'Second reply')],
      prefs: DEFAULT_CHAT_PREFS,
      workingDirectory: '/repo',
      onOpenFile: noop,
      onContextMenu: noopContextMenu,
      renderToolCall: noopRenderToolCall,
      ...extra,
    }),
  );
}

test('TranscriptMessageList renders one message block per message', () => {
  const html = render();
  const matches = html.match(/class="[^"]*\bmessage\b[^"]*"/g) ?? [];
  assert.ok(matches.length >= 2, 'expected at least two message blocks');
  assert.match(html, /First reply/);
  assert.match(html, /Second reply/);
});

test('TranscriptMessageList adds the owning request time to nested assistant headers', () => {
  const request = userMessage('user-1', 'Nested request');
  const html = render({ messages: [request, assistantMessage('assistant-1', 'Nested reply')] });

  assert.match(html, /datetime="2026-01-01T12:30:00\.000Z"/);
  assert.match(html, /aria-label="Request made /);
});

test('TranscriptMessageList renders read-only when readonly is set', () => {
  const html = render({ readonly: true });
  // Read-only nested transcripts expose no edit/retry affordances.
  assert.doesNotMatch(html, /message-retry-btn/);
  assert.doesNotMatch(html, /message-edit/);
});
