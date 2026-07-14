import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getSkillNameFromToolCall,
  
  normalizeToolCallName,
  summarizeSubagentToolCallInput,
} from '../../../src/shared/tool-call-analysis/summary';
import { isRecord } from '../../../src/shared/type-guards';;
import type { ToolCall } from '../../../src/shared/protocol';

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tool-1',
    name: 'read',
    input: { path: '/repo/skills/frontend-design/SKILL.md' },
    status: 'completed',
    ...overrides,
  };
}

test('normalizeToolCallName trims and lowercases tool names', () => {
  assert.equal(normalizeToolCallName('  Read_File  '), 'read_file');
});

test('isRecord accepts plain objects and rejects arrays/null', () => {
  assert.equal(isRecord({ value: true }), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(['x']), false);
  assert.equal(isRecord('text'), false);
});

test('summarizeSubagentToolCallInput handles primitives and collections', () => {
  assert.equal(summarizeSubagentToolCallInput('  spaced text  '), 'spaced text');
  assert.equal(summarizeSubagentToolCallInput(42), '42');
  assert.equal(summarizeSubagentToolCallInput(false), 'false');
  assert.equal(
    summarizeSubagentToolCallInput([' first ', 'second', 'third', 'fourth']),
    'first, second, third +1 more',
  );
  assert.equal(summarizeSubagentToolCallInput(['', 1, null]), null);
});

test('summarizeSubagentToolCallInput prioritizes multi-task and agent/task summaries', () => {
  assert.equal(
    summarizeSubagentToolCallInput({ tasks: [{ agent: 'scout', task: 'Inspect session-opened flow for prompt drift' }] }),
    'scout: Inspect session-opened flow for prompt drift',
  );
  assert.equal(
    summarizeSubagentToolCallInput({ chain: [{ agent: 'worker', task: 'Implement the fix' }, { agent: 'reviewer', task: 'Check it' }] }),
    'worker: Implement the fix +1 more',
  );
  assert.equal(
    summarizeSubagentToolCallInput({ agent: 'planner', task: 'Design the system architecture for agents' }),
    'planner: Design the system architecture for agents',
  );
});

test('summarizeSubagentToolCallInput falls back through object fields and nested values', () => {
  assert.equal(summarizeSubagentToolCallInput({ command: 'npm test -- --package extension' }), 'npm test -- --package extension');
  assert.equal(summarizeSubagentToolCallInput({ urls: ['https://a.example', 'https://b.example'] }), 'https://a.example, https://b.example');
  assert.equal(
    summarizeSubagentToolCallInput({ metadata: { description: 'Summarize the fallback object field' } }),
    'Summarize the fallback object field',
  );
  assert.equal(summarizeSubagentToolCallInput({ empty: {} }), '{"empty":{}}');
});

test('summarizeSubagentToolCallInput truncates long previews to the summary limit', () => {
  const summary = summarizeSubagentToolCallInput({ description: 'x'.repeat(320) });
  assert.ok(summary);
  assert.ok(summary!.endsWith('...'));
  assert.ok(summary!.length <= 300);
});

test('getSkillNameFromToolCall extracts names from supported read path fields only', () => {
  assert.equal(getSkillNameFromToolCall(makeToolCall()), 'frontend-design');
  assert.equal(
    getSkillNameFromToolCall(makeToolCall({ name: 'read_file', input: { fileUri: 'file:///repo/skills/debugging-and-error-recovery/SKILL.md' } })),
    'debugging-and-error-recovery',
  );
  assert.equal(
    getSkillNameFromToolCall(makeToolCall({ input: { filePath: 'D:/repo/skills/code-simplification/SKILL.md' } })),
    'code-simplification',
  );
  assert.equal(getSkillNameFromToolCall(makeToolCall({ name: 'write' })), null);
  assert.equal(getSkillNameFromToolCall(makeToolCall({ input: { path: '/repo/src/index.ts' } })), null);
  assert.equal(getSkillNameFromToolCall(makeToolCall({ input: null })), null);
});
