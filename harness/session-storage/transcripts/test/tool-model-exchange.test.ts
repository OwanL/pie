import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage, ToolCall } from '../../../agent-processes/lib/rpc/message-contract';
import { captureModelExchangeEntries, findToolModelExchange, modelExchangeRef } from '../tool-model-exchange';

const tool: ToolCall = { id: 'exact|id', durableEntryId: 'result-entry', name: 'display-name', input: { display: true }, result: 'not captured', status: 'completed' };
function transcriptFor(...tools: ToolCall[]): ChatMessage[] {
  return [{ id: 'assistant', role: 'assistant', createdAt: '', markdown: '', status: 'completed', parts: tools.map((toolCall) => ({ kind: 'toolCall', toolCall })) }];
}
const transcript = transcriptFor(tool);
const ref = modelExchangeRef('/session', tool);
function capture(data: unknown) {
  return { type: 'custom', customType: 'pie.tool-model-exchange', data, id: 'metadata', timestamp: 'metadata' };
}
function assistant(id = tool.id) {
  return { type: 'message', id: 'assistant', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'display', arguments: 'never retained' }] } };
}
function result(id = tool.durableEntryId, toolCallId = tool.id) {
  return { type: 'message', id, message: { role: 'toolResult', toolCallId, content: ['never retained'] } };
}
const produced = { name: 'actual-name', arguments: '{"exact":true}' };
const producedCapture = capture({ version: 1, toolCallId: tool.id, produced: { ...produced, metadata: 'omit' }, metadata: 'omit' });
const receivedCapture = capture({ version: 1, toolCallId: tool.id, received: [{ content: ['exact'] }], metadata: 'omit' });

test('exact capture retains only occurrence identity and payload, never display or sidecar fields', () => {
  const entries = captureModelExchangeEntries([producedCapture, assistant(), result(), receivedCapture]);
  const found = findToolModelExchange(transcript, entries, ref);
  assert.equal(found.status, 'loaded');
  if (found.status !== 'loaded') return;
  assert.deepEqual(found.value, { produced, received: [{ content: ['exact'] }] });
  assert.equal(found.sizeBytes, Buffer.byteLength(JSON.stringify(found.value)));
  assert.deepEqual(entries, [{ customType: 'pie.tool-model-exchange', durableEntryId: 'result-entry', assistantEntryId: 'assistant', data: { version: 1, toolCallId: tool.id, ...found.value } }]);
  assert.equal(ref.sizeBytes, 0);
  assert.equal(ref.key, modelExchangeRef('/session', { ...tool, result: 'changed' }).key);
});

test('requires exact active branch identity; provisional fallback only for one occurrence', () => {
  const entries = captureModelExchangeEntries([producedCapture, assistant(), result()]);
  for (const invalid of [{ ...ref, messageId: 'assistant' }, { ...ref, toolCallId: 'exact' }, { ...ref, source: 'live' as const }]) {
    assert.equal(findToolModelExchange(transcript, entries, invalid).status, 'unavailable');
  }
  assert.equal(findToolModelExchange([], entries, ref).status, 'unavailable');
  assert.equal(findToolModelExchange(transcript, captureModelExchangeEntries([producedCapture, assistant(), result('out-of-branch')]), ref).status, 'unavailable');
  const provisional = { ...tool, durableEntryId: undefined };
  assert.equal(findToolModelExchange(transcriptFor(provisional), entries, modelExchangeRef('/session', provisional)).status, 'loaded');
  const runningEntries = captureModelExchangeEntries([producedCapture, assistant()]);
  const running = findToolModelExchange(transcriptFor(provisional), runningEntries, modelExchangeRef('/session', provisional));
  assert.equal(running.status, 'loaded', 'generated arguments are inspectable before the tool returns');
  if (running.status === 'loaded') assert.deepEqual(running.value, { produced });
  assert.equal(findToolModelExchange(transcriptFor(provisional, provisional), entries, modelExchangeRef('/session', provisional)).status, 'unavailable');
});

test('both reused-ID invocations load their own exact produced and received data', () => {
  const newer = { ...tool, durableEntryId: 'new-result' };
  const branch = [producedCapture, assistant(), result(), receivedCapture,
    capture({ version: 1, toolCallId: tool.id, produced: { name: 'new', arguments: 'new' } }), assistant(), result('new-result'),
    capture({ version: 1, toolCallId: tool.id, received: [] }),
    capture({ version: 1, toolCallId: tool.id, received: ['later'] })];
  const entries = captureModelExchangeEntries(branch);
  const both = transcriptFor(tool, newer);
  const old = findToolModelExchange(both, entries, ref);
  const next = findToolModelExchange(both, entries, modelExchangeRef('/session', newer));
  assert.equal(old.status, 'loaded');
  assert.equal(next.status, 'loaded');
  if (old.status === 'loaded') assert.deepEqual(old.value, { produced, received: [{ content: ['exact'] }] });
  if (next.status === 'loaded') assert.deepEqual(next.value, { produced: { name: 'new', arguments: 'new' }, received: [] });
  const provisional = { ...tool, durableEntryId: undefined };
  assert.equal(findToolModelExchange(transcriptFor(provisional), entries, modelExchangeRef('/session', provisional)).status, 'unavailable');
});

test('missing or ambiguous markers never claim exact capture', () => {
  for (const branch of [
    [producedCapture, receivedCapture],
    [producedCapture, assistant()],
    [producedCapture, assistant(), result('wrong', 'other'), receivedCapture],
    [producedCapture, producedCapture, assistant(), result()],
    [producedCapture, assistant(), result(), result('duplicate'), receivedCapture],
    [assistant(), producedCapture, result()],
  ]) assert.equal(findToolModelExchange(transcript, captureModelExchangeEntries(branch), ref).status, 'unavailable');
});

test('partial produced and received-only captures stay exact; invalid captures unavailable', () => {
  const partial = findToolModelExchange(transcript, captureModelExchangeEntries([producedCapture, assistant(), result()]), ref);
  assert.equal(partial.status, 'loaded');
  if (partial.status === 'loaded') assert.deepEqual(partial.value, { produced });
  const received = findToolModelExchange(transcript, captureModelExchangeEntries([assistant(), result(), receivedCapture]), ref);
  assert.equal(received.status, 'loaded');
  if (received.status === 'loaded') assert.deepEqual(received.value, { received: [{ content: ['exact'] }] });
  const invalid = captureModelExchangeEntries([
    { ...producedCapture, type: 'custom_message' }, capture({ version: 2, toolCallId: tool.id, produced }),
    capture({ version: 1, toolCallId: tool.id }), assistant(), result(),
  ]);
  assert.equal(findToolModelExchange(transcript, invalid, ref).status, 'unavailable');
});
