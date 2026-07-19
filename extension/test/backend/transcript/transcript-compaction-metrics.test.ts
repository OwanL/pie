import test from 'node:test';
import assert from 'node:assert/strict';

import { mapTranscript, type SessionEntryLike } from '../../../src/backend/transcript';
import type { CompactionSummaryDetails } from '../../../src/shared/protocol';

function compactionEntry(id: string, summary = '## Kept context'): SessionEntryLike {
  return {
    id,
    type: 'compaction',
    timestamp: '2026-07-15T00:00:00.000Z',
    summary,
  };
}

function metricsSidecar(
  id: string,
  compactionEntryId: string,
  details: Partial<CompactionSummaryDetails> & { reason?: string },
): SessionEntryLike {
  return {
    id,
    type: 'custom',
    timestamp: '2026-07-15T00:00:01.000Z',
    customType: 'pie.compaction-metrics',
    data: {
      compactionEntryId,
      reason: details.reason ?? 'threshold',
      tokensBefore: details.tokensBefore,
      estimatedTokensAfter: details.estimatedTokensAfter,
      durationMs: details.durationMs,
      modelId: details.modelId,
      provider: details.provider,
      thinkingLevel: details.thinkingLevel,
    },
  };
}

test('mapTranscript attaches a typed CompactionSummaryDetails to the matching compaction-summary row', () => {
  const entries: SessionEntryLike[] = [
    compactionEntry('compact-1'),
    metricsSidecar('sidecar-1', 'compact-1', {
      reason: 'threshold',
      tokensBefore: 100_000,
      estimatedTokensAfter: 12_345,
      durationMs: 4_200,
      modelId: 'claude-sonnet-4',
      provider: 'anthropic',
      thinkingLevel: 'medium',
    }),
  ];

  const [message] = mapTranscript(entries);
  assert.equal(message.customType, 'compaction-summary');
  assert.deepEqual(message.customDetails, {
    reason: 'threshold',
    tokensBefore: 100_000,
    estimatedTokensAfter: 12_345,
    durationMs: 4_200,
    modelId: 'claude-sonnet-4',
    provider: 'anthropic',
    thinkingLevel: 'medium',
  } satisfies CompactionSummaryDetails);
});

test('mapTranscript leaves a compaction-summary row without metrics when no sidecar exists (legacy)', () => {
  const entries: SessionEntryLike[] = [compactionEntry('compact-1')];

  const [message] = mapTranscript(entries);
  assert.equal(message.customType, 'compaction-summary');
  assert.equal(message.customDetails, undefined);
});

test('mapTranscript does not render the pie.compaction-metrics sidecar as its own row', () => {
  const entries: SessionEntryLike[] = [
    compactionEntry('compact-1', 'kept context'),
    metricsSidecar('sidecar-1', 'compact-1', { tokensBefore: 10, estimatedTokensAfter: 5 }),
    compactionEntry('compact-2', 'second compaction'),
    metricsSidecar('sidecar-2', 'compact-2', { tokensBefore: 20, estimatedTokensAfter: 8 }),
  ];

  const transcript = mapTranscript(entries);
  assert.equal(transcript.length, 2, 'only the two compaction rows render; sidecars never render');
  assert.equal(transcript[0].id, 'compact-1');
  assert.equal(transcript[1].id, 'compact-2');
  for (const message of transcript) {
    assert.equal(message.customType, 'compaction-summary');
    assert.notEqual(message.customDetails, undefined, 'each compaction row carries its metrics');
  }
});

test('mapTranscript ignores a sidecar whose compactionEntryId does not match any compaction entry', () => {
  const entries: SessionEntryLike[] = [
    compactionEntry('compact-1'),
    metricsSidecar('sidecar-orphan', 'compact-missing', {
      tokensBefore: 100,
      estimatedTokensAfter: 50,
    }),
  ];

  const [message] = mapTranscript(entries);
  assert.equal(message.customDetails, undefined, 'an orphan sidecar attaches nothing');
});

test('mapTranscript drops a malformed sidecar (missing compactionEntryId)', () => {
  const entries: SessionEntryLike[] = [
    compactionEntry('compact-1'),
    {
      id: 'sidecar-malformed',
      type: 'custom',
      timestamp: '2026-07-15T00:00:01.000Z',
      customType: 'pie.compaction-metrics',
      data: { reason: 'manual', tokensBefore: 100, estimatedTokensAfter: 50 },
    },
  ];

  const [message] = mapTranscript(entries);
  assert.equal(message.customDetails, undefined);
});

test('mapTranscript drops a sidecar with no usable token metric', () => {
  const entries: SessionEntryLike[] = [
    compactionEntry('compact-1'),
    metricsSidecar('sidecar-empty', 'compact-1', { reason: 'manual' }),
  ];

  const [message] = mapTranscript(entries);
  assert.equal(message.customDetails, undefined);
});

test('mapTranscript coerces partial metrics: tokensBefore only', () => {
  const entries: SessionEntryLike[] = [
    compactionEntry('compact-1'),
    metricsSidecar('sidecar-partial', 'compact-1', {
      reason: 'overflow',
      tokensBefore: 80_000,
      durationMs: 1_000,
    }),
  ];

  const [message] = mapTranscript(entries);
  assert.deepEqual(message.customDetails, {
    reason: 'overflow',
    tokensBefore: 80_000,
    durationMs: 1_000,
  } satisfies CompactionSummaryDetails);
});

test('mapTranscript treats non-number token fields as absent (legacy/malformed)', () => {
  const entries: SessionEntryLike[] = [
    compactionEntry('compact-1'),
    {
      id: 'sidecar-bad-numbers',
      type: 'custom',
      timestamp: '2026-07-15T00:00:01.000Z',
      customType: 'pie.compaction-metrics',
      data: {
        compactionEntryId: 'compact-1',
        reason: 'threshold',
        tokensBefore: 'lots',
        estimatedTokensAfter: null,
        durationMs: -10,
        modelId: '',
        provider: 42,
      },
    },
  ];

  const [message] = mapTranscript(entries);
  // No usable token metric → sidecar dropped entirely.
  assert.equal(message.customDetails, undefined);
});

test('mapTranscript last sidecar wins when two sidecars target the same compaction entry', () => {
  const entries: SessionEntryLike[] = [
    compactionEntry('compact-1'),
    metricsSidecar('sidecar-stale', 'compact-1', {
      reason: 'manual',
      tokensBefore: 100,
      estimatedTokensAfter: 90,
      durationMs: 500,
    }),
    metricsSidecar('sidecar-fresh', 'compact-1', {
      reason: 'threshold',
      tokensBefore: 100,
      estimatedTokensAfter: 40,
      durationMs: 3_000,
    }),
  ];

  const [message] = mapTranscript(entries);
  assert.equal((message.customDetails as CompactionSummaryDetails).estimatedTokensAfter, 40);
  assert.equal((message.customDetails as CompactionSummaryDetails).durationMs, 3_000);
  assert.equal((message.customDetails as CompactionSummaryDetails).reason, 'threshold');
});

test('mapTranscript ignores a custom entry with a different customType (not a sidecar)', () => {
  const entries: SessionEntryLike[] = [
    compactionEntry('compact-1'),
    {
      id: 'other-custom',
      type: 'custom',
      timestamp: '2026-07-15T00:00:01.000Z',
      customType: 'some-other-extension',
      data: { whatever: true },
    },
    metricsSidecar('sidecar-1', 'compact-1', { tokensBefore: 10, estimatedTokensAfter: 5 }),
  ];

  const transcript = mapTranscript(entries);
  // The unrelated `custom` entry has no `content`, so it also does not render.
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].id, 'compact-1');
  assert.notEqual(transcript[0].customDetails, undefined);
});

test('mapTranscript handles a compaction entry with an empty reason in the sidecar', () => {
  const entries: SessionEntryLike[] = [
    compactionEntry('compact-1'),
    metricsSidecar('sidecar-1', 'compact-1', {
      reason: '',
      tokensBefore: 100,
      estimatedTokensAfter: 50,
    }),
  ];

  const [message] = mapTranscript(entries);
  assert.equal((message.customDetails as CompactionSummaryDetails).reason, '');
});
