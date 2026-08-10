import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import {
  coerceHistoricalSessionSummaries,
  discoverHistoricalSessions,
  normalizeSessionPath,
  summarizeTranscriptJsonl,
} from '../scripts/transcript-source.ts';
import { deepClone, loadFixture, withTempDir } from './helpers.ts';

function line(value: unknown): string {
  return JSON.stringify(value);
}

function transcript(entries: unknown[]): string {
  return entries.map(line).join('\n');
}

function header(id = 'session-1'): unknown {
  return { type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: 'C:\\repo' };
}

function user(id: string, parentId: string | null, text: string): unknown {
  return { type: 'message', id, parentId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text }] } };
}

function assistant(
  id: string,
  parentId: string,
  model: string,
  stopReason: string,
  totalTokens = 0,
  content: unknown[] = [],
): unknown {
  return {
    type: 'message', id, parentId, timestamp: `2026-01-01T00:00:0${id.length}.000Z`,
    message: {
      role: 'assistant', model, stopReason, content,
      usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { total: totalTokens / 1000 } },
    },
  };
}

test('stable session identity requires the first non-empty line to be a valid session header', () => {
  const valid = summarizeTranscriptJsonl(`\n${line(header('stable-id'))}\n`, 'C:/repo/stable.jsonl');
  assert.equal(valid?.sessionId, 'stable-id');
  assert.equal(summarizeTranscriptJsonl(`${line(user('before', null, 'not a header'))}\n${line(header('too-late'))}`, 'C:/repo/malformed.jsonl'), null);
  assert.equal(summarizeTranscriptJsonl(`not-json\n${line(header('too-late'))}`, 'C:/repo/malformed.jsonl'), null);
});

test('reconstructs only the active parentId branch', () => {
  const raw = transcript([
    header(),
    { type: 'thinking_level_change', id: 'think', parentId: null, timestamp: '2026-01-01T00:00:00.500Z', thinkingLevel: 'high' },
    user('user', 'think', 'active prompt'),
    assistant('abandoned', 'user', 'abandoned-model', 'stop', 500),
    assistant('active', 'user', 'active-model', 'stop', 100),
  ]);

  const summary = summarizeTranscriptJsonl(raw, 'C:\\Repo\\session.jsonl');
  assert.ok(summary);
  assert.equal(summary.successfulAssistantTurns, 1);
  assert.equal(summary.firstUserMessageChars, 'active prompt'.length);
  assert.deepEqual(summary.attributions.map((row) => [row.modelId, row.thinkingLevel]), [['active-model', 'high']]);
});

test('max thinking level is preserved in transcript attribution', () => {
  const raw = transcript([
    header(),
    { type: 'thinking_level_change', id: 'think', parentId: null, timestamp: '2026-01-01T00:00:00.500Z', thinkingLevel: 'max' },
    user('user', 'think', 'active prompt'),
    assistant('active', 'user', 'active-model', 'stop', 100),
  ]);

  const summary = summarizeTranscriptJsonl(raw, 'C:\\Repo\\session.jsonl');
  assert.ok(summary);
  assert.deepEqual(summary.attributions.map((row) => [row.modelId, row.thinkingLevel]), [['active-model', 'max']]);
});

test('excludes failed-only model attempts from attribution and retains terminal counts', () => {
  const summary = summarizeTranscriptJsonl(transcript([
    header(), user('u', null, 'prompt'),
    assistant('failed', 'u', 'failed-model', 'error', 50),
  ]), 'C:/repo/failed.jsonl');

  assert.ok(summary);
  assert.deepEqual(summary.attributions, []);
  assert.equal(summary.errorAssistantTurns, 1);
  assert.equal(summary.successfulAssistantTurns, 0);
  assert.equal(summary.terminalStatus, 'error');
});

test('mixed-model attribution uses successful token share and sums to one', () => {
  const summary = summarizeTranscriptJsonl(transcript([
    header(), user('u', null, 'prompt'),
    assistant('a', 'u', 'model-a', 'toolUse', 100, [{ type: 'toolCall', id: 'call-1', name: 'read' }]),
    { type: 'message', id: 'r', parentId: 'a', timestamp: '2026-01-01T00:00:04.000Z', message: { role: 'toolResult', isError: true, content: [{ type: 'text', text: 'private output' }] } },
    assistant('bb', 'r', 'model-b', 'stop', 300),
  ]), 'C:/repo/mixed.jsonl');

  assert.ok(summary);
  assert.equal(summary.mixedModel, true);
  assert.equal(summary.toolCallCount, 1);
  assert.equal(summary.toolErrorCount, 1);
  assert.equal(summary.attributions.reduce((sum, row) => sum + row.share, 0), 1);
  assert.deepEqual(summary.attributions.map((row) => row.share), [0.25, 0.75]);
  assert.doesNotMatch(JSON.stringify(summary), /private output/);
});

test('falls back to successful turn share when token usage is zero', () => {
  const summary = summarizeTranscriptJsonl(transcript([
    header(), user('u', null, 'prompt'),
    assistant('a', 'u', 'model-a', 'toolUse'),
    assistant('b', 'a', 'model-b', 'stop'),
  ]), 'C:/repo/fallback.jsonl');

  assert.deepEqual(summary?.attributions.map((row) => row.share), [0.5, 0.5]);
});

test('normalizes Windows paths case- and slash-insensitively', () => {
  assert.equal(normalizeSessionPath('C:\\Users\\Me\\Session.JSONL'), normalizeSessionPath('c:/users/me/session.JSONL'));
  assert.equal(normalizeSessionPath('\\\\Server\\Share\\Session.JSONL'), normalizeSessionPath('//server/share/session.jsonl'));
});

test('coerces optional portable summaries without retaining unknown private fields', () => {
  const summaries = coerceHistoricalSessionSummaries([{
    sessionId: 'portable', normalizedSessionPath: 'C:\\Private\\session.jsonl',
    startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z',
    firstUserMessageChars: 12,
    attributions: [
      { modelId: 'a', thinkingLevel: 'high', share: 99, successfulAssistantTurns: 1, attributedTokens: 10 },
      { modelId: 'b', thinkingLevel: 'low', share: 1, successfulAssistantTurns: 1, attributedTokens: 30 },
    ],
    successfulAssistantTurns: 2, errorAssistantTurns: 0, abortedAssistantTurns: 0,
    inputTokens: 40, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reportedCostUsd: 1, toolCallCount: 0, toolErrorCount: 0,
    terminalStatus: 'success', mixedModel: true,
    prompt: 'PRIVATE PROMPT', reason: 'PRIVATE REASON', toolOutput: 'PRIVATE TOOL OUTPUT',
  }]);

  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0]?.attributions.map((row) => row.share), [0.25, 0.75]);
  assert.deepEqual(summaries[0]?.sourceProvenance, ['portable-export']);
  assert.doesNotMatch(JSON.stringify(summaries), /PRIVATE/);
});

test('canonical paths suppress transcript-only evidence', async () => {
  const fixture = deepClone(await loadFixture());
  const canonicalPath = fixture.completedRuns[0]!.sessionPath;
  fixture.historicalSessions = [{
    sessionId: 'history', normalizedSessionPath: normalizeSessionPath(canonicalPath.toUpperCase().replaceAll('/', '\\')),
    startedAt: null, endedAt: null, firstUserMessageChars: 7,
    attributions: [{ modelId: 'claude-opus-4.8', thinkingLevel: 'high', share: 1, successfulAssistantTurns: 1, attributedTokens: 10 }],
    successfulAssistantTurns: 1, errorAssistantTurns: 0, abortedAssistantTurns: 0,
    inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reportedCostUsd: null, toolCallCount: 0, toolErrorCount: 0,
    terminalStatus: 'success', mixedModel: false, sourceProvenance: ['legacy'],
  }];

  const historical = prepareSourceAnalytics(fixture).historicalSessions[0]!;
  assert.equal(historical.matchedCanonical, true);
  assert.equal(historical.transcriptOnly, false);
  assert.equal('normalizedSessionPath' in historical, false);
});

test('configured discovery reads only the canonical root and records configured provenance', async () => {
  await withTempDir(async (dir) => {
    const configured = path.join(dir, 'configured');
    const legacy = path.join(dir, 'sessions');
    await fs.mkdir(configured, { recursive: true });
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(configured, 'canonical.jsonl'), transcript([header('canonical')]));
    await fs.writeFile(path.join(legacy, 'stranded.jsonl'), transcript([header('stranded')]));

    const summaries = await discoverHistoricalSessions({ configuredSessionsDir: configured });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.sessionId, 'canonical');
    assert.deepEqual(summaries[0]?.sourceProvenance, ['configured']);
  });
});

test('configured discovery returns no summaries when no canonical root is given', async () => {
  assert.deepEqual(await discoverHistoricalSessions({}), []);
});
