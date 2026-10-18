import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnWindowsOwnedTree } from '../../lib/process-lifecycle/windows-owned-tree.mjs';
import { OWNERSHIP_STARTUP_TOKEN } from './ownership-startup.mjs';

// The primitive's closeAfterRelease resolves once the guardian has exited, but
// its stdout/stderr pipes may still deliver a short output tail afterwards.
// Both streams must reach actual EOF before collected output is returned or
// forwarding is stopped. A bounded settle failure is an output error, never a
// substitute for the kernel's tree-empty proof.
function settleOutputStream(stream, timeoutMs) {
  return new Promise((resolve) => {
    if (stream.readableEnded) { resolve(); return; }
    if (stream.destroyed) { resolve(new Error('Output stream closed before EOF')); return; }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off('end', onEnd); stream.off('close', onClose); stream.off('error', onError);
      resolve(error);
    };
    const onEnd = () => finish();
    const onClose = () => finish(stream.readableEnded ? undefined : new Error('Output stream closed before EOF'));
    const onError = (error) => finish(new Error('Output stream errored before EOF', { cause: error }));
    const timer = setTimeout(() => finish(new Error('Timed out waiting for output stream EOF')), timeoutMs);
    stream.once('end', onEnd);
    stream.once('close', onClose);
    stream.once('error', onError);
  });
}

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
 * `authorizationText` defaults to the ownership startup token used by the
 * contained test-runner preload; ordinary tsc/Vitest children have no preload
 * (the Job already contains their tree) and authorize with '' — an exact close
 * without write, which closes their stdin without sending the token.
 * `collectOutput` returns the child's stdout+stderr instead of forwarding them.
 */
export async function runOwnedTestDriver(invocation, {
  cwd, env, signal, timeoutMs, authorizationText, collectOutput = false, onTerminate,
} = {}, { spawnTree = spawnWindowsOwnedTree, releaseReader, evidenceDirectory, outputSettleTimeoutMs = 5_000 } = {}) {
  let tree;
  let error;
  let completion;
  let cancelled = signal?.aborted === true;
  let timedOut = false;
  let wake;
  let timer;
  let unforward = [];
  let collected;
  let outputError;
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
      // No source stream can own an error event; guardian pipe failures must
      // neither crash teardown nor stall the bounded tail settle below.
      for (const source of [tree.stdout, tree.stderr]) source.on('error', () => { });
      if (collectOutput) {
        // The owner (typecheck) consumes the child output as its result payload;
        // nothing is mirrored to the keeper console.
        collected = '';
        tree.stdout.on('data', (chunk) => { collected += chunk; });
        tree.stderr.on('data', (chunk) => { collected += chunk; });
      } else {
        unforward = [forward(tree.stdout, process.stdout), forward(tree.stderr, process.stderr)];
      }
      if (evidenceDirectory) writeFileSync(path.join(evidenceDirectory, 'owned-tree.json'), JSON.stringify({
        configRoot: invocation.configRoot, stage: 'ready', invocationId: tree.invocationId,
        rootPid: tree.rootPid, guardianPid: tree.guardianPid, evidenceDirectory: tree.evidenceDirectory,
      }, null, 2));
      if (!cancelled && !timedOut) {
        await tree.authorizeStartup(authorizationText ?? OWNERSHIP_STARTUP_TOKEN);
        completion = await Promise.race([tree.completion, interrupted]);
      }
    }
  } catch (caught) {
    error = caught;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  // Cancel-during-startup never aborts the guardian's readiness; it surfaces
  // below with the same termination report the watchdog routes print. A tree
  // that was never admitted (cancelled before entry) reports nothing.
  if (timedOut) onTerminate?.({ reason: 'timeout' });
  else if (cancelled && !noProcessAdmitted) onTerminate?.({ reason: 'abort' });

  let proof;
  let released = false;
  let closed = false;
  try {
    if (tree) {
      // Root exit is not tree-empty. Also drain after authorization/output/
      // completion exceptions; unknown is the default, not an opt-in flag.
      proof = await tree.stopAndDrain();
      if (!matchingProof(tree, proof)) throw new Error(proof?.diagnostic ?? 'Missing matching sealed open-Job empty proof');
      await releaseReader({ teardownConfirmed: true });
      released = true;
      await tree.closeAfterRelease();
      closed = true;
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
    // A proven close may still be followed by a late output tail: wait for both
    // source streams' actual EOF (bounded) before releasing the forwarded data
    // or computing the collected return value. Output failures are reported only
    // after the kernel-proof cleanup above has completed.
    if (tree && closed) {
      const failures = (await Promise.all([
        settleOutputStream(tree.stdout, outputSettleTimeoutMs),
        settleOutputStream(tree.stderr, outputSettleTimeoutMs),
      ])).filter(Boolean);
      if (failures.length) outputError = new AggregateError(failures, 'One or more output streams did not reach EOF');
    }
    for (const stopForwarding of unforward) stopForwarding();
  }
  if (error) {
    if (outputError && (typeof error === 'object' || typeof error === 'function')) {
      try { error.outputError = outputError; } catch { /* Preserve the original operation error. */ }
    }
    throw error;
  }
  if (outputError) throw Object.assign(new Error('Output incomplete: one or more output streams did not reach EOF', { cause: outputError }), { outputIncomplete: true });
  return {
    code: cancelled || timedOut ? 1 : (completion?.code ?? 1),
    teardownConfirmed: true,
    ...(collectOutput ? { output: collected ?? '' } : {}),
  };
}
