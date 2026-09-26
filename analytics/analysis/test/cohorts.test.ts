import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyHarnessCohort,
  HISTORICAL_CURRENT_BOUNDARY,
  IDENTITY_REQUIRED_BOUNDARY,
} from '../scripts/cohorts.ts';
import { CURRENT_HARNESS_REVISION } from '../scripts/contracts.ts';

const PRE_BOUNDARY = '2026-07-25T23:59:59.999Z';
const MID_WINDOW = '2026-08-01T12:00:00.000Z';
const POST_REQUIRED = '2026-08-15T00:00:00.000Z';

test('explicit current revision match classifies as current regardless of era', () => {
  const result = classifyHarnessCohort({
    startedAt: PRE_BOUNDARY,
    harnessRevision: CURRENT_HARNESS_REVISION,
    harnessFingerprint: 'ab'.repeat(32),
  });
  assert.equal(result.status, 'current');
  assert.equal(result.isCurrentHarness, true);
  assert.equal(result.harnessRevision, CURRENT_HARNESS_REVISION);
  assert.equal(result.harnessFingerprint, 'ab'.repeat(32));
});

test('mismatched revision classifies as incompatible', () => {
  const result = classifyHarnessCohort({
    startedAt: MID_WINDOW,
    harnessRevision: 'other-harness-2026-08',
    harnessFingerprint: 'cd'.repeat(32),
  });
  assert.equal(result.status, 'incompatible');
  assert.equal(result.isCurrentHarness, false);
  assert.equal(result.harnessRevision, 'other-harness-2026-08');
  assert.equal(result.harnessFingerprint, 'cd'.repeat(32));
});

test('un-stamped runs before the historical-current boundary are legacy', () => {
  const result = classifyHarnessCohort({ startedAt: PRE_BOUNDARY });
  assert.equal(result.status, 'legacy');
  assert.equal(result.isCurrentHarness, false);
  assert.equal(result.harnessRevision, null);
  assert.equal(result.harnessFingerprint, null);
});

test('historical-current boundary is inclusive: the boundary instant is current', () => {
  const atBoundary = classifyHarnessCohort({ startedAt: HISTORICAL_CURRENT_BOUNDARY });
  assert.equal(atBoundary.status, 'current', 'startedAt === boundary instant is still current');
  assert.equal(atBoundary.isCurrentHarness, true);

  const justBefore = classifyHarnessCohort({ startedAt: '2026-07-25T23:59:59.999Z' });
  assert.equal(justBefore.status, 'legacy');
});

test('un-stamped runs inside the historical-current window are current', () => {
  const result = classifyHarnessCohort({ startedAt: MID_WINDOW });
  assert.equal(result.status, 'current');
  assert.equal(result.isCurrentHarness, true);
  assert.equal(result.harnessRevision, null, 'historical current runs have no stamp');
});

test('identity-required boundary is inclusive: missing identity at/after it is unknown', () => {
  const atBoundary = classifyHarnessCohort({ startedAt: IDENTITY_REQUIRED_BOUNDARY });
  assert.equal(atBoundary.status, 'unknown', 'startedAt === identity-required instant requires identity');
  assert.equal(atBoundary.isCurrentHarness, false);

  const after = classifyHarnessCohort({ startedAt: POST_REQUIRED });
  assert.equal(after.status, 'unknown');
  assert.equal(after.isCurrentHarness, false);

  const justBefore = classifyHarnessCohort({ startedAt: '2026-08-13T23:59:59.999Z' });
  assert.equal(justBefore.status, 'current');
});

test('unparseable startedAt with missing identity is unknown, not guessed', () => {
  const result = classifyHarnessCohort({ startedAt: 'not-a-date' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.isCurrentHarness, false);
});

test('empty or whitespace revision is treated as missing identity', () => {
  const empty = classifyHarnessCohort({ startedAt: MID_WINDOW, harnessRevision: '   ' });
  assert.equal(empty.status, 'current', 'whitespace revision falls back to era classification');

  const preBoundary = classifyHarnessCohort({ startedAt: PRE_BOUNDARY, harnessRevision: '' });
  assert.equal(preBoundary.status, 'legacy');
});
