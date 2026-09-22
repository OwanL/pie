import assert from 'node:assert/strict';
import test from 'node:test';

import { getSessionTabTooltip } from '../../src/webview/panel/session-tabs/session-tab';

test('agent-created session tab appends provenance to its existing tooltip', () => {
  assert.equal(getSessionTabTooltip(true), 'Agent-created session');
  assert.equal(
    getSessionTabTooltip(true, 'Session (waiting for your answer)'),
    'Session (waiting for your answer) · Agent-created session',
  );
  assert.equal(getSessionTabTooltip(false, 'Session (finished, unread)'), 'Session (finished, unread)');
  assert.equal(getSessionTabTooltip(undefined), undefined);
});
