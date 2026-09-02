import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCoverage } from '../test-reporter.mjs';

test('normalizeCoverage unions duplicate transformed records by source line', () => {
  const normalized = normalizeCoverage({
    totals: {
      totalLineCount: 3, coveredLineCount: 1, coveredLinePercent: 33.33,
      totalBranchCount: 4, coveredBranchCount: 3, coveredBranchPercent: 75,
      totalFunctionCount: 2, coveredFunctionCount: 1, coveredFunctionPercent: 50,
    },
    files: [{
      path: 'src/example.ts',
      lines: [
        { line: 1, count: 1 }, { line: 2, count: 0 }, { line: 3, count: 0 },
        // A second transform covered the lines missed by the first record.
        { line: 1, count: 0 }, { line: 2, count: 2 }, { line: 3, count: 1 },
      ],
    }],
  });
  assert.equal(normalized.totalLineCount, 3);
  assert.equal(normalized.coveredLineCount, 3);
  assert.equal(normalized.coveredLinePercent, 100);
  assert.equal(normalized.coveredBranchPercent, 75, 'branch totals remain Node-authoritative');
});

test('normalizeCoverage falls back to raw totals when file records are unavailable', () => {
  const normalized = normalizeCoverage({
    totals: {
      totalLineCount: 10, coveredLineCount: 8, coveredLinePercent: 80,
      totalBranchCount: 2, coveredBranchCount: 1, coveredBranchPercent: 50,
      totalFunctionCount: 1, coveredFunctionCount: 1, coveredFunctionPercent: 100,
    },
  });
  assert.equal(normalized.totalLineCount, 10);
  assert.equal(normalized.coveredLineCount, 8);
  assert.equal(normalized.coveredLinePercent, 80);
});
