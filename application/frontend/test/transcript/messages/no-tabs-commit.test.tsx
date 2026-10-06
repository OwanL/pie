/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from '../../helpers/dom';
installDom();

import { render } from 'preact';
import { act } from 'preact/test-utils';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, EMPTY_TRANSCRIPT_WINDOW, type WebviewToHostMessage } from '../../../../lib/protocol/index.js';
import { transcriptRenderSignature } from '../../../../lib/transcript/render-signature';
import { StateDeliveryController, type StateDeliveryClock, type StateDeliveryRecovery } from '../../../../hosts/lib/renderer-delivery/state-delivery-controller';
import { PanelMain, type PanelMainProps } from '../../../shell/panel-main';
import { TranscriptCommitProvider, type TranscriptCommitTarget } from '../../../transcript/commit-registry';

class Clock implements StateDeliveryClock {
  time = 0;
  next = 0;
  timers = new Map<number, { due: number; callback: () => void }>();
  now() { return this.time; }
  setTimeout(callback: () => void, delay: number) {
    const id = ++this.next;
    this.timers.set(id, { due: this.time + delay, callback });
    return id;
  }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.due <= this.time && this.timers.delete(id)) timer.callback();
    }
  }
}

const noop = () => undefined;
function props(postMessage: PanelMainProps['postMessage']): PanelMainProps {
  return {
    panelSurface: 'empty', hasActiveTabs: false, showSessionChrome: false,
    needsSessionRecovery: false, loadingStatus: 'Loading', activeSessionPath: null,
    activeSession: null, fileChanges: [], fileChangesExpanded: false, readFilePaths: [],
    handlers: {
      handleOpenFileDiff: noop, handleOpenFileInEditor: noop, handleRevertFile: noop,
      handleSetFileChangesExpanded: noop, handleSetFileRead: noop, handleEditRequest: noop,
      handleEditSend: noop, handleCancelEdit: noop, handleOpenFile: noop,
      handleOpenContextMenu: noop, handleNewSession: noop,
    },
    postMessage, mergedTranscript: [], transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW },
    transcriptLoaded: true, availableModels: [], busy: false, compacting: false,
    liveTurnPhase: null, prefs: { ...DEFAULT_CHAT_PREFS }, pruningSettings: { ...DEFAULT_PRUNING_SETTINGS },
    systemPrompts: [], pruningResult: null, pendingAssistantModelId: '',
    pendingAssistantThinkingLevel: 'off', editingMessageId: null, editingDraft: null,
    workspaceCwd: null, openTabPaths: [], onCancelPrepass: noop,
  };
}
function target(revision = 1): TranscriptCommitTarget {
  return {
    revision, viewGeneration: 1, acceptedAt: performance.now(),
    expectedTranscriptIdentity: transcriptRenderSignature({
      activeSession: null, busy: false, prepassPhase: 'idle', retryStatus: null, transcript: [],
    }),
    state: { activeSessionPath: null, openTabPaths: [], transcript: [], transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW } },
  };
}

// Keep paint delivery deterministic so stale target and branch cleanup can be
// checked without relying on happy-dom's timing.
test('startup loading and no-tabs PanelMain prove only empty transcript and release the host deadline', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCaf = globalThis.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  globalThis.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
  const clock = new Clock();
  const recoveries: StateDeliveryRecovery[] = [];
  const messages: WebviewToHostMessage[] = [];
  const commits: number[] = [];
  const defects: unknown[] = [];
  let snapshotState = target().state;
  let postedTarget: TranscriptCommitTarget;
  let forwardEvidence = true;
  const controller = new StateDeliveryController<TranscriptCommitTarget>({
    clock, isEligible: () => true,
    buildSnapshot: (context) => {
      const payload = {
        ...target(context.revision), state: snapshotState, viewGeneration: context.viewGeneration,
        expectedTranscriptIdentity: transcriptRenderSignature({
          activeSession: null, busy: false, prepassPhase: 'idle', retryStatus: null,
          transcript: snapshotState.transcript,
        }),
      };
      postedTarget = payload;
      return { payload, expectedTranscriptIdentity: payload.expectedTranscriptIdentity };
    },
    post: () => true, onRecovery: (event) => recoveries.push(event),
    onProtocolDefect: (event) => defects.push(event), onCommitAdvanced: (revision) => commits.push(revision),
    commitTimeoutMs: 100, settlementTimeoutMs: 100, retryDelayMs: 10,
    maxRetryAttempts: 2, acceptedLedgerCapacity: 8,
  });
  const postMessage = (message: WebviewToHostMessage) => {
    messages.push(message);
    if (!forwardEvidence) return;
    if (message.type === 'appCommitted') controller.appCommitted(message.payload);
    if (message.type === 'transcriptCommitted') controller.transcriptCommitted(message.payload);
    if (message.type === 'paintObserved') controller.paintObserved(message.payload);
  };
  const renderPanel = async (commitTarget: TranscriptCommitTarget, overrides: Partial<PanelMainProps> = {}) => {
    const panelProps = { ...props(postMessage), ...overrides };
    await act(async () => {
      render(
        <TranscriptCommitProvider target={commitTarget} postMessage={postMessage} appSurface={panelProps.panelSurface === 'loading' ? 'loading' : 'empty'}>
          <PanelMain {...panelProps} />
        </TranscriptCommitProvider>, container,
      );
    });
  };
  try {
    controller.markDirty();
    await Promise.resolve();
    await Promise.resolve();
    const acceptedTarget = postedTarget!;
    await renderPanel(acceptedTarget, { panelSurface: 'loading', transcriptLoaded: false });
    assert.match(container.textContent ?? '', /Loading/);
    assert.equal(container.querySelector('.transcript-host'), null, 'no heavy transcript mounted');
    const commit = messages.find((message) => message.type === 'transcriptCommitted');
    assert.ok(commit && commit.type === 'transcriptCommitted');
    assert.equal(commit.payload.identity, acceptedTarget.expectedTranscriptIdentity);
    assert.equal(commit.payload.evidence, 'no-transcript');
    assert.ok(commit.payload.mountGeneration > 0);
    assert.deepEqual(commits, [1]);
    assert.ok(messages.some((message) => message.type === 'appCommitted'));
    for (const [id, frame] of frames) { frames.delete(id); frame(0); }
    assert.ok(messages.some((message) => message.type === 'paintObserved'));
    clock.advance(1_000);
    assert.deepEqual(recoveries, []);
    assert.deepEqual(defects, []);

    // Target object identity, not just numeric counters, owns each delivery.
    messages.length = 0;
    await renderPanel({ ...acceptedTarget });
    assert.match(container.textContent ?? '', /Start a session/);
    assert.equal(messages.filter((message) => message.type === 'transcriptCommitted').length, 1);
    assert.equal(frames.size, 1);

    // Switching to startup loading cancels the prior target's paint, but the
    // new empty target still proves no transcript without marking data loaded.
    const priorFrame = [...frames.keys()][0]!;
    controller.markDirty();
    await Promise.resolve();
    await Promise.resolve();
    messages.length = 0;
    await renderPanel(postedTarget!, { panelSurface: 'loading', transcriptLoaded: false });
    assert.equal(frames.has(priorFrame), false);
    assert.equal(frames.size, 1);
    assert.deepEqual(commits, [1, 2]);
    assert.equal(messages.filter((message) => message.type === 'transcriptCommitted').length, 1);
    const loadingCommit = messages.find((message) => message.type === 'transcriptCommitted');
    assert.ok(loadingCommit && loadingCommit.type === 'transcriptCommitted');
    assert.equal(loadingCommit.payload.identity, postedTarget!.expectedTranscriptIdentity);
    assert.equal(loadingCommit.payload.evidence, 'no-transcript');
    assert.ok(loadingCommit.payload.mountGeneration > commit.payload.mountGeneration);
    for (const [id, frame] of frames) { frames.delete(id); frame(0); }
    assert.ok(messages.some((message) => message.type === 'paintObserved' && message.payload.revision === 2));
    clock.advance(1_000);
    assert.deepEqual(recoveries, []);
    assert.deepEqual(defects, []);

    // Synthetic comparator probes are not accepted controller deliveries.
    forwardEvidence = false;
    // No-tabs/loading DOM cannot bless stale session/row/window expectations.
    const nonEmpty = { ...target(3), state: { ...target().state, transcript: [{ id: 'a', role: 'assistant' as const, status: 'completed' as const, markdown: 'old', createdAt: '2026-10-06T00:00:00Z' }] } };
    const mismatches = [
      { ...target(3), state: { ...target().state, activeSessionPath: '/session/a', openTabPaths: ['/session/a'] } },
      { ...target(3), state: { ...target().state, activeSessionPath: '/session/a' } },
      { ...target(3), state: { ...target().state, openTabPaths: ['/session/a'] } },
      nonEmpty,
      { ...target(3), state: { ...target().state, transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW, totalCount: 1 } } },
    ];
    for (const panelSurface of ['empty', 'loading'] as const) {
      for (const mismatch of mismatches) {
        messages.length = 0;
        await renderPanel(mismatch, { panelSurface });
        assert.equal(messages.some((message) => message.type === 'transcriptCommitted'), false);
        assert.equal(frames.size, 0);
      }
      for (const overrides of [
        { activeSessionPath: '/session/a' },
        { openTabPaths: ['/session/a'] },
        { mergedTranscript: nonEmpty.state.transcript },
        { transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW, totalCount: 1 } },
      ]) {
        messages.length = 0;
        await renderPanel(target(4), { panelSurface, ...overrides });
        assert.equal(messages.some((message) => message.type === 'transcriptCommitted'), false);
      }
      // Matching nonempty windows still do not prove an empty transcript.
      const windowTarget = mismatches.at(-1)!;
      messages.length = 0;
      await renderPanel(windowTarget, { panelSurface, transcriptWindow: windowTarget.state.transcriptWindow });
      assert.equal(messages.some((message) => message.type === 'transcriptCommitted'), false);
    }
    messages.length = 0;
    await renderPanel(target(4), { activeSessionPath: '/session/a', openTabPaths: ['/session/a'] });
    assert.equal(messages.some((message) => message.type === 'transcriptCommitted'), false);
    await renderPanel(target(5), { hasActiveTabs: true, needsSessionRecovery: true });
    assert.equal(messages.some((message) => message.type === 'transcriptCommitted'), false);

    // Real expected rows stalled behind loading never receive transcript/paint
    // evidence; the unchanged host deadline must still trigger recovery.
    forwardEvidence = true;
    snapshotState = nonEmpty.state;
    controller.markDirty();
    await Promise.resolve();
    await Promise.resolve();
    messages.length = 0;
    await renderPanel(postedTarget!, {
      panelSurface: 'loading', transcriptLoaded: false,
      mergedTranscript: snapshotState.transcript,
    });
    assert.ok(messages.some((message) => message.type === 'appCommitted'));
    assert.equal(messages.some((message) => message.type === 'transcriptCommitted' || message.type === 'paintObserved'), false);
    assert.deepEqual(commits, [1, 2]);
    clock.advance(100);
    const completedRecoveries: StateDeliveryRecovery[] = recoveries;
    assert.equal(completedRecoveries.length, 1);
    assert.equal(completedRecoveries[0]?.reason, 'commit-timeout');
    assert.deepEqual(defects, []);
  } finally {
    act(() => render(null, container));
    controller.dispose();
    assert.equal(frames.size, 0);
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
    container.remove();
  }
});
