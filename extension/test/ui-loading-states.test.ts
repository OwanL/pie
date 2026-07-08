/**
 * Tests for UI loading states, typing indicator, streaming responsiveness,
 * and pruning result scoping.
 *
 * These tests verify the front-end's behaviour during various async states:
 * waiting for backend, waiting for response, streaming in progress, and
 * pruning result freshness.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from './_helpers/dom';
installDom();

import DOMPurify from 'dompurify';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import renderToString from 'preact-render-to-string';

import { useBufferedText } from '../src/webview/panel/transcript/use-buffered-text';

import { buildTranscriptRows, estimateTranscriptRowSize } from '../src/webview/panel/transcript/virtual-list-rows';
import { AGENT_ACTIVITY_LABELS, derivePendingActivityLabel, deriveTurnActivityState } from '../src/webview/panel/transcript/activity';
import { isPanelBooting, resolvePanelSurface } from '../src/webview/panel/panel-state';
import { derivePruningResult } from '../src/host/core/projection';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, type ChatMessage } from '../src/shared/protocol';
import type { TurnActivityState } from '../src/webview/panel/transcript/activity';

// Mock DOMPurify for markdown rendering in tests
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

function assistantMessage(parts: any[] = [], overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: '2026-01-01T12:34:56.000Z',
    markdown: 'fallback',
    parts,
    status: 'streaming',
    modelId: 'claude-sonnet-4-5:cloud',
    thinkingLevel: 'high',
    ...overrides,
  } as unknown as ChatMessage;
}

async function loadWebviewModules() {
  const [messageItemModule] = await Promise.all([
    import('../src/webview/panel/transcript/message-item.tsx'),
  ]);
  return { MessageItem: messageItemModule.MessageItem };
}

const noop = () => undefined;
const noopContextMenu = () => undefined;

function makeMessage(id: string, role: ChatMessage['role'], overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role,
    createdAt: '2026-05-16T00:00:00.000Z',
    markdown: role === 'user' ? 'hello' : 'hi there',
    status: 'completed',
    ...overrides,
  } as unknown as ChatMessage;
}

// ─── Busy-state footer shell ─────────────────────────────────────────────────

test('buildTranscriptRows adds an assistant placeholder row when busy after a user prompt', () => {
  const transcript = [makeMessage('user-1', 'user')];
  const activityState = deriveTurnActivityState({
    busy: true,
    transcript,
    prefs: DEFAULT_CHAT_PREFS,
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
  });
  const rows = buildTranscriptRows({
    transcript,
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: true,
    hasPruningResult: false,
    activityState,
  });

  const kinds = rows.map((r) => r.kind);
  assert.deepEqual(kinds, ['message', 'message']);
  assert.equal(rows[1]?.kind === 'message' ? rows[1].message.id : null, 'assistant-placeholder:user-1');
  assert.equal(rows[1]?.kind === 'message' && rows[1].activityState ? rows[1].activityState.phase : null, 'pruning');
});

test('buildTranscriptRows omits typingIndicator when last message is already streaming', () => {
  const transcript = [
    makeMessage('user-1', 'user'),
    makeMessage('assist-1', 'assistant', { status: 'streaming' }),
  ];
  const activityState = deriveTurnActivityState({
    busy: true,
    transcript,
    prefs: DEFAULT_CHAT_PREFS,
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
  });
  const rows = buildTranscriptRows({
    transcript,
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: true,
    hasPruningResult: false,
    activityState,
  });

  const kinds = rows.map((r) => r.kind);
  assert.ok(!kinds.includes('typingIndicator'), 'should not show typing indicator during streaming');
  assert.equal(rows[1]?.kind === 'message' && rows[1].activityState ? rows[1].activityState.phase : null, 'streaming');
});

test('buildTranscriptRows omits typingIndicator when not busy', () => {
  const rows = buildTranscriptRows({
    transcript: [makeMessage('user-1', 'user')],
    systemPromptCount: 0,
    hasOlder: false,
    hasNewer: false,
    busy: false,
    hasPruningResult: false,
  });

  const kinds = rows.map((r) => r.kind);
  assert.ok(!kinds.includes('typingIndicator'));
});

test('buildTranscriptRows keeps the assistant placeholder before bottomGap', () => {
  const rows = buildTranscriptRows({
    transcript: [makeMessage('user-1', 'user')],
    systemPromptCount: 1,
    hasOlder: false,
    hasNewer: true,
    busy: true,
    hasPruningResult: false,
  });

  const kinds = rows.map((r) => r.kind);
  assert.deepEqual(kinds, ['systemPrompts', 'message', 'message', 'bottomGap']);
  assert.equal(rows[2]?.kind === 'message' ? rows[2].message.id : null, 'assistant-placeholder:user-1');
});

test('estimateTranscriptRowSize returns stable size for typingIndicator', () => {
  assert.equal(
    estimateTranscriptRowSize({ kind: 'typingIndicator', key: 'typing-indicator' }),
    40,
  );
});

test('derivePendingActivityLabel names pruning prepass after a user prompt', () => {
  assert.equal(
    derivePendingActivityLabel({
      busy: true,
      transcript: [makeMessage('user-1', 'user')],
      prefs: DEFAULT_CHAT_PREFS,
      pruningSettings: DEFAULT_PRUNING_SETTINGS,
    }),
    AGENT_ACTIVITY_LABELS.pruning,
  );
});

test('derivePendingActivityLabel falls back when skill-pruner is disabled', () => {
  assert.equal(
    derivePendingActivityLabel({
      busy: true,
      transcript: [makeMessage('user-1', 'user')],
      prefs: { ...DEFAULT_CHAT_PREFS, extensionToggles: { 'skill-pruner': false } },
      pruningSettings: DEFAULT_PRUNING_SETTINGS,
    }),
    AGENT_ACTIVITY_LABELS.preparing,
  );

  assert.equal(
    derivePendingActivityLabel({
      busy: true,
      transcript: [makeMessage('user-1', 'user')],
      prefs: DEFAULT_CHAT_PREFS,
      pruningSettings: { ...DEFAULT_PRUNING_SETTINGS, mode: 'off' },
    }),
    AGENT_ACTIVITY_LABELS.preparing,
  );
});

test('derivePendingActivityLabel advances after pruning and assistant phases', () => {
  const pruningMessage = {
    id: 'prune-1',
    role: 'system',
    createdAt: '2026-05-16T00:00:01.000Z',
    markdown: 'Pruned',
    status: 'completed',
    customType: 'pruning-result',
    customDetails: {
      includedSkills: ['debugging'],
      excludedSkills: [],
      includedTools: ['read'],
      excludedTools: [],
      mode: 'auto',
      skillTokensSaved: 0,
      toolTokensSaved: 0,
    },
  } as unknown as ChatMessage;

  assert.equal(
    derivePendingActivityLabel({
      busy: true,
      transcript: [makeMessage('user-1', 'user'), pruningMessage],
      prefs: DEFAULT_CHAT_PREFS,
      pruningSettings: DEFAULT_PRUNING_SETTINGS,
    }),
    AGENT_ACTIVITY_LABELS.startingModel,
  );

  assert.equal(
    derivePendingActivityLabel({
      busy: true,
      transcript: [
        makeMessage('user-1', 'user'),
        makeMessage('assistant-1', 'assistant', {
          toolCalls: [{ id: 'tool-1', name: 'read', input: {}, status: 'running' }],
        }),
      ],
      prefs: DEFAULT_CHAT_PREFS,
      pruningSettings: DEFAULT_PRUNING_SETTINGS,
    }),
    'running read',
  );

  assert.equal(
    derivePendingActivityLabel({
      busy: true,
      transcript: [makeMessage('user-1', 'user'), makeMessage('assistant-1', 'assistant')],
      prefs: DEFAULT_CHAT_PREFS,
      pruningSettings: DEFAULT_PRUNING_SETTINGS,
    }),
    AGENT_ACTIVITY_LABELS.thinking,
  );
});

// ─── Structured activity state ───────────────────────────────────────────────

test('deriveTurnActivityState returns null when not busy', () => {
  const state = deriveTurnActivityState({
    busy: false,
    transcript: [makeMessage('user-1', 'user')],
    prefs: DEFAULT_CHAT_PREFS,
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
  });
  assert.equal(state, null);
});

test('deriveTurnActivityState returns structured streaming state', () => {
  const state = deriveTurnActivityState({
    busy: true,
    transcript: [
      makeMessage('user-1', 'user'),
      makeMessage('assistant-1', 'assistant', { status: 'streaming' }),
    ],
    prefs: DEFAULT_CHAT_PREFS,
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
  });
  assert.ok(state);
  assert.equal(state!.phase, 'streaming');
  assert.equal(state!.label, AGENT_ACTIVITY_LABELS.responding);
  assert.equal(state!.tone, 'active');
  assert.equal(state!.ariaLabel, 'Agent is responding');
});

test('deriveTurnActivityState returns structured pruning state', () => {
  const state = deriveTurnActivityState({
    busy: true,
    transcript: [makeMessage('user-1', 'user')],
    prefs: DEFAULT_CHAT_PREFS,
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
  });
  assert.ok(state);
  assert.equal(state!.phase, 'pruning');
  assert.equal(state!.label, AGENT_ACTIVITY_LABELS.pruning);
  assert.equal(state!.tone, 'processing');
  assert.ok(state!.ariaLabel.includes('pruning'));
});

test('deriveTurnActivityState returns startingModel phase after pruning', () => {
  const pruningMessage = {
    id: 'prune-1',
    role: 'system',
    createdAt: '2026-05-16T00:00:01.000Z',
    markdown: 'Pruned',
    status: 'completed',
    customType: 'pruning-result',
    customDetails: {
      includedSkills: ['debugging'],
      excludedSkills: [],
      includedTools: ['read'],
      excludedTools: [],
      mode: 'auto',
      skillTokensSaved: 0,
      toolTokensSaved: 0,
    },
  } as unknown as ChatMessage;

  const state = deriveTurnActivityState({
    busy: true,
    transcript: [makeMessage('user-1', 'user'), pruningMessage],
    prefs: DEFAULT_CHAT_PREFS,
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
    pendingAssistantModelId: 'gpt-5.4',
    pendingAssistantThinkingLevel: 'xhigh',
  });
  assert.ok(state);
  assert.equal(state!.phase, 'startingModel');
  assert.equal(state!.label, AGENT_ACTIVITY_LABELS.startingModel);
  assert.equal(state!.pendingModelLabel, 'gpt-5.4 (xhigh)');
});

test('deriveTurnActivityState returns runningTool phase with tool name', () => {
  const state = deriveTurnActivityState({
    busy: true,
    transcript: [
      makeMessage('user-1', 'user'),
      makeMessage('assistant-1', 'assistant', {
        toolCalls: [{ id: 'tool-1', name: 'read', input: {}, status: 'running' }],
      }),
    ],
    prefs: DEFAULT_CHAT_PREFS,
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
  });
  assert.ok(state);
  assert.equal(state!.phase, 'runningTool');
  assert.equal(state!.label, 'running read');
  assert.equal(state!.runningToolName, 'read');
  assert.ok(state!.ariaLabel.includes('running read'));
});

test('deriveTurnActivityState returns runningTool phase with multiple tools', () => {
  const state = deriveTurnActivityState({
    busy: true,
    transcript: [
      makeMessage('user-1', 'user'),
      makeMessage('assistant-1', 'assistant', {
        toolCalls: [
          { id: 'tool-1', name: 'read', input: {}, status: 'running' },
          { id: 'tool-2', name: 'bash', input: {}, status: 'running' },
          { id: 'tool-3', name: 'write', input: {}, status: 'running' },
        ],
      }),
    ],
    prefs: DEFAULT_CHAT_PREFS,
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
  });
  assert.ok(state);
  assert.equal(state!.phase, 'runningTool');
  assert.equal(state!.label, 'running 3 tools');
  assert.equal(state!.runningToolSummary, 'running 3 tools');
  assert.equal(state!.detail, 'read, bash, write');
});

test('deriveTurnActivityState returns thinking phase when assistant is not streaming', () => {
  const state = deriveTurnActivityState({
    busy: true,
    transcript: [
      makeMessage('user-1', 'user'),
      makeMessage('assistant-1', 'assistant'),
    ],
    prefs: DEFAULT_CHAT_PREFS,
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
  });
  assert.ok(state);
  assert.equal(state!.phase, 'thinking');
  assert.equal(state!.label, AGENT_ACTIVITY_LABELS.thinking);
  assert.equal(state!.tone, 'processing');
});

// ─── Panel loading states ────────────────────────────────────────────────────

test('panel shows loading surface during initial backend boot', () => {
  assert.equal(
    resolvePanelSurface({ backendReady: false, notice: null, openTabPaths: [] }),
    'loading',
  );
});

test('panel shows session surface immediately when tabs exist even during boot', () => {
  assert.equal(
    resolvePanelSurface({ backendReady: false, notice: null, openTabPaths: ['/session/a'] }),
    'session',
  );
});

test('panel transitions from loading to empty when backend ready with no tabs', () => {
  assert.equal(
    resolvePanelSurface({ backendReady: true, notice: null, openTabPaths: [] }),
    'empty',
  );
});

test('panel shows empty state with notice during boot (error display)', () => {
  // When there's a notice but no tabs, the panel should show the empty state
  // (not loading), because the notice gives the user information about what happened.
  assert.equal(isPanelBooting({ backendReady: false, notice: 'Backend failed to start' }), false);
  assert.equal(
    resolvePanelSurface({ backendReady: false, notice: 'Backend failed', openTabPaths: [] }),
    'empty',
  );
});

// ─── Pruning result scoping ──────────────────────────────────────────────────

test('derivePruningResult returns most recent pruning result even from a previous turn', () => {
  const transcript: ChatMessage[] = [
    makeMessage('user-1', 'user'),
    {
      id: 'prune-old',
      role: 'system',
      createdAt: '',
      markdown: 'old pruning',
      status: 'completed',
      customType: 'pruning-result',
      customDetails: {
        includedSkills: ['a'],
        excludedSkills: ['b'],
        includedTools: [],
        excludedTools: [],
        mode: 'auto',
        skillTokensSaved: 100,
        toolTokensSaved: 0,
      },
    } as unknown as ChatMessage,
    makeMessage('assist-1', 'assistant'),
    // New user message starts a new turn
    makeMessage('user-2', 'user'),
  ];

  // The pruning result is from a previous turn, but it's the most recent
  // available — it should still be returned so the banner stays visible.
  const result = derivePruningResult(transcript);
  assert.ok(result);
  assert.equal(result!.skillsKept, 1);
  assert.equal(result!.skillsTotal, 2);
});

test('derivePruningResult returns result from the current turn', () => {
  const transcript: ChatMessage[] = [
    makeMessage('user-1', 'user'),
    makeMessage('user-2', 'user'),
    {
      id: 'prune-current',
      role: 'system',
      createdAt: '',
      markdown: 'current pruning',
      status: 'completed',
      customType: 'pruning-result',
      customDetails: {
        includedSkills: ['x', 'y'],
        excludedSkills: ['z'],
        includedTools: ['read', 'edit'],
        excludedTools: ['web_search'],
        mode: 'auto',
        skillTokensSaved: 500,
        toolTokensSaved: 200,
      },
    } as unknown as ChatMessage,
  ];

  const result = derivePruningResult(transcript);
  assert.ok(result);
  assert.equal(result!.skillsKept, 2);
  assert.equal(result!.skillsTotal, 3);
  assert.equal(result!.toolsKept, 2);
  assert.equal(result!.toolsTotal, 3);
  assert.equal(result!.tokensSaved, 700);
});

test('derivePruningResult handles prepassError in current turn', () => {
  const transcript: ChatMessage[] = [
    makeMessage('user-1', 'user'),
    {
      id: 'prune-err',
      role: 'system',
      createdAt: '',
      markdown: 'error',
      status: 'completed',
      customType: 'pruning-result',
      customDetails: {
        includedSkills: [],
        excludedSkills: [],
        includedTools: [],
        excludedTools: [],
        mode: 'auto',
        skillTokensSaved: 0,
        toolTokensSaved: 0,
        prepassError: 'Model timeout',
      },
    } as unknown as ChatMessage,
  ];

  const result = derivePruningResult(transcript);
  assert.ok(result);
  assert.equal(result!.error, 'Model timeout');
  assert.equal(result!.skillsKept, 0);
});

// ─── Streaming text buffering ────────────────────────────────────────────────

test('useBufferedText progressively reveals streamed text and snaps to full when streaming stops', () => {
  // Deterministic, manually-flushed rAF so each frame's reveal is inspectable
  // without real timing. The hook reschedules itself while it is behind; we
  // drain one callback per flush.
  const queue: Array<(t: number) => void> = [];
  const origRaf = globalThis.requestAnimationFrame;
  const origCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: (t: number) => void) => {
    queue.push(cb);
    return queue.length;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const flushFrame = () => act(() => { queue.shift()?.(0); });
  // Coerce to a string for length checks: textContent is `string | null` at
  // runtime, and `.length` on it trips the project's DOM type setup.
  const visibleLength = () => (container.textContent ?? '').length;

  try {
    const Harness = (props: { text: string; streaming: boolean }) =>
      h('span', null, useBufferedText(props.text, props.streaming));

    // Not streaming: the full text is returned immediately, no rAF armed.
    act(() => render(h(Harness, { text: 'complete response', streaming: false }), container));
    assert.equal(container.textContent, 'complete response');
    assert.equal(queue.length, 0, 'no rAF armed while not streaming');

    // Reset for the streaming phase (fresh mount → visibleLength starts at 0).
    act(() => render(null, container));

    // Mount streaming with empty text, then grow far past one frame's reveal.
    act(() => render(h(Harness, { text: '', streaming: true }), container));
    assert.equal(container.textContent, '', 'empty buffer renders nothing');
    act(() => render(h(Harness, { text: 'x'.repeat(10000), streaming: true }), container));
    assert.equal(queue.length, 1, 'growth while behind arms exactly one rAF');
    assert.equal(visibleLength(), 0, 'no reveal until a frame fires');

    // First frame: bounded advance. CHARS_PER_FRAME (100) × max scaleFactor
    // (8, for remaining=10000) = 800 — capped well below the full buffer.
    flushFrame();
    assert.equal(visibleLength(), 800, 'first frame reveals CHARS_PER_FRAME × maxScale');
    assert.ok(visibleLength() < 10000, 'capped below the full buffer');

    // Second frame keeps advancing toward the target.
    flushFrame();
    assert.equal(visibleLength(), 1600, 'second frame advances by another slice');

    // Flipping streaming off snaps to the full text immediately.
    act(() => render(h(Harness, { text: 'x'.repeat(10000), streaming: false }), container));
    assert.equal(visibleLength(), 10000, 'streaming=false snaps to full text');
  } finally {
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCaf;
    render(null, container);
    container.remove();
  }
});

// ─── Pruning banner gates ────────────────────────────────────────────────────

test('selectViewState hides pruning banner when skill-pruner extension toggled off', async () => {
  const { createInitialArchState } = await import('../src/host/core/arch-state');
  const { selectViewState } = await import('../src/host/core/projection');
  const { produce } = await import('immer');

  const sessionPath = '/ws/prune-toggle-off';
  let state = createInitialArchState();
  state = produce(state, draft => {
    draft.sessions.sessions = [{ path: sessionPath, name: 'test', isPlaceholder: false, cwd: '', modifiedAt: '', messageCount: 0 }];
    draft.sessions.openTabPaths = [sessionPath];
    draft.sessions.activeSessionPath = sessionPath;
    draft.transcript.bySession[sessionPath] = [
      makeMessage('user-1', 'user'),
      {
        id: 'prune-1',
        role: 'system',
        createdAt: '2026-01-01T00:00:00.000Z',
        markdown: '',
        status: 'completed',
        customType: 'pruning-result',
        customDetails: {
          includedSkills: ['a'],
          excludedSkills: ['b'],
          includedTools: ['t1'],
          excludedTools: [],
          skillTokensSaved: 100,
          toolTokensSaved: 0,
        },
      } as any,
    ];
  });

  // With extension enabled (default), pruning banner shows.
  assert.ok(selectViewState(state).pruningResult, 'banner shown by default');

  // Toggling extension off hides the banner even though the pruning-result message exists.
  state = produce(state, draft => {
    draft.settings.prefs.extensionToggles = { 'skill-pruner': false };
  });
  assert.equal(selectViewState(state).pruningResult, null, 'banner hidden when extension off');
});

test('selectViewState hides pruning banner when pruningSettings.mode is off', async () => {
  const { createInitialArchState } = await import('../src/host/core/arch-state');
  const { selectViewState } = await import('../src/host/core/projection');
  const { produce } = await import('immer');

  const sessionPath = '/ws/prune-mode-off';
  let state = createInitialArchState();
  state = produce(state, draft => {
    draft.sessions.sessions = [{ path: sessionPath, name: 'test', isPlaceholder: false, cwd: '', modifiedAt: '', messageCount: 0 }];
    draft.sessions.openTabPaths = [sessionPath];
    draft.sessions.activeSessionPath = sessionPath;
    // Re-enable extension in case a prior test toggled it off.
    draft.settings.prefs.extensionToggles = { 'skill-pruner': true };
    draft.transcript.bySession[sessionPath] = [
      makeMessage('user-1', 'user'),
      {
        id: 'prune-1',
        role: 'system',
        createdAt: '2026-01-01T00:00:00.000Z',
        markdown: '',
        status: 'completed',
        customType: 'pruning-result',
        customDetails: {
          includedSkills: ['a'],
          excludedSkills: [],
          includedTools: [],
          excludedTools: [],
          skillTokensSaved: 0,
          toolTokensSaved: 0,
        },
      } as any,
    ];
  });

  // Default mode 'auto': banner shows.
  assert.ok(selectViewState(state).pruningResult, 'banner shown when mode=auto');

  // Mode 'off': banner hidden.
  state = produce(state, draft => {
    draft.settings.pruningSettings = {
      mode: 'off',
      skillCeiling: 5,
      toolCeiling: 5,
      skillAlwaysKeep: [],
      toolAlwaysKeep: [],
      model: 'gpt-5.4-mini',
      provider: 'github-copilot',
      thinkingLevel: 'minimal',
    };
  });
  assert.equal(selectViewState(state).pruningResult, null, 'banner hidden when mode=off');
});

// ─── Optimistic running state ────────────────────────────────────────────────

test('Send command optimistically marks session as running for instant Stop button', async () => {
  // The CQRS reducer handles the Send command by inserting an optimistic
  // user message and adding the session to runningSessionPaths, so the
  // composer flips to Stop before the backend confirms busy.
  // We verify this contract by checking the reducer produces running session state.
  const { reducer, createInitialArchState } = await import('../src/host/core/reducer');
  const state = createInitialArchState();
  state.sessions.openTabPaths = ['/test'];
  state.sessions.sessions = [{ path: '/test', name: 'Test', isPlaceholder: false, cwd: '', modifiedAt: '', messageCount: 0 }];
  state.settings.backendReady = true;

  const result = reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: 'c1',
      sessionPath: '/test',
      text: 'hello',
      inputs: [],
      composedText: 'hello',
      localId: 'local-1',
      userParts: undefined,
      previousSummary: null,
      timestamp: 1,
    },
  });

  // The optimistic message should be in the transcript.
  assert.ok(result.state.transcript.bySession['/test'], 'transcript should have session entry');
  assert.equal(result.state.transcript.bySession['/test'].length, 1, 'should have one message');
  assert.equal(result.state.transcript.bySession['/test'][0].id, 'local-1', 'message should have local ID');
});

test('SendResult failure removes optimistic message from transcript', async () => {
  // When a send fails, the reducer should remove the optimistic message
  // and set a notice error.
  const { reducer, createInitialArchState } = await import('../src/host/core/reducer');
  const state = createInitialArchState();
  state.sessions.openTabPaths = ['/test'];
  state.sessions.sessions = [{ path: '/test', name: 'Test', isPlaceholder: false, cwd: '', modifiedAt: '', messageCount: 0 }];
  state.settings.backendReady = true;

  // First, send a message to create optimistic state.
  const afterSend = reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: 'c1',
      sessionPath: '/test',
      text: 'hello',
      inputs: [],
      composedText: 'hello',
      localId: 'local-1',
      userParts: undefined,
      previousSummary: null,
      timestamp: 1,
    },
  }).state;

  assert.ok(afterSend.transcript.bySession['/test'], 'transcript should exist after send');
  assert.equal(afterSend.transcript.bySession['/test'].length, 1, 'should have optimistic message');

  // Now, send fails.
  const result = reducer(afterSend, {
    kind: 'SendResult',
    corrId: 'c1',
    sessionPath: '/test',
    ok: false,
    error: 'test error',
  });

  // The optimistic message should be removed.
  assert.equal(result.state.transcript.bySession['/test']?.length ?? 0, 0, 'optimistic message should be removed');
  // A notice should be set.
  assert.ok(result.state.settings.notice, 'should have error notice');
  assert.ok(result.state.settings.notice!.includes("Couldn't send"), 'notice should mention send failure');
});

// ─── TurnActivityStrip inline rendering ──────────────────────────────────────

test('MessageItem renders TurnActivityStrip inline for assistant turns with activityState', async () => {
  const { MessageItem } = await import('../src/webview/panel/transcript/message-item.tsx');
  const activityState: TurnActivityState = {
    phase: 'runningTool',
    label: 'running read',
    detail: 'src/main.ts',
    tone: 'active',
    ariaLabel: 'Agent is running read',
    runningToolName: 'read',
  };

  const html = renderToString(h(MessageItem, {
    message: assistantMessage([{ kind: 'text', text: 'Reading file' }], { status: 'completed' }),
    isStreaming: false,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: false,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
    isLastAssistantMessage: true,
    activityState,
  }));

  // TurnActivityStrip renders
  assert.match(html, /turn-activity-strip/);
  // Phase is exposed on the strip element
  assert.match(html, /data-phase="runningTool"/);
  // Label is shown
  assert.match(html, /turn-activity-strip-label">running read</);
});

test('MessageItem renders TurnActivityStrip with neutral tone for thinking phase', async () => {
  const { MessageItem } = await loadWebviewModules();
  const activityState: TurnActivityState = {
    phase: 'thinking',
    label: 'thinking',
    tone: 'processing',
    ariaLabel: 'Agent is thinking',
  };

  const html = renderToString(h(MessageItem, {
    message: assistantMessage([{ kind: 'text', text: 'Done' }], { status: 'completed' }),
    isStreaming: false,
    prefs: DEFAULT_CHAT_PREFS,
    readonly: true,
    workingDirectory: '/repo',
    editingId: null,
    onEditRequest: noop,
    onEditConfirm: noop,
    onEditCancel: noop,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: () => null,
    isLastAssistantMessage: true,
    activityState,
  }));

  assert.match(html, /turn-activity-strip/);
});
