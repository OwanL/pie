import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceFixture } from './source-fixture.js';

const candidateDistPath = path.join(sourceFixture.packageRoots.ai, 'dist', 'utils', 'retry.js');

test('source pi-ai dist retries terminal response cuts and provider-gate stalls', async () => {
  const candidateRealPath = await fs.realpath(candidateDistPath);
  const candidatePackageRoot = await fs.realpath(sourceFixture.packageRoots.ai);
  assert.ok(
    candidateRealPath.startsWith(`${candidatePackageRoot}${path.sep}`),
    'the candidate dist import must resolve within the selected source graph',
  );

  const { isRetryableAssistantError } = await import(pathToFileURL(candidateDistPath).href);
  const classify = (stopReason: string, errorMessage?: string): boolean => (
    isRetryableAssistantError({ stopReason, errorMessage })
  );

  for (const errorMessage of [
    'Provider returned an incomplete successful response: Stream ended before a terminal response event',
    'upstream stream stalled',
    'upstream header phase stalled',
    'upstream transport circuit open',
  ]) {
    assert.equal(classify('error', errorMessage), true, `${errorMessage} must be retryable`);
  }

  assert.equal(classify('error', 'overloaded_error'), true, 'existing transient provider errors remain retryable');
  assert.equal(classify('error', '429 quota exceeded'), false, 'provider quota exhaustion remains non-retryable');
  assert.equal(
    classify('error', 'upstream stream stalled: quota exceeded'),
    false,
    'non-retryable quota classification still takes precedence',
  );
  assert.equal(classify('stop', 'upstream stream stalled'), false, 'successful assistant turns are not retryable');
  assert.equal(classify('error'), false, 'an error without provider text is not retryable');
});
