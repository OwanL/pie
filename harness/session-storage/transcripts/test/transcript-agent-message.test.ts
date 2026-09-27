import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_MESSAGE_CUSTOM_TYPE, AGENT_MESSAGE_PROVENANCE_CUSTOM_TYPE } from '../../../agent-processes/lib/rpc/message-contract.js';
import { mapTranscript, type SessionEntryLike } from '../transcript';

const userEntry: SessionEntryLike = {
  id: 'agent-user-entry',
  timestamp: '2026-01-01T00:00:00.000Z',
  type: 'message',
  message: { role: 'user', content: 'inspect the failing session' },
};

const provenanceEntry: SessionEntryLike = {
  id: 'agent-provenance-entry',
  timestamp: '2026-01-01T00:00:00.001Z',
  type: 'custom',
  customType: AGENT_MESSAGE_PROVENANCE_CUSTOM_TYPE,
  data: { userEntryId: 'agent-user-entry' },
};

test('mapTranscript reattaches agent provenance to the matching user row after reload', () => {
  const transcript = mapTranscript([userEntry, provenanceEntry]);

  assert.equal(transcript.length, 1);
  assert.equal(transcript[0]?.role, 'user');
  assert.equal(transcript[0]?.id, 'agent-user-entry');
  assert.equal(transcript[0]?.customType, AGENT_MESSAGE_CUSTOM_TYPE);
  assert.equal(transcript[0]?.customDetails, undefined);
});

test('mapTranscript ignores malformed or unrelated agent provenance markers', () => {
  const transcript = mapTranscript([
    userEntry,
    { ...provenanceEntry, id: 'bad-marker', data: { userEntryId: '' } },
    { ...provenanceEntry, id: 'wrong-type', customType: 'pie.other' },
  ]);

  assert.equal(transcript[0]?.customType, undefined);
  assert.equal(transcript.length, 1);
});
