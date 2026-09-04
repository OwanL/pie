import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import { selectViewState } from '../../../../src/host/core/projection';
import { reducer } from '../../../../src/host/core/reducer';
import { createOperationalIncident } from '../../../../src/shared/incidents';
import type { ChatMessage } from '../../../../src/shared/protocol';

function assistant(id: string, status: ChatMessage['status'] = 'completed'): ChatMessage {
  return {
    id,
    role: 'assistant',
    createdAt: '2026-09-05T00:00:00.000Z',
    markdown: id,
    status,
  };
}

test('a delayed incident stamps only its exact assistant message after a newer turn', () => {
  const state = createInitialArchState();
  state.transcript.bySession['/session'] = [
    assistant('assistant-old'),
    { id: 'user-new', role: 'user', createdAt: '2026-09-05T00:01:00.000Z', markdown: 'new', status: 'completed' },
    assistant('assistant-new'),
  ];

  const result = reducer(state, {
    kind: 'AssistantMessageErrorStamped',
    sessionPath: '/session',
    requestId: 'req-old',
    turnId: 'turn-old',
    messageId: 'assistant-old',
    errorMessage: 'old turn failed',
  });

  assert.equal(result.state.transcript.bySession['/session']?.[0]?.status, 'error');
  assert.equal(result.state.transcript.bySession['/session']?.[0]?.errorDetail, 'old turn failed');
  assert.equal(result.state.transcript.bySession['/session']?.[2]?.status, 'completed');
  assert.equal(result.state.transcript.bySession['/session']?.[2]?.errorDetail, undefined);
});

test('continuation failure before a row exists never stamps the prior assistant', () => {
  const state = createInitialArchState();
  state.transcript.bySession['/session'] = [assistant('prior-interrupted', 'interrupted')];

  const result = reducer(state, {
    kind: 'AssistantMessageErrorStamped',
    sessionPath: '/session',
    operationId: '64e84c7a-b210-4eb6-a17b-38d59b1cbf33',
    requestId: 'req-continue',
    errorMessage: 'continue rejected before message_start',
  });

  assert.equal(result.state.transcript.bySession['/session']?.[0]?.status, 'interrupted');
  assert.equal(result.state.transcript.bySession['/session']?.[0]?.errorDetail, undefined);
});

test('warning and info incidents remain non-error notices', () => {
  for (const severity of ['warning', 'info'] as const) {
    const incident = createOperationalIncident({
      sessionPath: '/session',
      requestId: `req-${severity}`,
      severity,
      certainty: 'definitive',
      phase: 'extension',
      code: 'EXTENSION_NOTIFICATION',
      message: `${severity} notice`,
      // Even a malformed producer eligibility cannot make a non-error
      // severity actionable at the renderer boundary.
      recovery: { retry: true, showLogs: true },
    });
    const state = createInitialArchState();
    state.sessions.activeSessionPath = '/session';
    const result = reducer(state, { kind: 'IncidentReported', incident });
    assert.equal(result.state.settings.notice, `${severity} notice`);
    assert.equal(result.state.settings.noticeKind, null);
    assert.equal(result.state.settings.noticeRaw, null);
    assert.equal(result.state.settings.latestIncident?.severity, severity);
    assert.deepEqual(selectViewState(result.state).noticeActions, []);
  }
});

test('typed recovery eligibility is projected without exposing incident identity', () => {
  const incident = createOperationalIncident({
    sessionPath: '/session', requestId: 'req-retry', severity: 'error', certainty: 'ambiguous',
    phase: 'provider', code: 'PROVIDER_RATE_LIMITED', message: 'Rate limited.',
    recovery: { retry: true, restart: false, showLogs: true },
  });
  const state = createInitialArchState();
  state.sessions.activeSessionPath = '/session';
  const reduced = reducer(state, { kind: 'IncidentReported', incident }).state;
  const view = selectViewState(reduced);

  assert.deepEqual(view.noticeActions, ['retry', 'show-logs']);
  assert.equal('latestIncident' in view, false);
});

test('renderer projection redacts credentials and internal identities from notice and transcript detail', () => {
  const state = createInitialArchState();
  const raw = [
    'Request: req-provider-1',
    'Operation ID: 64e84c7a-b210-4eb6-a17b-38d59b1cbf33',
    'Correlation ID: corr-internal-7',
    'Authorization: Bearer secret-token-value',
  ].join('\n');
  state.sessions.activeSessionPath = '/session';
  state.transcript.bySession['/session'] = [{ ...assistant('assistant-error', 'error'), errorDetail: raw }];
  state.settings.notice = raw;
  state.settings.noticeKind = 'operational-error';
  state.settings.noticeRaw = raw;
  state.settings.noticeSessionPath = '/session';

  const view = selectViewState(state);
  assert.equal(state.settings.noticeRaw, raw, 'host diagnostic remains intact');
  assert.equal(state.transcript.bySession['/session']?.[0]?.errorDetail, raw, 'durable host detail remains intact');
  for (const visible of [view.notice, view.noticeRaw, view.transcript[0]?.errorDetail]) {
    assert.ok(visible);
    assert.doesNotMatch(visible, /req-provider-1|64e84c7a-b210-4eb6-a17b-38d59b1cbf33|corr-internal-7|secret-token-value/);
  }
});
