import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionNoteAdmission } from '../session-note-admission.js';

test('pair burst and aggregate recipient budgets return retry hints without admitting over-limit notes', () => {
  let now = 0;
  const admission = new SessionNoteAdmission({ now: () => now });
  for (let index = 0; index < 5; index++) {
    assert.equal(admission.admit('source', 'target', `note-${index}`).status, 'admitted');
  }
  const pairLimited = admission.admit('source', 'target', 'sixth unique note');
  assert.equal(pairLimited.status, 'rejected');
  if (pairLimited.status === 'rejected') {
    assert.equal(pairLimited.reason, 'rate_limited');
    assert.equal(pairLimited.retryAfterMs, 3_000);
  }

  now += 3_000;
  assert.equal(admission.admit('source', 'target', 'after pair refill').status, 'admitted');

  now = 0;
  const sharedRecipient = new SessionNoteAdmission({ now: () => now });
  for (let index = 0; index < 15; index++) {
    assert.equal(sharedRecipient.admit(`source-${index}`, 'same-target', `sender note ${index}`).status, 'admitted');
  }
  const recipientLimited = sharedRecipient.admit('source-15', 'same-target', 'aggregate limit');
  assert.equal(recipientLimited.status, 'rejected');
  if (recipientLimited.status === 'rejected') {
    assert.equal(recipientLimited.reason, 'rate_limited');
    assert.equal(recipientLimited.retryAfterMs, 1_000);
  }
  assert.equal(sharedRecipient.admit('source', 'different-target', 'isolated recipient').status, 'admitted');
});

test('exact most-recent duplicate returns its committed receipt or stays unknown without replay', () => {
  let now = 1_000;
  const admission = new SessionNoteAdmission({ now: () => now });
  const first = admission.admit('source', 'target', 'same exact body');
  assert.equal(first.status, 'admitted');
  if (first.status !== 'admitted') return;
  const pendingDuplicate = admission.admit('source', 'target', 'same exact body');
  assert.equal(pendingDuplicate.status, 'duplicate');
  if (pendingDuplicate.status === 'duplicate') {
    assert.equal(pendingDuplicate.receipt.messageId, first.messageId);
    assert.equal(pendingDuplicate.receipt.status, 'unknown');
  }
  assert.equal(admission.commit(first.messageId, { status: 'accepted', delivery: 'queued', wake: false }), true);
  const committedDuplicate = admission.admit('source', 'target', 'same exact body');
  assert.equal(committedDuplicate.status, 'duplicate');
  if (committedDuplicate.status === 'duplicate') {
    assert.equal(committedDuplicate.receipt.messageId, first.messageId);
    assert.equal(committedDuplicate.receipt.status, 'accepted');
  }

  assert.equal(admission.admit('source', 'target', 'different body').status, 'admitted');
  assert.equal(admission.admit('other-source', 'target', 'same exact body').status, 'admitted');
  assert.equal(admission.admit('source', 'other-target', 'same exact body').status, 'admitted');
  now += 5_001;
  assert.equal(admission.admit('source', 'target', 'different body').status, 'admitted');
});

test('forget clears only dedupe evidence while preserving spent rate credits', () => {
  let now = 0;
  const admission = new SessionNoteAdmission({ now: () => now, pairBurst: 1, recipientBurst: 1 });
  const first = admission.admit('source', 'target', 'known local enqueue failure');
  assert.equal(first.status, 'admitted');
  if (first.status !== 'admitted') return;
  assert.equal(admission.forget(first.messageId), true);
  const retry = admission.admit('source', 'target', 'known local enqueue failure');
  assert.equal(retry.status, 'rejected');
  if (retry.status === 'rejected') assert.equal(retry.reason, 'rate_limited');
  now = 60_000;
  assert.equal(admission.admit('source', 'target', 'known local enqueue failure').status, 'admitted');
});

test('bounded state rejects without evicting active quota and later expires lazily', () => {
  let now = 0;
  const admission = new SessionNoteAdmission({ now: () => now, maxPairs: 1, maxRecipients: 1, maxRecent: 1 });
  assert.equal(admission.admit('source', 'target', 'first').status, 'admitted');
  const full = admission.admit('another-source', 'another-target', 'second');
  assert.equal(full.status, 'rejected');
  if (full.status === 'rejected') {
    assert.equal(full.reason, 'coordination_capacity');
    assert.equal(full.retryAfterMs, 300_000);
  }
  now = 300_001;
  assert.equal(admission.admit('another-source', 'another-target', 'second').status, 'admitted');
});

test('normal close retains quotas, privacy deletion purges all identity-linked state', () => {
  const now = 0;
  const admission = new SessionNoteAdmission({ now: () => now, pairBurst: 1, recipientBurst: 1 });
  assert.equal(admission.admit('source', 'target', 'one').status, 'admitted');
  admission.retireOwner('source');
  const afterClose = admission.admit('source', 'target', 'two');
  assert.equal(afterClose.status, 'rejected');
  if (afterClose.status === 'rejected') assert.equal(afterClose.reason, 'rate_limited');

  admission.retireOwner('source', { deleted: true });
  assert.equal(admission.admit('source', 'new-target', 'two').status, 'admitted');
  admission.retireOwner('target', { deleted: true });
  assert.equal(admission.admit('source', 'target', 'three').status, 'admitted');
});

test('receipt cache retains only bounded delivery metadata, never the note body', () => {
  const admission = new SessionNoteAdmission();
  const body = 'private-body-should-not-be-retained';
  const admitted = admission.admit('source', 'target', body);
  assert.equal(admitted.status, 'admitted');
  if (admitted.status !== 'admitted') return;
  admission.commit(admitted.messageId, { status: 'unknown', error: body, outcome: 'unknown' });
  const privateState = admission as unknown as { pairs: Map<string, unknown> };
  assert.equal(JSON.stringify([...privateState.pairs.values()]).includes(body), false);
  const duplicate = admission.admit('source', 'target', body);
  assert.equal(duplicate.status, 'duplicate');
  if (duplicate.status === 'duplicate') {
    assert.equal(duplicate.receipt.status, 'unknown');
    assert.equal(duplicate.receipt.messageId, admitted.messageId);
    assert.equal('error' in duplicate.receipt, false);
  }
});
