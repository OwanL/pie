import assert from 'node:assert/strict';
import test from 'node:test';

import { render as renderDom } from 'preact';
import { act } from 'preact/test-utils';
import { installDom } from '../../helpers/dom';
installDom();

import { DEFAULT_CHAT_PREFS, type ToolCall } from '../../../../lib/protocol/index.js';
import { MARKDOWN_FILE_PATH_ATTRIBUTE } from '../../../transcript/markdown-file-path';
import type { TranscriptContextMenuHandler } from '../../../transcript/types';

// Trigger side-effect renderer registration and exercise its actual default renderer.
require('../../../transcript/register-builtins');
const registryModule: typeof import('../../../transcript/registry') =
  require('../../../transcript/registry');

function toolCall(): ToolCall {
  return {
    id: 'tool-file-menu',
    name: 'unregistered_file_tool',
    input: { path: 'src/main.ts' },
    result: { content: [{ type: 'text', text: 'done' }] },
    status: 'completed',
  };
}

function mountDefaultTool(workingDirectory: string | null, onContextMenu: TranscriptContextMenuHandler) {
  const Renderer = registryModule.getToolRenderer('__default');
  assert.ok(Renderer, 'default renderer should be registered');
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => renderDom(Renderer({
    toolCall: toolCall(),
    prefs: DEFAULT_CHAT_PREFS,
    workingDirectory,
    onOpenFile: () => undefined,
    onContextMenu,
    renderToolCall: () => null,
  }), container));
  const toggle = container.querySelector('.tool-call-toggle') as HTMLButtonElement | null;
  assert.ok(toggle, 'default renderer should render the tool-card toggle');
  act(() => toggle.click());
  return { container, toggle };
}

function contextMenu(target: EventTarget): void {
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

test('default tool file-path right-click opens the file menu with the full path and captured cwd', () => {
  const calls: Parameters<TranscriptContextMenuHandler>[] = [];
  const { container, toggle } = mountDefaultTool('/repo', (...args) => calls.push(args));
  const fullPath = '/repo/src/main.ts';
  toggle.setAttribute(MARKDOWN_FILE_PATH_ATTRIBUTE, fullPath);

  contextMenu(toggle);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'filePath');
  assert.equal(calls[0][1], fullPath);
  assert.equal(calls[0][4]?.reference, fullPath);
  assert.equal(calls[0][4]?.workingDirectory, '/repo');
  container.remove();
});

test('default tool context-menu elsewhere retains raw tool JSON', () => {
  const calls: Parameters<TranscriptContextMenuHandler>[] = [];
  const { container } = mountDefaultTool('/repo', (...args) => calls.push(args));
  const card = container.querySelector('.tool-call-card') as HTMLElement | null;
  assert.ok(card, 'default renderer should render the tool card');
  contextMenu(card);

  assert.equal(calls.length, 1);
  assert.notEqual(calls[0][0], 'filePath');
  assert.equal(calls[0][1], JSON.stringify(toolCall(), null, 2));
  container.remove();
});

test('default tool file-path right-click resolves Windows-relative paths against the session cwd', () => {
  const calls: Parameters<TranscriptContextMenuHandler>[] = [];
  const { container, toggle } = mountDefaultTool('C:\\repo\\workspace', (...args) => calls.push(args));
  toggle.setAttribute(MARKDOWN_FILE_PATH_ATTRIBUTE, 'src\\main.ts');

  contextMenu(toggle);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'filePath');
  assert.equal(calls[0][1], 'C:\\repo\\workspace\\src\\main.ts');
  assert.equal(calls[0][4]?.reference, 'src\\main.ts');
  assert.equal(calls[0][4]?.workingDirectory, 'C:\\repo\\workspace');
  container.remove();
});

test('keyboard-origin contextmenu on the tool toggle uses the file-path menu', () => {
  const calls: Parameters<TranscriptContextMenuHandler>[] = [];
  const { container, toggle } = mountDefaultTool('/repo', (...args) => calls.push(args));
  toggle.setAttribute(MARKDOWN_FILE_PATH_ATTRIBUTE, '/repo/src/main.ts');

  // Browsers dispatch contextmenu at the focused toggle for the Context Menu key / Shift+F10.
  contextMenu(toggle);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'filePath');
  assert.equal(calls[0][1], '/repo/src/main.ts');
  container.remove();
});
