import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { Collapsible } from '../../../src/webview/panel/components/collapsible.tsx';
import { ToolCallCard } from '../../../src/webview/panel/transcript/tool-call-card.tsx';
import { SubagentToolRenderer } from '../../../src/webview/panel/transcript/tool-call-item.tsx';
import { ToolCallItem } from '../../../src/webview/panel/transcript/tool-call-item.tsx';
import '../../../src/webview/panel/transcript/register-builtins.ts';
import { clearCollapsibleCache } from '../../../src/webview/panel/transcript/use-collapsible-open';
import { DEFAULT_CHAT_PREFS, type ChatPrefs, type ToolCall } from '../../../src/shared/protocol';
import type { RenderToolCall, TranscriptContextMenuHandler } from '../../../src/webview/panel/transcript/types';

const noop = () => undefined;
const noopContextMenu: TranscriptContextMenuHandler = () => undefined;
let container: HTMLElement;

beforeEach(() => {
  clearCollapsibleCache();
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => { render(null, container); container.remove(); };
});

test('Collapsible: open header references the body via aria-controls; body carries the matching id', () => {
  let open = true;
  act(() => {
    render(
      h(Collapsible, {
        open,
        onToggle: (v) => { open = v; },
        ariaLabel: 'Details',
        header: 'Details',
        children: h('p', { id: 'x' }, 'body content'),
      }),
      container,
    );
  });
  const header = container.querySelector('.collapsible-header') as HTMLElement;
  const body = container.querySelector('.collapsible-body') as HTMLElement;
  assert.ok(header, 'header button present');
  assert.ok(body, 'body present when open');
  const controls = header.getAttribute('aria-controls');
  assert.ok(controls, 'open header has aria-controls');
  assert.equal(body.getAttribute('id'), controls, 'body id matches aria-controls');
  assert.equal(header.getAttribute('aria-expanded'), 'true');
});

test('Collapsible: collapsed header omits aria-controls (body is not mounted)', () => {
  let open = false;
  act(() => {
    render(
      h(Collapsible, {
        open,
        onToggle: (v) => { open = v; },
        ariaLabel: 'Details',
        header: 'Details',
        children: 'body content',
      }),
      container,
    );
  });
  const header = container.querySelector('.collapsible-header') as HTMLElement;
  assert.ok(header);
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  assert.ok(!header.getAttribute('aria-controls'), 'collapsed header has no aria-controls (body unmounted)');
  assert.ok(!container.querySelector('.collapsible-body'), 'body not mounted when collapsed');
});

test('ToolCallCard: header aria-controls references the mounted body-wrap id', () => {
  const toolCall: ToolCall = {
    id: 'tc-read',
    name: 'read',
    input: { path: '/repo/README.md' },
    result: 'contents',
    status: 'completed',
    durationMs: 12,
  };
  act(() => {
    render(
      h(ToolCallCard, {
        toolCall,
        autoExpand: true,
        workingDirectory: '/repo',
        onOpenFile: noop,
        onContextMenu: noop,
      }),
      container,
    );
  });
  const header = container.querySelector('.tool-call-header') as HTMLElement;
  const body = container.querySelector('.tool-call-body-wrap') as HTMLElement;
  assert.ok(header && body, 'header and body mounted when open');
  const controls = header.getAttribute('aria-controls');
  assert.ok(controls, 'open tool-call header has aria-controls');
  assert.equal(body.getAttribute('id'), controls, 'body-wrap id matches aria-controls');
});

test('SubagentSingleBlock: open header aria-controls references the mounted body id', () => {
  const prefs: ChatPrefs = { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: true };
  const tc: ToolCall = {
    id: 'sub_aria',
    name: 'subagent',
    input: { agent: 'worker', task: 'do the thing' },
    status: 'completed',
    result: { details: { results: [{ agent: 'worker', task: 'do the thing', exitCode: 0, messages: [
      { role: 'assistant', content: 'working' },
    ] }] } },
  };
  function rtc(toolCall: ToolCall, cm: TranscriptContextMenuHandler) {
    return h(ToolCallItem, { toolCall, prefs, workingDirectory: '/repo', onOpenFile: noop, onContextMenu: cm, renderToolCall: rtc });
  }
  act(() => {
    render(
      h(SubagentToolRenderer, { toolCall: tc, prefs, workingDirectory: '/repo', onOpenFile: noop, onContextMenu: noopContextMenu, renderToolCall: rtc }),
      container,
    );
  });
  const header = container.querySelector('.subagent-header') as HTMLElement;
  const body = container.querySelector('.subagent-messages') as HTMLElement;
  assert.ok(header && body, 'header and body mounted when auto-expanded');
  const controls = header.getAttribute('aria-controls');
  assert.ok(controls, 'open subagent header has aria-controls');
  assert.equal(body.getAttribute('id'), controls, 'subagent body id matches aria-controls');
  assert.equal(header.getAttribute('aria-expanded'), 'true');
});

test('SubagentSingleBlock: collapsed header omits aria-controls (body unmounted)', () => {
  const prefs: ChatPrefs = { ...DEFAULT_CHAT_PREFS, autoExpandSubagentCalls: false };
  const tc: ToolCall = {
    id: 'sub_aria_collapsed',
    name: 'subagent',
    input: { agent: 'worker', task: 'do the thing' },
    status: 'completed',
    result: { details: { results: [{ agent: 'worker', task: 'do the thing', exitCode: 0, messages: [
      { role: 'assistant', content: 'working' },
    ] }] } },
  };
  function rtc(toolCall: ToolCall, cm: TranscriptContextMenuHandler) {
    return h(ToolCallItem, { toolCall, prefs, workingDirectory: '/repo', onOpenFile: noop, onContextMenu: cm, renderToolCall: rtc });
  }
  act(() => {
    render(
      h(SubagentToolRenderer, { toolCall: tc, prefs, workingDirectory: '/repo', onOpenFile: noop, onContextMenu: noopContextMenu, renderToolCall: rtc }),
      container,
    );
  });
  const header = container.querySelector('.subagent-header') as HTMLElement;
  assert.ok(header);
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  assert.ok(!header.getAttribute('aria-controls'), 'collapsed subagent header has no aria-controls');
  assert.ok(!container.querySelector('.subagent-messages'), 'body not mounted when collapsed');
});