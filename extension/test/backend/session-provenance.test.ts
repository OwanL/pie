import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_CREATED_SESSION_CUSTOM_TYPE,
  appendAgentCreatedSessionProvenance,
  isAgentCreatedSession,
} from '../../src/backend/session-provenance';

function manager(sessionId: string, dataSessionId = sessionId) {
  const entries: Array<{
    id: string;
    timestamp: string;
    type: string;
    customType?: string;
    data?: unknown;
  }> = [{
    id: 'marker',
    timestamp: new Date(0).toISOString(),
    type: 'custom',
    customType: AGENT_CREATED_SESSION_CUSTOM_TYPE,
    data: { version: 1, sessionId: dataSessionId },
  }];
  return {
    getSessionId: () => sessionId,
    getHeader: () => ({ id: sessionId }),
    getEntries: () => entries,
    appendCustomEntry: (customType: string, data?: unknown) => {
      entries.push({ id: 'appended', timestamp: new Date(0).toISOString(), type: 'custom', customType, data });
      return 'appended';
    },
  };
}

test('agent-created provenance is explicit and session-identity bound', () => {
  assert.equal(isAgentCreatedSession(manager('session-a')), true);
  assert.equal(isAgentCreatedSession(manager('session-b', 'session-a')), false);

  const created = manager('session-c');
  created.getEntries().length = 0;
  appendAgentCreatedSessionProvenance(created);
  assert.equal(isAgentCreatedSession(created), true);
  assert.deepEqual(created.getEntries()[0]?.data, { version: 1, sessionId: 'session-c' });
});
