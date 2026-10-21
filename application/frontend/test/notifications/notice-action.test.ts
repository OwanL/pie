/**
 * useNoticeAction dispatch/decouple contract: the Retry and
 * Retry-without-pruning actions dismiss the error notice only when the
 * re-send actually dispatched (`sendAsRetry` returning `true`). A no-op
 * re-send (empty draft, busy, send-blocked — callback returns `false`, or no
 * registered callback at all) leaves the banner standing so the error it
 * reports is not silently cleared. Other actions keep their existing
 * dismiss / no-dismiss contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { useNoticeAction } from '../../notifications/use-notice-action';
import type { NoticeAction } from '../../../lib/protocol/webview.js';
import type { WebviewToHostMessage } from '../../../lib/protocol/index.js';

type RetrySendFn = (disablePruning?: boolean) => boolean;
type NoticeActionFn = (action: NoticeAction) => void;

const retryRef: { current: RetrySendFn | null } = { current: null };
const handleRef: { current: NoticeActionFn | null } = { current: null };

let container: HTMLElement;

function NoticeActionHarness(props: { postMessage: (msg: WebviewToHostMessage) => void }) {
  handleRef.current = useNoticeAction(props.postMessage, retryRef);
  return null;
}

/** Mount the hook harness over a fresh container; returns the posted messages. */
function mountHarness(): Array<WebviewToHostMessage & { type: string }> {
  const posted: Array<WebviewToHostMessage & { type: string }> = [];
  act(() => {
    render(h(NoticeActionHarness, {
      postMessage: (msg: WebviewToHostMessage) => posted.push(msg as WebviewToHostMessage & { type: string }),
    }), container);
  });
  return posted;
}

function postedTypes(posted: Array<WebviewToHostMessage & { type: string }>): string[] {
  return posted.map((msg) => msg.type);
}

function makeRecordingRetrySend(result: boolean): {
  calls: Array<boolean | undefined>;
  fn: RetrySendFn;
} {
  const calls: Array<boolean | undefined> = [];
  return {
    calls,
    fn: (disablePruning?: boolean) => {
      calls.push(disablePruning);
      return result;
    },
  };
}

test.beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

test.afterEach(() => {
  act(() => { render(null, container); });
  container.remove();
  retryRef.current = null;
  handleRef.current = null;
});

test('retry dismisses the notice when the re-send actually dispatched', () => {
  const posted = mountHarness();
  const retrySend = makeRecordingRetrySend(true);
  retryRef.current = retrySend.fn;

  handleRef.current!('retry');

  assert.deepEqual(retrySend.calls, [undefined], 'plain retry sends without the pruning flag');
  assert.deepEqual(postedTypes(posted), ['dismissNotice'], 'a real dispatch dismisses the banner');
});

test('retry preserves the banner when the re-send no-ops', () => {
  const posted = mountHarness();
  const retrySend = makeRecordingRetrySend(false);
  retryRef.current = retrySend.fn;

  handleRef.current!('retry');

  assert.equal(retrySend.calls.length, 1, 'the registered callback is still invoked');
  assert.deepEqual(posted, [], 'a no-op retry must not dismiss the banner');
});

test('retry preserves the banner when no callback is registered', () => {
  const posted = mountHarness();
  retryRef.current = null;

  handleRef.current!('retry');

  assert.deepEqual(posted, [], 'not dispatched → not dismissed');
});

test('retry-without-pruning dismisses the notice when the re-send dispatched', () => {
  const posted = mountHarness();
  const retrySend = makeRecordingRetrySend(true);
  retryRef.current = retrySend.fn;

  handleRef.current!('retry-without-pruning');

  assert.deepEqual(retrySend.calls, [true], 'pruning disabled before the re-send');
  assert.deepEqual(postedTypes(posted), ['dismissNotice'], 'a real dispatch dismisses the banner');
});

test('retry-without-pruning preserves the banner when the re-send no-ops', () => {
  const posted = mountHarness();
  const retrySend = makeRecordingRetrySend(false);
  retryRef.current = retrySend.fn;

  handleRef.current!('retry-without-pruning');

  assert.equal(retrySend.calls.length, 1);
  assert.deepEqual(posted, [], 'a no-op retry must not dismiss the banner');
});

test('show-logs / open-settings never dismiss; restart-backend still dismisses', () => {
  const posted = mountHarness();
  retryRef.current = () => true;

  handleRef.current!('show-logs');
  handleRef.current!('open-settings');
  // Neither inspection action dismissed the error — it still stands.
  assert.deepEqual(postedTypes(posted), ['showLogs', 'openSettings']);

  handleRef.current!('restart-backend');
  assert.deepEqual(
    postedTypes(posted),
    ['showLogs', 'openSettings', 'restartBackend', 'dismissNotice'],
    'restart addresses the error, so it dismisses the banner',
  );
});