/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from '../../../_helpers/dom';
installDom();

import { render } from 'preact';
import { act } from 'preact/test-utils';

import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, EMPTY_TRANSCRIPT_WINDOW } from '../../../../src/shared/protocol';
import { TranscriptCommitProvider, type TranscriptCommitTarget } from '../../../../src/webview/panel/transcript/commit-registry';
import { TranscriptHost } from '../../../../src/webview/panel/transcript/transcript-host';

const target: TranscriptCommitTarget = {
  revision: 3,
  viewGeneration: 1,
  expectedTranscriptIdentity: 'empty-identity',
  acceptedAt: 0,
  state: {
    transcript: [],
    transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW },
    activeSessionPath: '/session/a',
    openTabPaths: ['/session/a'],
  },
};

test('mounting TranscriptHost emits fresh transcript evidence without another envelope or a leaked paint frame', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const messages: any[] = [];
  const postMessage = (message: any) => messages.push(message);
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCaf = globalThis.cancelAnimationFrame;
  const pendingFrames = new Set<number>();
  let nextFrame = 1;
  globalThis.requestAnimationFrame = ((_: FrameRequestCallback) => {
    const frame = nextFrame++;
    pendingFrames.add(frame);
    return frame;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((frame: number) => {
    pendingFrames.delete(frame);
  }) as typeof cancelAnimationFrame;
  const host = (
    <TranscriptCommitProvider target={target} postMessage={postMessage} appSurface="transcript-suspense">
      <TranscriptHost
        openTabPaths={['/session/a']}
        activeSessionPath="/session/a"
        transcript={[]}
        transcriptWindow={{ ...EMPTY_TRANSCRIPT_WINDOW }}
        transcriptLoaded
        busy={false}
        prefs={{ ...DEFAULT_CHAT_PREFS }}
        pruningSettings={{ ...DEFAULT_PRUNING_SETTINGS }}
        systemPrompts={[]}
        pruningResult={null}
        workingDirectory={null}
        editingId={null}
        onEditRequest={() => undefined}
        onEditConfirm={() => undefined}
        onEditCancel={() => undefined}
        onOpenFile={() => undefined}
        onContextMenu={() => undefined}
        postMessage={postMessage}
      />
    </TranscriptCommitProvider>
  );

  try {
    await act(async () => {
      render(host, container);
      await Promise.resolve();
    });
    const commit = messages.find((message) => message.type === 'transcriptCommitted');
    assert.ok(commit, 'lazy subtree mount should create evidence for the retained target');
    assert.equal(commit.payload.revision, 3);
    assert.equal(commit.payload.identity, 'empty-identity');
    assert.equal(commit.payload.evidence, 'no-transcript');
    assert.ok(commit.payload.mountGeneration > 0);
  } finally {
    act(() => render(null, container));
    assert.equal(pendingFrames.size, 0, 'unmount must cancel the pending paint frame');
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
    container.remove();
  }
});
