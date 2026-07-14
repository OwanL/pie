import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateTranscriptCommitIdentity,
  boundedTextIdentity,
  createDisplayedTranscriptCommitIdentity,
  createExpectedTranscriptCommitIdentity,
  createLazyTranscriptHostMount,
  equalBoundedCommitAggregate,
  equalTranscriptCommitIdentity,
  mountTranscriptHost,
  unmountTranscriptHost,
  type LiveToolExecutionIdentityInput,
  type TerminalToolRevisionIdentityInput,
  type TranscriptHostMountState,
} from '../../../src/shared/transcript-commit-identity';

const window = {
  totalCount: 1,
  loadedStart: 0,
  loadedEnd: 1,
  hasOlder: false,
  hasNewer: false,
  isPartial: false,
  hasUserMessages: true,
};

const structureRows = [{
  messageId: 'assistant-1',
  role: 'assistant',
  status: 'streaming',
  partCount: 1,
  toolCallCount: 1,
  hasThinking: true,
  hasDraftingToolCall: false,
}];

interface IdentityOverrides {
  text?: string;
  reasoning?: string;
  liveTools?: readonly LiveToolExecutionIdentityInput[];
  terminalTools?: readonly TerminalToolRevisionIdentityInput[];
  host?: TranscriptHostMountState;
}

function expected({
  text = 'current text',
  reasoning = 'current reasoning',
  liveTools = [],
  terminalTools = [],
  host = mountTranscriptHost(createLazyTranscriptHostMount()),
}: IdentityOverrides = {}) {
  return createExpectedTranscriptCommitIdentity({
    window,
    structureRows,
    liveTools,
    terminalTools,
    host,
    active: { text, reasoning },
  });
}

function displayed({
  text = 'current text',
  reasoning = 'current reasoning',
  liveTools = [],
  terminalTools = [],
  host = mountTranscriptHost(createLazyTranscriptHostMount()),
}: IdentityOverrides = {}) {
  return createDisplayedTranscriptCommitIdentity({
    window,
    structureRows,
    liveTools,
    terminalTools,
    host,
    active: { policy: { kind: 'mounted' }, text, reasoning },
  });
}

test('equal-length stale displayed text has a different bounded identity and cannot acknowledge', () => {
  const host = mountTranscriptHost(createLazyTranscriptHostMount());
  const expectedIdentity = expected({ text: 'abc123', host });
  const displayedIdentity = displayed({ text: 'xyz789', host });

  assert.equal(boundedTextIdentity('abc123').length, boundedTextIdentity('xyz789').length);
  assert.notDeepEqual(boundedTextIdentity('abc123'), boundedTextIdentity('xyz789'));
  assert.equal(equalTranscriptCommitIdentity(expectedIdentity, displayedIdentity), false);
});

test('a stale live tool phase and terminal revision cannot acknowledge', () => {
  const host = mountTranscriptHost(createLazyTranscriptHostMount());
  const liveTool = {
    messageId: 'assistant-1',
    toolCallId: 'tool-1',
    executionId: 'execution-1',
    attempt: 2,
    seq: 9,
    phase: 'running',
  };
  const expectedIdentity = expected({
    host,
    liveTools: [liveTool],
    terminalTools: [{ messageId: 'assistant-1', toolCallId: 'prior-tool', status: 'completed', revision: 4 }],
  });
  const stalePhase = displayed({
    host,
    liveTools: [{ ...liveTool, phase: 'waiting' }],
    terminalTools: [{ messageId: 'assistant-1', toolCallId: 'prior-tool', status: 'completed', revision: 4 }],
  });
  const staleTerminalRevision = displayed({
    host,
    liveTools: [liveTool],
    terminalTools: [{ messageId: 'assistant-1', toolCallId: 'prior-tool', status: 'completed', revision: 3 }],
  });

  assert.equal(equalTranscriptCommitIdentity(expectedIdentity, stalePhase), false);
  assert.equal(equalTranscriptCommitIdentity(expectedIdentity, staleTerminalRevision), false);
});

test('lazy TranscriptHost remount advances generation and invalidates the prior displayed identity', () => {
  const lazy = createLazyTranscriptHostMount();
  const firstMount = mountTranscriptHost(lazy);
  const remount = mountTranscriptHost(unmountTranscriptHost(firstMount));
  assert.deepEqual(firstMount, { kind: 'mounted', generation: 1 });
  assert.deepEqual(remount, { kind: 'mounted', generation: 2 });

  assert.equal(equalTranscriptCommitIdentity(expected({ host: remount }), displayed({ host: firstMount })), false);
  assert.equal(equalTranscriptCommitIdentity(expected({ host: remount }), displayed({ host: remount })), true);
});

test('an offscreen active row explicitly reports no displayed content', () => {
  const host = mountTranscriptHost(createLazyTranscriptHostMount());
  const expectedIdentity = expected({ host });
  const offscreen = createDisplayedTranscriptCommitIdentity({
    window,
    structureRows,
    liveTools: [],
    terminalTools: [],
    host,
    active: { policy: { kind: 'offscreen' } },
  });

  assert.equal(offscreen.active.content, null);
  assert.equal(equalTranscriptCommitIdentity(expectedIdentity, offscreen), false);
});

test('bounded aggregation never traverses beyond its limit and incomplete aggregates are not equal', () => {
  let serialized = 0;
  const values = ['a', 'b', 'c', 'd'];
  const left = aggregateTranscriptCommitIdentity(values, 2, (value) => {
    serialized += 1;
    return value;
  });
  const right = aggregateTranscriptCommitIdentity(['a', 'b', 'changed', 'd'], 2, (value) => value);

  assert.equal(serialized, 2);
  assert.deepEqual(left, { totalCount: 4, traversedCount: 2, complete: false, hash: left.hash });
  assert.equal(left.hash, right.hash, 'the unvisited suffix is deliberately not traversed');
  assert.equal(equalBoundedCommitAggregate(left, right), false);
});
