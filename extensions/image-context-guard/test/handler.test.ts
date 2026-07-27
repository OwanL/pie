import assert from 'node:assert/strict';
import test from 'node:test';

import { buildImagePolicy, policyKey } from '../src/policy.js';
import { projectContextHandler } from '../src/handler.js';

const text = (value: string) => ({ type: 'text', text: value });
const image = (id: string) => ({ type: 'image', data: id, mimeType: 'image/png' });

const user = (parts: any[]) => ({ role: 'user', timestamp: 0, content: parts });
const computer = (id: string, images: string[]) => ({
  role: 'toolResult', toolCallId: id, toolName: 'computer', isError: false, timestamp: 0,
  content: [text(`observe: ${id}`), ...images.map(image)],
});

function imageCount(messages: any[]): number {
  return messages.flatMap((m) => Array.isArray(m?.content)
    ? m.content.filter((p: any) => p.type === 'image')
    : []).length;
}

const POLICY_CATALOG = {
  providers: {
    'github-copilot': {
      models: [{ id: 'claude-sonnet-5', input: ['text', 'image'], maxImagesPerRequest: 2 }],
    },
    ollama: {
      models: [{ id: 'text-only', input: ['text'] }],
    },
  },
};
const POLICY = buildImagePolicy(POLICY_CATALOG as any);

const imageModel = { provider: 'github-copilot', id: 'claude-sonnet-5', input: ['text', 'image'] };
const textModel = { provider: 'ollama', id: 'text-only', input: ['text'] };

test('handler returns undefined when there are no images (hot-path short-circuit)', () => {
  const messages: any[] = [user([text('hi')]), { role: 'assistant', timestamp: 0, content: [text('hello')] }];
  assert.equal(projectContextHandler(messages, imageModel, POLICY), undefined);
});

test('handler fails closed when no provider-qualified active model can be resolved', () => {
  const messages: any[] = [user([image('a')])];
  const result = projectContextHandler(messages, undefined, POLICY);
  assert.ok(result);
  assert.equal(imageCount(result.messages), 0);
  assert.equal(imageCount(messages), 1, 'durable input remains unchanged');
  assert.match(String((result.messages[result.messages.length - 1] as any).content), /could not resolve the active provider-qualified model/);
});

test('a provider never observes more images than the configured maximum', () => {
  // Six images across computer + user; the configured maximum is two.
  const messages: any[] = [
    computer('c1', ['a', 'b', 'c']),
    computer('c2', ['d', 'e']),
    user([image('u1')]),
  ];
  const result = projectContextHandler(messages, imageModel, POLICY);
  assert.ok(result, 'the handler should project and append a notice');
  assert.ok(imageCount(result.messages) <= 2, 'projected image count must not exceed the configured maximum');
  assert.equal(imageCount(result.messages), 2);
  // newest-first: the two newest survive.
  assert.deepEqual(
    result.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'image').map((p: any) => p.data) : []),
    ['e', 'u1'],
  );
  // the durable input is untouched.
  assert.equal(imageCount(messages), 6);
});

test('handler omits all images for a text-only active model and appends an unsupported-input notice', () => {
  const messages: any[] = [computer('c1', ['a', 'b']), user([image('u1')])];
  const result = projectContextHandler(messages, textModel, POLICY);
  assert.ok(result);
  assert.equal(imageCount(result.messages), 0);
  const notice = result.messages[result.messages.length - 1] as any;
  assert.equal(notice.role, 'custom');
  assert.match(String(notice.content), /\[Pie image delivery\]/);
});

test('handler falls back to the fail-safe one and diagnostic for an unconfigured image model', () => {
  const unconfigured = { provider: 'github-copilot', id: 'brand-new-vision', input: ['text', 'image'] };
  const messages: any[] = [computer('c1', ['a', 'b', 'c'])];
  const result = projectContextHandler(messages, unconfigured, POLICY);
  assert.ok(result);
  // fail-safe max 1: only the newest image survives.
  assert.equal(imageCount(result.messages), 1);
  const notice = result.messages[result.messages.length - 1] as any;
  assert.match(String(notice.content), /\[Pie image policy\]/);
  assert.match(String(notice.content), /no configured maxImagesPerRequest/);
});

test('handler is unaffected by an empty policy map (text-only resolves to zero)', () => {
  const empty = new Map<string, number>();
  const messages: any[] = [user([image('a')])];
  // A model with image input and no policy entry -> fail-safe one image + diagnostic.
  const imageResult = projectContextHandler(messages, imageModel, empty);
  assert.ok(imageResult);
  assert.equal(imageCount(imageResult.messages), 1);
  // A text-only model -> zero images (text-only is configured even with an empty map).
  const textResult = projectContextHandler(messages, textModel, empty);
  assert.ok(textResult);
  assert.equal(imageCount(textResult.messages), 0);
});

test('policyKey is provider-qualified so a duplicate id is never confused', () => {
  // 'claude-sonnet-5' exists only under github-copilot in POLICY; a same-id
  // model under another provider must not inherit the copilot maximum.
  assert.equal(POLICY.get(policyKey('ollama', 'claude-sonnet-5')), undefined);
  assert.equal(POLICY.get(policyKey('github-copilot', 'claude-sonnet-5')), 2);
});
