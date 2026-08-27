import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactSubagentResultPreview,
  SUBAGENT_PREVIEW_MAX_BYTES,
} from '../../../src/shared/lazy-details.js';

test('oversized subagent previews retain every child detail address in the minimal branch', () => {
  const sessionPath = '/sessions/addressable.jsonl';
  const turnId = 'turn-1';
  const rootToolCallId = 'tool-1';
  const rootAttemptId = 'root-attempt-1';
  const results = Array.from({ length: 12 }, (_, index) => {
    const childId = `child-${index}`;
    const attemptId = `child-attempt-${index}`;
    const lineage = [{ childId, spawningToolCallId: rootToolCallId, attemptId }];
    return {
      id: childId,
      childId,
      attemptId,
      lineage,
      liveAddressable: true,
      detailAddress: { sessionPath, turnId, rootToolCallId, rootAttemptId, lineage },
      agent: `worker-${index}`,
      task: `Inspect ${index} ${'t'.repeat(4_000)}`,
      exitCode: -1,
      streamingText: `${'s'.repeat(16_000)}-tail-${index}`,
      messages: [{ role: 'assistant', content: 'recursive body must not ride the snapshot' }],
    };
  });

  const preview = compactSubagentResultPreview({
    details: { mode: 'parallel', results },
  }) as { details?: { results?: Array<Record<string, unknown>> } };
  const compactResults = preview.details?.results ?? [];

  assert.equal(compactResults.length, results.length);
  for (const [index, child] of compactResults.entries()) {
    assert.equal(child.id, results[index]?.id);
    assert.equal(child.childId, results[index]?.childId);
    assert.equal(child.attemptId, results[index]?.attemptId);
    assert.deepEqual(child.lineage, results[index]?.lineage);
    assert.equal(child.liveAddressable, true);
    assert.deepEqual(child.detailAddress, results[index]?.detailAddress);
  }
  assert.equal(JSON.stringify(preview).includes('recursive body must not ride the snapshot'), false);
  assert.equal(Buffer.byteLength(JSON.stringify(preview), 'utf8') <= SUBAGENT_PREVIEW_MAX_BYTES, true);
});
