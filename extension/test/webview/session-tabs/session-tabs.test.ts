import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPOSER_MARK_DONE_ACTION,
  getComposerRunControls,
  getSessionTabRunMenuItems,
} from '../../../src/webview/panel/session-tabs/run-state';

test('getSessionTabRunMenuItems exposes completion and task actions for open runs', () => {
  assert.deepEqual(getSessionTabRunMenuItems({
    runId: 'run-1',
    status: 'open',
    scored: false,
  }), [
    { action: 'recordOutcome', label: 'Mark tab as complete…' },
    { action: 'startNewTask', label: 'Start new task' },
  ]);
});

test('getSessionTabRunMenuItems keeps outcome capture available for closed unscored runs', () => {
  assert.deepEqual(getSessionTabRunMenuItems({
    runId: 'run-2',
    status: 'closed_unscored',
    scored: false,
  }), [
    { action: 'recordOutcome', label: 'Rate completed run…' },
    { action: 'continueTask', label: 'Continue task' },
    { action: 'startNewTask', label: 'Start new task' },
  ]);
});

test('getSessionTabRunMenuItems offers continuation for scored runs', () => {
  assert.deepEqual(getSessionTabRunMenuItems({
    runId: 'run-3',
    status: 'scored',
    scored: true,
  }), [
    { action: 'continueTask', label: 'Continue task' },
    { action: 'startNewTask', label: 'Start new task' },
  ]);
});

test('getSessionTabRunMenuItems returns no actions when there is no active run', () => {
  assert.deepEqual(getSessionTabRunMenuItems(null), []);
});

test('getComposerRunControls returns a completion action for open runs', () => {
  const controls = getComposerRunControls({
    runId: 'run-open-toolbar',
    status: 'open',
    scored: false,
  });

  assert.deepEqual(controls, {
    status: null,
    action: COMPOSER_MARK_DONE_ACTION,
  });
  assert.strictEqual(controls.action, COMPOSER_MARK_DONE_ACTION);
});

test('getComposerRunControls keeps the mark-done action available for closed unscored runs', () => {
  const controls = getComposerRunControls({
    runId: 'run-needs-rating',
    status: 'closed_unscored',
    scored: false,
  });

  assert.deepEqual(controls, {
    status: null,
    action: COMPOSER_MARK_DONE_ACTION,
  });
  assert.strictEqual(controls.action, COMPOSER_MARK_DONE_ACTION);
});

test('getComposerRunControls returns outcome-saved status after a run is scored', () => {
  assert.deepEqual(getComposerRunControls({
    runId: 'run-complete',
    status: 'scored',
    scored: true,
  }), {
    status: {
      text: 'Outcome saved',
      tone: 'subtle',
      title: 'Local outcome saved. Send another message to continue this task, or queue a new one.',
    },
    action: null,
  });
});

test('getComposerRunControls surfaces queued new-task state', () => {
  assert.deepEqual(getComposerRunControls({
    runId: 'run-queued',
    status: 'scored',
    scored: true,
    nextSendStartsNewTask: true,
  }), {
    status: {
      text: 'New task queued',
      tone: 'subtle',
      title: 'The next send will start a new task group instead of continuing the completed one.',
    },
    action: null,
  });
});

test('run-state helpers handle queued states and unknown statuses defensively', () => {
  assert.deepEqual(getComposerRunControls({
    runId: 'run-open-queued',
    status: 'open',
    scored: false,
    nextSendStartsNewTask: true,
  }), {
    status: {
      text: 'New task queued',
      tone: 'subtle',
      title: 'The next send will close the current run and start a new task group.',
    },
    action: COMPOSER_MARK_DONE_ACTION,
  });

  assert.deepEqual(getComposerRunControls({
    runId: 'run-closed-queued',
    status: 'closed_unscored',
    scored: false,
    nextSendStartsNewTask: true,
  }), {
    status: {
      text: 'New task queued',
      tone: 'subtle',
      title: 'The next send will start a new task group after this completed run.',
    },
    action: COMPOSER_MARK_DONE_ACTION,
  });

  assert.deepEqual(getSessionTabRunMenuItems({
    runId: 'run-unknown',
    status: 'mystery' as never,
    scored: false,
  }), []);
  assert.deepEqual(getComposerRunControls({
    runId: 'run-unknown',
    status: 'mystery' as never,
    scored: false,
  }), { status: null, action: null });
});
