import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from '../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import type { ViewState, WebviewToHostMessage } from '../../../lib/protocol/index.js';
import { useAppBodyDerivedState } from '../../shell/use-app-body-derived-state';
import { useSessionRecovery } from '../../session-tabs/use-session-recovery';

const first = '/sessions/first.jsonl';
const selected = '/sessions/selected.jsonl';
const noop = () => {};
function snapshot(overrides: Partial<ViewState> = {}): ViewState {
  return {
    sessions: [], openTabPaths: [], activeSession: null, backendReady: true, notice: null,
    modelSettings: null, availableModels: [], pendingExtensionUIRequestsBySession: {},
    transcript: [], systemPrompts: [], transcriptLoaded: false, deferredTriggers: [],
    ...overrides,
  } as ViewState;
}

function fixture(run: (update: (state: ViewState) => void, posted: WebviewToHostMessage[], derived: () => ReturnType<typeof useAppBodyDerivedState>) => void) {
  const container = document.createElement('div');
  document.body.append(container);
  const posted: WebviewToHostMessage[] = [];
  const postMessage = (message: WebviewToHostMessage) => { posted.push(message); };
  let result: ReturnType<typeof useAppBodyDerivedState>;
  function Harness({ state }: { state: ViewState }) {
    result = useAppBodyDerivedState(state, postMessage, noop, noop);
    useSessionRecovery(state.backendReady, result.needsSessionRecovery, result.recoverySessionPath, state.notice, postMessage);
    return h('button', {}, 'Manage snoozed sessions');
  }
  try {
    run((state) => act(() => render(h(Harness, { state }), container)), posted, () => result!);
  } finally {
    act(() => render(null, container));
    container.remove();
  }
}

test('expiry after every tab was hidden preserves deliberate host no-selection without recovery or focus', () => fixture((update, posted, derived) => {
  update(snapshot({ activeSessionPath: null }));
  const manage = document.querySelector<HTMLButtonElement>('button')!;
  manage.focus();
  // The host restores the only tab in the background, without selecting it.
  update(snapshot({ activeSessionPath: null, openTabPaths: [first], sessions: [{ path: first, name: 'Restored' } as ViewState['sessions'][number]] }));
  assert.deepEqual(posted, []);
  assert.ok(document.activeElement === manage);
  assert.equal(derived().activeSessionPath, null);
  assert.equal(derived().needsSessionRecovery, false);
  assert.equal(derived().panelSurface, 'empty', 'do not spin on an intentionally unselected transcript');
  assert.equal(derived().hasActiveTabs, false, 'do not mount the selected-session composer');
  assert.equal(derived().showSessionChrome, true, 'restored tabs remain selectable');
  assert.equal(derived().transcriptHydrating, false);
}));

test('missing selected summary recovers the raw host selection rather than the first tab', () => fixture((update, posted, derived) => {
  update(snapshot({ activeSessionPath: selected, openTabPaths: [first, selected], sessions: [{ path: first } as ViewState['sessions'][number]] }));
  assert.equal(derived().needsSessionRecovery, true);
  assert.equal(derived().recoverySessionPath, selected);
  assert.deepEqual(posted, [{ type: 'openSession', sessionPath: selected }]);
}));

test('legacy snapshots without raw selection retain genuine recovery', () => fixture((update, posted, derived) => {
  update(snapshot({ openTabPaths: [first, selected] }));
  assert.equal(derived().needsSessionRecovery, true);
  assert.deepEqual(posted, [{ type: 'openSession', sessionPath: first }]);
}));

test('selected summary and pending selection do not request recovery', () => fixture((update, posted, derived) => {
  update(snapshot({ activeSessionPath: selected, openTabPaths: [selected], activeSession: { path: selected } as ViewState['sessions'][number] }));
  assert.equal(derived().activeSessionPath, selected);
  assert.equal(derived().needsSessionRecovery, false);
  update(snapshot({ activeSessionPath: '__pending__:one', openTabPaths: ['__pending__:one'] }));
  assert.equal(derived().needsSessionRecovery, false);
  assert.deepEqual(posted, []);
}));
