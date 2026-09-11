import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { forgetLegacyReviewArtifacts } from '../../../src/backend/legacy-review-artifact-cleanup';

test('private cleanup removes only the forgotten session from retired review sidecars', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-legacy-review-cleanup-'));
  const prior = process.env.PIE_REVIEWS_DIR;
  process.env.PIE_REVIEWS_DIR = root;
  try {
    const sessionPath = path.join(root, 'private.jsonl');
    await fs.writeFile(path.join(root, 'reviews.jsonl'), [
      JSON.stringify({ sessionId: 'private-id', reviewId: 'remove-by-id' }),
      JSON.stringify({ sessionId: 'other-id', reviewId: 'keep' }),
      '{malformed',
      '',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(root, 'closure-actions.jsonl'), [
      JSON.stringify({ targetSessionId: 'private-id', actionId: 'remove-by-target-id' }),
      JSON.stringify({ targetSessionPath: sessionPath, actionId: 'remove-by-path' }),
      JSON.stringify({ targetSessionId: 'other-id', actionId: 'keep' }),
      '',
    ].join('\n'), 'utf8');

    forgetLegacyReviewArtifacts(sessionPath, 'private-id');

    const reviews = await fs.readFile(path.join(root, 'reviews.jsonl'), 'utf8');
    assert.doesNotMatch(reviews, /remove-by-id/);
    assert.match(reviews, /"reviewId":"keep"/);
    assert.match(reviews, /\{malformed/);
    const closures = await fs.readFile(path.join(root, 'closure-actions.jsonl'), 'utf8');
    assert.doesNotMatch(closures, /remove-by-target-id|remove-by-path/);
    assert.match(closures, /"actionId":"keep"/);
  } finally {
    if (prior === undefined) delete process.env.PIE_REVIEWS_DIR;
    else process.env.PIE_REVIEWS_DIR = prior;
    await fs.rm(root, { recursive: true, force: true });
  }
});
