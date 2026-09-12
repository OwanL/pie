import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyExecutionSummaryDelta,
  executionSummaryCoverage,
  executionSummaryTimingCoverage,
} from '../../src/analytics/execution-summary.js';

test('execution summary coverage distinguishes complete, partial, and invalid counts', () => {
  assert.equal(executionSummaryCoverage(0, 0, 0), 'known');
  assert.equal(executionSummaryCoverage(3, 3, 2), 'partial');
  assert.equal(executionSummaryCoverage(3, 3, 4), 'unknown');
  assert.equal(executionSummaryCoverage(3, 0, 3), 'partial');
  assert.equal(executionSummaryCoverage(-1, 0, 0), 'unknown');
  assert.equal(executionSummaryTimingCoverage(2, 2, 2), 'known');
  assert.equal(executionSummaryTimingCoverage(2, 2, 1), 'partial');
  assert.equal(executionSummaryTimingCoverage(2, 3, 2), 'unknown');
});

test('execution summary deltas fail closed on underflow and preserve settled bound', () => {
  assert.deepEqual(
    applyExecutionSummaryDelta(
      { executionCount: 1, begunCount: 1, settledCount: 0, startedAtCount: 1, endedAtCount: 0 },
      { executionCount: 1, begunCount: 1, settledCount: 1, startedAtCount: 0, endedAtCount: 1 },
    ),
    { executionCount: 2, begunCount: 2, settledCount: 1, startedAtCount: 1, endedAtCount: 1 },
  );
  assert.throws(
    () => applyExecutionSummaryDelta(
      { executionCount: 0, begunCount: 0, settledCount: 0, startedAtCount: 0, endedAtCount: 0 },
      { executionCount: -1, begunCount: 0, settledCount: 0, startedAtCount: 0, endedAtCount: 0 },
    ),
    /outside the safe range/iu,
  );
  assert.throws(
    () => applyExecutionSummaryDelta(
      { executionCount: 1, begunCount: 1, settledCount: 1, startedAtCount: 1, endedAtCount: 1 },
      { executionCount: 0, begunCount: 0, settledCount: -2, startedAtCount: 0, endedAtCount: 0 },
    ),
    /outside the safe range/iu,
  );
});
