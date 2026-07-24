import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getComposerRunControls,
  getSessionTabRunMenuItems,
} from '../../../src/webview/panel/session-tabs/run-state';

test('getSessionTabRunMenuItems exposes the start-new-task action for open runs', () => {
  assert.deepEqual(getSessionTabRunMenuItems({
    runId: 'run-1',
    status: 'open',
    scored: false,
  }), [
    { action: 'startNewTask', label: 'Start new task' },
  ]);
});

test('getSessionTabRunMenuItems offers continuation for closed unscored runs', () => {
  assert.deepEqual(getSessionTabRunMenuItems({
    runId: 'run-2',
    status: 'closed_unscored',
    scored: false,
  }), [
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

test('getComposerRunControls returns no status for open runs without a queued new task', () => {
  assert.deepEqual(getComposerRunControls({
    runId: 'run-open-toolbar',
    status: 'open',
    scored: false,
  }), {
    status: null,
  });
});

test('getComposerRunControls returns no status for closed unscored runs without a queued new task', () => {
  assert.deepEqual(getComposerRunControls({
    runId: 'run-needs-rating',
    status: 'closed_unscored',
    scored: false,
  }), {
    status: null,
  });
});

test('getComposerRunControls returns no status after a run is scored without a queued new task', () => {
  assert.deepEqual(getComposerRunControls({
    runId: 'run-complete',
    status: 'scored',
    scored: true,
  }), {
    status: null,
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
  }), { status: null });
});
