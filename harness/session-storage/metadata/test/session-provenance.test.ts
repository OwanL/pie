import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_CREATED_SESSION_CUSTOM_TYPE,
  appendAgentCreatedSessionProvenance,
  isAgentCreatedSession,
} from '../session-provenance';

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

test('rejects malformed and unrelated provenance entries', () => {
  const current = manager('session-a');
  const marker = current.getEntries()[0]!;
  const invalidEntries = [
    { ...marker, type: 'message' },
    { ...marker, customType: 'another-extension' },
    ...[undefined, null, 'session-a', [], { version: 2, sessionId: 'session-a' },
      { version: '1', sessionId: 'session-a' }, { version: 1 },
      { version: 1, sessionId: 'session-b' }].map((data) => ({ ...marker, data })),
  ];
  for (const entry of invalidEntries) {
    current.getEntries().splice(0, 1, entry);
    assert.equal(isAgentCreatedSession(current), false, JSON.stringify(entry));
  }
  // An unrelated entry must not hide a later, identity-bound marker.
  current.getEntries().push(marker);
  assert.equal(isAgentCreatedSession(current), true);
});

test('falls back to a durable header identity and trims ids when appending', () => {
  const current = manager('session-a');
  const fallback = { ...current, getSessionId: () => ' ', getHeader: () => ({ id: ' session-a ' }) };
  assert.equal(isAgentCreatedSession(fallback), true);
  fallback.getEntries().length = 0;
  appendAgentCreatedSessionProvenance(fallback);
  assert.deepEqual(fallback.getEntries()[0]?.data, { version: 1, sessionId: 'session-a' });
  assert.equal(isAgentCreatedSession(fallback), true);
  assert.equal(isAgentCreatedSession({ ...fallback, getSessionId: undefined } as any), true);
});

test('cannot authenticate or append provenance without a valid durable identity', () => {
  for (const header of [undefined, null, [], 'session-a', {}, { id: 42 }, { id: ' ' }]) {
    const current = { ...manager('session-a'), getSessionId: () => undefined, getHeader: () => header };
    assert.equal(isAgentCreatedSession(current as any), false);
    assert.throws(() => appendAgentCreatedSessionProvenance(current as any), /without a durable session id/);
    assert.equal(current.getEntries().length, 1, 'failed append must leave entries unchanged');
  }
  assert.equal(isAgentCreatedSession({ getEntries: () => [] } as any), false);
});

test('reports unavailable custom-entry API instead of silently losing provenance', () => {
  const current = manager('session-a');
  for (const appendCustomEntry of [undefined, 'not callable']) {
    assert.throws(() => appendAgentCreatedSessionProvenance({ ...current, appendCustomEntry } as any),
      /SDK custom entries are unavailable/);
    assert.equal(current.getEntries().length, 1);
  }
});

test('agent-created provenance is explicit and session-identity bound', () => {
  assert.equal(isAgentCreatedSession(manager('session-a')), true);
  assert.equal(isAgentCreatedSession(manager('session-b', 'session-a')), false);

  const created = manager('session-c');
  created.getEntries().length = 0;
  appendAgentCreatedSessionProvenance(created);
  assert.equal(isAgentCreatedSession(created), true);
  assert.deepEqual(created.getEntries()[0]?.data, { version: 1, sessionId: 'session-c' });
});
