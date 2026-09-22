import assert from 'node:assert/strict';
import test from 'node:test';
import { resizeComposerTextarea } from '../../../src/webview/panel/composer/hooks';

test('composer only enables native scrolling after reaching its height cap', () => {
  const textarea = { style: { height: '', overflowY: '' }, scrollHeight: 17 };
  const resize = () => resizeComposerTextarea(textarea as unknown as HTMLTextAreaElement);
  resize();
  assert.equal(textarea.style.height, '17px');
  assert.equal(textarea.style.overflowY, 'hidden');

  textarea.scrollHeight = 200;
  resize();
  assert.equal(textarea.style.overflowY, 'hidden');

  textarea.scrollHeight = 260;
  resize();
  assert.equal(textarea.style.height, '200px');
  assert.equal(textarea.style.overflowY, 'auto');

  textarea.scrollHeight = 17;
  resize();
  assert.equal(textarea.style.overflowY, 'hidden');
});
