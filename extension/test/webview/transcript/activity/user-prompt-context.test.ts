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

function startsByRow(values: Record<number, number>): (rowIndex: number) => number | null {
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

test('viewport selection follows the last prompt at the turn boundary', () => {
  const entries = buildUserPromptEntries([
    messageRow(userMessage('prompt-1', 'first')),
    messageRow(userMessage('assistant-1', '', { role: 'assistant' })),
    messageRow(userMessage('prompt-2', 'second')),
  ]);
  const getRowStart = startsByRow({ 0: 0, 1: 70, 2: 160 });

  assert.equal(selectUserPromptAtViewport({
    entries,
    getRowStart,
    scrollOffset: 80,
    isAtBottom: false,
  })?.messageId, 'prompt-1');
  assert.equal(selectUserPromptAtViewport({
    entries,
    getRowStart,
    scrollOffset: 150,
    isAtBottom: false,
  })?.messageId, 'prompt-2');
});

test('selection switches at the padded-origin boundary, not the raw offset', () => {
  // Prompt row starts 200px into the content; the container pads the top by
  // 100px, so the boundary is offset - origin + threshold.
  const entries = buildUserPromptEntries([messageRow(userMessage('prompt-1', 'first'))]);
  const getRowStart = startsByRow({ 0: 200 });

  assert.equal(selectUserPromptAtViewport({
    entries,
    getRowStart,
    scrollOffset: 289,
    isAtBottom: false,
    contentOriginPx: 100,
  }), null, 'offset 289 puts the boundary at 199, still before the prompt');
  assert.equal(selectUserPromptAtViewport({
    entries,
    getRowStart,
    scrollOffset: 290,
    isAtBottom: false,
    contentOriginPx: 100,
  })?.messageId, 'prompt-1', 'offset 290 puts the boundary exactly at the prompt start');

  // A non-finite origin is treated as no padding.
  assert.equal(selectUserPromptAtViewport({
    entries,
    getRowStart,
    scrollOffset: null,
    isAtBottom: false,
    contentOriginPx: Number.NaN,
  }), null);
});

test('viewport selection switches at the ten-pixel threshold', () => {
  const entries = buildUserPromptEntries([messageRow(userMessage('prompt-1', 'first'))]);
  const getRowStart = startsByRow({ 0: 100 });

  assert.equal(selectUserPromptAtViewport({
    entries,
    getRowStart,
    scrollOffset: 89,
    isAtBottom: false,
  }), null);
  assert.equal(selectUserPromptAtViewport({
    entries,
    getRowStart,
    scrollOffset: 90,
    isAtBottom: false,
  })?.messageId, 'prompt-1');
});

test('bottom selection returns the latest loaded prompt', () => {
  const entries = buildUserPromptEntries([
    messageRow(userMessage('prompt-1', 'first')),
    messageRow(userMessage('prompt-2', 'latest')),
  ]);

  assert.equal(selectUserPromptAtViewport({
    entries,
    getRowStart: () => null,
    scrollOffset: null,
    isAtBottom: true,
  })?.messageId, 'prompt-2');
});

test('selection hides above a loaded window that begins with an assistant', () => {
  const entries = buildUserPromptEntries([
    messageRow(userMessage('prompt-2', 'later')),
  ]);

  assert.equal(selectUserPromptAtViewport({
    entries: entries.map((entry) => ({ ...entry, rowIndex: 1 })),
    getRowStart: startsByRow({ 1: 120 }),
    scrollOffset: 0,
    isAtBottom: false,
  }), null);
});

test('element metrics select from scrollTop and force the latest prompt near the bottom', () => {
  const entries = buildUserPromptEntries([
    messageRow(userMessage('prompt-1', 'first')),
    messageRow(userMessage('assistant-1', '', { role: 'assistant' })),
    messageRow(userMessage('prompt-2', 'second')),
  ]);
  // The latest prompt starts a full viewport above the maximum scrollTop, so
  // the top-edge boundary math alone would keep the earlier prompt.
  const getRowStart = startsByRow({ 0: 0, 1: 50, 2: 380 });
  const metrics = { scrollTop: 50, scrollHeight: 600, clientHeight: 200 };
  const options = {
    entries,
    getRowStart,
    metrics,
    fallbackScrollOffset: null as number | null,
    fallbackIsAtBottom: false,
  };
  const select = () => selectPromptFromElementMetrics(options);

  assert.equal(select()?.messageId, 'prompt-1');
  metrics.scrollTop = 370;
  assert.equal(select()?.messageId, 'prompt-2', 'scrollTop follows the element, not the fallback offset');

  // Near the bottom (distance-from-bottom within the bottom threshold) the
  // latest prompt wins even when its row start lies below the boundary.
  assert.equal(selectUserPromptAtViewport({
    entries,
    getRowStart: startsByRow({ 0: 0, 1: 50, 2: 580 }),
    scrollOffset: 400,
    isAtBottom: false,
  })?.messageId, 'prompt-1', 'the top-edge boundary math alone keeps the earlier prompt');
  assert.equal(selectPromptFromElementMetrics({
    ...options,
    getRowStart: startsByRow({ 0: 0, 1: 50, 2: 580 }),
    metrics: { scrollTop: 400, scrollHeight: 600, clientHeight: 200 },
  })?.messageId, 'prompt-2', 'metric near-bottom promotes the latest prompt');
});

test('unmeasurable elements fall back to the virtualizer offset and isAtBottom', () => {
  const entries = buildUserPromptEntries([
    messageRow(userMessage('prompt-1', 'first')),
    messageRow(userMessage('prompt-2', 'latest')),
  ]);
  const getRowStart = startsByRow({ 0: 0, 1: 160 });

  assert.equal(selectPromptFromElementMetrics({
    entries,
    getRowStart,
    metrics: null,
    fallbackScrollOffset: 80,
    fallbackIsAtBottom: false,
  })?.messageId, 'prompt-1', 'null metrics defer to the virtualizer offset');

  assert.equal(selectPromptFromElementMetrics({
    entries,
    getRowStart,
    metrics: { scrollTop: 0, scrollHeight: 0, clientHeight: 0 },
    fallbackScrollOffset: null,
    fallbackIsAtBottom: true,
  })?.messageId, 'prompt-2', 'zero-size metrics defer to the parent isAtBottom state');

  assert.equal(selectPromptFromElementMetrics({
    entries,
    getRowStart,
    metrics: { scrollTop: 0, scrollHeight: 0, clientHeight: 0 },
    fallbackScrollOffset: null,
    fallbackIsAtBottom: false,
  }), null, 'no recoverable signal leaves the bar unowned');
});