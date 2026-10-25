/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../helpers/dom';
installDom();
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { ComposerAttachments } from '../../composer/attachments';
import type { ComposerInput } from '../../../lib/protocol/index.js';

for (const owner of ['composer', 'inline-editor']) for (const kind of ['filesystemPathRef', 'imageBlob'] as const) {
  test(`${owner} ${kind} attachment removal keeps focus on next, previous, then owning textarea`, () => {
    const container = document.createElement('div');
    document.body.append(container);
    function Harness() {
      const [inputs, setInputs] = useState<ComposerInput[]>(['one', 'two', 'three'].map((id): ComposerInput => kind === 'imageBlob'
        ? { id, kind, name: `${id}.txt`, mimeType: 'image/png', dataBase64: 'abc', sizeBytes: 3, source: 'paste' }
        : { id, kind, path: `/${id}.txt`, name: `${id}.txt`, source: 'picker' }));
      return <><textarea aria-label="Other composer" /><div class={owner}>
        <ComposerAttachments pendingComposerInputs={inputs} attachmentSummary="Files"
          onRemoveInput={id => setInputs(previous => previous.filter(input => input.id !== id))} />
        <textarea aria-label="Owner" />
      </div></>;
    }
    try {
      act(() => render(<Harness />, container));
      const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('.attachment-card-remove')];
      assert.deepEqual(buttons().map(button => button.getAttribute('aria-label')), ['Remove one.txt', 'Remove two.txt', 'Remove three.txt']);
      buttons()[1].focus();
      act(() => buttons()[1].click());
      assert.ok(document.activeElement === buttons()[1]);
      act(() => buttons()[1].click());
      assert.ok(document.activeElement === buttons()[0]);
      act(() => buttons()[0].click());
      assert.ok(document.activeElement === container.querySelector('[aria-label="Owner"]'));
    } finally {
      act(() => render(null, container));
      container.remove();
    }
  });
}

test('removing an unfocused attachment does not steal focus', () => {
  const container = document.createElement('div');
  document.body.append(container);
  function Harness() {
    const [inputs, setInputs] = useState<ComposerInput[]>([{ id: 'one', kind: 'filesystemPathRef', path: '/one.txt' } as ComposerInput]);
    return <div><ComposerAttachments pendingComposerInputs={inputs} attachmentSummary="File" onRemoveInput={() => setInputs([])} /><textarea /></div>;
  }
  try {
    act(() => render(<Harness />, container));
    const textarea = container.querySelector('textarea')!;
    textarea.focus();
    act(() => container.querySelector('button')!.click());
    assert.ok(document.activeElement === textarea);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
});
