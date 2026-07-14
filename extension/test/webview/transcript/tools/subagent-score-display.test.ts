import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeTaskScoresForDisplay } from '../../../../src/webview/panel/transcript/subagent-score-display';

test('normalizeTaskScoresForDisplay fills omitted dimensions with the default score', () => {
  assert.deepEqual(
    normalizeTaskScoresForDisplay({ precision: 5, thoroughness: 4 }),
    { precision: 5, creativity: 2, reasoning: 2, thoroughness: 4 },
  );
});

test('normalizeTaskScoresForDisplay preserves explicit zero values', () => {
  assert.deepEqual(
    normalizeTaskScoresForDisplay({ precision: 0, creativity: 1, reasoning: 0, thoroughness: 5 }),
    { precision: 0, creativity: 1, reasoning: 0, thoroughness: 5 },
  );
});

test('normalizeTaskScoresForDisplay treats an empty score object as all-default dimensions', () => {
  assert.deepEqual(
    normalizeTaskScoresForDisplay({}),
    { precision: 2, creativity: 2, reasoning: 2, thoroughness: 2 },
  );
});

test('normalizeTaskScoresForDisplay returns undefined when no score metadata exists', () => {
  assert.equal(normalizeTaskScoresForDisplay(undefined), undefined);
});
