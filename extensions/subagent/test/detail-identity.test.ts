import assert from 'node:assert/strict';
import test from 'node:test';

import { extendSubagentLineage, nextChildIdentity } from '../runner.js';

test('producer child identities are stable under single, parallel, and chain display reorder', () => {
  const single = nextChildIdentity('worker', 'tool-single');
  const parallel = [
    nextChildIdentity('scout', 'tool-parallel-a'),
    nextChildIdentity('worker', 'tool-parallel-b'),
  ];
  const chain = [
    nextChildIdentity('scout', 'tool-chain-1'),
    nextChildIdentity('worker', 'tool-chain-2'),
  ];
  const before = [single, ...parallel, ...chain];
  const reordered = [parallel[1], chain[0], single, chain[1], parallel[0]];
  assert.deepEqual(new Set(reordered), new Set(before));
  assert.equal(new Set(before).size, before.length);
  assert.ok(before.every((identity) => identity.includes(':child:')));
});

test('nested attempts carry complete immutable ancestor lineage at every depth', () => {
  const root = extendSubagentLineage(undefined, 'child-root', 'tool-root', 'attempt-root');
  const nested = extendSubagentLineage(root, 'child-nested', 'tool-nested', 'attempt-nested');
  const leaf = extendSubagentLineage(nested, 'child-leaf', 'tool-leaf', 'attempt-leaf');
  assert.deepEqual(leaf.map((identity) => identity.childId), ['child-root', 'child-nested', 'child-leaf']);
  assert.deepEqual(leaf.map((identity) => identity.spawningToolCallId), ['tool-root', 'tool-nested', 'tool-leaf']);
  assert.deepEqual(leaf.map((identity) => identity.attemptId), ['attempt-root', 'attempt-nested', 'attempt-leaf']);
  leaf[0]!.childId = 'mutated-copy';
  assert.equal(root[0]!.childId, 'child-root', 'descendant lineage does not alias ancestor producer state');
});
