import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harnessPiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../pi');
const candidateDistPath = path.join(
  harnessPiRoot,
  'node_modules',
  '@earendil-works',
  'pi-ai',
  'dist',
  'utils',
  'retry.js',
);
const workspaceDistPath = path.join(harnessPiRoot, 'packages', 'ai', 'dist', 'utils', 'retry.js');

test('source pi-ai dist retries terminal response cuts and provider-gate stalls', async () => {
  const [candidateRealPath, workspaceRealPath] = await Promise.all([
    fs.realpath(candidateDistPath),
    fs.realpath(workspaceDistPath),
  ]);
  assert.equal(
    candidateRealPath,
    workspaceRealPath,
    'the candidate dist import must resolve to the harness/pi workspace package',
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
