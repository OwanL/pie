import assert from 'node:assert/strict';
import test from 'node:test';

import { runRecencyMs, type RunSnapshot } from '../../../src/host/run-analytics';

/** Build a minimal RunSnapshot exercising only the recency timestamp fields. */
function snapshot(fields: {
  startedAt: string;
  updatedAt: string;
  finalizedAt?: string;
}): RunSnapshot {
  return {
    startedAt: fields.startedAt,
    updatedAt: fields.updatedAt,
    finalizedAt: fields.finalizedAt,
  } as RunSnapshot;
}

test('runRecencyMs prefers updatedAt when it parses', () => {
  const ms = runRecencyMs(
    snapshot({ startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-07-29T12:00:00.000Z' }),
  );
  assert.equal(ms, Date.parse('2026-07-29T12:00:00.000Z'));
});

test('runRecencyMs ignores finalizedAt when updatedAt parses', () => {
  const ms = runRecencyMs(
    snapshot({
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z',
      finalizedAt: '2026-07-30T00:00:00.000Z',
    }),
  );
  assert.equal(ms, Date.parse('2026-07-29T12:00:00.000Z'));
});

test('runRecencyMs falls back to finalizedAt when updatedAt is unparseable', () => {
  const ms = runRecencyMs(
    snapshot({
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: 'not-a-date',
      finalizedAt: '2026-07-01T00:00:00.000Z',
    }),
  );
  assert.equal(ms, Date.parse('2026-07-01T00:00:00.000Z'));
});

test('runRecencyMs falls back to startedAt when updatedAt is unparseable and finalizedAt is absent', () => {
  const ms = runRecencyMs(
    snapshot({ startedAt: '2026-01-01T00:00:00.000Z', updatedAt: 'not-a-date' }),
  );
  assert.equal(ms, Date.parse('2026-01-01T00:00:00.000Z'));
});

test('runRecencyMs falls back to startedAt when finalizedAt is present but unparseable', () => {
  const ms = runRecencyMs(
    snapshot({
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: 'not-a-date',
      finalizedAt: 'also-bad',
    }),
  );
  assert.equal(ms, Date.parse('2026-01-01T00:00:00.000Z'));
});

test('runRecencyMs ranks a newer updatedAt above an older finalizedAt-only snapshot (query.ts merge semantics)', () => {
  const withUpdatedAt = runRecencyMs(
    snapshot({ startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-07-29T12:00:00.000Z' }),
  );
  const finalizedOnly = runRecencyMs(
    snapshot({
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: 'not-a-date',
      finalizedAt: '2026-07-01T00:00:00.000Z',
    }),
  );
  assert.ok(withUpdatedAt > finalizedOnly);
});
