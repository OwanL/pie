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
  }), [
    { action: 'startNewTask', label: 'Start new task' },
  ]);
});

test('getSessionTabRunMenuItems offers continuation for closed runs', () => {
  assert.deepEqual(getSessionTabRunMenuItems({
    runId: 'run-2',
    status: 'closed',
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
  }), {
    status: null,
  });
});

test('getComposerRunControls returns no status for closed runs without a queued new task', () => {
  assert.deepEqual(getComposerRunControls({
    runId: 'run-closed',
    status: 'closed',
  }), {
    status: null,
  });
});

test('getComposerRunControls surfaces queued new-task state', () => {
  assert.deepEqual(getComposerRunControls({
    runId: 'run-queued',
    status: 'closed',
    nextSendStartsNewTask: true,
  }), {
    status: {
      text: 'New task queued',
      tone: 'subtle',
      title: 'The next send will start a new task group after this completed run.',
    },
  });
});

test('run-state helpers handle queued states and unknown statuses defensively', () => {
  assert.deepEqual(getComposerRunControls({
    runId: 'run-open-queued',
    status: 'open',
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
    status: 'closed',
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
  }), []);
  assert.deepEqual(getComposerRunControls({
    runId: 'run-unknown',
    status: 'mystery' as never,
  }), { status: null });
});
