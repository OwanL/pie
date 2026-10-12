import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import test from 'node:test';

import type { RendererCommandContext, WebviewToHostMessage } from '../../../lib/protocol/index.js';
import { createInitialArchState, reducer } from '../../conversation-state/reducer.js';
import { EffectRunner } from '../../conversation-state/effects/effect-runner.js';
import { makeEffectRunnerDeps } from '../helpers/effect-runner-deps.js';

let restoreVscode: (() => void) | undefined;
let MessageRouterCtor: typeof import('../../conversation-state/message-router.js').MessageRouter;
test.before(async () => {
  const patched = Module as typeof Module & { _load: (...args: any[]) => unknown };
  const load = patched._load;
  patched._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') return { EventEmitter: class<T> {
      private emitter = new EventEmitter();
      readonly event = (listener: (value: T) => void) => { this.emitter.on('event', listener); return { dispose: () => this.emitter.off('event', listener) }; };
    } };
    return load.call(this, request, parent, isMain);
  };
  restoreVscode = () => { patched._load = load; };
  ({ MessageRouter: MessageRouterCtor } = await import('../../conversation-state/message-router.js'));
});
test.after(() => restoreVscode?.());

const startMessage: Extract<WebviewToHostMessage, { type: 'dictationStart' }> = {
  type: 'dictationStart', sessionPath: null, recordingId: 'capture-1', draftText: 'say this', selectionStart: 4, selectionEnd: 8,
};
function routerFixture() {
  const initial = createInitialArchState();
  const state = { ...initial, sessions: { ...initial.sessions, activeSessionPath: 'pending:1', openTabPaths: ['pending:1'] },
    dictation: { ...initial.dictation, available: true } };
  const events: any[] = [];
  const notices: any[] = [];
  const router = new MessageRouterCtor((event) => { events.push(event); }, () => state,
    { createNewSession: () => 'pending:1' } as never,
    { postImperative() {}, isRendererOwnerCurrent: () => true } as never,
    () => {}, (text) => ({ name: text, isPlaceholder: false }), () => false);
  return { router, state, events, notices };
}
const local: RendererCommandContext = { rendererId: 'renderer-local', rendererGeneration: 3, kind: 'vscode' };
const remote: RendererCommandContext = { rendererId: 'renderer-remote', rendererGeneration: 9, kind: 'browser' };

test('trusted local ingress captures renderer identity and selected draft range', async () => {
  const h = routerFixture();
  await h.router.handle(startMessage, local);
  assert.equal(h.events.length, 2);
  const start = h.events[1].cmd;
  assert.deepEqual({ kind: start.kind, recordingId: start.recordingId, sessionPath: start.sessionPath,
    rendererId: start.rendererId, rendererGeneration: start.rendererGeneration,
    draftText: start.draftText, selectionStart: start.selectionStart, selectionEnd: start.selectionEnd }, {
    kind: 'DictationStart', recordingId: 'capture-1', sessionPath: 'pending:1', rendererId: local.rendererId,
    rendererGeneration: local.rendererGeneration, draftText: 'say this', selectionStart: 4, selectionEnd: 8,
  });
  let state = reducer(h.state, h.events[0]).state;
  state = reducer(state, h.events[1]).state;
  assert.equal(state.dictation.capture?.rendererId, local.rendererId);
  assert.equal(state.dictation.capture?.prefix, 'say ');
  assert.equal(state.dictation.capture?.selectedText, 'this');
});

test('remote renderer cannot start local audio, even with an untrusted microphone claim', async () => {
  const h = routerFixture();
  await h.router.handle(startMessage, remote);
  await h.router.handle({ ...startMessage, hostMicrophoneAllowed: true } as never, remote);
  assert.deepEqual(h.events.filter((event) => event.kind === 'Command'), []);
});

test('wrong-renderer stop is a reducer no-op and renderer invalidation cancels its capture', async () => {
  const h = routerFixture();
  await h.router.handle(startMessage, local);
  let state = reducer(h.state, h.events[0]).state;
  state = reducer(state, h.events[1]).state;
  const before = state;
  await h.router.handle({ type: 'dictationStop', sessionPath: 'pending:1', recordingId: 'capture-1' },
    { rendererId: 'renderer-other', rendererGeneration: 1, kind: 'vscode' });
  const wrongStop = h.events.at(-1);
  assert.equal(reducer(state, wrongStop).state, before);
  const invalidated = reducer(state, { kind: 'DictationRendererInvalidated', rendererId: local.rendererId, rendererGeneration: local.rendererGeneration });
  assert.equal(invalidated.state.dictation.capture, null);
  assert.deepEqual(invalidated.effects, [{ kind: 'DictationControl', action: 'cancel', recordingId: 'capture-1' }]);
});

test('dictation effects serialize start, cancel, and replacement start; disposal drops late observations', async () => {
  const calls: string[] = [];
  let releaseStart!: (value: void) => void;
  let observation!: (value: import('../../../lib/protocol/dictation.js').DictationObservation) => void;
  const { deps } = makeEffectRunnerDeps();
  const dispatched: any[] = [];
  deps.dispatchEvent = (event) => { dispatched.push(event); };
  deps.dictation = {
    start: async (_id, observe) => { calls.push('start-1'); observation = observe; await new Promise<void>((resolve) => { releaseStart = resolve; }); },
    cancel: async () => { calls.push('cancel'); },
    stop: async () => { calls.push('stop'); },
  };
  const runner = new EffectRunner(deps);
  runner.run({ kind: 'DictationControl', action: 'start', recordingId: 'one' });
  runner.run({ kind: 'DictationControl', action: 'cancel', recordingId: 'one' });
  runner.run({ kind: 'DictationControl', action: 'start', recordingId: 'two' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['start-1']);
  releaseStart();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['start-1', 'cancel', 'start-1']);
  runner.dispose();
  observation({ kind: 'transcript', text: 'late', final: true });
  assert.deepEqual(dispatched, []);
});
