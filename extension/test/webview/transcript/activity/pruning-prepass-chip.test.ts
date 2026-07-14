/**
 * Brief F — Pruning prepass UX now lives inside the agent reply.
 *
 * The bottom status chip is removed. While the prepass is running, the
 * placeholder assistant row shows a pending "pruning skills/tools" chip with a
 * Cancel button that reuses Brief E's interrupt dispatch.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../../_helpers/dom';
installDom();

// Stub DOMPurify before any component imports
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { App, EMPTY_VIEW_STATE } from '../../../../src/webview/panel/app';
import type { AppAdapter } from '../../../../src/webview/panel/app';
import type { ViewState, ChatMessage } from '../../../../src/shared/protocol';
import { EMPTY_TRANSCRIPT_WINDOW } from '../../../../src/shared/protocol';
import { PruningHeaderChip } from '../../../../src/webview/panel/transcript/pruning-header';

function makeAdapter(): AppAdapter & { messages: any[] } {
  const messages: any[] = [];
  return { messages, postMessage: (msg: any) => messages.push(msg) };
}

function sessionViewState(overrides: Partial<ViewState> = {}): ViewState {
  return {
    ...EMPTY_VIEW_STATE,
    backendReady: true,
    openTabPaths: ['/session/a'],
    activeSession: {
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 2,
    },
    transcript: [
      {
        id: 'user-1',
        role: 'user',
        createdAt: '2026-01-01T12:00:00.000Z',
        markdown: 'Hello world',
        status: 'completed',
      } as ChatMessage,
    ],
    transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW, hasNewer: false, hasOlder: false },
    transcriptLoaded: true,
    ...overrides,
  };
}

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  container.id = 'app';
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

test('Brief F: no bottom prepass chip while phase is idle', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState({ prepassPhase: 'idle', prepassStartedAt: null });

  act(() => {
    render(h(App, { adapter }), container);
  });

  assert.equal(container.querySelector('.prepass-status-chip'), null, 'no bottom chip while idle');
});

test('Brief F: running prepass does not render a bottom status chip', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState({ prepassPhase: 'running', prepassStartedAt: 5_000, busy: true });

  act(() => {
    render(h(App, { adapter }), container);
  });

  assert.equal(container.querySelector('.prepass-status-chip'), null, 'bottom chip removed even while running');
});

test('Brief F: agent-reply pruning chip renders a pending state with Cancel', () => {
  let clicked = false;
  act(() => {
    render(
      h(PruningHeaderChip, {
        state: { kind: 'pending', label: 'pruning skills/tools' },
        expanded: false,
        onToggle: () => {},
        onCancel: () => {
          clicked = true;
        },
      }),
      container,
    );
  });

  const pendingChip = container.querySelector('.panel-chip-pruning-pending');
  assert.ok(pendingChip, 'pending pruning chip renders');
  assert.match(pendingChip!.textContent!, /pruning skills\/tools/i);

  const cancelBtn = container.querySelector('[aria-label="Cancel pruning prepass"]') as HTMLButtonElement;
  assert.ok(cancelBtn, 'Cancel affordance present on the agent-reply pruning chip');

  act(() => {
    cancelBtn.click();
  });
  assert.equal(clicked, true, 'Cancel invokes the provided handler');
});

test('Brief F: completed pruning result chip still renders without Cancel', () => {
  act(() => {
    render(
      h(PruningHeaderChip, {
        state: {
          kind: 'result',
          details: {
            includedSkills: ['skill-a'],
            excludedSkills: [],
            includedTools: ['tool-a'],
            excludedTools: [],
            mode: 'auto',
            skillTokensSaved: 0,
            toolTokensSaved: 0,
          } as any,
        },
        expanded: false,
        onToggle: () => {},
      }),
      container,
    );
  });

  assert.ok(container.querySelector('.panel-chip-pruning'));
  assert.equal(container.querySelector('[aria-label="Cancel pruning prepass"]'), null, 'no Cancel on completed result chip');
});
