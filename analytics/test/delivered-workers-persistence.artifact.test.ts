import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSanitizedRealChildTestEnv } from '../../harness/agent-processes/test/fixtures/sanitized-real-child-env.js';
// @ts-expect-error Existing public verification helper is JavaScript.
import { watchChildProcess, withProcessTreeIsolation } from '../../scripts/lib/process-watchdog.mjs';

function selection(env: NodeJS.ProcessEnv) {
  const packageRoot = env.PIE_DELIVERED_HOST_ROOT;
  const stageRoot = env.PIE_ANALYTICS_MANAGED_STAGE;
  const receiptPath = env.PIE_ANALYTICS_MANAGED_RECEIPT;
  assert.ok(packageRoot && path.isAbsolute(packageRoot), 'PIE_DELIVERED_HOST_ROOT must select the intact absolute candidate');
  assert.equal(Boolean(stageRoot), Boolean(receiptPath), 'managed stage and receipt must be paired');
  if (stageRoot && receiptPath) {
    assert.ok(path.isAbsolute(stageRoot) && path.isAbsolute(receiptPath));
  }
  return { packageRoot, managedIntegration: stageRoot ? { stageRoot, receiptPath } : undefined };
}

test('delivered analytics selection rejects absent, relative or partial explicit roots without executing workers', () => {
  assert.throws(() => selection({}));
  assert.throws(() => selection({ PIE_DELIVERED_HOST_ROOT: 'relative' }));
  assert.throws(() => selection({ PIE_DELIVERED_HOST_ROOT: os.tmpdir(), PIE_ANALYTICS_MANAGED_STAGE: os.tmpdir() }));
  assert.equal(selection({ PIE_DELIVERED_HOST_ROOT: os.tmpdir() }).packageRoot, os.tmpdir());
});

// Explicit opt-in only. No native SDK or SQLite module is imported by the skipped route.
// Whole-candidate hashing can take minutes; each coordinator remains bounded to 60s.
test('delivered recorder/query helpers preserve canonical facts across private coordinator restart', { timeout: 600_000 }, async t => {
  if (process.env.PIE_RUN_DELIVERED_ANALYTICS_TESTS !== '1') return t.skip('Requires explicit authorization and a newly qualified candidate.');
  const selected = selection(process.env);
  // @ts-expect-error Existing candidate verifier owns identity, SDK target compatibility and managed admission.
  const { verifyCandidateIdentity } = await import('../../scripts/verification/lib/vsix-candidate.mjs');
  const identity = await verifyCandidateIdentity(selected.packageRoot, { managedIntegration: selected.managedIntegration });
  t.signal.throwIfAborted();
  const workerPaths = ['analytics-recorder-worker.js', 'analytics-query-worker.js'].map(name => path.join(selected.packageRoot, 'out', name));
  const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = workerPaths.map(digest);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-delivered-analytics-'));
  let confirmed = true;
  let passed = false;
  const sentinel = path.join(root, 'agent', 'data', 'outcomes', 'legacy-sentinel.jsonl');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, 'preserved legacy sentinel\n');
  const legacyBytes = fs.readFileSync(sentinel);
  const worker = fileURLToPath(new URL('./fixtures/delivered-workers-persistence-coordinator.ts', import.meta.url));
  const repo = path.resolve(path.dirname(worker), '../../..');
  try {
    for (const phase of ['capture', 'reopen']) {
      t.signal.throwIfAborted();
      const reportPath = path.join(root, `${phase}-report.json`);
      const env = buildSanitizedRealChildTestEnv(process.env, root, 'inventory');
      env.PIE_DATA_DIR = path.join(root, 'pie-data');
      // The canonical source policy modules require no SDK import or tsconfig alias.
      const child = spawn(process.execPath, ['--require', path.join(repo, 'node_modules/tsx/dist/cjs/index.cjs'), worker, selected.packageRoot, root, phase, identity.buildId, reportPath], withProcessTreeIsolation({ cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
      confirmed = false;
      const watchdog = watchChildProcess(child, { timeoutMs: 60_000, signal: t.signal, label: `delivered analytics ${phase}` });
      let output = '';
      child.stdout.on('data', (data: Buffer) => { output += data; });
      child.stderr.on('data', (data: Buffer) => { output += data; });
      const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      }).finally(async () => {
        const tree = await watchdog.settle();
        confirmed = tree.gone && tree.survivors.length === 0 && !watchdog.timedOut;
        fs.writeFileSync(path.join(root, `${phase}-outer-teardown.json`), JSON.stringify({ confirmed, tree, timedOut: watchdog.timedOut }, null, 2));
      });
      assert.ok(confirmed, `Uncertain owned teardown; retained ${root}\n${output}`);
      assert.deepEqual(result, { code: 0, signal: null }, output);
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      assert.equal(report.success, true, output);
      assert.deepEqual(report.attempts, []);
      assert.ok(report.children.every((entry: { terminal?: { code: number; signal: null } }) => entry.terminal?.code === 0 && entry.terminal.signal === null));
      t.diagnostic(`${phase}: ${report.children.length} actual delivered helper identities reached terminal exit; zero durable leases asserted by coordinator`);
    }
    assert.deepEqual(fs.readFileSync(sentinel), legacyBytes);
    assert.deepEqual(fs.readdirSync(path.dirname(sentinel)), ['legacy-sentinel.jsonl']);
    assert.ok(!fs.existsSync(path.join(root, 'pie-data', 'sessions')), 'no transcript cutoff or session write');
    assert.deepEqual(workerPaths.map(digest), before);
    // Reverify the whole selected runtime/candidate and managed bindings, not only entry hashes.
    assert.deepEqual(await verifyCandidateIdentity(selected.packageRoot, { managedIntegration: selected.managedIntegration }), identity);
    t.signal.throwIfAborted();
    passed = true;
  } finally {
    if (passed && confirmed) fs.rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`Private analytics evidence retained: ${root}`);
  }
});
