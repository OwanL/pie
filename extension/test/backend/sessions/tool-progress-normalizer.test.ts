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

test('subagent previews retain every sibling and complete recursively renderable transcript', () => {
  const children = Array.from({ length: 40 }, (_, index) => ({
    id: `child-${index}`,
    status: index % 2 === 0 ? 'completed' : 'running',
    summary: 's'.repeat(2_000),
    messages: [{ role: 'assistant', content: 'must cross intact' }],
  }));
  const preview = normalizeToolProgress('subagent', { children });
  assert.equal(preview.kind, 'subagent');
  assert.equal(isBoundedToolPreview(preview), true);
  if (preview.kind === 'subagent') {
    assert.equal(preview.children.length, 40);
    assert.equal(preview.omittedChildren, 0);
    assert.equal(JSON.stringify(preview).includes('must cross intact'), true);
  }
});

test('subagent previews understand the real details.results progress shape', () => {
  const preview = normalizeToolProgress('subagent', {
    details: {
      mode: 'single',
      results: [{
        agent: 'worker', task: 'inspect the queue', exitCode: -1,
        model: 'provider/model', provider: 'provider', thinkingLevel: 'high',
        contextWindow: 200000, usage: { input: 1200, output: 300, cacheRead: 50, cacheWrite: 0, contextTokens: 1550, cost: 0.02, turns: 2 },
        startedAt: 1000, activitySince: 1100,
        activityPhase: 'streaming', activityDetail: 'replying',
        streaming: true, streamingText: 'The child reply is visible while running.',
        messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'live reasoning' }] }],
      }],
    },
  });
  assert.equal(preview.kind, 'subagent');
  assert.equal(isBoundedToolPreview(preview), true);
  if (preview.kind === 'subagent') {
    assert.equal(preview.children.length, 1);
    assert.equal(preview.children[0]?.agent, 'worker');
    assert.equal(preview.children[0]?.model, 'provider/model');
    assert.equal(preview.children[0]?.thinkingLevel, 'high');
    assert.equal(preview.children[0]?.streamingText, 'The child reply is visible while running.');
    assert.equal(preview.children[0]?.usage?.input, 1200);
    assert.equal(preview.children[0]?.contextWindow, 200000);
    assert.equal(preview.children[0]?.startedAt, 1000);
    assert.match(JSON.stringify(preview.children[0]?.messages), /live reasoning/);
  }
});

test('subagent previews retain full streaming text plus a cumulative counter including nested descendants', () => {
  const longStream = 'The quick brown fox jumps over the lazy dog. '.repeat(1_000);
  const preview = normalizeToolProgress('subagent', {
    details: {
      results: [{
        agent: 'worker', task: 'long task', exitCode: -1, streaming: true,
        usage: { output: 120 },
        streamingText: longStream,
        messages: [{
          role: 'assistant',
          content: [{
            type: 'toolCall', name: 'subagent',
            result: { details: { results: [{
              agent: 'scout', task: 'nested', exitCode: -1,
              usage: { output: 40 }, streamingText: 'nested reply', messages: [],
            }] } },
          }],
        }],
      }],
    },
  });

  assert.equal(preview.kind, 'subagent');
  if (preview.kind === 'subagent') {
    const child = preview.children[0]!;
    assert.equal(child.streamingText, longStream, 'the live transcript is not reduced to a tail');
    assert.ok(
      (child.cumulativeOutputTokens ?? 0) > 10_000,
      'counter reflects the complete stream plus nested output, not only the bounded visible tail',
    );
  }
});

test('unchanged modern subagent revision reuses its recursive normalized preview', () => {
  const child = {
    attemptId: 'attempt-cache-1', progressGeneration: 7,
    agent: 'worker', task: 'large task', exitCode: -1,
    messages: Array.from({ length: 200 }, (_, index) => ({
      role: 'assistant', content: [{ type: 'text', text: `${index}:${'x'.repeat(2_000)}` }],
    })),
  };
  const first = normalizeToolProgress('subagent', { details: { mode: 'single', results: [child] } });
  const duplicate = normalizeToolProgress('subagent', { details: { mode: 'single', results: [child] } });
  assert.equal(duplicate, first, 'duplicate generation skips recursive JSON-safe cloning');

  const advanced = normalizeToolProgress('subagent', {
    details: { mode: 'single', results: [{ ...child, progressGeneration: 8 }] },
  });
  assert.notEqual(advanced, first, 'a new generation invalidates the normalization cache');
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
