import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestFilesInvocation } from '../run-affected-tests.mjs';

test('affected test file lists use stdin instead of a Windows-length command line', () => {
  const files = Array.from({ length: 503 }, (_, index) =>
    `application/frontend/test/${'long-test-path-segment-'.repeat(3)}${index}.test.ts`);
  const invocation = buildTestFilesInvocation(files);

  assert.ok(invocation.stdin.length > 32_767, 'simulated list exceeds the Windows command-line limit');
  assert.deepEqual(invocation.args, ['--files-from-stdin']);
  assert.ok(invocation.args.join(' ').length < 100, 'child command-line stays small');
  assert.deepEqual(JSON.parse(invocation.stdin), files);
});
