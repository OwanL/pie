import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ColdBrowseHelperRuntime } from '../cold-browse-helper-runtime';
import { readColdBrowseFingerprintSync } from '../cold-browse-helper-protocol';
import type { SdkModule } from '../../lib/sdk-integration/sdk';
import { LIVE_PIPELINE_LIMITS } from '../../lib/rpc/live-pipeline';
import type { SessionEntryLike } from '../../../session-storage/transcripts/transcript';

test('cold browse serves capture only, wildcard size, partial refresh and explicit oversized unavailable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-model-exchange-'));
  const sessionPath = path.join(root, 'session.jsonl');
  const branch: SessionEntryLike[] = [{
    type: 'message', id: 'assistant', timestamp: '2026-10-08T00:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tool', name: 'display', arguments: { display: true } }] },
  }, {
    type: 'message', id: 'result', timestamp: '2026-10-08T00:00:01.000Z',
    message: { role: 'toolResult', toolCallId: 'tool', content: [{ type: 'text', text: 'display result' }] },
  }];
  const sdk = { SessionManager: { open: () => ({
    getBranch: () => branch, getSessionName: () => '', getCwd: () => root,
    buildSessionContext: () => ({ messages: [], model: null }),
  }) } } as unknown as Pick<SdkModule, 'SessionManager'>;
  const runtime = new ColdBrowseHelperRuntime({ sdk, startupCwd: root });
  const ref = { key: 'stable', kind: 'model-exchange' as const, source: 'durable' as const, sessionPath, messageId: 'result', toolCallId: 'tool', sizeBytes: 0, summary: '', available: true };
  let version = 0;
  async function load() {
    await fs.writeFile(sessionPath, `${++version}`);
    return (await runtime.execute({ operation: 'detail', fence: {
      sessionPath, sessionPathKey: sessionPath, coordinatorGeneration: 1, ownershipRevision: 0,
      fingerprint: readColdBrowseFingerprintSync(sessionPath),
    }, ref })).result;
  }
  try {
    const empty = await load();
    assert.equal('status' in empty && empty.status, 'unavailable');
    branch.unshift({ type: 'custom', id: 'produced', timestamp: '', customType: 'pie.tool-model-exchange', data: { version: 1, toolCallId: 'tool', produced: { name: 'actual', arguments: '{exact}' } } });
    const partial = await load();
    assert.equal('status' in partial && partial.status, 'loaded');
    if ('value' in partial) assert.deepEqual(partial.value, { produced: { name: 'actual', arguments: '{exact}' } });
    branch.push({ type: 'custom', id: 'received', timestamp: '', customType: 'pie.tool-model-exchange', data: { version: 1, toolCallId: 'tool', received: ['exact result'] } });
    const full = await load();
    if ('value' in full) assert.deepEqual(full.value, { produced: { name: 'actual', arguments: '{exact}' }, received: ['exact result'] });
    else assert.fail('expected full capture');
    branch.splice(0, 1, { type: 'custom', id: 'oversize', timestamp: '', customType: 'pie.tool-model-exchange', data: { version: 1, toolCallId: 'tool', produced: { name: 'actual', arguments: 'x'.repeat(LIVE_PIPELINE_LIMITS.previewBytes + 1) } } });
    const oversized = await load();
    assert.equal('status' in oversized && oversized.status, 'unavailable');
    if ('message' in oversized) assert.match(oversized.message, /exceeds/);
  } finally {
    runtime.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
