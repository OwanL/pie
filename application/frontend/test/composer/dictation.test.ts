import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import renderToString from 'preact-render-to-string';
import { act } from 'preact/test-utils';
import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_PRUNING_SETTINGS,
  DEFAULT_SESSION_TITLES_SETTINGS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  EMPTY_PROVIDER_GATE_STATS,
  EMPTY_TRANSCRIPT_WINDOW,
} from '../../../lib/protocol';
import { PanelMain } from '../../shell/panel-main';
import { ComposerActions } from '../../composer/actions';
import { BottomSection, type BottomSectionProps } from '../../composer/bottom-section';
import { useComposerInput } from '../../composer/hooks';
import type { DictationView } from '../../../lib/protocol/dictation';

const recording: DictationView = { available: true, phase: 'recording', sessionPath: '/s', recordingId: 'r', transcript: '', error: null };
test('mic immediately precedes disabled Send while recording; preparing can stop', () => {
  const root = document.createElement('div');
  let clicks = 0;
  const props = { busy: false, hasQueuedMessages: false, onInterrupt() {}, onClearQueue() {}, sendCurrentText() {}, canSend: true, onToggleDictation() { clicks++; } };
  act(() => render(h(ComposerActions, { ...props, commandsAvailable: false, dictation: recording }), root));
  const mic = root.querySelector<HTMLButtonElement>('[data-action="dictation"]')!;
  assert.equal(mic.nextElementSibling?.getAttribute('data-action'), 'send');
  assert.equal(mic.getAttribute('aria-pressed'), 'false');
  assert.equal(mic.classList.contains('is-active'), false);
  assert.equal(mic.disabled, false);
  assert.equal((mic.nextElementSibling as HTMLButtonElement).disabled, true);
  act(() => render(h(ComposerActions, { ...props, commandsAvailable: false, dictation: { ...recording, phase: 'preparing' } }), root));
  mic.click();
  assert.equal(clicks, 1);
  act(() => render(h(ComposerActions, { ...props, commandsAvailable: false, dictation: { ...recording, available: false } }), root));
  assert.equal(mic.disabled, true);
  act(() => render(h(ComposerActions, { ...props, dictation: { ...recording, phase: 'finalizing' } }), root));
  assert.equal(mic.disabled, true);
  render(null, root);
});

test('recording mic reacts to samples; busy and terminal phases reset its active cue', () => {
  const root = document.createElement('div');
  const props = { busy: false, hasQueuedMessages: false, onInterrupt() {}, onClearQueue() {}, sendCurrentText() {}, canSend: true };
  const paint = (dictation: DictationView) => act(() => render(h(ComposerActions, { ...props, dictation }), root));
  paint({ ...recording, audioLevel: 0 });
  const mic = root.querySelector('[data-action="dictation"]')!;
  const quiet = mic.getAttribute('style');
  assert.equal(mic.getAttribute('aria-pressed'), 'true');
  assert.match(mic.getAttribute('title')!, /10\x20seconds/);
  paint({ ...recording, audioLevel: 0.01 });
  assert.notEqual(mic.getAttribute('style'), quiet);
  const quietSpeech = mic.getAttribute('style');
  paint({ ...recording, audioLevel: 0.04 });
  assert.notEqual(mic.getAttribute('style'), quietSpeech);
  paint({ ...recording, audioLevel: 1 });
  assert.notEqual(mic.getAttribute('style'), quiet);
  for (const phase of ['preparing', 'finalizing', 'idle', 'error'] as const) {
    paint({ ...recording, phase });
    assert.equal(mic.getAttribute('aria-pressed'), 'false');
    assert.equal(mic.classList.contains('is-active'), false);
    assert.equal(mic.getAttribute('aria-busy'), phase === 'preparing' || phase === 'finalizing' ? 'true' : null);
  }
  paint({ ...recording, available: false });
  assert.equal(mic.getAttribute('aria-pressed'), 'false');
  render(null, root);
});

test('transcript root never renders the dictation edge', () => {
  const props: any = { panelSurface: 'chat', hasActiveTabs: true, showSessionChrome: false, needsSessionRecovery: true, activeSessionPath: '/s', fileChanges: [], handlers: {}, mergedTranscript: [], transcriptWindow: EMPTY_TRANSCRIPT_WINDOW, openTabPaths: ['/s'], postMessage() {}, loadingStatus: '' };
  const root = document.createElement('div');
  const html = (dictation: DictationView, overrides = {}) => {
    act(() => render(h(PanelMain, { ...props, needsSessionRecovery: false, dictation, ...overrides }), root));
    return root.innerHTML;
  };
  const quiet = html({ ...recording, audioLevel: 0 });
  assert.doesNotMatch(quiet, /dictation-edge/);
  assert.doesNotMatch(html({ ...recording, audioLevel: 1 }), /dictation-edge/);
  for (const phase of ['preparing', 'finalizing', 'idle', 'error'] as const) assert.doesNotMatch(html({ ...recording, phase }), /dictation-edge/);
  assert.doesNotMatch(html({ ...recording, available: false }), /dictation-edge/);
  for (const overrides of [{ commandsAvailable: false }, { activeSessionPath: '/other' }, { hasActiveTabs: false }, { panelSurface: 'loading' }]) {
    assert.doesNotMatch(html(recording, overrides), /dictation-edge/);
  }
  const panelSource = readFileSync(new URL('../../shell/panel-main.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(panelSource, /dictation/);
  assert.doesNotMatch(readFileSync(new URL('../../styles/transcript.css', import.meta.url), 'utf8'), /dictation-edge/);
  const css = readFileSync(new URL('../../styles/composer.css', import.meta.url), 'utf8');
  assert.match(css, /position: absolute;\n {2}inset: 0;/);
  assert.match(css, /pointer-events: none/);
  assert.match(css, /position: relative;\n {2}isolation: isolate/);
  assert.match(css, /z-index: -1;\n {2}border-radius: inherit/);
  assert.match(css, /transparent 12px/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  const edgeCss = css.match(/\.dictation-edge \{[^}]+\}/)![0];
  const micCss = readFileSync(new URL('../../styles/composer.css', import.meta.url), 'utf8').match(/\.composer-action-mic\.is-active:not\(:disabled\) \{[^}]+\}/)![0];
  const themeCss = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');
  assert.match(themeCss, /--panel-accent:/);
  for (const activeCss of [edgeCss, micCss]) {
    assert.match(activeCss, /var\(--panel-accent\)/);
    assert.doesNotMatch(activeCss, /var\(--accent\)/);
  }
  render(null, root);
});

test('real composer confines sample-reactive recording edge to input and toolbar', () => {
  const noop = () => {};
  const props: BottomSectionProps = {
    hasActiveTabs: true,
    needsSessionRecovery: false,
    pendingExtensionUIRequest: null,
    activeSessionPath: '/s',
    postMessage: noop,
    busy: false,
    retryStatus: null,
    interrupting: false,
    activeSession: null,
    modelSettings: null,
    availableModels: [],
    availableModelsStatus: 'authoritative',
    availableExtensions: [],
    contextUsage: null,
    initialContextEstimate: null,
    prefs: DEFAULT_CHAT_PREFS,
    mcpServers: [],
    mcpPendingApply: false,
    mcpSessionServers: [],
    mcpSessionPendingApply: false,
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
    pruningCatalog: { skills: [], tools: [] },
    pruningResult: null,
    toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
    sessionTitlesSettings: DEFAULT_SESSION_TITLES_SETTINGS,
    providerGateStats: EMPTY_PROVIDER_GATE_STATS,
    systemPrompts: [],
    transcript: [],
    transcriptWindow: EMPTY_TRANSCRIPT_WINDOW,
    sessionUsage: null,
    draftRestore: null,
    draftText: '',
    pendingComposerInputs: [],
    activeRunSummary: null,
    tokenRateBySession: {},
    workingTimeBySession: {},
    compacting: false,
    lastCompaction: null,
    dictation: recording,
    handlers: {
      handleSend: () => true,
      handleRetrySend: () => true,
      handleInterrupt: () => true,
      handleAddComposerInput: noop,
      handleRemoveComposerInput: noop,
      handleModelChange: noop,
      handleSetPrefs: noop,
      handleMcpListRequested: noop,
      handleMcpSetServerEnabled: noop,
      handleMcpSetServerEnabledForSession: noop,
      handleSetPrivacyMode: noop,
      handleSetBrowserServerLanEnabled: noop,
      handleSetBrowserServerEnabled: noop,
      handleSetSystemPromptToggles: noop,
      handleSetPruningSettings: noop,
      handleSetPruningRefreshPending: noop,
      handleSetToolResultPruningSettings: noop,
      handleSetSessionTitlesSettings: noop,
    },
  };
  const html = renderToString(h(BottomSection, props));
  assert.match(html, /data-action="dictation"/);
  assert.doesNotMatch(html, /data-action="token-rate"/);
  const root = document.createElement('div');
  const messages: any[] = [];
  let sends = 0;
  props.draftText = 'preserved draft';
  props.postMessage = message => messages.push(message);
  props.handlers.handleSend = () => { sends++; return true; };
  const paint = (dictation: DictationView | undefined, overrides: Partial<BottomSectionProps> = {}) => {
    act(() => render(h(BottomSection, { ...props, dictation, ...overrides }), root));
  };
  paint({ ...recording, audioLevel: 0 });
  const shell = root.querySelector('.composer-shell')!;
  const edge = shell.querySelector('.dictation-edge')!;
  assert.equal(edge.parentElement, shell);
  assert.equal(edge.getAttribute('aria-hidden'), 'true');
  assert.ok(shell.querySelector('textarea'));
  assert.ok(shell.querySelector('.composer-bottom-bar'));
  assert.equal(root.querySelectorAll('.dictation-edge').length, 1);
  const quiet = edge.getAttribute('style');
  const messageCount = messages.length;
  for (const audioLevel of [0.01, 0.04, 1]) {
    paint({ ...recording, audioLevel });
    assert.notEqual(edge.getAttribute('style'), quiet);
    assert.equal(root.querySelector('textarea')!.value, 'preserved draft');
    assert.equal(messages.length, messageCount);
    assert.equal(sends, 0);
  }
  assert.ok(Math.abs(Number((edge as HTMLElement).style.opacity) - 0.8) < 1e-12);
  assert.equal((edge as HTMLElement).style.getPropertyValue('--dictation-position'), '80%');
  assert.equal((edge as HTMLElement).style.getPropertyValue('--dictation-angle'), '130deg');
  for (const phase of ['preparing', 'finalizing', 'error', 'idle'] as const) {
    paint({ ...recording, phase });
    assert.equal(root.querySelector('.dictation-edge'), null);
  }
  for (const dictation of [undefined, { ...recording, available: false }, { ...recording, sessionPath: '/other' }]) {
    paint(dictation);
    assert.equal(root.querySelector('.dictation-edge'), null);
  }
  for (const overrides of [{ commandsAvailable: false }, { activeSessionPath: null }, { hasActiveTabs: false }, { needsSessionRecovery: true }]) {
    paint(recording, overrides);
    assert.equal(root.querySelector('.dictation-edge'), null);
  }
  render(null, root);
});

test('dictation edge drifts continuously independent of RMS and respects reduced motion', () => {
  const css = readFileSync(new URL('../../styles/composer.css', import.meta.url), 'utf8');
  const edgeCss = css.match(/\.composer-shell > \.dictation-edge \{[^}]+\}/)?.[0];
  assert.ok(edgeCss, 'composer dictation edge rule exists');
  assert.match(edgeCss, /animation:\s*dictation-drift\s+8s\s+ease-in-out\s+infinite/);

  const keyframes = css.match(/@keyframes dictation-drift\s*\{([^}]+\}[^}]+\})\s*\}/)?.[1];
  assert.ok(keyframes, 'continuous dictation drift keyframes exist');
  assert.match(keyframes, /0%,\s*100%\s*\{\s*background-position:\s*calc\(var\(--dictation-position,\s*20%\)\s*-\s*20%\)\s+35%/);
  assert.match(keyframes, /50%\s*\{\s*background-position:\s*calc\(var\(--dictation-position,\s*20%\)\s*\+\s*20%\)\s+65%/);
  for (const cueCss of [edgeCss, keyframes]) {
    assert.doesNotMatch(cueCss, /(?:^|;)\s*(?:opacity|transform|width|height|min-width|min-height)\s*:/);
  }

  const reducedMotion = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.composer-shell > \.dictation-edge\s*\{([^}]+)\}/)?.[1];
  assert.ok(reducedMotion, 'dictation edge has a reduced-motion rule');
  assert.match(reducedMotion, /animation:\s*none/);
  assert.match(reducedMotion, /opacity:\s*0\.4\s*!important/);
  assert.doesNotMatch(reducedMotion, /(?:^|;)\s*(?:transform|width|height|min-width|min-height)\s*:/);
});

test('active dictation can stop while sends and agent commands are blocked', () => {
  const root = document.createElement('div');
  const messages: any[] = [];
  let sends = 0;
  function Harness({ view }: { view: DictationView }) {
    const input = useComposerInput({ busy: false, sendBlocked: true, commandsAvailable: false, dictation: view, onSend() { sends++; }, onRetrySend() { sends++; }, pendingComposerInputsLength: 0, initialRows: 1, sessionPath: '/s', draftText: '', postMessage(message) { messages.push(message); }, onAddInput() {}, supportsImageInputs: false });
    return h('div', {}, h('button', { onClick: input.toggleDictation }, 'mic'), h('button', { onClick: input.sendCurrentText }, 'send'));
  }
  for (const phase of ['recording', 'preparing'] as const) {
    const view = { ...recording, phase };
    act(() => render(h(Harness, { view }), root));
    const buttons = root.querySelectorAll('button');
    act(() => { buttons[0].click(); buttons[1].click(); });
    assert.ok(messages.some(message => message.type === 'dictationStop' && message.recordingId === 'r'));
    assert.equal(messages.some(message => message.type === 'dictationStart'), false);
    assert.equal(sends, 0);
  }
  render(null, root);
});

test('host previews form one undo group and manual editing cancels', () => {
  const root = document.createElement('div');
  const messages: any[] = [];
  let sends = 0;
  function Harness({ draft, view }: { draft: string; view: DictationView }) {
    const input = useComposerInput({ busy: false, dictation: view, onSend() { sends++; }, onRetrySend() { sends++; }, pendingComposerInputsLength: 0, initialRows: 1, sessionPath: '/s', draftText: draft, postMessage(message) { messages.push(message); }, onAddInput() {}, supportsImageInputs: false });
    return h('textarea', { value: input.text, onInput: input.handleInput, onKeyDown: input.handleKeyDown, ref: input.textareaRef });
  }
  act(() => render(h(Harness, { draft: 'base ', view: recording }), root));
  act(() => render(h(Harness, { draft: 'base hello', view: recording }), root));
  act(() => render(h(Harness, { draft: 'base hello world', view: recording }), root));
  const textarea = root.querySelector('textarea')!;
  assert.equal(textarea.value, 'base hello world');
  const messageCount = messages.length;
  for (const audioLevel of [0, 1, 0]) {
    act(() => render(h(Harness, { draft: 'base hello world', view: { ...recording, audioLevel } }), root));
    assert.equal(textarea.value, 'base hello world');
    assert.equal(messages.length, messageCount);
  }
  act(() => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  assert.equal(sends, 0);
  act(() => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); });
  assert.equal(textarea.value, 'base ');
  assert.ok(messages.some(message => message.type === 'dictationCancel' && message.recordingId === 'r'));
  act(() => { textarea.value = 'typed'; textarea.dispatchEvent(new Event('input', { bubbles: true })); });
  act(() => render(h(Harness, { draft: 'late preview', view: recording }), root));
  assert.equal(textarea.value, 'typed');
  render(null, root);
});

test('start captures selection, flushes draft and prevents duplicate intents', () => {
  const root = document.createElement('div');
  const messages: any[] = [];
  function Harness() {
    const input = useComposerInput({ busy: false, dictation: { ...recording, phase: 'idle', recordingId: null }, onSend() {}, onRetrySend() {}, pendingComposerInputsLength: 0, initialRows: 1, sessionPath: '/s', draftText: 'base', postMessage(message) { messages.push(message); }, onAddInput() {}, supportsImageInputs: false });
    return h('div', {}, h('textarea', { ref: input.textareaRef, value: input.text, onInput: input.handleInput }), h('button', { onClick: input.toggleDictation }, 'mic'));
  }
  act(() => render(h(Harness, {}), root));
  const textarea = root.querySelector('textarea')!;
  textarea.setSelectionRange(1, 3);
  act(() => { root.querySelector('button')!.click(); root.querySelector('button')!.click(); });
  assert.equal(messages[0].type, 'setComposerDraft');
  assert.equal(messages[1].type, 'dictationStart');
  assert.equal(messages[1].draftText, 'base');
  assert.equal(messages[1].selectionStart, 1);
  assert.equal(messages[1].selectionEnd, 3);
  assert.equal(messages.length, 2);
  render(null, root);
});

test('a null-path start preserves edits made before its resolved-session acknowledgement', async () => {
  const root = document.createElement('div');
  const messages: any[] = [];
  const idle = { ...recording, phase: 'idle' as const, recordingId: null };
  function StartHarness({ sessionPath, draft, view }: { sessionPath: string | null; draft: string; view: DictationView }) {
    const input = useComposerInput({ busy: false, dictation: view, onSend() {}, onRetrySend() {}, pendingComposerInputsLength: 0, initialRows: 1, sessionPath, draftText: draft, postMessage(message) { messages.push(message); }, onAddInput() {}, supportsImageInputs: false });
    return h('div', {}, h('textarea', { value: input.text, ref: input.textareaRef, onInput: input.handleInput, onKeyDown: input.handleKeyDown }), h('button', { onClick: input.toggleDictation }));
  }
  act(() => render(h(StartHarness, { sessionPath: null, draft: '', view: idle }), root));
  act(() => root.querySelector('button')!.click());
  const start = messages.find(message => message.type === 'dictationStart');
  const textareaAfterStart = root.querySelector('textarea')!;
  act(() => { textareaAfterStart.value = 'manual draft'; textareaAfterStart.dispatchEvent(new Event('input', { bubbles: true })); });
  const acknowledged = { ...recording, phase: 'preparing' as const, sessionPath: '/new-session', recordingId: start.recordingId, detail: 'Downloading model…' };
  act(() => render(h(StartHarness, { sessionPath: '/new-session', draft: '', view: acknowledged }), root));
  assert.equal(root.querySelector('textarea')!.value, 'manual draft');
  assert.equal(messages.filter(message => message.type === 'dictationCancel' && message.recordingId === start.recordingId).length, 1);
  assert.ok(messages.some(message => message.type === 'setComposerDraft' && message.sessionPath === '/new-session' && message.text === 'manual draft'));
  await new Promise(resolve => setTimeout(resolve, 510));
  act(() => { root.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); });
  assert.equal(root.querySelector('textarea')!.value, '');
  render(null, root);
});

test('manual edits reverted before a start acknowledgement still cancel and protect the local draft', () => {
  const idle = { ...recording, phase: 'idle' as const, recordingId: null };
  for (const scenario of [
    { initialPath: '/existing-session', ackPath: '/existing-session', initialDraft: 'base' },
    { initialPath: null, ackPath: '/new-session', initialDraft: '' },
  ]) {
    const root = document.createElement('div');
    const messages: any[] = [];
    function Harness({ sessionPath, draft, view }: { sessionPath: string | null; draft: string; view: DictationView }) {
      const input = useComposerInput({ busy: false, dictation: view, onSend() {}, onRetrySend() {}, pendingComposerInputsLength: 0, initialRows: 1, sessionPath, draftText: draft, postMessage(message) { messages.push(message); }, onAddInput() {}, supportsImageInputs: false });
      return h('div', {}, h('textarea', { value: input.text, ref: input.textareaRef, onInput: input.handleInput }), h('button', { onClick: input.toggleDictation }));
    }
    act(() => render(h(Harness, { sessionPath: scenario.initialPath, draft: scenario.initialDraft, view: idle }), root));
    act(() => root.querySelector('button')!.click());
    const start = messages.find(message => message.type === 'dictationStart');
    const textarea = root.querySelector('textarea')!;
    act(() => { textarea.value = 'temporary edit'; textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => { textarea.value = scenario.initialDraft; textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    const acknowledged = { ...recording, phase: 'preparing' as const, sessionPath: scenario.ackPath, recordingId: start.recordingId, detail: 'Downloading model…' };
    act(() => render(h(Harness, { sessionPath: scenario.ackPath, draft: scenario.initialDraft, view: acknowledged }), root));
    assert.equal(root.querySelector('textarea')!.value, scenario.initialDraft);
    assert.equal(messages.filter(message => message.type === 'dictationCancel' && message.recordingId === start.recordingId && message.sessionPath === scenario.ackPath).length, 1);
    assert.ok(messages.some(message => message.type === 'setComposerDraft' && message.sessionPath === scenario.ackPath && message.text === scenario.initialDraft));
    const preview = { ...acknowledged, phase: 'recording' as const };
    act(() => render(h(Harness, { sessionPath: scenario.ackPath, draft: 'voice preview', view: preview }), root));
    assert.equal(root.querySelector('textarea')!.value, scenario.initialDraft);
    render(null, root);
  }
});

test('an unedited null-path start adopts the host draft after a slow acknowledgement', () => {
  const root = document.createElement('div');
  const messages: any[] = [];
  function Harness({ sessionPath, draft, view }: { sessionPath: string | null; draft: string; view: DictationView }) {
    const input = useComposerInput({ busy: false, dictation: view, onSend() {}, onRetrySend() {}, pendingComposerInputsLength: 0, initialRows: 1, sessionPath, draftText: draft, postMessage(message) { messages.push(message); }, onAddInput() {}, supportsImageInputs: false });
    return h('div', {}, h('textarea', { value: input.text, ref: input.textareaRef }), h('button', { onClick: input.toggleDictation }));
  }
  const idle = { ...recording, phase: 'idle' as const, recordingId: null };
  act(() => render(h(Harness, { sessionPath: null, draft: '', view: idle }), root));
  act(() => root.querySelector('button')!.click());
  const start = messages.find(message => message.type === 'dictationStart');
  const preparing = { ...recording, phase: 'preparing' as const, sessionPath: '/new-session', recordingId: start.recordingId, detail: 'Downloading model…' };
  act(() => render(h(Harness, { sessionPath: '/new-session', draft: 'host draft', view: preparing }), root));
  assert.equal(root.querySelector('textarea')!.value, 'host draft');
  assert.equal(messages.some(message => message.type === 'dictationCancel'), false);
  render(null, root);
});

test('unacknowledged starts unlock send and retry with a local error', () => {
  const root = document.createElement('div');
  const messages: any[] = [];
  let sends = 0;
  let ackExpired: (() => void) | null = null;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) => {
    if (delay === 15_000 && typeof callback === 'function') {
      ackExpired = () => callback(...args);
      return 1 as any;
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  function Harness({ commandsAvailable = true, busy = false }: { commandsAvailable?: boolean; busy?: boolean }) {
    const input = useComposerInput({ busy, commandsAvailable, dictation: { ...recording, phase: 'idle', recordingId: null }, onSend() { sends++; return false; }, onRetrySend() { sends++; }, pendingComposerInputsLength: 0, initialRows: 1, sessionPath: '/s', draftText: 'draft', postMessage(message) { messages.push(message); }, onAddInput() {}, supportsImageInputs: false });
    return h('div', {}, h('button', { onClick: input.toggleDictation }, 'mic'), h('button', { onClick: input.sendCurrentText }, 'send'), h('button', { onClick: input.sendAsRetry }, 'retry'), h('output', {}, input.dictationStartError));
  }
  try {
    act(() => render(h(Harness, { commandsAvailable: true, busy: false }), root));
    const buttons = root.querySelectorAll('button');
    act(() => { buttons[0].click(); buttons[1].click(); buttons[2].click(); });
    assert.equal(sends, 0);
    assert.equal(messages.filter(message => message.type === 'dictationStart').length, 1);
    act(() => ackExpired!());
    assert.equal(root.querySelector('output')?.textContent, 'Dictation did not start. Try again.');
    act(() => { buttons[1].click(); buttons[2].click(); });
    assert.equal(sends, 2);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    render(null, root);
  }
});

test('disconnect clears a pending start so reconnect can retry', () => {
  const root = document.createElement('div');
  const messages: any[] = [];
  function Harness({ commandsAvailable }: { commandsAvailable: boolean }) {
    const input = useComposerInput({ busy: false, commandsAvailable, dictation: { ...recording, phase: 'idle', recordingId: null }, onSend() {}, onRetrySend() {}, pendingComposerInputsLength: 0, initialRows: 1, sessionPath: '/s', draftText: '', postMessage(message) { messages.push(message); }, onAddInput() {}, supportsImageInputs: false });
    return h('button', { onClick: input.toggleDictation }, 'mic');
  }
  act(() => render(h(Harness, { commandsAvailable: true }), root));
  act(() => root.querySelector('button')!.click());
  act(() => render(h(Harness, { commandsAvailable: false }), root));
  act(() => render(h(Harness, { commandsAvailable: true }), root));
  act(() => root.querySelector('button')!.click());
  assert.equal(messages.filter(message => message.type === 'dictationStart').length, 2);
  render(null, root);
});

test('matching preparing acknowledgement clears deadline during model download', () => {
  const root = document.createElement('div');
  const messages: any[] = [];
  let ackExpired: (() => void) | null = null;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) => {
    if (delay === 15_000 && typeof callback === 'function') {
      ackExpired = () => callback(...args);
      return 1 as any;
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  function Harness({ view }: { view: DictationView }) {
    const input = useComposerInput({ busy: false, dictation: view, onSend() {}, onRetrySend() {}, pendingComposerInputsLength: 0, initialRows: 1, sessionPath: '/s', draftText: '', postMessage(message) { messages.push(message); }, onAddInput() {}, supportsImageInputs: false });
    return h('button', { onClick: input.toggleDictation }, 'mic');
  }
  try {
    const idle = { ...recording, phase: 'idle' as const, recordingId: null };
    act(() => render(h(Harness, { view: idle }), root));
    act(() => root.querySelector('button')!.click());
    const start = messages.find(message => message.type === 'dictationStart');
    const preparing = { ...recording, phase: 'preparing' as const, recordingId: start.recordingId, detail: 'Downloading model (149 MB)…' };
    act(() => render(h(Harness, { view: preparing }), root));
    act(() => ackExpired!());
    assert.equal(messages.filter(message => message.type === 'dictationStart').length, 1);
    act(() => root.querySelector('button')!.click());
    assert.ok(messages.some(message => message.type === 'dictationStop' && message.recordingId === start.recordingId));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    render(null, root);
  }
});

test('token rate chip is absent while phase and error feedback remain', () => {
  const toolbar = readFileSync(new URL('../../composer/toolbar.tsx', import.meta.url), 'utf8');
  assert.ok(!toolbar.includes("key: 'token-rate'"));
  const ui = readFileSync(new URL('../../shell/ui.tsx', import.meta.url), 'utf8');
  assert.ok(ui.includes('visibleDictation.error ||'));
  assert.ok(!ui.includes('Listening —'));
  assert.ok(!ui.includes("'Finalizing dictation…'"));
  assert.ok(ui.includes("visibleDictation.phase === 'preparing' || visibleDictation.error"));
  assert.ok(ui.includes('visibleDictation.detail'));
});
