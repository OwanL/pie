import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subagentObservationSource } from '../../analytics-views/subagent-evidence-source.js';

test('subagent evidence keeps identity and reads mutable child evidence lazily', () => {
  const child = {
    agent: 'worker', task: 'task', exitCode: 0,
    model: 'original',
    usage: { input: 1, cost: { reportedCostUsd: 'invalid', extra: true } },
    attemptRecords: [null, { attemptId: 'retry', usage: { input: 'invalid', cost: null } }],
    messages: [{ role: 'toolResult', toolName: 'bash', details: { nested: true }, extra: true }],
  };
  const raw = { mode: 'single', results: [child] };
  const first = subagentObservationSource.getRenderableSubagentResult(raw)?.results[0];
  assert.ok(first);
  assert.strictEqual(subagentObservationSource.getRenderableSubagentResult({ details: raw })?.results[0], first);
  assert.deepEqual(first.usage?.cost, { providerReportedCostUsd: undefined, reportedCostUsd: 'invalid' });
  assert.deepEqual(first.attemptRecords, [{}, {
    attemptId: 'retry', model: undefined, provider: undefined,
    usage: { input: 'invalid', output: undefined, cacheRead: undefined, cacheWrite: undefined,
      providerReportedCostUsd: undefined, reportedCostUsd: undefined, cost: null },
  }]);
  assert.deepEqual(first.messages, [{ role: 'toolResult', toolName: 'bash', details: { nested: true } }]);
  child.model = 'updated';
  child.usage.input = 2;
  assert.equal(first.model, 'updated');
  assert.equal(first.usage?.input, 2);
});

test('subagent evidence preserves primitive malformed usage and rejects unsupported evidence', () => {
  const raw = { results: [{ agent: 'worker', task: 'task', exitCode: 0, messages: [],
    attemptRecords: [
      { usage: null }, { usage: 'invalid' }, { usage: [1] },
      { usage: () => 1 }, { usage: { cost: Symbol('invalid') } },
    ],
  }] };
  const result = subagentObservationSource.getRenderableSubagentResult(raw)?.results[0];
  assert.ok(result);
  assert.deepEqual(result.attemptRecords?.slice(0, 3).map((attempt) => attempt.usage), [null, 'invalid', [1]]);
  assert.equal(Object.hasOwn(result.attemptRecords![3], 'usage'), false);
  assert.equal(Object.hasOwn(result.attemptRecords![4].usage!, 'cost'), false);
  assert.equal(subagentObservationSource.getRenderableSubagentResult({ results: [] }), undefined);
});
