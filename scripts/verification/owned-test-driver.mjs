import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnWindowsOwnedTree } from '../../lib/process-lifecycle/windows-owned-tree.mjs';
import { OWNERSHIP_STARTUP_TOKEN } from './ownership-startup.mjs';

function matchingProof(tree, proof) {
  return proof?.gone === true && proof.activeProcesses === 0
    && proof.invocationId === tree.invocationId && proof.rootPid === tree.rootPid
    && proof.admissionSealed === true && proof.authority === 'open-windows-job-accounting';
}

function forward(source, destination) {
  // A dead launcher must not stop the keeper consuming child output.
  const onError = () => { source.unpipe(destination); source.resume(); };
  destination.on('error', onError);
  source.pipe(destination, { end: false });
  return () => { source.unpipe(destination); destination.removeListener('error', onError); source.resume(); };
}

/** SDK-independent contained driver. Only releaseReader may release the lease;
 * it runs with the guardian's sealed, matching empty Job still open.
 * Callers retain the overlay on ANY unconfirmed error after admission begins.
 */
export async function runOwnedTestDriver(invocation, {
  cwd, env, signal, timeoutMs,
} = {}, { spawnTree = spawnWindowsOwnedTree, releaseReader, evidenceDirectory } = {}) {
  let tree;
  let error;
  let completion;
  let cancelled = signal?.aborted === true;
  let timedOut = false;
  let wake;
  let timer;
  let unforward = [];
  let noProcessAdmitted = true;
  const interrupted = new Promise((resolve) => { wake = resolve; });
  const onAbort = () => { cancelled = true; wake(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    if (!cancelled) {
      if (evidenceDirectory) writeFileSync(path.join(evidenceDirectory, 'owned-tree.json'), JSON.stringify({ configRoot: invocation.configRoot, stage: 'starting' }));
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(() => { timedOut = true; wake(); }, timeoutMs);
      // Deliberately do NOT pass the user's signal. Once startup is in flight,
      // cancellation queues until bounded readiness, then drains without ever
      // authorizing. Aborting the helper here would destroy the proof channel.
      noProcessAdmitted = false;
      try {
        tree = await spawnTree({ command: process.execPath, args: invocation.args, cwd, env });
      } catch (startupError) {
        // The primitive allocates evidence before any possible guardian/root.
        // An error carrying that directory is uncertainty, never no-admission.
        noProcessAdmitted = !startupError?.evidenceDirectory;
        throw startupError;
      }
      unforward = [forward(tree.stdout, process.stdout), forward(tree.stderr, process.stderr)];
      if (evidenceDirectory) writeFileSync(path.join(evidenceDirectory, 'owned-tree.json'), JSON.stringify({
        configRoot: invocation.configRoot, stage: 'ready', invocationId: tree.invocationId,
        rootPid: tree.rootPid, guardianPid: tree.guardianPid, evidenceDirectory: tree.evidenceDirectory,
      }, null, 2));
      if (!cancelled && !timedOut) {
        await tree.authorizeStartup(OWNERSHIP_STARTUP_TOKEN);
        completion = await Promise.race([tree.completion, interrupted]);
      }
    }
  } catch (caught) {
    error = caught;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  let proof;
  let released = false;
  try {
    if (tree) {
      // Root exit is not tree-empty. Also drain after authorization/output/
      // completion exceptions; unknown is the default, not an opt-in flag.
      proof = await tree.stopAndDrain();
      if (!matchingProof(tree, proof)) throw new Error(proof?.diagnostic ?? 'Missing matching sealed open-Job empty proof');
      await releaseReader({ teardownConfirmed: true });
      released = true;
      await tree.closeAfterRelease();
    } else if (noProcessAdmitted) {
      await releaseReader({ teardownConfirmed: true });
      released = true;
    } else {
      throw error ?? new Error('Owned-tree startup did not establish no-admission or an empty proof');
    }
    invocation.dispose();
  } catch (cleanupError) {
    const uncertain = Object.assign(new Error('Node test process tree teardown is unconfirmed'), {
      cause: cleanupError,
      teardownUnconfirmed: true,
      evidenceDirectory: tree?.evidenceDirectory ?? error?.evidenceDirectory,
      diagnosticPath: path.join(invocation.configRoot, 'teardown.json'),
    });
    try {
      writeFileSync(uncertain.diagnosticPath, JSON.stringify({
        ownerPid: process.pid, invocationId: tree?.invocationId, rootPid: tree?.rootPid,
        guardianPid: tree?.guardianPid, evidenceDirectory: uncertain.evidenceDirectory,
        released, proof, diagnostic: cleanupError.message, operationError: error?.message,
      }, null, 2));
    } catch (diagnosticWriteError) { uncertain.diagnosticWriteError = diagnosticWriteError; }
    throw uncertain;
  } finally {
    for (const stopForwarding of unforward) stopForwarding();
  }
  if (error) throw error;
  return { code: cancelled || timedOut ? 1 : (completion?.code ?? 1), teardownConfirmed: true };
}
