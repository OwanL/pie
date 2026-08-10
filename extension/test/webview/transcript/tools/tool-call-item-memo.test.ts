import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { installDom } from '../../../_helpers/dom';
installDom();

import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import renderToString from 'preact-render-to-string';

import { DEFAULT_CHAT_PREFS, type ChatPrefs, type ExtensionUIRequestPayload, type ToolCall } from '../../../../src/shared/protocol';
import { AskUserContext } from '../../../../src/webview/panel/hooks/ask-user-context';
import { registerToolRenderer } from '../../../../src/webview/panel/transcript/registry';
import { SubagentToolRenderer, ToolCallItem } from '../../../../src/webview/panel/transcript/tool-call-item';
import type { RenderToolCall, TranscriptContextMenuHandler } from '../../../../src/webview/panel/transcript/types';
import { pickStable } from '../../../../src/webview/panel/utils/view-state-stabilize';
import '../../../../src/webview/panel/transcript/register-builtins';

const noop = () => undefined;
const noopContextMenu: TranscriptContextMenuHandler = () => undefined;
const noopRenderToolCall: RenderToolCall = () => null;
const prefs: ChatPrefs = { ...DEFAULT_CHAT_PREFS };
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

function mountTool(toolCall: ToolCall, renderPrefs: ChatPrefs = prefs): void {
  act(() => {
    render(h(ToolCallItem, {
      toolCall,
      prefs: renderPrefs,
      workingDirectory: '/repo',
      onOpenFile: noop,
      onContextMenu: noopContextMenu,
      renderToolCall: noopRenderToolCall,
    }), container);
  });
}

test('ToolCallItem holds its memo barrier across host-style cloned prefs after stabilization', () => {
  let bodyRenders = 0;
  registerToolRenderer('memo-probe-cloned-prefs', () => {
    bodyRenders += 1;
    return h('span', null, 'cloned prefs');
  });
  const completed: ToolCall = {
    id: 'memo-cloned-prefs',
    name: 'memo-probe-cloned-prefs',
    input: {},
    result: { output: 'done' },
    status: 'completed',
  };
  const stablePrefs: ChatPrefs = structuredClone({
    ...DEFAULT_CHAT_PREFS,
    subagentBuckets: {
      small: [{ model: 'test/small-model', thinkingLevel: 'low' }],
      medium: [],
      frontier: [],
    },
    subagentProviderTogglesBySession: { '/session/a': { openai: true } },
    providerConcurrency: { openai: { maxConcurrentRequests: 2 } },
  });
  const equivalentPrefs = pickStable(stablePrefs, structuredClone(stablePrefs));

  mountTool(completed, stablePrefs);
  mountTool(structuredClone(completed), equivalentPrefs);
  assert.equal(bodyRenders, 1, 'equivalent hydrated prefs must not reopen the heavy tool body');

  const changedCandidate = structuredClone(stablePrefs);
  changedCandidate.subagentBuckets.medium.push({ model: 'test/medium-model', thinkingLevel: 'medium' });
  const changedPrefs = pickStable(stablePrefs, changedCandidate);
  mountTool(structuredClone(completed), changedPrefs);
  assert.equal(bodyRenders, 2, 'a nested preference change must cross the tool memo barrier');
});

test('ToolCallItem skips equivalent structured clones and rerenders visible lifecycle changes', () => {
  let bodyRenders = 0;
  registerToolRenderer('memo-probe-terminal', ({ toolCall }) => {
    bodyRenders += 1;
    return h('span', { class: 'memo-probe' }, `${toolCall.status}:${toolCall.seq}`);
  });
  const completed: ToolCall = {
    id: 'memo-terminal',
    name: 'memo-probe-terminal',
    input: { command: 'done' },
    result: { output: 'done' },
    status: 'completed',
    seq: 7,
  };

  mountTool(completed);
  mountTool(structuredClone(completed));
  assert.equal(bodyRenders, 1);

  mountTool({ ...completed, status: 'failed', seq: 8 });
  assert.equal(bodyRenders, 2);
  assert.equal(container.querySelector('.memo-probe')?.textContent, 'failed:8');
});

test('ToolCallItem uses seq as the live revision and fails open for unsequenced running calls', () => {
  let sequencedRenders = 0;
  registerToolRenderer('memo-probe-sequenced', () => {
    sequencedRenders += 1;
    return h('span', null, 'sequenced');
  });
  const sequenced: ToolCall = {
    id: 'memo-sequenced',
    name: 'memo-probe-sequenced',
    input: {},
    result: { progress: 'one' },
    status: 'running',
    seq: 10,
  };
  mountTool(sequenced);
  mountTool(structuredClone(sequenced));
  assert.equal(sequencedRenders, 1);
  mountTool({ ...sequenced, result: { progress: 'two' }, seq: 11 });
  assert.equal(sequencedRenders, 2);

  let legacyRenders = 0;
  registerToolRenderer('memo-probe-legacy', () => {
    legacyRenders += 1;
    return h('span', null, 'legacy');
  });
  const legacy: ToolCall = {
    id: 'memo-legacy',
    name: 'memo-probe-legacy',
    input: {},
    result: { progress: 'one' },
    status: 'running',
  };
  mountTool(legacy);
  mountTool(structuredClone(legacy));
  assert.equal(legacyRenders, 2, 'running calls without producer revisions must rerender defensively');
});

test('ToolCallItem memo does not block ask-user context updates inside subagent cards', () => {
  const toolCall: ToolCall = {
    id: 'memo-context-subagent',
    name: 'subagent',
    input: { agent: 'worker', task: 'wait for input' },
    result: {
      details: {
        results: [{
          agent: 'worker',
          task: 'wait for input',
          exitCode: -1,
          messages: [],
          activityPhase: 'waiting_provider',
        }],
      },
    },
    status: 'running',
    seq: 20,
  };
  const contextBase = {
    sessionPath: '/repo/session.jsonl',
    postMessage: noop,
    registerInlineRequest: noop,
    unregisterInlineRequest: noop,
  };
  const mountWithRequests = (pendingRequests: Record<string, ExtensionUIRequestPayload>) => {
    act(() => {
      render(h(AskUserContext.Provider, {
        value: { ...contextBase, pendingRequests },
        children: h(ToolCallItem, {
          toolCall: structuredClone(toolCall),
          prefs,
          workingDirectory: '/repo',
          onOpenFile: noop,
          onContextMenu: noopContextMenu,
          renderToolCall: noopRenderToolCall,
        }),
      }), container);
    });
  };

  mountWithRequests({});
  assert.equal(container.querySelector('.pending-ask-user'), null);
  mountWithRequests({
    request: {
      id: 'request',
      sessionPath: '/repo/session.jsonl',
      method: 'confirm',
      title: 'Continue?',
      message: 'Continue?',
      subagentCallId: toolCall.id,
    },
  });
  assert.ok(container.querySelector('.pending-ask-user'));
});

test('expanded running subagents do not also traverse the collapsed preview', () => {
  let streamingTextReads = 0;
  const singleResult: Record<string, unknown> = {
    agent: 'worker',
    task: 'inspect the repository',
    exitCode: -1,
    messages: [],
    streaming: true,
    activityPhase: 'streaming',
  };
  Object.defineProperty(singleResult, 'streamingText', {
    enumerable: true,
    get: () => {
      streamingTextReads += 1;
      return 'live child output';
    },
  });
  const toolCall: ToolCall = {
    id: 'expanded-preview-probe',
    name: 'subagent',
    input: { agent: 'worker', task: 'inspect the repository' },
    result: { details: { results: [singleResult] } },
    status: 'running',
    seq: 1,
  };

  renderToString(h(SubagentToolRenderer, {
    toolCall,
    prefs: { ...prefs, autoExpandSubagentCalls: true },
    workingDirectory: '/repo',
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: noopRenderToolCall,
  }));

  assert.equal(streamingTextReads, 3, 'status, activity, and expanded transcript each read once');
});
