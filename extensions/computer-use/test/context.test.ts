import assert from 'node:assert/strict';
import test from 'node:test';

import { COMPUTER_CONTEXT_IMAGE_LIMIT, projectComputerImageContext } from '../src/context.js';

const text = (value: string) => ({ type: 'text', text: value });
const image = (id: string) => ({ type: 'image', data: id, mimeType: 'image/png' });
const computer = (id: string, images: string[]) => ({
  role: 'toolResult', toolCallId: id, toolName: 'computer', isError: false, timestamp: 0,
  content: [text(`computer observe: ok\nfull_png: C:/artifacts/${id}.png`), ...images.map(image)],
});

function computerImages(messages: any[]): string[] {
  return messages.flatMap((message) => message.role === 'toolResult' && message.toolName === 'computer'
    ? message.content.filter((part: any) => part.type === 'image').map((part: any) => part.data)
    : []);
}

test('projects only the newest three computer image parts without changing transcript messages', () => {
  const oldest = computer('oldest', ['oldest-1', 'oldest-2']);
  const middle = computer('middle', ['middle-1', 'middle-2']);
  const newest = computer('newest', ['newest-1', 'newest-2', 'newest-3', 'newest-4']);
  const otherTool = { role: 'toolResult', toolCallId: 'other', toolName: 'read', isError: false, timestamp: 0, content: [text('read result'), image('read-image')] };
  const user = { role: 'user', timestamp: 0, content: [text('user attachment'), image('user-image')] };
  const messages: any[] = [oldest, otherTool, middle, user, newest];
  const original = structuredClone(messages);

  const projected = projectComputerImageContext(messages as any);

  assert.deepEqual(computerImages(projected), ['newest-2', 'newest-3', 'newest-4'], 'multiple image parts retain the latest three across the context');
  assert.deepEqual((projected as any[])[0].content, [text('computer observe: ok\nfull_png: C:/artifacts/oldest.png')], 'older computer observations retain text and artifact paths');
  assert.deepEqual((projected as any[])[2].content, [text('computer observe: ok\nfull_png: C:/artifacts/middle.png')]);
  assert.deepEqual((projected as any[])[4].content.map((part: any) => part.data ?? part.text), [
    'computer observe: ok\nfull_png: C:/artifacts/newest.png', 'newest-2', 'newest-3', 'newest-4',
  ]);
  assert.strictEqual(projected[1], otherTool, 'non-computer messages are unchanged');
  assert.strictEqual(projected[3], user, 'non-computer images are unchanged');
  assert.deepEqual(messages, original, 'input messages remain unchanged');
  assert.deepEqual(projectComputerImageContext(projected), projected, 'projection is idempotent');
});

test('a twenty-observation context sends at most three computer images', () => {
  const messages = Array.from({ length: 20 }, (_, index) => computer(`observe-${index}`, [`image-${index}`]));
  const projected = projectComputerImageContext(messages as any);

  assert.equal(COMPUTER_CONTEXT_IMAGE_LIMIT, 3);
  assert.deepEqual(computerImages(projected), ['image-17', 'image-18', 'image-19']);
  assert.ok(computerImages(projected).length <= 3);
  for (const message of (projected as any[]).slice(0, -3)) assert.deepEqual(message.content.map((part: any) => part.type), ['text']);
});
