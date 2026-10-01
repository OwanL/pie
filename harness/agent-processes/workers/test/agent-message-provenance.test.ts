import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { attachAgentMessageProvenance } from '../agent-message-provenance';
import { createSessionControlSender } from '../../lib/rpc/session-control-attribution';
import { mapTranscript, type SessionEntryLike } from '../../../session-storage/transcripts/transcript';
import { FENCED_ENTRY_ID, type MutableSdkSessionManager } from '../../../session-storage/ownership/session-manager-fence';
import type { SessionContext } from '../../coordinator/server-types';

function fixture(result: 'stored' | 'missing' | 'throw' | 'fenced', t: { after: (callback: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-agent-provenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionFile = path.join(root, 'session.jsonl');
  const entries: SessionEntryLike[] = [];
  const errors: string[] = [];
  const sender = createSessionControlSender({ sessionId: 'authenticated-source', identityFallback: false }, 'Source');
  let settle!: (durable: boolean) => void;
  const promise = new Promise<boolean>((resolve) => { settle = resolve; });
  const context = {
    activeRequest: {
      id: 'agent-send', messageIndex: 0, aborted: false,
      agentMessageLocalId: 'local:agent-session:message', coordinatorAttribution: sender,
      agentMessageDurability: { settle, promise },
    },
  } as unknown as SessionContext;
  let disk = '';
  const unexpectedMutation = (): never => { throw new Error('unexpected session-manager mutation'); };
  const underlying: MutableSdkSessionManager = {
    getCwd: () => root,
    getSessionName: () => undefined,
    getBranch: () => entries,
    getEntries: () => entries,
    newSession: unexpectedMutation,
    setSessionFile: unexpectedMutation,
    _persist: unexpectedMutation,
    _appendEntry: unexpectedMutation,
    appendThinkingLevelChange: unexpectedMutation,
    appendModelChange: unexpectedMutation,
    appendCompaction: unexpectedMutation,
    appendCustomEntry: unexpectedMutation,
    appendSessionInfo: unexpectedMutation,
    appendCustomMessageEntry: unexpectedMutation,
    appendLabelChange: unexpectedMutation,
    branch: unexpectedMutation,
    resetLeaf: unexpectedMutation,
    branchWithSummary: unexpectedMutation,
    createBranchedSession: unexpectedMutation,
    flushed: true,
    isPersisted: () => true,
    getSessionFile: () => sessionFile,
    _rewriteFile() {
      disk = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
      fs.writeFileSync(sessionFile, disk);
    },
    appendMessage(message: unknown) {
      if (result === 'throw') throw new Error('append unavailable');
      if (result === 'fenced') return FENCED_ENTRY_ID;
      if (result === 'missing') return '';
      const entryId = `entry-${entries.length + 1}`;
      entries.push({ id: entryId, type: 'message', timestamp: new Date().toISOString(), message: message as SessionEntryLike['message'] });
      if (this.flushed) {
        disk += JSON.stringify(entries.at(-1)) + '\n';
        fs.appendFileSync(sessionFile, JSON.stringify(entries.at(-1)) + '\n');
      }
      if ((message as { role?: string }).role === 'assistant') this.flushed = true;
      return entryId;
    },
  };
  const manager = attachAgentMessageProvenance(underlying, () => context, (_owner, reason) => {
    errors.push(reason);
    settle(false);
  });
  return { manager, underlying, context, entries, errors, sender, promise, disk: () => disk };
}

test('authenticated sender is attached atomically at SDK append and restored on reload without a sidecar', async (t) => {
  const { manager, context, entries, sender, promise } = fixture('stored', t);
  const original = { role: 'user', content: 'request', pieAgentMessageProvenance: { sender: 'forged' } };
  assert.equal(manager.appendMessage(original), 'entry-1');
  assert.equal(await promise, true);
  assert.deepEqual(original, { role: 'user', content: 'request', pieAgentMessageProvenance: { sender: 'forged' } });
  assert.equal(context.activeRequest?.agentMessageProvenanceEntryId, 'entry-1');
  assert.equal(entries.length, 1);
  const reloaded = mapTranscript(JSON.parse(JSON.stringify(entries)) as SessionEntryLike[]);
  assert.equal(reloaded[0]?.customType, 'agent-message');
  assert.deepEqual(reloaded[0]?.sender, sender);
  assert.equal(reloaded[0]?.markdown, 'request');
});

test('queued sender is selected only at delivery and persists through reload', (t) => {
  const { manager, context, sender, disk } = fixture('stored', t);
  context.activeRequest!.agentMessageLocalId = undefined;
  context.activeRequest!.coordinatorAttribution = undefined;
  assert.equal(manager.appendMessage({ role: 'assistant', content: [] }), 'entry-1');
  context.activeRequest!.agentMessageLocalId = 'local:agent-session:queued';
  context.activeRequest!.coordinatorAttribution = sender;
  manager.appendMessage({ role: 'user', content: 'delivered after queue' });
  const reloaded = mapTranscript(disk().trim().split('\n').map((line) => JSON.parse(line) as SessionEntryLike));
  assert.deepEqual(reloaded.at(-1)?.sender, sender);
  assert.equal(reloaded.at(-1)?.customType, 'agent-message');
});

test('agent origin without a sender keeps a durable agent marker', (t) => {
  const { manager, context, entries } = fixture('stored', t);
  context.activeRequest!.coordinatorAttribution = undefined;
  manager.appendMessage({ role: 'user', content: 'agent request' });
  const row = mapTranscript(JSON.parse(JSON.stringify(entries)) as SessionEntryLike[])[0];
  assert.equal(row?.customType, 'agent-message');
  assert.equal(row?.sender, undefined);
});

test('fresh sessions flush the attributed user entry before acceptance, without waiting for an answer', async (t) => {
  const { manager, promise, entries, sender, disk } = fixture('stored', t);
  manager.flushed = false;
  manager.appendMessage({ role: 'user', content: 'fresh session request' });
  assert.equal(await promise, true);
  assert.equal(manager.flushed, true);
  assert.equal(entries.length, 1, 'no assistant answer is needed for acceptance');
  assert.deepEqual(mapTranscript(disk().trim().split('\n').map((line) => JSON.parse(line) as SessionEntryLike))[0]?.sender, sender);
});

test('deferred SDK rewrite failure or fenced no-op never confirms first-user durability', async (t) => {
  for (const mode of ['throw', 'no-op'] as const) {
    const { manager, underlying, errors, promise } = fixture('stored', t);
    underlying.flushed = false;
    underlying._rewriteFile = () => {
      if (mode === 'throw') throw new Error('disk unavailable');
    };
    assert.throws(() => manager.appendMessage({ role: 'user', content: 'request' }));
    assert.equal(await promise, false, mode);
    assert.deepEqual(errors, ['append_failed']);
  }
});

test('missing, throwing, and fenced SDK appends cannot confirm admitted sender durability', async (t) => {
  for (const mode of ['missing', 'throw', 'fenced'] as const) {
    const { manager, errors, promise, entries } = fixture(mode, t);
    if (mode === 'throw') assert.throws(() => manager.appendMessage({ role: 'user', content: 'request' }));
    else manager.appendMessage({ role: 'user', content: 'request' });
    assert.equal(await promise, false, mode);
    assert.deepEqual(errors, [mode === 'fenced' ? 'fenced' : 'append_failed']);
    assert.equal(entries.length, 0);
  }
});
