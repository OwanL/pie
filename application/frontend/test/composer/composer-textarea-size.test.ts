import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resizeComposerTextarea } from '../../composer/hooks';

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

test('mobile composer yields height to the keyboard without changing draft or selection', () => {
  const textarea = { style: { height: '', overflowY: '' }, scrollHeight: 500, value: 'a long draft', selectionStart: 4, selectionEnd: 4 };
  for (const [visibleHeight, height] of [[844, 200], [400, 100], [320, 80], [120, 48], [844, 200]]) {
    resizeComposerTextarea(textarea as unknown as HTMLTextAreaElement, visibleHeight);
    assert.equal(textarea.style.height, `${height}px`);
    assert.equal(textarea.style.overflowY, 'auto');
    assert.equal(textarea.value, 'a long draft');
    assert.equal(textarea.selectionStart, 4);
    assert.equal(textarea.selectionEnd, 4);
  }
  textarea.scrollHeight = 24;
  resizeComposerTextarea(textarea as unknown as HTMLTextAreaElement, 320);
  assert.equal(textarea.style.height, '24px');
  assert.equal(textarea.style.overflowY, 'hidden');
});

test('default mobile measurement follows keyboard height but ignores pinch zoom and fine pointers', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let coarse = true;
  const mockWindow = { innerHeight: 800, matchMedia: () => ({ matches: coarse }), visualViewport: { height: 400, scale: 1 } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: mockWindow });
  try {
    const textarea = { style: { height: '', overflowY: '' }, scrollHeight: 500 };
    resizeComposerTextarea(textarea as unknown as HTMLTextAreaElement);
    assert.equal(textarea.style.height, '100px', 'unscaled keyboard height governs mobile cap');
    mockWindow.visualViewport.scale = 2;
    resizeComposerTextarea(textarea as unknown as HTMLTextAreaElement);
    assert.equal(textarea.style.height, '200px', 'zoomed visual height must not shrink the typing area');
    coarse = false;
    mockWindow.visualViewport.scale = 1;
    resizeComposerTextarea(textarea as unknown as HTMLTextAreaElement);
    assert.equal(textarea.style.height, '200px', 'desktop cap stays unchanged');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('invalid viewport measurements retain the existing composer height cap', () => {
  const textarea = { style: { height: '', overflowY: '' }, scrollHeight: 500 };
  for (const height of [0, -1, NaN, Infinity]) {
    resizeComposerTextarea(textarea as unknown as HTMLTextAreaElement, height);
    assert.equal(textarea.style.height, '200px');
  }
});

test('touch typography and controls preserve desktop sizing and larger user fonts', async () => {
  const composerCss = await readFile(new URL('../../styles/composer.css', import.meta.url), 'utf8');
  const indexCss = await readFile(new URL('../../styles/index.css', import.meta.url), 'utf8');
  assert.match(composerCss, /@media \(pointer: coarse\)[\s\S]*?font-size: max\(16px, var\(--panel-composer-font-size, 11px\)\)/);
  assert.match(composerCss, /@media \(pointer: coarse\)[\s\S]*?\.composer-actions \.composer-action-icon\s*\{[^}]*width: 44px;[^}]*height: 44px;/);
  assert.match(indexCss, /@media \(pointer: coarse\)\s*\{\s*\.message-body,\s*\.message-prose \{ font-size: max\(14px, var\(--panel-font-size, 11px\)\)/);
});
