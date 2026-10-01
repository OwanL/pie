import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSessionControlTranscript } from '../session-control-transcript.js';
import type { ChatMessage } from '../../lib/rpc/message-contract.js';
import { createSessionControlSender } from '../../lib/rpc/session-control-attribution.js';

const base: ChatMessage = {
  id: 'm1', role: 'assistant', createdAt: '2026-09-30', status: 'completed', markdown: 'answer',
};

test('agent read keeps attribution and canonical content without renderer/debug mirrors', () => {
  const sender = createSessionControlSender({ sessionId: 'source', identityFallback: false }, 'Source');
  const [row] = projectSessionControlTranscript([{
    ...base, role: 'user', sender, customDetails: { diagnostic: 'private to UI' },
    usage: { input: 0 } as never, billingSourceEntryIds: ['billing'],
  }]);
  assert.equal(row.markdown, 'answer');
  assert.deepEqual(row.sender, sender);
  assert.equal(row.customDetails, undefined);
  assert.equal(row.usage, undefined);
  assert.equal(row.billingSourceEntryIds, undefined);
});

test('agent read bounds tool previews with explicit omissions and never serializes SDK details', () => {
  const diagnostic = { toJSON: () => { throw new Error('details must not be serialized'); } };
  const [row] = projectSessionControlTranscript([{
    ...base,
    parts: [{ kind: 'text', text: 'answer' }, { kind: 'toolCall', toolCall: {
      id: 'tool', name: 'read', status: 'completed', input: 'x'.repeat(8000),
      result: { content: [{ type: 'text', text: 'y'.repeat(8000) }], details: diagnostic },
    } }],
    toolCalls: [{ id: 'tool', name: 'read', status: 'completed', input: {} }],
  }]);
  assert.equal(row.markdown, '');
  assert.equal(row.toolCalls, undefined);
  const toolPart = row.parts![1];
  assert.equal(toolPart.kind, 'toolCall');
  if (toolPart.kind !== 'toolCall') return;
  assert.equal((toolPart.toolCall.input as { truncated: boolean }).truncated, true);
  assert.equal((toolPart.toolCall.result as { truncated: boolean }).truncated, true);
  assert.ok(JSON.stringify(row).length < 9000);
});

test('agent read keeps image metadata but explicitly omits base64 payloads', () => {
  const [row] = projectSessionControlTranscript([{
    ...base, role: 'user', userParts: [{ kind: 'text', text: 'inspect this' }, {
      kind: 'image', mimeType: 'image/png', dataBase64: 'x'.repeat(600_000), width: 640, name: 'shot.png',
    }],
  }]);
  assert.ok(JSON.stringify(row).length < 1000);
  assert.equal(row.userParts![1].kind, 'image');
  assert.equal((row.userParts![1] as unknown as { omitted: boolean }).omitted, true);
  assert.equal((row.userParts![1] as { name?: string }).name, 'shot.png');
});

test('agent read retains legacy text/tools and marks lazy tool output as omitted', () => {
  const [row] = projectSessionControlTranscript([{
    ...base, toolCalls: [{
      id: 'tool', name: 'subagent', status: 'completed', input: {},
      detailRef: { key: 'ui-detail', kind: 'tool-result', source: 'durable', sessionPath: '/s',
        messageId: 'm1', sizeBytes: 900000, summary: '1 subagent child', available: true },
    }],
  }]);
  assert.equal(row.markdown, 'answer');
  assert.deepEqual(row.toolCalls![0].result, { preview: '1 subagent child', omitted: true, sizeBytes: 900000 });
  assert.equal(row.toolCalls![0].detailRef, undefined);
});
