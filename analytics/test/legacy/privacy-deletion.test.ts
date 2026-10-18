import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { forgetLegacyAnalyticsForStorageDirs } from '../../legacy/privacy-deletion';

const sessionPath = '/sessions/private.jsonl';
const sessionId = 'private-id';
const byPath = { sessionPath, sessionId: 'old-id' };
const byId = { sessionPath: '/sessions/renamed.jsonl', sessionId };
const unrelated = { sessionPath: '/sessions/other.jsonl', sessionId: 'other-id' };
const jsonl = (values: unknown[]) => values.map((value) => JSON.stringify(value)).join('\n') + '\n';

async function fixture(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-legacy-privacy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function readJson(root: string, name: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
}

test('explicit deletion scrubs every preserved format by path OR id and preserves unrelated data', async (t) => {
  const root = await fixture(t);
  const roots = [path.join(root, 'current'), path.join(root, 'legacy')];
  for (const dir of roots) {
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'run-snapshots.jsonl'), jsonl([byPath, byId, unrelated].map((run, index) => ({
      schemaVersion: 1, kind: 'run_snapshot', recordedAt: '2026-01-01T00:00:00Z', run: { runId: `r${index}`, ...run },
    }))));
    for (const slot of ['a', 'b']) {
      await fs.writeFile(path.join(dir, `open-runs.${slot}.json`), JSON.stringify({
        schemaVersion: 1, seq: 42,
        sessions: {
          [sessionPath]: { currentRun: null, lastRun: null },
          '/old-path': { currentRun: byPath, lastRun: null },
          '/renamed': { currentRun: null, lastRun: byId },
          '/other': { currentRun: unrelated, lastRun: null, busyStartedAt: 'keep' },
        },
      }));
    }
    await fs.writeFile(path.join(dir, 'open-runs.gen'), 'b');
    await fs.writeFile(path.join(dir, 'billable-invocations.jsonl'), jsonl([byPath, byId, unrelated].map((value, i) => ({
      schemaVersion: 1, invocationId: `i${i}`, sourceId: `s${i}`, ...value,
    }))));
    await fs.writeFile(path.join(dir, 'activity-intervals.json'), JSON.stringify([byPath, byId, unrelated]));
    await fs.writeFile(path.join(dir, 'activity-intervals.journal.jsonl'), jsonl([
      { __activityTimeline: 'reset' }, byPath, byId, unrelated,
    ]));
    await fs.writeFile(path.join(dir, 'accounting-private-sessions.json'), JSON.stringify([
      { sessionPath }, { sessionId }, { sessionPath: unrelated.sessionPath },
    ]));
    const exported = {
      schemaVersion: 1, workspaceKey: 'workspace', exportedAt: 'keep-time',
      completedRuns: [byPath, byId, unrelated], openRuns: [byId, unrelated],
      billableInvocations: [byPath, byId, unrelated], activityIntervals: [byPath, byId, unrelated],
      billableInvocationSummary: { invocationCount: 3 },
      pruningDecisions: [byPath, byId, unrelated],
      pruningEvents: [{ sessionId }, { sessionId: unrelated.sessionId }],
      toolResultPruningEvents: [{ sessionId: sessionPath }, { sessionId: unrelated.sessionId }],
      warmBashSummaries: [{ rootSessionId: sessionId }, { sessionId: unrelated.sessionId }],
      unknownMetadata: { keep: true },
    };
    await fs.writeFile(path.join(dir, 'run-analytics.json'), JSON.stringify(exported));
  }

  await forgetLegacyAnalyticsForStorageDirs([...roots, roots[0]], sessionPath, sessionId);
  for (const dir of roots) {
    const lines = (await fs.readFile(path.join(dir, 'run-snapshots.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.run), [{ runId: 'r2', ...unrelated }]);
    for (const slot of ['a', 'b']) {
      assert.deepEqual(await readJson(dir, `open-runs.${slot}.json`), {
        schemaVersion: 1, seq: 42,
        sessions: { '/other': { currentRun: unrelated, lastRun: null, busyStartedAt: 'keep' } },
      });
    }
    assert.equal(await fs.readFile(path.join(dir, 'open-runs.gen'), 'utf8'), 'b');
    assert.equal(await fs.readFile(path.join(dir, 'billable-invocations.jsonl'), 'utf8'), jsonl([
      { schemaVersion: 1, invocationId: 'i2', sourceId: 's2', ...unrelated },
    ]));
    assert.deepEqual(await readJson(dir, 'activity-intervals.json'), [unrelated]);
    assert.equal(await fs.readFile(path.join(dir, 'activity-intervals.journal.jsonl'), 'utf8'), jsonl([
      { __activityTimeline: 'reset' }, unrelated,
    ]));
    assert.deepEqual(await readJson(dir, 'accounting-private-sessions.json'), [{ sessionPath: unrelated.sessionPath }]);
    const exported = await readJson(dir, 'run-analytics.json');
    for (const field of ['completedRuns', 'openRuns', 'billableInvocations', 'activityIntervals', 'pruningDecisions']) {
      assert.deepEqual(exported[field], [unrelated]);
    }
    for (const field of ['pruningEvents', 'toolResultPruningEvents', 'warmBashSummaries']) {
      assert.deepEqual(exported[field], [{ sessionId: unrelated.sessionId }]);
    }
    assert.equal(exported.billableInvocationSummary, undefined, 'mixed aggregate must not retain deleted usage');
    assert.equal(exported.exportedAt, 'keep-time');
    assert.deepEqual(exported.unknownMetadata, { keep: true });
  }
});

test('missing files and unmodified files cause no writes or persistent store initialization', async (t) => {
  const root = await fixture(t);
  const missing = path.join(root, 'absent');
  await fs.writeFile(path.join(root, 'run-analytics.json'), JSON.stringify({ completedRuns: [unrelated] }));
  const before = await fs.stat(path.join(root, 'run-analytics.json'));
  const write = t.mock.method(fs, 'writeFile', async () => { throw new Error('unexpected write'); });
  await forgetLegacyAnalyticsForStorageDirs([missing, root], sessionPath, sessionId);
  assert.equal(write.mock.callCount(), 0);
  assert.deepEqual(await fs.readdir(root), ['run-analytics.json']);
  assert.equal((await fs.stat(path.join(root, 'run-analytics.json'))).mtimeMs, before.mtimeMs);
});

test('JSONL preserves malformed lines, whitespace, CRLF, and unterminated tails byte-for-byte', async (t) => {
  const root = await fixture(t);
  const malformed = '  {torn private-id\r\n\r\n';
  const tail = ' {"unterminated":';
  const kept = `  ${JSON.stringify(unrelated)} \r\n`;
  const historyKept = `  ${JSON.stringify({ run: unrelated })} \r\n`;
  const names = ['run-snapshots.jsonl', 'billable-invocations.jsonl', 'activity-intervals.journal.jsonl'];
  for (const name of names) {
    const wrap = (record: unknown) => name === 'run-snapshots.jsonl' ? { run: record } : record;
    const validKept = name === 'run-snapshots.jsonl' ? historyKept : kept;
    await fs.writeFile(path.join(root, name), malformed + JSON.stringify(wrap(byPath)) + '\r\n'
      + validKept + JSON.stringify(wrap(byId)) + '\n' + tail);
  }
  await forgetLegacyAnalyticsForStorageDirs([root], sessionPath, sessionId);
  for (const name of names) {
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), malformed
      + (name === 'run-snapshots.jsonl' ? historyKept : kept) + tail);
  }
});

test('read and parse failures reject and remain retryable after partial deletion', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'run-snapshots.jsonl'), jsonl([{ run: byId }, { run: unrelated }]));
  const ledger = path.join(root, 'billable-invocations.jsonl');
  await fs.mkdir(ledger);
  await assert.rejects(forgetLegacyAnalyticsForStorageDirs([root], sessionPath, sessionId));
  await fs.rmdir(ledger);
  await fs.writeFile(ledger, jsonl([byPath, unrelated]));
  const timeline = path.join(root, 'activity-intervals.json');
  await fs.writeFile(timeline, '{broken');
  await assert.rejects(forgetLegacyAnalyticsForStorageDirs([root], sessionPath, sessionId), SyntaxError);
  assert.equal(await fs.readFile(timeline, 'utf8'), '{broken');
  await fs.writeFile(timeline, JSON.stringify([byId, unrelated]));
  await forgetLegacyAnalyticsForStorageDirs([root], sessionPath, sessionId);
  assert.equal(await fs.readFile(ledger, 'utf8'), jsonl([unrelated]));
  assert.deepEqual(await readJson(root, 'activity-intervals.json'), [unrelated]);
});

test('failed atomic replacement preserves original and retry succeeds without stale state', async (t) => {
  const root = await fixture(t);
  const ledger = path.join(root, 'billable-invocations.jsonl');
  const original = jsonl([byId, unrelated]);
  await fs.writeFile(ledger, original);
  const rename = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('injected write failure'), { code: 'EIO' }); });
  await assert.rejects(forgetLegacyAnalyticsForStorageDirs([root], sessionPath, sessionId), /injected write failure/);
  assert.equal(await fs.readFile(ledger, 'utf8'), original);
  assert.deepEqual(await fs.readdir(root), ['billable-invocations.jsonl']);
  rename.mock.restore();
  await forgetLegacyAnalyticsForStorageDirs([root], sessionPath, sessionId);
  assert.equal(await fs.readFile(ledger, 'utf8'), jsonl([unrelated]));
});

test('concurrent deletions do not resurrect a sibling subject', async (t) => {
  const root = await fixture(t);
  const ledger = path.join(root, 'billable-invocations.jsonl');
  await fs.writeFile(ledger, jsonl([byPath, byId, unrelated]));
  await Promise.all([
    forgetLegacyAnalyticsForStorageDirs([root], sessionPath),
    forgetLegacyAnalyticsForStorageDirs([root], unrelated.sessionPath, sessionId),
  ]);
  assert.equal(await fs.readFile(ledger, 'utf8'), '');
});
