import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveFileChangeFromToolCall,
  deriveFileChangesFromToolCall,
  deriveFileChangesFromSubagentResult,
  deriveFileChangesFromTranscript,
} from '../../../../src/host/core/file-change-derivation';
import type { ChatMessage, FileChangeEntry } from '../../../../src/shared/protocol';

// ─── deriveFileChangeFromToolCall ───────────────────────────────────────────

test('deriveFileChangeFromToolCall: null for non-file tool', () => {
  const result = deriveFileChangeFromToolCall(
    { id: 'tc1', name: 'read', input: { path: '/foo.txt' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result, null);
});

test('deriveFileChangeFromToolCall: created for write', () => {
  const result = deriveFileChangeFromToolCall(
    { id: 'tc1', name: 'write', input: { path: '/foo.txt', content: 'line1\nline2' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.ok(result);
  assert.equal(result!.kind, 'created');
  assert.equal(result!.path, '/foo.txt');
  assert.equal(result!.additions, 2);
  assert.equal(result!.deletions, 0);
});

test('deriveFileChangeFromToolCall: modified for edit with oldText/newText', () => {
  const result = deriveFileChangeFromToolCall(
    {
      id: 'tc1',
      name: 'edit',
      input: { path: '/foo.txt', oldText: 'a\nb', newText: 'a\nb\nc' },
    },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.ok(result);
  assert.equal(result!.kind, 'modified');
  assert.equal(result!.additions, 3);
  assert.equal(result!.deletions, 2);
});

test('deriveFileChangeFromToolCall: deleted for delete', () => {
  const result = deriveFileChangeFromToolCall(
    { id: 'tc1', name: 'delete_file', input: { path: '/foo.txt' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.ok(result);
  assert.equal(result!.kind, 'deleted');
});

// ─── deriveFileChangesFromToolCall (plural: bash rm) ──────────────────────

test('deriveFileChangesFromToolCall: bash rm single file', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm /foo.txt' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, '/foo.txt');
  assert.equal(result[0].kind, 'deleted');
  assert.equal(result[0].description, 'deleted');
});

test('deriveFileChangesFromToolCall: bash rm multiple files', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm -rf a.txt b.txt c.txt' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 3);
  const paths = result.map((c) => c.path).sort();
  assert.deepEqual(paths, ['a.txt', 'b.txt', 'c.txt']);
  for (const c of result) assert.equal(c.kind, 'deleted');
});

test('deriveFileChangesFromToolCall: bash rm skips flags and globs', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm -f -- *.log keep.txt' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  // *.log is a glob and excluded; keep.txt after `--` is kept.
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'keep.txt');
});

test('deriveFileChangesFromToolCall: bash rm with quotes and separators', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'cd src && rm "my file.txt" \'other.txt\'; rm third.ts' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  const paths = result.map((c) => c.path).sort();
  assert.deepEqual(paths, ['my file.txt', 'other.txt', 'third.ts']);
});

test('deriveFileChangesFromToolCall: bash rm in a pipe stops at operator', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm foo.txt > /dev/null' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'foo.txt');
});

test('deriveFileChangesFromToolCall: git rm tracks working-tree deletes', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'git rm old.ts' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'old.ts');
  assert.equal(result[0].kind, 'deleted');
});

test('deriveFileChangesFromToolCall: git rm --cached is not a working-tree delete', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'git rm --cached tracked.txt' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 0);
});

test('deriveFileChangesFromToolCall: non-delete bash command yields nothing', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'ls -la && echo done' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.deepEqual(result, []);
});

test('deriveFileChangesFromToolCall: delegates to singular for write', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'write', input: { path: '/foo.txt', content: 'line1\nline2' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'created');
  assert.equal(result[0].additions, 2);
});

// ─── Tier 1: tilde expansion ────────────────────────────────────────────────

test('deriveFileChangesFromToolCall: bash rm with tilde expands to home', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm ~/notes.txt' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 1);
  assert.ok(result[0].path.length > 0);
  assert.ok(!result[0].path.startsWith('~'));
  assert.ok(result[0].path.endsWith('notes.txt'));
});

test('deriveFileChangesFromToolCall: bash rm with bare tilde expands to home dir', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm ~' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 1);
  assert.ok(!result[0].path.startsWith('~'));
});

test('deriveFileChangesFromToolCall: bash rm with tilde in multiple paths', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm -rf ~/.pi/agent/agents && rm ~/.pi/agent/settings.json' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 2);
  for (const c of result) {
    assert.ok(!c.path.startsWith('~'), `path ${c.path} should be expanded`);
  }
});

test('deriveFileChangesFromToolCall: tilde-user is left as-is (no passwd lookup)', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm ~root/file.txt' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, '~root/file.txt');
});

// ─── Tier 1: brace expansion ─────────────────────────────────────────────────

test('deriveFileChangesFromToolCall: brace expansion in rm paths', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm src/file{1,2,3}.ts' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 3);
  const paths = result.map((c) => c.path).sort();
  assert.deepEqual(paths, ['src/file1.ts', 'src/file2.ts', 'src/file3.ts']);
});

test('deriveFileChangesFromToolCall: brace expansion with directory variants', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm src/{a,b}/test.ts' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 2);
  const paths = result.map((c) => c.path).sort();
  assert.deepEqual(paths, ['src/a/test.ts', 'src/b/test.ts']);
});

test('deriveFileChangesFromToolCall: nested brace expansion', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm {src/{a,b},lib}/x.ts' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 3);
  const paths = result.map((c) => c.path).sort();
  assert.deepEqual(paths, ['lib/x.ts', 'src/a/x.ts', 'src/b/x.ts']);
});

test('deriveFileChangesFromToolCall: no brace expansion for single option', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm {only}.ts' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, '{only}.ts');
});

test('deriveFileChangesFromToolCall: unbalanced braces left as-is', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm file{1,2.ts' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'file{1,2.ts');
});

// ─── Tier 1: nested shell (bash -c / sh -c) ──────────────────────────────────

test('deriveFileChangesFromToolCall: nested bash -c rm', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'bash -c "rm nested.ts"' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'nested.ts');
  assert.equal(result[0].kind, 'deleted');
});

test('deriveFileChangesFromToolCall: nested sh -c with multiple files', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: "sh -c 'rm a.ts b.ts'" } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 2);
  const paths = result.map((c) => c.path).sort();
  assert.deepEqual(paths, ['a.ts', 'b.ts']);
});

test('deriveFileChangesFromToolCall: nested bash -c with flags before -c', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'bash -e -c "rm flag-test.ts"' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'flag-test.ts');
});

test('deriveFileChangesFromToolCall: nested bash -c combined with outer rm', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm outer.ts && bash -c "rm inner.ts"' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 2);
  const paths = result.map((c) => c.path).sort();
  assert.deepEqual(paths, ['inner.ts', 'outer.ts']);
});

// ─── Tier 1: trash command ─────────────────────────────────────────────────

test('deriveFileChangesFromToolCall: trash command tracks deletion', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'trash old-file.ts' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'old-file.ts');
  assert.equal(result[0].kind, 'deleted');
});

test('deriveFileChangesFromToolCall: trash-put with multiple files', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'trash-put a.txt b.txt c.txt' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 3);
  const paths = result.map((c) => c.path).sort();
  assert.deepEqual(paths, ['a.txt', 'b.txt', 'c.txt']);
});

test('deriveFileChangesFromToolCall: trash skips flags', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'trash -f -- keep.ts' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'keep.ts');
});

// ─── Tier 1: combined features ─────────────────────────────────────────────

test('deriveFileChangesFromToolCall: brace + tilde combined', () => {
  const result = deriveFileChangesFromToolCall(
    { id: 'tc1', name: 'bash', input: { command: 'rm ~/{a,b}.txt' } },
    'msg1',
    '2024-01-01T00:00:00Z',
  );
  assert.equal(result.length, 2);
  for (const c of result) {
    assert.ok(!c.path.startsWith('~'), `path ${c.path} should be expanded`);
    assert.ok(c.path.endsWith('a.txt') || c.path.endsWith('b.txt'));
  }
});

// ─── deriveFileChangesFromSubagentResult ──────────────────────────────────

function buildSubagentResult(innerToolCalls: { name: string; arguments: Record<string, unknown> }[]) {
  return {
    content: [{ type: 'text', text: 'done' }],
    details: {
      mode: 'single',
      agentScope: 'user',
      projectAgentsDir: null,
      results: [
        {
          agent: 'worker',
          agentSource: 'user',
          task: 'fix bugs',
          exitCode: 0,
          messages: [
            {
              role: 'assistant',
              content: innerToolCalls.map((tc) => ({ type: 'toolCall', ...tc })),
            },
          ],
          stderr: '',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
        },
      ],
    },
  };
}

test('deriveFileChangesFromSubagentResult: empty for non-subagent result', () => {
  const result = deriveFileChangesFromSubagentResult(
    { text: 'plain text' },
    'msg1',
    '2024-01-01T00:00:00Z',
    'tc1',
  );
  assert.deepEqual(result, []);
});

test('deriveFileChangesFromSubagentResult: reads compact persisted summaries without full tool arguments', () => {
  const subagentResult = {
    details: {
      mode: 'single',
      results: [{
        messages: [],
        transcriptCompacted: true,
        fileChanges: [{ path: '/compact.ts', kind: 'modified', description: '2 edits', additions: 3, deletions: 1 }],
      }],
    },
  };
  const changes = deriveFileChangesFromSubagentResult(subagentResult, 'msg1', '2024-01-01T00:00:00Z', 'tc1');
  assert.deepEqual(changes.map((change) => ({
    path: change.path,
    kind: change.kind,
    additions: change.additions,
    deletions: change.deletions,
  })), [{ path: '/compact.ts', kind: 'modified', additions: 3, deletions: 1 }]);
});

test('deriveFileChangesFromSubagentResult: recursively falls back to nested shell transcripts', () => {
  const result = {
    details: {
      results: [{
        messages: [{
          role: 'toolResult',
          toolName: 'subagent',
          details: {
            results: [{
              messages: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'rm nested.txt' } }] }],
            }],
          },
        }],
      }],
    },
  };
  const changes = deriveFileChangesFromSubagentResult(result, 'msg1', '2024-01-01T00:00:00Z', 'tc1');
  assert.deepEqual(changes.map((change) => ({ path: change.path, kind: change.kind })), [{ path: 'nested.txt', kind: 'deleted' }]);
});

test('deriveFileChangesFromSubagentResult: extracts write from subagent messages', () => {
  const subagentResult = buildSubagentResult([
    { name: 'write', arguments: { path: '/inner.txt', content: 'hello\nworld' } },
  ]);
  const changes = deriveFileChangesFromSubagentResult(subagentResult, 'msg1', '2024-01-01T00:00:00Z', 'tc1');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, '/inner.txt');
  assert.equal(changes[0].kind, 'created');
  assert.equal(changes[0].additions, 2);
  assert.equal(changes[0].messageId, 'msg1');
  assert.ok(changes[0].toolCallId.startsWith('tc1-sa'));
});

test('deriveFileChangesFromSubagentResult: extracts edit from subagent messages', () => {
  const subagentResult = buildSubagentResult([
    { name: 'edit', arguments: { path: '/inner.ts', oldText: 'foo', newText: 'bar\nbaz' } },
  ]);
  const changes = deriveFileChangesFromSubagentResult(subagentResult, 'msg1', '2024-01-01T00:00:00Z', 'tc1');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'modified');
  assert.equal(changes[0].additions, 2);
  assert.equal(changes[0].deletions, 1);
});

test('deriveFileChangesFromSubagentResult: skips non-file tools inside subagent', () => {
  const subagentResult = buildSubagentResult([
    { name: 'read', arguments: { path: '/inner.txt' } },
    { name: 'bash', arguments: { command: 'ls' } },
  ]);
  const changes = deriveFileChangesFromSubagentResult(subagentResult, 'msg1', '2024-01-01T00:00:00Z', 'tc1');
  assert.equal(changes.length, 0);
});

test('deriveFileChangesFromSubagentResult: handles multiple results (parallel mode)', () => {
  const subagentResult = {
    content: [{ type: 'text', text: 'done' }],
    details: {
      mode: 'parallel',
      agentScope: 'user',
      projectAgentsDir: null,
      results: [
        {
          agent: 'a1',
          agentSource: 'user',
          task: 't1',
          exitCode: 0,
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'toolCall', name: 'write', arguments: { path: '/a.txt', content: 'a' } }],
            },
          ],
          stderr: '',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
        },
        {
          agent: 'a2',
          agentSource: 'user',
          task: 't2',
          exitCode: 0,
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'toolCall', name: 'edit', arguments: { path: '/b.ts', oldText: 'x', newText: 'y' } }],
            },
          ],
          stderr: '',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
        },
      ],
    },
  };
  const changes = deriveFileChangesFromSubagentResult(subagentResult, 'msg1', '2024-01-01T00:00:00Z', 'tc1');
  assert.equal(changes.length, 2);
  const paths = changes.map((c) => c.path).sort();
  assert.deepEqual(paths, ['/a.txt', '/b.ts']);
});

// ─── deriveFileChangesFromTranscript ──────────────────────────────────────

function makeChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    createdAt: '2024-01-01T00:00:00Z',
    markdown: '',
    status: 'completed',
    toolCalls: [],
    ...overrides,
  };
}

test('deriveFileChangesFromTranscript: includes regular tool calls', () => {
  const transcript: ChatMessage[] = [
    makeChatMessage({
      toolCalls: [
        { id: 'tc1', name: 'write', input: { path: '/x.txt', content: 'hello' }, status: 'completed' },
      ],
    }),
  ];
  const changes = deriveFileChangesFromTranscript(transcript);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, '/x.txt');
});

test('deriveFileChangesFromTranscript: includes subagent inner changes', () => {
  const subagentResult = buildSubagentResult([
    { name: 'write', arguments: { path: '/sub.txt', content: 'data' } },
  ]);
  const transcript: ChatMessage[] = [
    makeChatMessage({
      toolCalls: [
        { id: 'tc1', name: 'subagent', input: { agent: 'worker', task: 'do work' }, result: subagentResult, status: 'completed' },
      ],
    }),
  ];
  const changes = deriveFileChangesFromTranscript(transcript);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, '/sub.txt');
  assert.equal(changes[0].kind, 'created');
});

test('deriveFileChangesFromTranscript: accumulates subagent changes with parent changes', () => {
  const subagentResult = buildSubagentResult([
    { name: 'edit', arguments: { path: '/shared.ts', oldText: 'a\nb', newText: 'a\nb\nc\nd' } },
  ]);
  const transcript: ChatMessage[] = [
    makeChatMessage({
      toolCalls: [
        { id: 'tc1', name: 'edit', input: { path: '/shared.ts', oldText: 'x', newText: 'a\nb' }, status: 'completed' },
      ],
    }),
    makeChatMessage({
      toolCalls: [
        { id: 'tc2', name: 'subagent', input: { agent: 'worker', task: 'do more' }, result: subagentResult, status: 'completed' },
      ],
    }),
  ];
  const changes = deriveFileChangesFromTranscript(transcript);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, '/shared.ts');
  assert.equal(changes[0].kind, 'modified');
  assert.equal(changes[0].additions, 6); // 2 from parent + 4 from subagent
  assert.equal(changes[0].deletions, 3); // 1 from parent + 2 from subagent
});

test('deriveFileChangesFromTranscript: subagent delete removes prior create', () => {
  const subagentResult = buildSubagentResult([
    { name: 'delete_file', arguments: { path: '/temp.txt' } },
  ]);
  const transcript: ChatMessage[] = [
    makeChatMessage({
      toolCalls: [
        { id: 'tc1', name: 'write', input: { path: '/temp.txt', content: 'tmp' }, status: 'completed' },
      ],
    }),
    makeChatMessage({
      toolCalls: [
        { id: 'tc2', name: 'subagent', input: { agent: 'cleaner', task: 'cleanup' }, result: subagentResult, status: 'completed' },
      ],
    }),
  ];
  const changes = deriveFileChangesFromTranscript(transcript);
  assert.equal(changes.length, 0);
});

test('deriveFileChangesFromTranscript: bash rm produces deleted entry', () => {
  const transcript: ChatMessage[] = [
    makeChatMessage({
      toolCalls: [
        { id: 'tc1', name: 'bash', input: { command: 'rm stale.txt' }, status: 'completed' },
      ],
    }),
  ];
  const changes = deriveFileChangesFromTranscript(transcript);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, 'stale.txt');
  assert.equal(changes[0].kind, 'deleted');
});

test('deriveFileChangesFromTranscript: bash rm of session-created file is net no-op', () => {
  const transcript: ChatMessage[] = [
    makeChatMessage({
      toolCalls: [
        { id: 'tc1', name: 'write', input: { path: '/tmp.txt', content: 'x' }, status: 'completed' },
      ],
    }),
    makeChatMessage({
      toolCalls: [
        { id: 'tc2', name: 'bash', input: { command: 'rm /tmp.txt' }, status: 'completed' },
      ],
    }),
  ];
  const changes = deriveFileChangesFromTranscript(transcript);
  assert.equal(changes.length, 0);
});

test('deriveFileChangesFromTranscript: skips failed subagent tool calls', () => {
  const subagentResult = buildSubagentResult([
    { name: 'write', arguments: { path: '/fail.txt', content: 'data' } },
  ]);
  const transcript: ChatMessage[] = [
    makeChatMessage({
      toolCalls: [
        { id: 'tc1', name: 'subagent', input: { agent: 'worker', task: 'do work' }, result: subagentResult, status: 'failed' },
      ],
    }),
  ];
  const changes = deriveFileChangesFromTranscript(transcript);
  assert.equal(changes.length, 0);
});
