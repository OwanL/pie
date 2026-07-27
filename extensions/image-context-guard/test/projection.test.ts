import assert from 'node:assert/strict';
import test from 'node:test';

import { projectImageContext, countImages } from '../src/projection.js';
import type { ProjectionInput } from '../src/projection.js';

const text = (value: string) => ({ type: 'text', text: value });
const image = (id: string) => ({ type: 'image', data: id, mimeType: 'image/png' });

const user = (id: string, parts: any[]) => ({
  role: 'user', timestamp: 0, content: parts, _id: id,
});
const toolResult = (id: string, toolName: string, images: string[]) => ({
  role: 'toolResult', toolCallId: id, toolName, isError: false, timestamp: 0,
  content: [text(`${toolName}: ok`), ...images.map(image)], _id: id,
});

function imageIds(messages: any[]): string[] {
  return messages.flatMap((m) => Array.isArray(m?.content)
    ? m.content.filter((p: any) => p.type === 'image').map((p: any) => p.data)
    : []);
}

function noticeText(messages: any[]): string | undefined {
  const last = messages[messages.length - 1];
  return last?.role === 'custom' && last?.customType === 'pie-image-context'
    ? String(last.content)
    : undefined;
}

function policy(max: number, configured = true): ProjectionInput['policy'] {
  return { maxImagesPerRequest: max, configured };
}

const MODEL = { provider: 'github-copilot', id: 'claude-sonnet-5' };

test('a context at or below the active model maximum is unchanged and emits no notice', () => {
  const messages: any[] = [
    toolResult('c1', 'computer', ['a', 'b']),
    user('u1', [text('hi'), image('u-a')]),
  ];
  const original = structuredClone(messages);
  const result = projectImageContext(messages, { policy: policy(3), model: MODEL });

  assert.equal(result.notice, undefined);
  assert.deepEqual(imageIds(result.messages), ['a', 'b', 'u-a']);
  assert.deepEqual(messages, original, 'input messages remain unchanged');
});

test('a context above the maximum sends only the newest permitted images', () => {
  const messages: any[] = [
    toolResult('c1', 'computer', ['old-1', 'old-2']),
    toolResult('c2', 'read', ['read-1']),
    user('u1', [image('u-a'), image('u-b')]),
  ];
  const result = projectImageContext(messages, { policy: policy(2), model: MODEL });

  assert.equal(imageIds(result.messages).length, 2);
  // newest-first retention: the two newest images survive.
  assert.deepEqual(imageIds(result.messages), ['u-a', 'u-b']);
});

test('the original session messages and image parts remain unchanged', () => {
  const messages: any[] = [
    toolResult('c1', 'computer', ['a', 'b', 'c', 'd']),
    user('u1', [image('u-a')]),
  ];
  const original = structuredClone(messages);
  projectImageContext(messages, { policy: policy(1), model: MODEL });
  assert.deepEqual(messages, original);
});

test('a bounded omission notice reaches the agent in the same request', () => {
  const messages: any[] = [
    toolResult('c1', 'computer', ['old-1', 'old-2']),
    user('u1', [image('u-a')]),
  ];
  const result = projectImageContext(messages, { policy: policy(1), model: MODEL });

  assert.ok(result.notice);
  assert.match(result.notice, /\[Pie image budget\]/);
  assert.match(result.notice, /at most 1 image per request/);
  assert.match(result.notice, /2 older session images were omitted/);
  assert.match(result.notice, /durable session history was not changed/);
  assert.match(result.notice, /Do not infer omitted image contents/);
  // The notice is appended as a transient custom message in the projection.
  assert.equal(noticeText(result.messages), result.notice);
});

test('a text-only model receives zero image parts and an unsupported-input notice', () => {
  const messages: any[] = [
    toolResult('c1', 'computer', ['a', 'b']),
    user('u1', [image('u-a')]),
  ];
  const result = projectImageContext(messages, { policy: policy(0), model: MODEL });

  assert.equal(imageIds(result.messages).length, 0);
  assert.ok(result.notice);
  assert.match(result.notice, /\[Pie image delivery\]/);
  assert.match(result.notice, /3 session images were omitted because the active model/);
  assert.match(result.notice, /does not accept image input/);
  assert.match(result.notice, /Do not infer their contents/);
});

test('read, computer, user, and custom-tool images all count toward the same total', () => {
  const messages: any[] = [
    user('u1', [image('user-1')]),
    toolResult('r1', 'read', ['read-1']),
    toolResult('c1', 'computer', ['comp-1']),
    toolResult('x1', 'custom-tool', ['custom-1']),
  ];
  // model max = 2: only the two newest images survive, regardless of producer.
  const result = projectImageContext(messages, { policy: policy(2), model: MODEL });
  assert.deepEqual(imageIds(result.messages), ['comp-1', 'custom-1']);
});

test('the computer newest-three bound and the total model rule compose correctly', () => {
  // Five computer screenshots: newest-three keeps the last three; the model
  // max of two then retains the two newest of those.
  const messages: any[] = [
    toolResult('c1', 'computer', ['comp-1', 'comp-2']),
    toolResult('c2', 'computer', ['comp-3', 'comp-4', 'comp-5']),
  ];
  const result = projectImageContext(messages, { policy: policy(2), model: MODEL });
  assert.deepEqual(imageIds(result.messages), ['comp-4', 'comp-5']);
  // omitted = 5 (original) - 2 (final) = 3, reported by the notice.
  assert.match(result.notice!, /3 older session images were omitted/);
});

test('switching models reprojects the same session against the new maximum', () => {
  const messages: any[] = [
    toolResult('c1', 'computer', ['a', 'b', 'c']),
    user('u1', [image('u-a')]),
  ];
  // Model A: max 4 — everything retained.
  const a = projectImageContext(messages, { policy: policy(4), model: { provider: 'p', id: 'A' } });
  assert.equal(imageIds(a.messages).length, 4);
  assert.equal(a.notice, undefined);
  // Model B: max 1 — only the newest image survives.
  const b = projectImageContext(messages, { policy: policy(1), model: { provider: 'p', id: 'B' } });
  assert.deepEqual(imageIds(b.messages), ['u-a']);
  // The durable session is unchanged; both projections derive from the same input.
  assert.deepEqual(imageIds(messages), ['a', 'b', 'c', 'u-a']);
  // Switching to a text-only model projects zero images.
  const textOnly = projectImageContext(messages, { policy: policy(0), model: { provider: 'p', id: 'C' } });
  assert.equal(imageIds(textOnly.messages).length, 0);
});

test('a runtime image-capable model absent from the policy gets the fail-safe one and a diagnostic', () => {
  const messages: any[] = [
    toolResult('c1', 'computer', ['a', 'b']),
    user('u1', [image('u-a')]),
  ];
  const result = projectImageContext(messages, {
    policy: { maxImagesPerRequest: 1, configured: false },
    model: { provider: 'github-copilot', id: 'unconfigured-vision' },
  });
  // fail-safe max 1: only the newest image survives.
  assert.deepEqual(imageIds(result.messages), ['u-a']);
  assert.ok(result.notice);
  assert.match(result.notice, /\[Pie image policy\]/);
  assert.match(result.notice, /no configured maxImagesPerRequest/);
  assert.match(result.notice, /fail-safe of 1 image per request/);
  assert.match(result.notice, /Add maxImagesPerRequest to models.yaml/);
  // Even with no omission, the diagnostic fires for the unconfigured model.
  const single = projectImageContext([user('u1', [image('only')])] as any, {
    policy: { maxImagesPerRequest: 1, configured: false },
    model: { provider: 'github-copilot', id: 'unconfigured-vision' },
  });
  assert.deepEqual(imageIds(single.messages), ['only']);
  assert.match(single.notice!, /no configured maxImagesPerRequest/);
});

test('computer-source and total-model limits apply in deterministic order and the notice reports the final omitted count', () => {
  // 4 computer screenshots (newest-three drops 1) + 1 user image = 5 original.
  // Model max 3: after the computer pass 3 remain; the total pass keeps the 3
  // newest overall (2 computer + 1 user). Final omitted = 5 - 3 = 2.
  const messages: any[] = [
    toolResult('c1', 'computer', ['comp-1']),
    toolResult('c2', 'computer', ['comp-2', 'comp-3', 'comp-4']),
    user('u1', [image('user-1')]),
  ];
  const result = projectImageContext(messages, { policy: policy(3), model: MODEL });
  assert.deepEqual(imageIds(result.messages), ['comp-3', 'comp-4', 'user-1']);
  assert.match(result.notice!, /2 older session images were omitted/);
});

test('projection is idempotent and notices do not accumulate', () => {
  const messages: any[] = [
    toolResult('c1', 'computer', ['a', 'b', 'c', 'd']),
  ];
  const first = projectImageContext(messages, { policy: policy(1), model: MODEL });
  // Re-projecting the projected context does not add a second notice: only one
  // image remains and no further omission occurs.
  const second = projectImageContext(first.messages, { policy: policy(1), model: MODEL });
  assert.equal(second.notice, undefined);
  assert.deepEqual(imageIds(second.messages), ['d']);
  // The first projection carried exactly one notice.
  const notices = first.messages.filter((m: any) => m?.role === 'custom' && m?.customType === 'pie-image-context');
  assert.equal(notices.length, 1);
});

test('countImages counts image parts across all producers', () => {
  const messages: any[] = [
    user('u1', [text('hi'), image('u-1'), image('u-2')]),
    toolResult('c1', 'computer', ['c-1']),
    { role: 'assistant', timestamp: 0, content: [text('thinking')] },
  ];
  assert.equal(countImages(messages), 3);
});
