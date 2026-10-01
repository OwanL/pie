import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSessionControlSettingsAcknowledgement,
  validateSessionControlSettingsRequest,
} from '../session-control-settings.js';
import {
  AUTONOMOUS_MODE_BY_SESSION_ENV,
  resolveAutonomousModeForSession,
  readAutonomousModeBySession,
} from '../../../../tool-and-skill-selection/settings/autonomous-mode.js';

test('session-control settings request and acknowledgement preserve narrow typed outcomes', () => {
  const request = validateSessionControlSettingsRequest({
    requestId: 'settings-1',
    sessionPath: '/sessions/root.jsonl',
    action: 'apply',
    settings: { autonomousMode: false, subagentProviderChoices: { openai: true } },
  });
  assert.deepEqual(request.settings, {
    autonomousMode: false,
    subagentProviderChoices: { openai: true },
  });
  assert.deepEqual(validateSessionControlSettingsAcknowledgement({
    requestId: request.requestId,
    sessionPath: request.sessionPath,
    action: 'apply',
    outcome: 'succeeded',
    application: 'pending',
    settings: { autonomousMode: false, subagentProviderChoices: { openai: true } },
  }).application, 'pending');
  assert.throws(() => validateSessionControlSettingsRequest({
    ...request,
    settings: { autonomousMode: false, unrelatedPreference: true },
  }));
  assert.throws(() => validateSessionControlSettingsRequest({
    requestId: 'settings-2',
    sessionPath: '/sessions/root.jsonl',
    action: 'capture',
    settings: { autonomousMode: true },
  }));
});

test('autonomous runtime preference uses root override before shared default', () => {
  const overrides = { '/sessions/one.jsonl': true, '/sessions/two.jsonl': false };
  assert.equal(resolveAutonomousModeForSession('/sessions/one.jsonl', false, overrides), true);
  assert.equal(resolveAutonomousModeForSession('/sessions/two.jsonl', true, overrides), false);
  assert.equal(resolveAutonomousModeForSession('/sessions/other.jsonl', true, overrides), true);
  assert.deepEqual(readAutonomousModeBySession({
    [AUTONOMOUS_MODE_BY_SESSION_ENV]: JSON.stringify(overrides),
  }), overrides);
  assert.deepEqual(readAutonomousModeBySession({ [AUTONOMOUS_MODE_BY_SESSION_ENV]: '{bad' }), {});
});
