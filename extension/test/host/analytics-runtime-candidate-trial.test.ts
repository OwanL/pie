import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ACTIVATION_MANIFEST_FILENAME, ACTIVATION_TOMBSTONE_FILENAME } from '../../../shared/analytics/activation.js';
import {
  CANDIDATE_TRIAL_AUTHORITY_KIND,
  CANDIDATE_TRIAL_DESCRIPTOR_KIND,
  candidateTrialPlanSha256,
  validateCandidateTrialPlan,
  type CandidateTrialPlan,
} from '../../../shared/analytics/candidate-trial.js';
import {
  assertTrialRootIsolated,
  authorizeCandidateTrialRoot,
  containsPath,
  type CandidateTrialAuthority,
  type CandidateTrialCleanupReceipt,
} from '../../src/analytics/candidate-trial-authority.js';
import { ActivationStore } from '../../src/analytics/activation-store.js';
import {
  CandidateTrialRuntime,
  startCandidateTrialRuntime,
} from '../../src/host/analytics-runtime.js';

const SOURCE_HEAD = 'a'.repeat(40);
const SOURCE_FINGERPRINT = 'b'.repeat(64);
const QUALIFICATION = 'c'.repeat(64);
const GENERATION_ID = '2f6e2b1c-9d4a-4e7b-8c3f-1a2b3c4d5e6f';

function trialPlan(): CandidateTrialPlan {
  return validateCandidateTrialPlan({
    schemaVersion: 1,
    kind: CANDIDATE_TRIAL_AUTHORITY_KIND,
    identity: {
      trialId: 'trial-1',
      generationId: GENERATION_ID,
      buildId: 'build-1',
      sourceHead: SOURCE_HEAD,
      sourceFingerprint: SOURCE_FINGERPRINT,
      qualificationSha256: QUALIFICATION,
    },
    workspaceId: 'workspace-trial',
  });
}

interface RealWorkerFixture {
  root: string;
  recorderWorkerScript: string;
  queryWorkerScript: string;
}

/** Real production worker entry points, loaded independently of extension/out. */
function realWorkerFixture(): RealWorkerFixture {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-candidate-trial-workers-'));
  const loaderUrl = new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
  const workerPath = (kind: 'recorder' | 'query'): string => {
    const target = path.join(root, `${kind}-worker.mjs`);
    const sourceUrl = new URL(`../../src/analytics/${kind}-worker-entry.ts`, import.meta.url).href;
    writeFileSync(target, `await import(${JSON.stringify(loaderUrl)});\nawait import(${JSON.stringify(sourceUrl)});\n`, 'utf8');
    return target;
  };
  return {
    root,
    recorderWorkerScript: workerPath('recorder'),
    queryWorkerScript: workerPath('query'),
  };
}

interface TrialFixture {
  authority: CandidateTrialAuthority;
  workspaceRoot: string;
  liveDir: string;
  liveFile: string;
  liveBytes: string;
  workers: RealWorkerFixture;
}

function trialFixture(overrides: Partial<Parameters<typeof authorizeCandidateTrialRoot>[1]> = {}): TrialFixture {
  const workspace = mkdtempSync(path.join(tmpdir(), 'pie-candidate-trial-live-'));
  const liveDir = path.join(workspace, 'live');
  mkdirSync(liveDir, { recursive: true });
  mkdirSync(path.join(workspace, 'data-owner'), { recursive: true });
  const liveFile = path.join(liveDir, 'live-fixture.txt');
  const liveBytes = 'analytics live fixture bytes\n';
  writeFileSync(liveFile, liveBytes, 'utf8');
  const workers = realWorkerFixture();
  try {
    const authority = authorizeCandidateTrialRoot(trialPlan(), {
      buildId: 'build-1',
      sourceHead: SOURCE_HEAD,
      sourceFingerprint: SOURCE_FINGERPRINT,
      liveRoots: [liveDir],
      canonicalDataRoot: path.join(workspace, 'data-owner'),
      ...overrides,
    });
    return { authority, workspaceRoot: workspace, liveDir, liveFile, liveBytes, workers };
  } catch (error) {
    // A refused authorization must not leak the helper or live fixtures either.
    rmSync(workers.root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

function cleanupTrialFixture(fixture: TrialFixture): void {
  rmSync(fixture.workers.root, { recursive: true, force: true });
  rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  assert.equal(existsSync(fixture.workers.root), false, 'the exact worker fixture root was removed');
  assert.equal(existsSync(fixture.workspaceRoot), false, 'the exact live fixture workspace was removed');
}

function assertNoManifestOrTombstone(rootDir: string): void {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === ACTIVATION_MANIFEST_FILENAME || entry.name === ACTIVATION_TOMBSTONE_FILENAME) {
        found.push(full);
      }
    }
  };
  walk(rootDir);
  assert.deepEqual(found, [], 'a trial must never create an activation manifest or tombstone');
}

async function startTrial(
  authority: CandidateTrialAuthority,
  workers: RealWorkerFixture,
): Promise<CandidateTrialRuntime> {
  return startCandidateTrialRuntime(authority, {
    recorderWorkerScript: workers.recorderWorkerScript,
    queryWorkerScript: workers.queryWorkerScript,
    hostInstanceId: 'process-trial',
    timeZone: 'UTC',
  });
}

test('candidate trial runs real recorder/query/capture in a factory-owned root and leaves no authority record', { timeout: 60_000 }, async () => {
  const fixture = trialFixture();
  const { authority, liveDir, liveFile, liveBytes, workers } = fixture;
  let runtime: CandidateTrialRuntime | undefined;
  try {
    runtime = await startTrial(authority, workers);
    const readiness = runtime.getReadiness();
    assert.ok(readiness);
    assert.equal(readiness.authority, 'candidate-trial');
    assert.equal(readiness.manifestRevision, null, 'no manifest exists in trial mode');
    assert.equal(readiness.manifestSha256, null);
    assert.equal(readiness.recorderReady, true);
    assert.equal(readiness.queryReady, true);
    assert.equal(runtime.backendDescriptor(), undefined, 'trial mode must never produce a backend descriptor');
    const descriptor = runtime.candidateTrialDescriptor();
    assert.equal(descriptor.kind, CANDIDATE_TRIAL_DESCRIPTOR_KIND);
    assert.equal(descriptor.trialPlanSha256, authority.grant.planSha256);
    assert.equal(descriptor.trialPlanSha256, candidateTrialPlanSha256(trialPlan()));
    assert.equal(descriptor.trialAuthorityRevision, 1);
    assert.ok(!('manifestRevision' in descriptor));
    assert.ok(!('manifestSha256' in descriptor));
    assert.ok(!('trialSha256' in descriptor));

    // Real capture through the production capture adapter into the trial recorder.
    const status = runtime.capture.captureExecution(
      { sessionId: 'root-a', sessionPath: `${authority.grant.resolvedPaths.rootDir}/sessions/root-a` },
      'execution-a',
      'end',
      'source-a',
      1_780_000_000_000,
      { source: 'host', outcome: 'success' },
    );
    assert.equal(status, 'submitted');
    const drained = await runtime.fenceWriters();
    assert.equal(drained, 0, 'accepted capture must drain before stop');
    const rows = await runtime.reads!.query<{ rows: Array<{ n?: unknown }> }>({
      type: 'query',
      sql: 'SELECT count(*) AS n FROM analytics_execution_observations',
    });
    assert.equal(Number(rows.rows[0]?.n), 1, 'the captured execution must be readable through the real query helper');

    // The trial state directory holds no activation authority record at all.
    const store = new ActivationStore({ stateDir: authority.grant.resolvedPaths.stateDir });
    const read = store.read();
    assert.equal(read.authority, 'legacy', 'an absent manifest must select legacy inside the trial root too');
    assert.equal(read.manifest, null);
    assert.equal(read.tombstonePresent, false);
    assertNoManifestOrTombstone(authority.grant.resolvedPaths.rootDir);

    await runtime.stop();
    const receipt: CandidateTrialCleanupReceipt | undefined = runtime.cleanupReceipt;
    assert.ok(receipt);
    assert.equal(receipt.completed, true);
    assert.equal(receipt.rootRemoved, true);
    assert.equal(existsSync(authority.grant.resolvedPaths.rootDir), false, 'cleanup removes the owned root');
    assert.equal(existsSync(liveDir), true, 'live fixture directory survives the trial');
    assert.equal(readFileSync(liveFile, 'utf8'), liveBytes, 'live fixture bytes must be unchanged');
  } finally {
    try {
      if (runtime && !runtime.isStopped) await runtime.stop().catch(() => { /* already reported */ });
    } finally {
      cleanupTrialFixture(fixture);
    }
  }
});

test('a grant is single use and a disposed root cannot be restarted', { timeout: 60_000 }, async () => {
  const fixture = trialFixture();
  const { authority, workers } = fixture;
  let runtime: CandidateTrialRuntime | undefined;
  try {
    runtime = await startTrial(authority, workers);
    await assert.rejects(
      () => startTrial(authority, workers),
      /already consumed/u,
      'a consumed grant must not authorize a second runtime',
    );
    await runtime.stop();
    await assert.rejects(
      () => startTrial(authority, workers),
      /already consumed/u,
      'stop does not restore grant capacity',
    );
    assert.throws(() => authority.consume(), /already consumed/u);
    assert.equal(existsSync(fixture.liveDir), true, 'live fixture directory survives the trial');
    assert.equal(readFileSync(fixture.liveFile, 'utf8'), fixture.liveBytes, 'live fixture bytes are unchanged');
  } finally {
    try {
      if (runtime && !runtime.isStopped) await runtime.stop().catch(() => { /* already reported */ });
    } finally {
      cleanupTrialFixture(fixture);
    }
  }
});

test('an expired grant refuses to start and disposes its owned root', async () => {
  const fixture = trialFixture({ maxLifetimeMs: 1 });
  try {
    const { authority } = fixture;
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    assert.throws(() => authority.consume(), /expired/u);
    const receipt = await authority.dispose();
    assert.equal(receipt.completed, true);
    assert.equal(receipt.rootRemoved, true);
    assert.equal(existsSync(authority.grant.resolvedPaths.rootDir), false);
    assert.equal(existsSync(fixture.liveDir), true, 'live fixture directory survives expiry disposal');
    assert.equal(readFileSync(fixture.liveFile, 'utf8'), fixture.liveBytes, 'live fixture bytes are unchanged');
  } finally {
    cleanupTrialFixture(fixture);
  }
});

test('a stale identity (build/source mismatch) is refused before any root is created', () => {
  const before = candidateTrialRootCount();
  assert.throws(
    () => trialFixture({ buildId: 'a-different-build' }),
    /does not match the actual build\/source identity/u,
  );
  assert.throws(
    () => trialFixture({ sourceFingerprint: 'f'.repeat(64) }),
    /does not match the actual build\/source identity/u,
  );
  assert.equal(candidateTrialRootCount(), before, 'refused authorization must not leak an owned root');
});

test('the factory root may not overlap a live root or the canonical data owner', () => {
  const before = candidateTrialRootCount();
  // tmpdir() contains the freshly created trial root, so it must be refused.
  assert.throws(
    () => trialFixture({ liveRoots: [tmpdir()] }),
    /overlaps a protected root \(live-root\)/u,
  );
  assert.throws(
    () => trialFixture({ canonicalDataRoot: tmpdir() }),
    /overlaps a protected root \(canonical-data-owner\)/u,
  );
  assert.equal(candidateTrialRootCount(), before, 'refused authorization must not leak an owned root');
});

test('containment math rejects symlink aliases and escaped children', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'pie-candidate-trial-containment-'));
  try {
    const realDir = path.join(workspace, 'real');
    const alias = path.join(workspace, 'alias');
    const child = path.join(workspace, 'child');
    mkdirSync(realDir, { recursive: true });
    mkdirSync(child, { recursive: true });
    const realNorm = path.normalize(realDir);
    assert.equal(containsPath(realNorm, path.join(realNorm, 'state')), true);
    assert.equal(containsPath(realNorm, realNorm), true);
    assert.equal(containsPath(realNorm, path.join(workspace, 'elsewhere')), false);
    assert.equal(containsPath(path.join(realNorm, 'state'), realNorm), false);
    // A symlink alias is not a real directory child. Windows refuses symlink
    // creation without privileges; the alias property is only asserted when the
    // OS actually created one.
    let aliased = false;
    try {
      symlinkSync(realDir, alias, 'dir');
      aliased = true;
    } catch {
      // Unprivileged Windows: alias coverage comes from the containment booleans.
    }
    if (aliased) {
      assert.throws(
        () => assertTrialRootIsolated(realNorm, [], [alias]),
        /real directory/u,
      );
    }
    // A child outside the root escapes.
    assert.throws(
      () => assertTrialRootIsolated(realNorm, [], [child]),
      /escaped its owned root/u,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a substituted analytics junction is rejected before any helper opens the protected root', async () => {
  const fixture = trialFixture();
  const { authority, workers } = fixture;
  try {
    rmSync(authority.grant.resolvedPaths.analyticsDir, { recursive: true, force: true });
    symlinkSync(fixture.liveDir, authority.grant.resolvedPaths.analyticsDir, 'junction');
    await assert.rejects(
      () => startTrial(authority, workers),
      /resolved child must be a real directory|helper directory realpath changed/u,
    );
    assert.equal(existsSync(path.join(fixture.liveDir, 'analytics.sqlite')), false);
    const receipt = await authority.dispose();
    assert.equal(receipt.completed, false, 'integrity substitution remains visible in cleanup');
    assert.equal(receipt.rootRemoved, true);
  } finally {
    cleanupTrialFixture(fixture);
  }
});

test('an invalid hostInstanceId is refused before consuming the grant, which stays reusable', { timeout: 60_000 }, async () => {
  const fixture = trialFixture();
  const { authority, liveDir, liveFile, liveBytes, workers } = fixture;
  const rootDir = authority.grant.resolvedPaths.rootDir;
  let runtime: CandidateTrialRuntime | undefined;
  try {
    const invalidOptions = (hostInstanceId: string) => ({
      recorderWorkerScript: workers.recorderWorkerScript,
      queryWorkerScript: workers.queryWorkerScript,
      hostInstanceId,
      timeZone: 'UTC',
    });
    await assert.rejects(
      () => startCandidateTrialRuntime(authority, invalidOptions('')),
      /descriptor\.hostInstanceId is invalid/u,
    );
    assert.equal(authority.isConsumed, false, 'an invalid input must not burn the single-use grant');
    assert.equal(lstatSync(rootDir).isDirectory(), true, 'the caller still owns the root; nothing was auto-cleaned');
    await assert.rejects(
      () => startCandidateTrialRuntime(authority, invalidOptions('   ')),
      /descriptor\.hostInstanceId is invalid/u,
    );
    assert.equal(authority.isConsumed, false);
    assert.equal(lstatSync(rootDir).isDirectory(), true);
    // The unconsumed grant is still reusable with valid options.
    runtime = await startTrial(authority, workers);
    assert.equal(runtime.getReadiness()?.authority, 'candidate-trial');
    await runtime.stop();
    assert.equal(runtime.cleanupReceipt?.completed, true);
    assert.throws(() => lstatSync(rootDir), /ENOENT/u, 'the valid run owns and cleans the same root');
    assert.equal(existsSync(liveDir), true, 'the live fixture directory survives');
    assert.equal(readFileSync(liveFile, 'utf8'), liveBytes, 'live fixture bytes are unchanged');
  } finally {
    try {
      if (runtime && !runtime.isStopped) await runtime.stop().catch(() => { /* already reported */ });
    } finally {
      cleanupTrialFixture(fixture);
    }
  }
});

test('an invalid candidate-trial IANA timezone is refused before consuming the grant', { timeout: 60_000 }, async () => {
  const fixture = trialFixture();
  const { authority, workers } = fixture;
  const rootDir = authority.grant.resolvedPaths.rootDir;
  try {
    await assert.rejects(
      () => startCandidateTrialRuntime(authority, {
        recorderWorkerScript: workers.recorderWorkerScript,
        queryWorkerScript: workers.queryWorkerScript,
        hostInstanceId: 'process-trial',
        timeZone: 'Not/AZone',
      }),
      /Analytics timezone is not a valid IANA name: Not\/AZone/u,
    );
    assert.equal(authority.isConsumed, false, 'invalid timezone input must not burn the single-use grant');
    assert.equal(lstatSync(rootDir).isDirectory(), true, 'the caller still owns the root; nothing was auto-cleaned');

    const runtime = await startTrial(authority, workers);
    assert.equal(runtime.analyticsTimeZone, 'UTC');
    await runtime.stop();
    assert.equal(runtime.cleanupReceipt?.completed, true);
    assert.throws(() => lstatSync(rootDir), /ENOENT/u, 'the valid run owns and cleans the same root');
  } finally {
    cleanupTrialFixture(fixture);
  }
});

test('after an invalid pre-consume input the owned root is removed only by explicit dispose', async () => {
  const fixture = trialFixture();
  const { authority, workers } = fixture;
  const rootDir = authority.grant.resolvedPaths.rootDir;
  try {
    await assert.rejects(
      () => startCandidateTrialRuntime(authority, {
        recorderWorkerScript: '',
        queryWorkerScript: workers.queryWorkerScript,
        hostInstanceId: 'process-trial',
        timeZone: 'UTC',
      }),
      /worker scripts are required/u,
    );
    assert.equal(authority.isConsumed, false, 'invalid options must not consume the grant');
    assert.equal(lstatSync(rootDir).isDirectory(), true, 'nothing is cleaned up automatically');
    const receipt = await authority.dispose();
    assert.equal(receipt.completed, true);
    assert.equal(receipt.rootRemoved, true);
    assert.throws(() => lstatSync(rootDir), /ENOENT/u, 'explicit caller dispose removes the owned root');
    assert.equal(existsSync(fixture.liveDir), true, 'live fixtures survive an explicit dispose');
    assert.equal(readFileSync(fixture.liveFile, 'utf8'), fixture.liveBytes, 'live fixture bytes are unchanged');
  } finally {
    cleanupTrialFixture(fixture);
  }
});

test('a failed reuse cannot dispose the first active trial root or stop its helpers', { timeout: 90_000 }, async () => {
  const fixture = trialFixture();
  const { authority, workers } = fixture;
  const rootDir = authority.grant.resolvedPaths.rootDir;
  let runtime: CandidateTrialRuntime | undefined;
  try {
    runtime = await startTrial(authority, workers);
    await assert.rejects(() => startTrial(authority, workers), /already consumed/u);
    assert.equal(lstatSync(rootDir).isDirectory(), true, 'the failed reuse must not delete the first active root');
    assert.equal(runtime.isStopped, false, 'the first runtime must not be stopped by the failed reuse');
    const status = runtime.capture.captureExecution(
      { sessionId: 'reuse-a', sessionPath: `${rootDir}/sessions/reuse-a` },
      'execution-reuse',
      'end',
      'source-reuse',
      1_780_000_000_000,
      { source: 'host', outcome: 'success' },
    );
    assert.equal(status, 'submitted', 'the first trial recorder still accepts capture');
    assert.equal(await runtime.fenceWriters(), 0);
    const rows = await runtime.reads!.query<{ rows: Array<{ n?: unknown }> }>({
      type: 'query',
      sql: 'SELECT count(*) AS n FROM analytics_execution_observations',
    });
    assert.equal(Number(rows.rows[0]?.n), 1, 'the first trial helpers still work end to end');
    await runtime.stop();
    assert.equal(runtime.cleanupReceipt?.completed, true);
    assert.equal(runtime.cleanupReceipt?.rootRemoved, true);
    assert.throws(() => lstatSync(rootDir), /ENOENT/u, 'the legitimate owner cleans up normally');
  } finally {
    try {
      if (runtime && !runtime.isStopped) await runtime.stop().catch(() => { /* already reported */ });
    } finally {
      cleanupTrialFixture(fixture);
    }
  }
});

test('runtime.stop reports cleanup failure and preserves the failed receipt', { timeout: 90_000 }, async () => {
  const fixture = trialFixture();
  const { authority, workers } = fixture;
  let runtime: CandidateTrialRuntime | undefined;
  const originalDispose = authority.dispose.bind(authority);
  try {
    runtime = await startTrial(authority, workers);
    // The authority's real dangling-root failure path is covered below. This
    // narrow boundary double makes runtime.stop's receipt propagation
    // deterministic without adding a production-only failure hook.
    authority.dispose = async (stopHelpers) => {
      await stopHelpers?.();
      return {
        trialId: authority.grant.identity.trialId,
        completed: false,
        rootRemoved: false,
        stoppedAt: new Date().toISOString(),
        failureReasons: ['simulated owned-root cleanup failure'],
      };
    };

    await assert.rejects(
      () => runtime!.stop(),
      /Candidate-trial cleanup failed: simulated owned-root cleanup failure/u,
    );
    assert.equal(runtime.isStopped, true, 'cleanup failure is terminal and must not restart helpers');
    const receipt = runtime.cleanupReceipt;
    assert.ok(receipt, 'runtime.stop must preserve the failed cleanup receipt');
    assert.equal(receipt.completed, false);
    assert.equal(receipt.rootRemoved, false);
    assert.deepEqual(receipt.failureReasons, ['simulated owned-root cleanup failure']);
  } finally {
    authority.dispose = originalDispose;
    // The test double deliberately leaves the owned root in place; restore the
    // real authority and remove only that factory-owned root.
    await originalDispose();
    if (runtime && !runtime.isStopped) await runtime.stop().catch(() => { /* already reported */ });
    cleanupTrialFixture(fixture);
  }
});

test('a helper startup failure disposes the owned root and preserves the startup error and cleanup receipt', { timeout: 90_000 }, async () => {
  // Counted before the fixture so its own authorize/remove cycle nets to zero.
  const rootsBefore = candidateTrialRootCount();
  const fixture = trialFixture();
  const { authority, workers } = fixture;
  const rootDir = authority.grant.resolvedPaths.rootDir;
  const seen: Array<{ error: unknown; stage: string }> = [];
  try {
    // Real helper-startup failure through existing options: the query worker
    // exits during startAnalyticsHelpers' readiness probe, before its helper
    // bundle is returned to the candidate runtime.
    //
    // The later outer catch path after helpers are ready was reviewed but is
    // not dynamically covered: no existing legitimate callback can throw
    // there, and this task does not add a production test hook solely for it.
    const brokenQueryScript = path.join(workers.root, 'broken-query-worker.mjs');
    writeFileSync(brokenQueryScript, 'process.exit(1);\n', 'utf8');
    await assert.rejects(
      () => startCandidateTrialRuntime(authority, {
        recorderWorkerScript: workers.recorderWorkerScript,
        queryWorkerScript: brokenQueryScript,
        hostInstanceId: 'process-trial',
        timeZone: 'UTC',
        onError: (error, stage) => seen.push({ error, stage }),
      }),
      /Candidate-trial startup failed: .*owned-root cleanup completed\./u,
    );
    assert.equal(authority.isConsumed, true, 'a post-consume helper startup failure consumes the single-use grant');
    assert.deepEqual(seen.map((entry) => entry.stage), ['candidate-trial-startup']);
    const failure = seen[0].error as Error & { candidateTrialCleanupReceipt?: CandidateTrialCleanupReceipt };
    assert.match(failure.message, /Candidate-trial startup failed:/u);
    assert.match(failure.message, /Analytics query worker exited/u, 'the primary reason is preserved');
    const receipt = failure.candidateTrialCleanupReceipt;
    assert.ok(receipt, 'the cleanup receipt must not be discarded');
    assert.equal(receipt.trialId, authority.grant.identity.trialId);
    assert.equal(receipt.completed, true, 'startup cleanup completed before the failure was rethrown');
    assert.equal(receipt.rootRemoved, true);
    assert.deepEqual(receipt.failureReasons, []);
    assert.throws(() => lstatSync(rootDir), /ENOENT/u, 'the owned root was removed');
    assert.equal(existsSync(fixture.liveDir), true, 'live fixtures survive the failed trial');
    assert.equal(readFileSync(fixture.liveFile, 'utf8'), fixture.liveBytes, 'live fixture bytes are unchanged');
    assert.equal(candidateTrialRootCount(), rootsBefore, 'the failed trial leaks no owned root');
  } finally {
    cleanupTrialFixture(fixture);
  }
});

test('dispose refuses a dangling symlink/junction at the owned root and never claims it removed', { timeout: 30_000 }, async () => {
  const fixture = trialFixture();
  const { authority, liveDir } = fixture;
  const rootDir = authority.grant.resolvedPaths.rootDir;
  const danglingTarget = path.join(path.dirname(liveDir), 'dangling-trial-link-target');
  try {
    // Windows creates the dangling link as a native junction (no privilege or
    // install needed); POSIX uses a plain dir symlink. Skip only if the OS
    // refuses link creation entirely.
    rmSync(rootDir, { recursive: true, force: true });
    let created = false;
    try {
      symlinkSync(danglingTarget, rootDir, process.platform === 'win32' ? 'junction' : 'dir');
      created = true;
    } catch {
      // Unprivileged refusal: leave the case unasserted rather than install.
    }
    if (created) {
      assert.equal(existsSync(rootDir), false, 'the dangling link reproduces the existsSync trap');
      const receipt = await authority.dispose();
      assert.equal(receipt.completed, false, 'a dangling link must fail closed');
      assert.equal(receipt.rootRemoved, false, 'no removal may be claimed while the path entry exists');
      assert.ok(
        receipt.failureReasons.some((reason) => /symlink\/junction/u.test(reason)),
        `expected a symlink refusal reason, got ${JSON.stringify(receipt.failureReasons)}`,
      );
      assert.equal(lstatSync(rootDir).isSymbolicLink(), true, 'the refusal leaves the owned link untouched');
    }
  } finally {
    // Cleanup removes only the link this test created, never any target.
    rmSync(rootDir, { recursive: true, force: true });
    cleanupTrialFixture(fixture);
  }
});

function candidateTrialRootCount(): number {
  try {
    return readdirSync(tmpdir()).filter((name) => name.startsWith('pie-analytics-candidate-trial-')).length;
  } catch {
    return -1;
  }
}