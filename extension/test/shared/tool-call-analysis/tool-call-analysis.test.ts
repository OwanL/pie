import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeToolCall,
  countTextLines,
  extractExitCode,
  getToolCallSizeHint,
  stripAnsiEscapes,
  summarizeSubagentToolCallInput,
  type FileMutationDelta,
} from '../../../src/shared/tool-call-analysis';
import type { ToolCall } from '../../../src/shared/protocol';

function makeToolCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: 'tool-1',
    name: 'bash',
    input: {},
    status: 'completed',
    ...overrides,
  };
}

function expectMutation(delta: FileMutationDelta, expected: Partial<FileMutationDelta>): void {
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(delta[key as keyof FileMutationDelta], value);
  }
}

test('analyzeToolCall classifies verification commands across common categories', () => {
  const testTool = analyzeToolCall(makeToolCall({
    input: { command: 'npm test -- --runInBand' },
  }));
  const lintTool = analyzeToolCall(makeToolCall({
    input: { command: 'pnpm lint' },
  }));
  const typecheckTool = analyzeToolCall(makeToolCall({
    input: { command: 'tsc --noEmit -p tsconfig.json' },
  }));
  const buildTool = analyzeToolCall(makeToolCall({
    input: { command: 'vite build' },
  }));
  const otherTool = analyzeToolCall(makeToolCall({
    input: { command: 'cargo check' },
  }));

  assert.deepEqual(testTool.verificationKinds, ['test']);
  assert.deepEqual(lintTool.verificationKinds, ['lint']);
  assert.deepEqual(typecheckTool.verificationKinds, ['typecheck']);
  assert.deepEqual(buildTool.verificationKinds, ['build']);
  assert.deepEqual(otherTool.verificationKinds, ['other']);
});

test('analyzeToolCall ignores non-command explanation text when classifying verification activity', () => {
  const analysis = analyzeToolCall(makeToolCall({
    name: 'apply_patch',
    input: {
      explanation: 'validate collapsed tool-call headers before release',
      input: '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch',
    },
  }));

  assert.deepEqual(analysis.verificationKinds, []);
});

test('analyzeToolCall classifies failed verification separately from tool-use errors', () => {
  const verification = analyzeToolCall(makeToolCall({
    input: { command: 'npm test' },
    result: { exitCode: 1, content: [{ type: 'text', text: 'AssertionError: expected true\nCommand exited with code 1' }] },
    status: 'failed',
  }));
  const unavailable = analyzeToolCall(makeToolCall({
    name: 'search',
    result: { content: [{ type: 'text', text: 'Tool search not found' }] },
    status: 'failed',
  }));
  const badEdit = analyzeToolCall(makeToolCall({
    name: 'edit',
    input: { path: 'src/app.ts', edits: [{ oldText: '', newText: 'x' }] },
    result: 'oldText must not be empty in D:/Users/example/project/src/app.ts.',
    status: 'failed',
  }));

  assert.equal(verification.failure, null);
  assert.equal(verification.resultIssue?.kind, 'verification_failure');
  assert.equal(verification.resultIssue?.exitCode, 1);
  assert.deepEqual(verification.resultIssue?.verificationKinds, ['test']);
  assert.equal(unavailable.failure?.kind, 'unavailable_tool');
  assert.equal(badEdit.failure?.kind, 'invalid_tool_arguments');
  assert.match(badEdit.failure?.errorExcerpt ?? '', /D:\/Users\/example\/project\/src\/app\.ts/);
});

test('analyzeToolCall classifies probe no-match and shell errors', () => {
  const probe = analyzeToolCall(makeToolCall({
    input: { command: 'rg "missing" src' },
    result: '(no output)\n\nCommand exited with code 1',
    status: 'failed',
  }));
  const shell = analyzeToolCall(makeToolCall({
    input: { command: 'jq . package.json' },
    result: '/usr/bin/bash: jq: command not found\n\nCommand exited with code 127',
    status: 'failed',
  }));

  assert.equal(probe.failure, null);
  assert.equal(probe.resultIssue?.kind, 'probe_no_match');
  assert.equal(shell.failure?.kind, 'shell_command_error');
  assert.equal(shell.failure?.exitCode, 127);
});

test('analyzeToolCall captures subagent usage details', () => {
  const analysis = analyzeToolCall(makeToolCall({
    name: 'subagent',
    input: {
      tasks: [
        { agent: 'scout', task: 'Find prompt factor sources' },
        { agent: 'reviewer', task: 'Check analytics diffs' },
      ],
    },
  }));

  assert.equal(analysis.subagentCallCount, 1);
  assert.equal(analysis.subagentTaskCount, 2);
  assert.deepEqual(analysis.subagentAgentNames, ['scout', 'reviewer']);
});

test('analyzeToolCall captures single-mode subagent usage', () => {
  const analysis = analyzeToolCall(makeToolCall({
    name: 'subagent',
    input: {
      agent: 'planner',
      task: 'Design the system architecture',
    },
  }));

  assert.equal(analysis.subagentCallCount, 1);
  assert.equal(analysis.subagentTaskCount, 1);
  assert.deepEqual(analysis.subagentAgentNames, ['planner']);
});

test('analyzeToolCall extracts mutation rollups from edit and patch tools', () => {
  const editAnalysis = analyzeToolCall(makeToolCall({
    name: 'edit',
    input: {
      path: '/workspace/src/main.ts',
      edits: [{
        oldText: 'const value = 1;\n',
        newText: 'const value = 2;\nconst next = 3;\n',
      }],
    },
  }));
  const patchAnalysis = analyzeToolCall(makeToolCall({
    name: 'apply_patch',
    input: {
      input: [
        '*** Begin Patch',
        '*** Add File: src/new.ts',
        '+export const created = true;',
        '*** Update File: src/main.ts',
        '@@',
        '-const value = 1;',
        '+const value = 2;',
        '*** Delete File: src/old.ts',
        '*** End Patch',
      ].join('\n'),
    },
  }));

  expectMutation(editAnalysis.fileMutation, {
    editCount: 1,
    touchedFileCount: 1,
    lineModifications: 2,
  });
  expectMutation(patchAnalysis.fileMutation, {
    writeCount: 1,
    editCount: 1,
    deleteCount: 1,
    touchedFileCount: 3,
    lineAdditions: 1,
    lineModifications: 1,
  });
});

test('analyzeToolCall does not double-count touched files for rename patches with updates', () => {
  const renamePatchAnalysis = analyzeToolCall(makeToolCall({
    name: 'apply_patch',
    input: {
      input: [
        '*** Begin Patch',
        '*** Update File: src/main.ts',
        '@@',
        '-const value = 1;',
        '+const value = 2;',
        '*** Move to: src/main-renamed.ts',
        '*** End Patch',
      ].join('\n'),
    },
  }));

  expectMutation(renamePatchAnalysis.fileMutation, {
    editCount: 1,
    renameCount: 1,
    touchedFileCount: 1,
    lineModifications: 1,
  });
});

test('getToolCallSizeHint and summarizeSubagentToolCallInput stay aligned with transcript UI expectations', () => {
  const sizeHint = getToolCallSizeHint(makeToolCall({
    name: 'write',
    input: {
      path: '/workspace/generated.ts',
      content: 'export const value = 1;\nexport const next = 2;\n',
    },
  }));

  const summary = summarizeSubagentToolCallInput({
    agent: 'planner',
    task: 'Capture prompt and tool metadata before transport lowering',
  });

  assert.equal(sizeHint, '+2 lines');
  assert.equal(summary, 'planner: Capture prompt and tool metadata before transport lowering');
});

test('analyzeToolCall handles subagent call without result gracefully', () => {
  const analysis = analyzeToolCall(makeToolCall({
    name: 'subagent',
    input: {
      agent: 'worker',
      task: 'Do something',
    },
    // no result or result without details
  }));

  assert.equal(analysis.subagentCallCount, 1);
  assert.equal(analysis.subagentTaskCount, 1);
});

test('getToolCallSizeHint suppresses hints for failed tool calls', () => {
  const readHint = getToolCallSizeHint(makeToolCall({
    name: 'read_file',
    status: 'failed',
    input: {
      filePath: '/workspace/src/missing.ts',
      startLine: 1,
      endLine: 25,
    },
  }));

  const editHint = getToolCallSizeHint(makeToolCall({
    name: 'edit',
    status: 'failed',
    input: {
      path: '/workspace/src/main.ts',
      edits: [{
        oldText: 'const value = 1;\n',
        newText: 'const value = 2;\n',
      }],
    },
  }));

  assert.equal(readHint, null);
  assert.equal(editHint, null);
});

// ── extractExitCode ────────────────────────────────────────────────────────
// The SDK's bash tool surfaces a non-zero exit only as text ("Command exited
// with code N"); extractExitCode recovers the numeric code by probing result
// fields first, then falling back to a regex on the text.

test('extractExitCode reads a numeric exit code from result fields', () => {
  assert.equal(extractExitCode({ exitCode: 1 }, ''), 1);
  assert.equal(extractExitCode({ code: 42 }, ''), 42);
  assert.equal(extractExitCode({ status: 0 }, ''), 0);
});

test('extractExitCode ignores non-numeric field values and falls through to the text regex', () => {
  // `status: 'failed'` is a string, not a number, so it is skipped and the
  // regex runs against the text.
  assert.equal(extractExitCode({ status: 'failed' }, 'Command exited with code 7'), 7);
});

test('extractExitCode recovers the code from the appended status text', () => {
  assert.equal(extractExitCode({}, '...output\n\nCommand exited with code 127'), 127);
  assert.equal(extractExitCode({}, 'exit code 2'), 2);
  assert.equal(extractExitCode({}, 'exited with code -1'), -1);
});

test('extractExitCode returns null when no exit code is present', () => {
  assert.equal(extractExitCode({}, 'no signal here'), null);
  assert.equal(extractExitCode(null, ''), null);
  assert.equal(extractExitCode(undefined, ''), null);
});

// ── stripAnsiEscapes ────────────────────────────────────────────────────────
// Shared by failure-analysis excerpts and terminal/tool-result display so
// forced-color tools (e.g. `ls --color=always`) don't leak raw ESC sequences.

test('stripAnsiEscapes removes CSI color and cursor sequences', () => {
  assert.equal(stripAnsiEscapes('hello \x1b[31mred\x1b[0m world'), 'hello red world');
  assert.equal(stripAnsiEscapes('\x1b[2Kline\x1b[1G'), 'line');
  assert.equal(stripAnsiEscapes('plain text'), 'plain text');
  assert.equal(stripAnsiEscapes(''), '');
});

// ── countTextLines ──────────────────────────────────────────────────────────
// Reused by tool-call size hints and the reasoning collapsed `~N lines` hint.

test('countTextLines counts newline-separated lines and ignores a trailing newline', () => {
  assert.equal(countTextLines(''), 0);
  assert.equal(countTextLines('one'), 1);
  assert.equal(countTextLines('a\nb\nc'), 3);
  assert.equal(countTextLines('a\nb\nc\n'), 3);
  assert.equal(countTextLines('a\r\nb'), 2);
});

test('analyzeToolCall accounts nested subagent usage exactly once', () => {
  const grandchild = {
    usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0 },
    messages: [],
  };
  const child = {
    usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 },
    messages: [{
      role: 'toolResult',
      toolName: 'subagent',
      details: { mode: 'single', results: [grandchild] },
    }],
  };
  const analysis = analyzeToolCall(makeToolCall({
    name: 'subagent',
    input: { agent: 'worker', task: 'nested' },
    result: { mode: 'single', results: [child] },
  }));

  assert.equal(analysis.subagentInputTokens, 15);
  assert.equal(analysis.subagentOutputTokens, 6);
  assert.equal(analysis.subagentCacheReadTokens, 3);
  assert.equal(analysis.subagentCacheWriteTokens, 1);
});
