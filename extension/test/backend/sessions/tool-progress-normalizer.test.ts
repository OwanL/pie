import assert from 'node:assert/strict';
import test from 'node:test';

import { isBoundedToolPreview, normalizeToolProgress } from '../../../src/backend/tool-progress-normalizer';

test('tool progress adapters emit typed bounded previews', () => {
  const command = normalizeToolProgress('bash', { command: 'npm test', output: 'x'.repeat(20_000) });
  assert.equal(command.kind, 'command');
  assert.equal(isBoundedToolPreview(command), true);
  if (command.kind === 'command') {
    assert.equal(command.commandSummary, 'npm test');
    assert.equal(command.outputTail?.length, 8_192);
    assert.equal(command.omittedChars, 11_808);
  }

  const question = normalizeToolProgress('ask_user', { question: 'Choose', options: ['a', 'b'] });
  assert.deepEqual(question, { kind: 'question', promptSummary: 'Choose', optionCount: 2 });
});

test('subagent previews retain bounded sibling lifecycle and current reply without complete transcript blobs', () => {
  const children = Array.from({ length: 40 }, (_, index) => ({
    id: `child-${index}`,
    status: index % 2 === 0 ? 'completed' : 'running',
    summary: 's'.repeat(2_000),
    messages: [{ role: 'assistant', content: 'must not cross' }],
  }));
  const preview = normalizeToolProgress('subagent', { children });
  assert.equal(preview.kind, 'subagent');
  assert.equal(isBoundedToolPreview(preview), true);
  if (preview.kind === 'subagent') {
    assert.equal(preview.children.length, 16);
    assert.equal(preview.omittedChildren, 24);
    assert.equal(JSON.stringify(preview).includes('must not cross'), false);
  }
});

test('subagent previews understand the real details.results progress shape', () => {
  const preview = normalizeToolProgress('subagent', {
    details: {
      mode: 'single',
      results: [{
        agent: 'worker', task: 'inspect the queue', exitCode: -1,
        activityPhase: 'streaming', activityDetail: 'replying',
        streaming: true, streamingText: 'The child reply is visible while running.',
        messages: [],
      }],
    },
  });
  assert.equal(preview.kind, 'subagent');
  assert.equal(isBoundedToolPreview(preview), true);
  if (preview.kind === 'subagent') {
    assert.equal(preview.children.length, 1);
    assert.equal(preview.children[0]?.agent, 'worker');
    assert.equal(preview.children[0]?.streamingText, 'The child reply is visible while running.');
  }
});

test('generic preview handles cyclic, bigint and throwing values without throwing', () => {
  const cyclic: Record<string, unknown> = { count: 10n };
  cyclic.self = cyclic;
  const throwing = {};
  Object.defineProperty(throwing, 'bad', { enumerable: true, get: () => { throw new Error('nope'); } });

  for (const value of [cyclic, throwing]) {
    const preview = normalizeToolProgress('custom-tool', value);
    assert.equal(preview.kind, 'generic');
    assert.equal(isBoundedToolPreview(preview), true);
  }
});
