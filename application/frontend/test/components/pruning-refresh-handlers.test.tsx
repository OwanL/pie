import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import type { WebviewToHostMessage } from '../../../lib/protocol/index.js';
import { useAppHandlers, type AppHandlers } from '../../shell/use-app-handlers';

test('refresh command is passive, explicitly addressed, busy-safe and transport gated', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const activePath: { current: string | null } = { current: '/sessions/one.jsonl' };
  const posted: WebviewToHostMessage[] = [];
  let handlers: AppHandlers;
  let accepted = true;
  const transport = (message: WebviewToHostMessage) => { posted.push(message); return accepted; };
  const unexpected = () => assert.fail('refresh must not change draft, optimistic messages or interrupt state');
  function Harness({ available }: { available: boolean }) {
    handlers = useAppHandlers(transport, activePath, unexpected, unexpected, true, unexpected, unexpected, available);
    return null;
  }
  try {
    act(() => render(h(Harness, { available: true }), container));
    handlers!.handleSetPruningRefreshPending(true);
    accepted = false;
    handlers!.handleSetPruningRefreshPending(true);
    activePath.current = '/sessions/two.jsonl';
    handlers!.handleSetPruningRefreshPending(false);
    assert.deepEqual(posted, [
      { type: 'setPruningRefreshPending', sessionPath: '/sessions/one.jsonl', pending: true },
      { type: 'setPruningRefreshPending', sessionPath: '/sessions/one.jsonl', pending: true },
      { type: 'setPruningRefreshPending', sessionPath: '/sessions/two.jsonl', pending: false },
    ]);
    activePath.current = null;
    handlers!.handleSetPruningRefreshPending(true);
    activePath.current = '/sessions/two.jsonl';
    act(() => render(h(Harness, { available: false }), container));
    handlers!.handleSetPruningRefreshPending(true);
    assert.equal(posted.length, 3);
  } finally {
    render(null, container);
    container.remove();
  }
});
