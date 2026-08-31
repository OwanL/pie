import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../../../../src/shared/protocol';
import {
  buildUserPromptEntries,
  selectPromptFromElementMetrics,
  selectUserPromptAtViewport,
  userPromptDetails,
  userPromptPlainText,
} from '../../../../src/webview/panel/transcript/user-prompt-context';
import type { TranscriptRow } from '../../../../src/webview/panel/transcript/virtual-list-rows';

function userMessage(
  id: string,
  markdown = '',
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role: 'user',
    createdAt: '2026-05-16T00:00:00.000Z',
    markdown,
    status: 'completed',
    ...extra,
  } as ChatMessage;
}

function messageRow(message: ChatMessage): Extract<TranscriptRow, { kind: 'message' }> {
  return { kind: 'message', key: `message:${message.id}`, message };
}

function endsByRow(values: Record<number, number>): (rowIndex: number) => number | null {
  return (rowIndex) => values[rowIndex] ?? null;
}

test('user prompt entries index source metadata without normalizing text', () => {
  const promptMessage = userMessage('prompt-1', 'ignored markdown', { userParts: [
    { kind: 'text', text: ' first\nline ' },
    { kind: 'image', mimeType: 'image/png', dataBase64: 'abc' },
    { kind: 'text', text: ' second ' },
  ] });
  const imageMessage = userMessage('prompt-2', '', {
    userParts: [{ kind: 'image', mimeType: 'image/jpeg', dataBase64: 'def' }],
  });
  const entries = buildUserPromptEntries([
    messageRow(promptMessage),
    messageRow(userMessage('assistant-looking', '', { role: 'assistant' })),
    messageRow(imageMessage),
  ]);

  // The index stays cheap: row/message references and flags only.
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.rowIndex, 0);
  assert.equal(entries[1]?.rowIndex, 2);
  assert.equal(entries[0]?.messageId, 'prompt-1');
  assert.equal(entries[0]?.message, promptMessage);
  assert.equal(entries[1]?.message, imageMessage);
  assert.equal(entries[0]?.isQueued, false);
  assert.equal(entries[0]?.isAutoResume, false);
});

test('userPromptDetails normalizes text and counts images for a selected prompt', () => {
  const structured = userPromptDetails(userMessage('prompt-1', 'ignored markdown', { userParts: [
    { kind: 'text', text: ' first\nline ' },
    { kind: 'image', mimeType: 'image/png', dataBase64: 'abc' },
    { kind: 'text', text: ' second ' },
  ] }));
  assert.deepEqual(structured, { plainText: 'first line second', imageCount: 1 });

  const images = userPromptDetails(userMessage('prompt-2', '', { userParts: [
    { kind: 'image', mimeType: 'image/jpeg', dataBase64: 'def' },
    { kind: 'image', mimeType: 'image/png', dataBase64: 'ghi' },
  ] }));
  assert.deepEqual(images, { plainText: '(2 images)', imageCount: 2 });

  const empty = userPromptDetails(userMessage('prompt-3'));
  assert.deepEqual(empty, { plainText: '(empty)', imageCount: 0 });
});

test('user prompt text falls back to markdown and empty prompts stay plain text', () => {
  const markdownRow = messageRow(userMessage('prompt-1', '  use **this**\nplease  '));
  const emptyRow = messageRow(userMessage('prompt-2'));

  assert.equal(userPromptPlainText(markdownRow.message), 'use **this** please');
  assert.equal(userPromptPlainText(emptyRow.message), '(empty)');
});

test('entries expose queued and auto-resume state for user messages', () => {
  const entries = buildUserPromptEntries([
    messageRow(userMessage('queued', 'later', { status: 'queued' })),
    messageRow(userMessage('resume', 'wake up', { customType: 'auto-resume' })),
  ]);

  assert.equal(entries[0]?.isQueued, true);
  assert.equal(entries[0]?.isAutoResume, false);
  assert.equal(entries[1]?.isQueued, false);
  assert.equal(entries[1]?.isAutoResume, true);
});

test('viewport selection only returns prompts fully above the viewport', () => {
  const entries = buildUserPromptEntries([
    messageRow(userMessage('prompt-1', 'first')),
    messageRow(userMessage('assistant-1', '', { role: 'assistant' })),
    messageRow(userMessage('prompt-2', 'second')),
  ]);
  const getRowEnd = endsByRow({ 0: 40, 1: 150, 2: 200 });

  assert.equal(selectUserPromptAtViewport({ entries, getRowEnd, scrollOffset: 20 }), null,
    'the first visible prompt has no predecessor to show');
  assert.equal(selectUserPromptAtViewport({ entries, getRowEnd, scrollOffset: 180 })?.messageId, 'prompt-1',
    'a visible second prompt falls back to its offscreen predecessor');
  assert.equal(selectUserPromptAtViewport({ entries, getRowEnd, scrollOffset: 200 })?.messageId, 'prompt-2',
    'the second prompt takes over only once its full row is offscreen');
});

test('selection uses the padded content origin when deciding whether a row is offscreen', () => {
  const entries = buildUserPromptEntries([messageRow(userMessage('prompt-1', 'first'))]);
  const getRowEnd = endsByRow({ 0: 240 });

  assert.equal(selectUserPromptAtViewport({
    entries,
    getRowEnd,
    scrollOffset: 339,
    contentOriginPx: 100,
  }), null);
  assert.equal(selectUserPromptAtViewport({
    entries,
    getRowEnd,
    scrollOffset: 340,
    contentOriginPx: 100,
  })?.messageId, 'prompt-1');

  assert.equal(selectUserPromptAtViewport({
    entries,
    getRowEnd,
    scrollOffset: null,
    contentOriginPx: Number.NaN,
  }), null);
});

test('selection fails closed when prompt geometry is incomplete', () => {
  const entries = buildUserPromptEntries([
    messageRow(userMessage('prompt-1', 'first')),
    messageRow(userMessage('prompt-2', 'second')),
  ]);

  assert.equal(selectUserPromptAtViewport({
    entries,
    getRowEnd: () => null,
    scrollOffset: 500,
  }), null);
});

test('element metrics drive selection and unmeasurable elements use the virtualizer offset', () => {
  const entries = buildUserPromptEntries([
    messageRow(userMessage('prompt-1', 'first')),
    messageRow(userMessage('prompt-2', 'latest')),
  ]);
  const getRowEnd = endsByRow({ 0: 40, 1: 200 });
  const metrics = { scrollTop: 100, scrollHeight: 600, clientHeight: 200 };

  assert.equal(selectPromptFromElementMetrics({
    entries,
    getRowEnd,
    metrics,
    fallbackScrollOffset: null,
  })?.messageId, 'prompt-1');

  metrics.scrollTop = 180;
  assert.equal(selectPromptFromElementMetrics({
    entries,
    getRowEnd,
    metrics,
    fallbackScrollOffset: null,
  })?.messageId, 'prompt-1', 'the visible latest prompt does not replace its predecessor');

  metrics.scrollTop = 210;
  assert.equal(selectPromptFromElementMetrics({
    entries,
    getRowEnd,
    metrics,
    fallbackScrollOffset: null,
  })?.messageId, 'prompt-2');

  assert.equal(selectPromptFromElementMetrics({
    entries,
    getRowEnd,
    metrics: null,
    fallbackScrollOffset: 100,
  })?.messageId, 'prompt-1');
  assert.equal(selectPromptFromElementMetrics({
    entries,
    getRowEnd,
    metrics: { scrollTop: 0, scrollHeight: 0, clientHeight: 0 },
    fallbackScrollOffset: null,
  }), null, 'without trustworthy geometry, hiding avoids duplicating a visible prompt');
});
