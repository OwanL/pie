import test from 'node:test';
import assert from 'node:assert/strict';

import type { ChatMessage, SystemPromptEntry } from '../../../../src/shared/protocol';
import { isTranscriptHydrating } from '../../../../src/webview/panel/transcript/state';

function userMessage(markdown: string): ChatMessage {
  return {
    id: 'msg-1',
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown,
    status: 'completed',
  };
}

function providerPrompt(): SystemPromptEntry {
  return {
    source: 'provider',
    title: 'Provider system prompt',
    summary: 'Unknown',
    text: 'Unknown',
    availability: 'unknown',
  };
}

test('isTranscriptHydrating returns true before transcript and system prompts arrive', () => {
  assert.equal(isTranscriptHydrating({ transcript: [], systemPrompts: [], transcriptLoaded: false }), true);
});

test('isTranscriptHydrating returns false once system prompts have loaded', () => {
  assert.equal(isTranscriptHydrating({ transcript: [], systemPrompts: [providerPrompt()], transcriptLoaded: true }), false);
});

test('isTranscriptHydrating returns false once transcript rows exist', () => {
  assert.equal(isTranscriptHydrating({ transcript: [userMessage('hello')], systemPrompts: [], transcriptLoaded: true }), false);
});

test('isTranscriptHydrating returns false once an empty transcript has loaded', () => {
  assert.equal(isTranscriptHydrating({ transcript: [], systemPrompts: [], transcriptLoaded: true }), false);
});
