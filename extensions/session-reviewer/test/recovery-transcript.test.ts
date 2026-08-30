import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import {
  readRecoveryTranscriptIndex,
  recoveryTranscriptCacheMetrics,
  resetRecoveryTranscriptCache,
} from '../src/recovery-transcript.js';

function line(value: unknown): string { return `${JSON.stringify(value)}\n`; }

function assistantEntry(id: string, parentId: string | null, callId: string, padding = ''): unknown {
  return {
    type: 'message', id, parentId,
    message: { role: 'assistant', content: [{
      type: 'toolCall', id: callId, name: 'subagent',
      arguments: {
        agent: 'session-evaluator', bucket: 'small', workflowRef: `session-review-v2/target/evidence/${callId}`,
        task: padding,
      },
    }] },
  };
}

function resultEntry(id: string, parentId: string, callId: string): unknown {
  return {
    type: 'message', id, parentId,
    message: {
      role: 'toolResult', toolCallId: callId, toolName: 'subagent',
      content: [{ type: 'text', text: '{"criteria":[]}' }],
      details: { results: [{
        parentToolCallId: callId, exitCode: 0, finalOutput: '{"criteria":[]}',
        requestedBucket: 'small', bucket: 'small', bucketDowngraded: false,
        model: 'model', provider: 'provider', family: 'family', thinkingLevel: 'high', promptHash: 'hash',
        messages: [{ role: 'assistant', content: 'discard this nested transcript' }],
      }] },
    },
  };
}

test('recovery transcript cache reads an unchanged lineage once, then only its append delta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-transcript-cache-'));
  const file = path.join(dir, 'orchestrator.jsonl');
  const padding = 'x'.repeat(1024 * 1024);
  try {
    resetRecoveryTranscriptCache();
    fs.writeFileSync(file, line({ type: 'session', id: 'self' }) + line(assistantEntry('call-entry', null, 'call-1', padding)));
    const sourceBytes = fs.statSync(file).size;

    assert.equal(readRecoveryTranscriptIndex(file).calls.has('call-1'), true);
    const initial = recoveryTranscriptCacheMetrics();
    assert.equal(initial.fullReads, 1);
    assert.equal(initial.incrementalReads, 0);
    assert.equal(initial.bytesRead, sourceBytes);

    readRecoveryTranscriptIndex(file);
    const unchanged = recoveryTranscriptCacheMetrics();
    assert.equal(unchanged.unchangedHits, 1);
    assert.equal(unchanged.bytesRead, sourceBytes, 'an unchanged status check performs no second file read');

    const appended = line(resultEntry('result-entry', 'call-entry', 'call-1'));
    fs.appendFileSync(file, appended);
    assert.equal(readRecoveryTranscriptIndex(file).results.has('call-1'), true);
    const incremental = recoveryTranscriptCacheMetrics();
    assert.equal(incremental.incrementalReads, 1);
    assert.equal(incremental.fullReads, 1);
    assert.equal(incremental.appendedBytesRead, Buffer.byteLength(appended));
    assert.ok(incremental.probeBytesRead <= 8 * 1024);
    assert.ok(incremental.bytesRead < sourceBytes + Buffer.byteLength(appended) + (9 * 1024));

    resetRecoveryTranscriptCache();
    assert.equal(readRecoveryTranscriptIndex(file).results.has('call-1'), true, 'a cold restart reconstructs the same durable index');
    assert.equal(recoveryTranscriptCacheMetrics().fullReads, 1);
  } finally {
    resetRecoveryTranscriptCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('incremental branch edits replace abandoned work and physical rewrites rebuild the cache', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-transcript-branch-'));
  const file = path.join(dir, 'orchestrator.jsonl');
  try {
    resetRecoveryTranscriptCache();
    fs.writeFileSync(file, [
      line({ type: 'session', id: 'self' }),
      line(assistantEntry('original-call', null, 'original')),
      line(resultEntry('original-result', 'original-call', 'original')),
    ].join(''));
    assert.equal(readRecoveryTranscriptIndex(file).calls.has('original'), true);

    // Editing/resending is an appended sibling branch. The latest leaf owns
    // recovery even though the abandoned branch remains durable in the file.
    fs.appendFileSync(file, line(assistantEntry('edited-call', null, 'edited')));
    const edited = readRecoveryTranscriptIndex(file);
    assert.equal(edited.calls.has('original'), false);
    assert.equal(edited.calls.has('edited'), true);
    assert.equal(recoveryTranscriptCacheMetrics().incrementalReads, 1);

    fs.appendFileSync(file, line(resultEntry('edited-result', 'edited-call', 'edited')));
    assert.equal(readRecoveryTranscriptIndex(file).results.has('edited'), true);

    // A truncate/rewrite cannot use the append fast path and must fail back to
    // a complete reconstruction before exposing recovery state.
    fs.writeFileSync(file, line({ type: 'session', id: 'replacement' }) + line(assistantEntry('replacement-call', null, 'replacement')));
    const rewritten = readRecoveryTranscriptIndex(file);
    assert.equal(rewritten.calls.has('edited'), false);
    assert.equal(rewritten.calls.has('replacement'), true);
    const metrics = recoveryTranscriptCacheMetrics();
    assert.equal(metrics.rebuilds, 1);
    assert.equal(metrics.fullReads, 2);
  } finally {
    resetRecoveryTranscriptCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a mutation during a full read retries before admitting the snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-transcript-full-race-'));
  const file = path.join(dir, 'orchestrator.jsonl');
  const mutableFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const originalReadFile = mutableFs.readFileSync;
  const originalAppendFile = mutableFs.appendFileSync;
  let injected = false;
  try {
    resetRecoveryTranscriptCache();
    fs.writeFileSync(file, line({ type: 'session', id: 'self' }));
    mutableFs.readFileSync = ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const bytes = (originalReadFile as (...values: unknown[]) => unknown)(target, ...args);
      if (!injected && typeof target !== 'number' && path.resolve(String(target)) === path.resolve(file)) {
        injected = true;
        originalAppendFile(file, line(assistantEntry('late-call', null, 'late')));
      }
      return bytes;
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();

    const index = readRecoveryTranscriptIndex(file);
    assert.equal(injected, true);
    assert.equal(index.calls.has('late'), true, 'the mixed first read is discarded before cache admission');
    assert.equal(recoveryTranscriptCacheMetrics().fullReads, 2, 'one bounded retry produces the stable snapshot');
  } finally {
    mutableFs.readFileSync = originalReadFile;
    syncBuiltinESMExports();
    resetRecoveryTranscriptCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two consecutive full-read mutations fail closed without admitting a cache entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-transcript-unstable-'));
  const file = path.join(dir, 'orchestrator.jsonl');
  const mutableFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const originalReadFile = mutableFs.readFileSync;
  const originalAppendFile = mutableFs.appendFileSync;
  let mutations = 0;
  try {
    resetRecoveryTranscriptCache();
    fs.writeFileSync(file, line({ type: 'session', id: 'self' }));
    mutableFs.readFileSync = ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const bytes = (originalReadFile as (...values: unknown[]) => unknown)(target, ...args);
      if (mutations < 2 && typeof target !== 'number' && path.resolve(String(target)) === path.resolve(file)) {
        mutations += 1;
        originalAppendFile(file, line({ type: 'custom', id: `mutation-${mutations}`, parentId: null }));
      }
      return bytes;
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();

    assert.throws(() => readRecoveryTranscriptIndex(file), /changed during recovery read/);
    assert.equal(mutations, 2);
    const metrics = recoveryTranscriptCacheMetrics();
    assert.equal(metrics.fullReads, 2);
    assert.equal(metrics.cachedFiles, 0);
  } finally {
    mutableFs.readFileSync = originalReadFile;
    syncBuiltinESMExports();
    resetRecoveryTranscriptCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a mutation during an append read retries the complete delta before admission', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-transcript-append-race-'));
  const file = path.join(dir, 'orchestrator.jsonl');
  const mutableFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const originalRead = mutableFs.readSync;
  const originalAppendFile = mutableFs.appendFileSync;
  let injected = false;
  try {
    resetRecoveryTranscriptCache();
    fs.writeFileSync(file, line({ type: 'session', id: 'self' }));
    readRecoveryTranscriptIndex(file);
    const cachedBytes = fs.statSync(file).size;
    fs.appendFileSync(file, line(assistantEntry('append-call', null, 'append')));

    mutableFs.readSync = ((
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      const read = originalRead(descriptor, buffer, offset, length, position);
      if (!injected && position === cachedBytes) {
        injected = true;
        originalAppendFile(file, line(resultEntry('append-result', 'append-call', 'append')));
      }
      return read;
    }) as typeof fs.readSync;
    syncBuiltinESMExports();

    const index = readRecoveryTranscriptIndex(file);
    assert.equal(injected, true);
    assert.equal(index.calls.has('append'), true);
    assert.equal(index.results.has('append'), true, 'the first partial delta is never cached');
    const metrics = recoveryTranscriptCacheMetrics();
    assert.equal(metrics.fullReads, 1);
    assert.equal(metrics.incrementalReads, 1, 'only the stable retry is admitted as an incremental read');
  } finally {
    mutableFs.readSync = originalRead;
    syncBuiltinESMExports();
    resetRecoveryTranscriptCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
