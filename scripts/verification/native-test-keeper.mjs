import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireDevelopmentReader } from '../../lib/development-runtime/lifetime.mjs';
import { resolveDevelopmentSdkWorkspaceRoot } from '../lib/development-sdk-reader.mjs';

const entry = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(entry), '../..');

function wireError(error) {
  return { message: String(error?.message ?? error), teardownUnconfirmed: error?.teardownUnconfirmed === true,
    diagnosticPath: error?.diagnosticPath, evidenceDirectory: error?.evidenceDirectory };
}

/** Launcher proxy; never owns a reader and never kills the independent keeper. */
export function runInNativeTestKeeper(files, options = {}, { spawnImpl = spawn } = {}) {
  const { signal, ...forwarded } = options;
  const serializable = { ...forwarded, cwd: path.resolve(options.cwd ?? root), env: options.env ?? process.env };
  const env = { ...process.env };
  // The keeper is SDK-independent. Test preloads/aliases belong exclusively to
  // the contained child environment sent over IPC, not this Node process.
  for (const key of Object.keys(env)) {
    if (['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH'].includes(key.toUpperCase())) delete env[key];
  }
  return new Promise((resolve, reject) => {
    let child;
    let outcome;
    let transportError;
    const onAbort = () => {
      if (child?.connected) child.send({ type: 'cancel' }, (error) => { if (error) transportError = error; });
    };
    try {
      child = spawnImpl(process.execPath, [entry], {
        cwd: serializable.cwd, env, detached: true, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (error) { reject(error); return; }
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.on('error', (error) => { transportError = error; });
    child.on('message', (message) => { if (message?.type === 'result') outcome = message; });
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (outcome?.error) reject(Object.assign(new Error(outcome.error.message), outcome.error));
      else if (outcome?.result) resolve(outcome.result);
      else reject(Object.assign(new Error(`Native test keeper lost without a cleanup result${transportError ? `: ${transportError.message}` : ''}; reader lifetime is unknown`), { teardownUnconfirmed: true }));
    };
    child.once('close', settle);
    child.once('exit', () => {
      // Unknown guardians may still hold inherited output handles. Waiting for
      // ChildProcess 'close' would hang the launcher despite keeper settlement.
      if (!outcome?.result) {
        child.stdout.destroy(); child.stderr.destroy();
        settle();
      }
    });
    child.on('error', () => { if (!child.pid) settle(); });
    // FIFO IPC: cancellation can queue before or during acquisition/startup.
    child.send({ type: 'run', files, options: serializable }, (error) => {
      if (error) { transportError = error; if (child.connected) child.disconnect(); }
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Local keeper operation. Production calls this ONLY in the keeper process.
 * Dependency seams are explicit and do not disable delegation in the launcher.
 */
export async function runNativeTestLease(files, options = {}, dependencies = {}) {
  if (options.signal?.aborted) return { code: 1, teardownConfirmed: true };
  const runner = await import('./test-node.mjs');
  const workspaceRoot = resolveDevelopmentSdkWorkspaceRoot(options.sdkPath, { root: options.repoRoot ?? root });
  if (!workspaceRoot) throw new Error('Native test keeper requires an explicit native workspace SDK');
  const evidenceDirectory = await mkdtemp(path.join(tmpdir(), 'pie-native-test-keeper-'));
  let reader;
  let overlay;
  let acquisitionStarted = false;
  let admissionStarted = false;
  let released = false;
  const releaseReader = async (proof) => {
    if (released) throw new Error('Native test reader already released');
    await reader.release(proof);
    released = true;
  };
  try {
    acquisitionStarted = true;
    reader = await (dependencies.acquireReader ?? acquireDevelopmentReader)(workspaceRoot, {
      metadata: { operation: 'native-test-keeper', invocation: randomUUID(), evidence: evidenceDirectory },
    });
    const resolved = { ...options, sdkPath: (dependencies.resolveSdkPath ?? runner.resolveTestSdkPath)(options.repoRoot ?? root, options.sdkPath) };
    overlay = (dependencies.createOverlay ?? runner.createRunnerTsconfigOverlay)(options.repoRoot ?? root, resolved);
    const env = { ...(resolved.env ?? process.env), ...(overlay ? { TSX_TSCONFIG_PATH: overlay.configPath } : {}) };
    await writeFile(path.join(evidenceDirectory, 'lifetime.json'), JSON.stringify({
      ownerPid: process.pid, workspaceRoot, overlayPath: overlay?.configPath,
    }, null, 2));
    admissionStarted = true;
    const result = await (dependencies.runOwnedTests ?? runner.runOwnedNodeTests)(files, { ...resolved, env }, { releaseReader, evidenceDirectory });
    // A success-shaped injected result is not release authority. Only the
    // owned driver's verified proof callback can release this exact reader.
    if (!released || result?.teardownConfirmed !== true) throw new Error('Owned native tests returned without confirmed reader cleanup');
    overlay?.dispose();
    overlay = undefined;
    await rm(evidenceDirectory, { recursive: true, force: true });
    return result;
  } catch (error) {
    if (reader && !released && !admissionStarted) {
      try { await releaseReader({ teardownConfirmed: true }); }
      catch (releaseError) { error = new AggregateError([error, releaseError], 'Native test setup failed and its reader could not be released'); }
    }
    // Acquisition can fail after a partial durable gate mutation. Never erase
    // that invocation's evidence just because no release closure was returned.
    const unknown = (acquisitionStarted && !reader) || (reader && !released) || error?.teardownUnconfirmed === true;
    if (unknown) {
      error.teardownUnconfirmed = true;
      error.evidenceDirectory ??= evidenceDirectory;
      error.diagnosticPath ??= path.join(evidenceDirectory, 'diagnostic.json');
      await writeFile(path.join(evidenceDirectory, 'diagnostic.json'), JSON.stringify({
        ownerPid: process.pid, workspaceRoot, admissionStarted, released, error: wireError(error),
      }, null, 2)).catch(() => {});
    } else {
      overlay?.dispose();
      await rm(evidenceDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  // Install BEFORE any asynchronous import/acquisition. EOF is cancellation,
  // never authorization or reader-release evidence.
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Native test launcher disconnected or cancelled'));
  process.on('disconnect', cancel);
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  let started = false;
  const initialTimer = setTimeout(() => process.exit(1), 30_000);
  process.on('message', (message) => {
    if (message?.type === 'cancel') { cancel(); return; }
    if (message?.type !== 'run' || started) return;
    started = true;
    clearTimeout(initialTimer);
    void (async () => {
      let outcome;
      try { outcome = { type: 'result', result: await runNativeTestLease(message.files, { ...message.options, signal: controller.signal }) }; }
      catch (error) { outcome = { type: 'result', error: wireError(error) }; }
      // Unknown may leave guardian/control handles alive. Settle the launcher,
      // preserve diagnostics/aliases/records, then exit rather than hanging.
      if (process.connected) await new Promise((resolve) => process.send(outcome, () => resolve()));
      if (process.connected) process.disconnect();
      await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((resolve) => stream.write('', () => resolve()))));
      process.exit(outcome.error ? 1 : 0);
    })();
  });
  if (!process.connected) { clearTimeout(initialTimer); process.exit(1); }
}
