import test from 'node:test';
import assert from 'node:assert/strict';

import type { ChatMessage, FileChangeEntry } from '../../../../src/shared/protocol';
import { deriveFileChangesFromTranscript } from '../../../../src/host/core/file-change-derivation';
// Import the EXTENSION's JSONL adapter (option A's second traversal) — this is
// what pins "shared logic, not shared value": the same per-tool-call core, two
// traversal adapters (ChatMessage[] vs SessionEntry[]), must yield equal results.
import { deriveFileChangesFromSessionEntries } from '../../../../../extensions/session-changes/src/session-jsonl';
import type { FileChange } from '../../../../../extensions/session-changes/src/types';

// ─── Equivalence: host (ChatMessage[]) vs extension (SessionEntry[]/JSONL) ──
//
// Option A shares the per-tool-call CORE but NOT the derived VALUE: the host
// derives from the merged ChatMessage.toolCalls[] (live, in-memory), the
// session-changes tool re-derives from the raw session JSONL (separate
// toolCall part + toolResult entries joined by toolCallId). This test pins that
// the two traversals agree. Its teeth (docs/SESSION-CHANGES-TOOL.md §8):
//   (a) a subagent tool call whose SEPARATE toolResult entry carries inner
//       transcripts — a plain content-parts scan would drop all subagent
//       changes;
//   (b) a FAILED edit whose toolResult.isError is set — must be skipped
//       (matching the host's status==='failed' skip), not leaked.

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

/** The inner subagent transcript shape (pi-ai Message), shared by both forms. */
const subagentDetails = {
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
          content: [
            { type: 'toolCall', name: 'write', arguments: { path: 'src/sub.ts', content: 'd\ne' } },
          ],
        },
      ],
      stderr: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    },
  ],
};

/** Host form: the merged ChatMessage[] view (toolCall + result on one entry). */
function hostTranscript(): ChatMessage[] {
  return [
    makeChatMessage({
      id: 'm1',
      createdAt: 't1',
      toolCalls: [
        { id: 'call_1', name: 'write', input: { path: 'src/new.ts', content: 'a\nb\nc' }, status: 'completed' },
      ],
    }),
    makeChatMessage({
      id: 'm2',
      createdAt: 't2',
      toolCalls: [
        { id: 'call_2', name: 'edit', input: { path: 'src/widget.ts', oldText: 'x\ny', newText: 'x\ny\nz' }, status: 'completed' },
      ],
    }),
    makeChatMessage({
      id: 'm3',
      createdAt: 't3',
      toolCalls: [
        // failed edit — must be skipped by both adapters
        { id: 'call_3', name: 'edit', input: { path: 'src/failed.ts', oldText: 'a', newText: 'b' }, status: 'failed' },
      ],
    }),
    makeChatMessage({
      id: 'm4',
      createdAt: 't4',
      toolCalls: [
        {
          id: 'call_4',
          name: 'subagent',
          input: { agent: 'worker', task: 'do work' },
          result: { content: [{ type: 'text', text: 'done' }], details: subagentDetails },
          status: 'completed',
        },
      ],
    }),
  ];
}

/** Extension form: the raw JSONL shape — assistant toolCall parts (arguments=input)
 *  as SEPARATE entries from their toolResult entries (joined by toolCallId). */
function jsonlEntries(): Record<string, unknown>[] {
  return [
    { type: 'session', version: 3, id: 's1', timestamp: 't0', cwd: '/proj' },
    // m1: write (created)
    {
      type: 'message', id: 'm1', timestamp: 't1',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'write', arguments: { path: 'src/new.ts', content: 'a\nb\nc' } }] },
    },
    { type: 'message', id: 'tr1', timestamp: 't1', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'write', content: 'ok', isError: false } },
    // m2: edit (modified)
    {
      type: 'message', id: 'm2', timestamp: 't2',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_2', name: 'edit', arguments: { path: 'src/widget.ts', oldText: 'x\ny', newText: 'x\ny\nz' } }] },
    },
    { type: 'message', id: 'tr2', timestamp: 't2', message: { role: 'toolResult', toolCallId: 'call_2', toolName: 'edit', content: 'ok', isError: false } },
    // m3: FAILED edit — toolResult.isError=true (the JSONL equivalent of status='failed')
    {
      type: 'message', id: 'm3', timestamp: 't3',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_3', name: 'edit', arguments: { path: 'src/failed.ts', oldText: 'a', newText: 'b' } }] },
    },
    { type: 'message', id: 'tr3', timestamp: 't3', message: { role: 'toolResult', toolCallId: 'call_3', toolName: 'edit', content: 'err', isError: true } },
    // m4: subagent — details live on the SEPARATE toolResult entry, NOT the toolCall part
    {
      type: 'message', id: 'm4', timestamp: 't4',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_4', name: 'subagent', arguments: { agent: 'worker', task: 'do work' } }] },
    },
    { type: 'message', id: 'tr4', timestamp: 't4', message: { role: 'toolResult', toolCallId: 'call_4', toolName: 'subagent', content: 'done', isError: false, details: subagentDetails } },
  ];
}

/** Normalize to a plain comparable shape (drops timestamp/messageId noise that
 *  is implementation-internal to each adapter, keeping the teeth-relevant
 *  fields: path, kind, churn, toolCallId, description). */
function normalize(changes: FileChangeEntry[] | FileChange[]): unknown[] {
  return changes.map((c) => ({
    path: c.path,
    kind: c.kind,
    additions: c.additions,
    deletions: c.deletions,
    toolCallId: c.toolCallId,
    description: c.description,
  }));
}

test('equivalence: host ChatMessage[] and extension SessionEntry[] yield equal changes', () => {
  const host = normalize(deriveFileChangesFromTranscript(hostTranscript()));
  const ext = normalize(deriveFileChangesFromSessionEntries(jsonlEntries() as never));
  assert.deepEqual(ext, host);
});

test('equivalence: both adapters skip the failed edit (tooth b)', () => {
  const host = deriveFileChangesFromTranscript(hostTranscript());
  const ext = deriveFileChangesFromSessionEntries(jsonlEntries() as never);
  assert.ok(!host.some((c) => c.path === 'src/failed.ts'), 'host leaked the failed edit');
  assert.ok(!ext.some((c) => c.path === 'src/failed.ts'), 'extension leaked the failed edit');
});

test('equivalence: both adapters surface subagent-attributed changes (tooth a)', () => {
  const host = deriveFileChangesFromTranscript(hostTranscript());
  const ext = deriveFileChangesFromSessionEntries(jsonlEntries() as never);
  assert.ok(host.some((c) => c.path === 'src/sub.ts'), 'host dropped the subagent change');
  assert.ok(ext.some((c) => c.path === 'src/sub.ts'), 'extension dropped the subagent change');
  // The subagent change's synthetic toolCallId is derived from the parent
  // call_4 the same way in both adapters (call_4-sa0-m0-c0).
  const hostSub = host.find((c) => c.path === 'src/sub.ts');
  const extSub = ext.find((c) => c.path === 'src/sub.ts');
  assert.equal(extSub!.toolCallId, hostSub!.toolCallId);
});

test('equivalence: churn totals match across both forms', () => {
  const host = deriveFileChangesFromTranscript(hostTranscript());
  const ext = deriveFileChangesFromSessionEntries(jsonlEntries() as never);
  const sum = (cs: FileChangeEntry[] | FileChange[]) =>
    cs.reduce((a, c) => a + (c.additions ?? 0), 0) +
    cs.reduce((a, c) => a + (c.deletions ?? 0), 0);
  assert.equal(sum(ext), sum(host));
});
