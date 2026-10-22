import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useComposerInput } from '../../composer/hooks';
import { useAppHandlers } from '../../shell/use-app-handlers';
import type { WebviewToHostMessage } from '../../../lib/protocol/index.js';

for (const source of ['paste', 'drop'] as const) {
  for (const transition of ['same', 'session', 'round-trip', 'model', 'disconnect', 'unmount', 'selection-gap'] as const) {
    test(`${source} delayed image ownership: ${transition}`, async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const messages: WebviewToHostMessage[] = [];
      const activeRef = { current: '/A' as string | null };
      const post = (message: WebviewToHostMessage) => { messages.push(message); return true; };
      let composer!: ReturnType<typeof useComposerInput>;
      type HarnessProps = { path: string; images: boolean; available: boolean };
      function Harness({ path, images, available }: HarnessProps) {
        const handlers = useAppHandlers(post, activeRef, () => {}, () => {}, false, () => {}, () => {}, available);
        composer = useComposerInput({ busy: false, onSend: () => {}, onRetrySend: () => {},
          pendingComposerInputsLength: 0, initialRows: 1, sessionPath: path, draftText: '',
          postMessage: post, onAddInput: handlers.handleAddComposerInput, supportsImageInputs: images,
          commandsAvailable: available });
        return null;
      }
      let resolve!: (buffer: ArrayBuffer) => void;
      const transfer = { files: [{ name: 'image.gif', type: 'image/gif', size: 1,
        arrayBuffer: () => new Promise<ArrayBuffer>((done) => { resolve = done; }) }] } as unknown as DataTransfer;
      try {
        const initialProps: HarnessProps = { path: '/A', images: true, available: true };
        act(() => render(h(Harness, initialProps), container));
        const completion = composer.applyComposerTransfer(transfer, source);
        if (transition === 'session' || transition === 'round-trip') {
          activeRef.current = '/B';
          act(() => render(h(Harness, { ...initialProps, path: '/B' }), container));
          if (transition === 'round-trip') {
            activeRef.current = '/A';
            act(() => render(h(Harness, initialProps), container));
          }
        } else if (transition === 'model') {
          act(() => render(h(Harness, { ...initialProps, images: false }), container));
        } else if (transition === 'disconnect') {
          act(() => render(h(Harness, { ...initialProps, available: false }), container));
          act(() => render(h(Harness, initialProps), container));
        } else if (transition === 'unmount') {
          act(() => render(null, container));
        } else if (transition === 'selection-gap') {
          activeRef.current = '/B';
        }
        if (transition === 'session' || transition === 'round-trip' || transition === 'disconnect') {
          assert.equal(composer.transferPending, false);
        }
        await act(async () => { resolve(new Uint8Array([1]).buffer); await completion; });
        const additions = messages.filter((message) => message.type === 'addComposerInput');
        assert.equal(additions.length, transition === 'same' ? 1 : 0);
        if (additions[0]?.type === 'addComposerInput') assert.equal(additions[0].sessionPath, '/A');
        if (transition === 'model') assert.match(composer.attachmentError ?? '', /does not support image/);
      } finally {
        act(() => render(null, container));
        container.remove();
      }
    });
  }
}

for (const reject of [false, true]) {
  for (const attachedOnly of [false, true]) {
  test(`pending image guards send until settled: rejection=${reject}, attachedOnly=${attachedOnly}`, async () => {
    const container = document.createElement('div');
    let composer!: ReturnType<typeof useComposerInput>;
    const sent: string[] = [];
    const added: unknown[] = [];
    function Harness() {
      composer = useComposerInput({ busy: false, onSend: (text) => { sent.push(text); },
        onRetrySend: (text) => { sent.push(text); }, pendingComposerInputsLength: attachedOnly ? 1 : 0,
        initialRows: 1, sessionPath: '/A', draftText: attachedOnly ? '' : 'prompt', postMessage: () => {},
        onAddInput: (input) => { added.push(input); }, supportsImageInputs: true });
      return null;
    }
    const controls: Array<{ resolve: (value: ArrayBuffer) => void; reject: (error: Error) => void }> = [];
    const transfer = (name: string) => ({ files: [{ name, type: 'image/gif', size: 1,
      arrayBuffer: () => new Promise<ArrayBuffer>((resolve, reject) => { controls.push({ resolve, reject }); }),
    }] }) as unknown as DataTransfer;
    try {
      act(() => render(h(Harness, {}), container));
      let first!: Promise<void>;
      let second!: Promise<void>;
      act(() => { first = composer.applyComposerTransfer(transfer('first.gif'), 'paste'); second = composer.applyComposerTransfer(transfer('second.gif'), 'drop'); });
      assert.equal(composer.transferPending, true);
      act(() => composer.sendCurrentText());
      assert.equal(composer.sendAsRetry(), false);
      assert.equal(composer.text, attachedOnly ? '' : 'prompt');
      assert.deepEqual(sent, []);
      await act(async () => { controls[1].resolve(new ArrayBuffer(1)); await Promise.resolve(); });
      assert.deepEqual(added, []);
      await act(async () => {
        if (reject) controls[0].reject(new Error('failed read'));
        else controls[0].resolve(new ArrayBuffer(1));
        await Promise.all([first, second]);
      });
      // An unreadable image remains visible as an unsupported file chip.
      assert.deepEqual(added, [
        { kind: reject ? 'fileBlob' : 'imageBlob', mimeType: 'image/gif', name: 'first.gif',
          sizeBytes: 1, dataBase64: reject ? '' : 'AA==', source: 'paste' },
        { kind: 'imageBlob', mimeType: 'image/gif', name: 'second.gif',
          sizeBytes: 1, dataBase64: 'AA==', source: 'drop' },
      ]);
      assert.equal(composer.transferPending, false);
      assert.deepEqual(sent, []);
      act(() => composer.sendCurrentText());
      assert.deepEqual(sent, [attachedOnly ? '' : 'prompt']);
      assert.equal(added.length, 2);
    } finally { act(() => render(null, container)); container.remove(); }
  });
  }
}

for (const transition of ['same', 'session', 'alias'] as const) {
  test(`attachment error ownership: ${transition}`, async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let composer!: ReturnType<typeof useComposerInput>;
    function Harness({ path, resolvedPendingPath }: { path: string; resolvedPendingPath?: string }) {
      composer = useComposerInput({ busy: false, onSend: () => {}, onRetrySend: () => {},
        pendingComposerInputsLength: 0, initialRows: 1, sessionPath: path, resolvedPendingPath, draftText: '',
        postMessage: () => {}, onAddInput: () => {}, supportsImageInputs: false,
        commandsAvailable: true });
      return null;
    }
    const initialPath = transition === 'alias' ? '__pending__:A' : '/A';
    const image = (arrayBuffer: () => Promise<ArrayBuffer>) => ({ files: [
      { name: 'image.gif', type: 'image/gif', size: 1, arrayBuffer },
    ] }) as unknown as DataTransfer;
    let resolve!: (buffer: ArrayBuffer) => void;
    try {
      act(() => render(h(Harness, { path: initialPath }), container));
      await act(async () => { await composer.applyComposerTransfer(image(async () => new ArrayBuffer(1)), 'paste'); });
      const error = composer.attachmentError;
      assert.match(error ?? '', /does not support image/);
      const completion = composer.applyComposerTransfer(image(() => new Promise((done) => { resolve = done; })), 'drop');
      const path = transition === 'session' ? '/B' : transition === 'alias' ? '/A' : initialPath;
      act(() => render(h(Harness, { path, resolvedPendingPath: transition === 'alias' ? initialPath : undefined }), container));
      assert.equal(composer.attachmentError, transition === 'session' ? null : error);
      await act(async () => { resolve(new ArrayBuffer(1)); await completion; });
      assert.equal(composer.attachmentError, transition === 'session' ? null : error);
    } finally {
      act(() => render(null, container));
      container.remove();
    }
  });
}
