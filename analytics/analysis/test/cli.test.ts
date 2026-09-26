import assert from 'node:assert/strict';
import test from 'node:test';

import { formatUsage, parseCliOptions } from '../scripts/cli.ts';

test('analysis CLI rejects retired dashboard options', () => {
  assert.throws(() => parseCliOptions(['--output-dir', 'site']), /Unknown argument: --output-dir/);
  assert.throws(() => parseCliOptions(['--port', '4173']), /Unknown argument: --port/);

  const usage = formatUsage('analytics', 'Analytics query tools');
  assert.doesNotMatch(usage, /--output-dir|--port/);
  assert.match(usage, /--db/);
  assert.match(usage, /--exports-dir/);
});
