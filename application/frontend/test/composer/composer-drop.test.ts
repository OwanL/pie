import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useComposerDragDrop } from '../../composer/hooks';

for (const text of ['ordinary text', 'https://example.com', '/tmp/report.txt', 'file:///tmp/%ZZ']) {
  test(`drop native insertion versus attachment: ${text}`, () => {
    const container = document.createElement('div');
    let drop!: ReturnType<typeof useComposerDragDrop>;
    let handled = 0;
    let prevented = false;
    function Harness() {
      drop = useComposerDragDrop({ applyComposerTransfer: async () => { handled++; } });
      return null;
    }
    const dataTransfer = { types: ['text/plain'], getData: (type: string) => type === 'text/plain' ? text : '' } as unknown as DataTransfer;
    const event = { dataTransfer, preventDefault: () => { prevented = true; } } as unknown as DragEvent;
    try {
      act(() => render(h(Harness, {}), container));
      act(() => drop.handleDragOver(event));
      assert.equal(drop.isDragActive, true);
      prevented = false;
      act(() => drop.handleDrop(event));
      assert.equal(drop.isDragActive, false);
      const attachment = text.startsWith('/') || text.startsWith('file:');
      assert.equal(prevented, attachment);
      assert.equal(handled, attachment ? 1 : 0);
    } finally { act(() => render(null, container)); container.remove(); }
  });
}
