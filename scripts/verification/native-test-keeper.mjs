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

const baseRoot = (options) => path.resolve(options.repoRoot ?? root);

/** SDK-independent native-workspace admission for the keeper dispatch. Each
 * entry owns (a) the workspace-root resolution the keeper validates BEFORE any
 * acquisition and (b) the keeper-process setup/run step used after it.
 * Scheduler/config/profile details stay in the trusted operation modules and
 * run only after the reader is acquired, so the keeper acquires before
 * validation/overlays/profiles for every shared consumer. */
const TRUSTED_OPERATIONS = Object.freeze({
  test: {
    label: 'native test',
    metadata: 'native-test-keeper',
    workspaceRequirement: 'Native test keeper requires an explicit native workspace SDK',
    async resolveWorkspaceRoot(options, ownerRoot) {
      return resolveDevelopmentSdkWorkspaceRoot(options.sdkPath, { root: ownerRoot });
    },
    async run(invocation, options, owner, dependencies = {}) {
      const runner = await import('./test-node.mjs');
      const resolved = { ...options, sdkPath: (dependencies.resolveSdkPath ?? runner.resolveTestSdkPath)(owner.baseRoot, options.sdkPath) };
      owner.overlay = (dependencies.createOverlay ?? runner.createRunnerTsconfigOverlay)(owner.baseRoot, resolved);
      const env = { ...(resolved.env ?? process.env), ...(owner.overlay ? { TSX_TSCONFIG_PATH: owner.overlay.configPath } : {}) };
      await owner.writeLifetime({ overlayPath: owner.overlay?.configPath });
      owner.markAdmission();
      return (dependencies.runOwnedTests ?? runner.runOwnedNodeTests)(invocation, { ...resolved, env }, owner);
    },
  },
  typecheck: {
    label: 'typecheck',
    metadata: 'native-typecheck-keeper',
    workspaceRequirement: 'Native typecheck keeper requires an explicit native workspace SDK',
    async resolveWorkspaceRoot(options, ownerRoot) {
      return resolveDevelopmentSdkWorkspaceRoot(options.sdkPath, { root: ownerRoot });
    },
    async run(invocation, options, owner) {
      const typecheck = await import('./typecheck-project.mjs');
      return typecheck.runOwnedTypecheck(invocation, options, owner);
    },
  },
  offline: {
    label: 'offline framework',
    metadata: 'native-offline-keeper',
    workspaceRequirement: 'Offline Vitest keeper requires the repository\'s native Pi workspace',
    async resolveWorkspaceRoot(options, ownerRoot) {
      const offline = await import('./test-framework-offline.mjs');
      return offline.resolveOfflineWorkspaceRoot(ownerRoot);
    },
    async run(invocation, options, owner) {
      const offline = await import('./test-framework-offline.mjs');
      return offline.runOwnedOfflineVitest(invocation, options, owner);
    },
  },
});

/** Keeper-process lease shared by every native Windows verification consumer.
 * The keeper acquires the development reader FIRST, before any SDK validation,
 * overlay, or private profile work; parent-loss cancellation is queued rather
 * than tearing the guardian down; the contained child always runs through the
 * one kernel owned driver; and the reader is released only on that driver's
 * verified matching tree-empty proof. */
export async function runTrustedNativeLease(operation, invocation, options = {}, dependencies = {}) {
  const spec = TRUSTED_OPERATIONS[operation];
  if (!spec) {
    throw new Error(`Native verification keeper does not trust operation: ${JSON.stringify(operation)}`);
  }
  if (options.signal?.aborted) return { code: 1, teardownConfirmed: true };
  const owner = {
    baseRoot: baseRoot(options), evidenceDirectory: undefined, releaseReader: undefined,
    writeLifetime: undefined, overlay: undefined,
  };
  const workspaceRoot = await spec.resolveWorkspaceRoot(options, owner.baseRoot);
  if (!workspaceRoot) throw new Error(spec.workspaceRequirement);
  const evidenceDirectory = await mkdtemp(path.join(tmpdir(), 'pie-native-test-keeper-'));
  let reader;
  let acquisitionStarted = false;
  let released = false;
  const releaseReader = async (proof) => {
    if (released) throw new Error('Native test reader already released');
    await reader.release(proof);
    released = true;
  };
  const writeLifetime = async (fields = {}) => {
    if (!owner.evidenceDirectory) return;
    await writeFile(path.join(owner.evidenceDirectory, 'lifetime.json'), JSON.stringify({
      ownerPid: process.pid, workspaceRoot, operation, ...fields,
    }, null, 2));
  };
  // Admissions begin only when an operation reaches its driver run; earlier
  // validation/overlay/profile failures release safely without launching.
  Object.assign(owner, {
    releaseReader, evidenceDirectory, writeLifetime, admissionStarted: false,
    markAdmission() { owner.admissionStarted = true; },
  });
  try {
    acquisitionStarted = true;
    reader = await (dependencies.acquireReader ?? acquireDevelopmentReader)(workspaceRoot, {
      metadata: { operation: spec.metadata, invocation: randomUUID(), evidence: evidenceDirectory },
    });
    await writeLifetime();
    const result = await spec.run(invocation, options, owner, dependencies);
    // A success-shaped injected result is not release authority. Only the
    // owned driver's verified proof callback can release this exact reader.
    if (!released || result?.teardownConfirmed !== true) throw new Error(`Owned ${spec.label} returned without confirmed reader cleanup`);
    // Overlay aliases stay alive for any unconfirmed error after admission;
    // only a confirmed (proof-released) result disposes them.
    owner.overlay?.dispose();
    await rm(evidenceDirectory, { recursive: true, force: true });
    return result;
  } catch (error) {
    if (reader && !released && !owner.admissionStarted) {
      try { await releaseReader({ teardownConfirmed: true }); }
      catch (releaseError) { error = new AggregateError([error, releaseError], 'Native verification setup failed and its reader could not be released'); }
    }
    // Acquisition can fail after a partial durable gate mutation. Never erase
    // that invocation's evidence just because no release closure was returned.
    const unknown = (acquisitionStarted && !reader) || (reader && !released) || error?.teardownUnconfirmed === true;
    if (unknown) {
      error.teardownUnconfirmed = true;
      error.evidenceDirectory ??= evidenceDirectory;
      error.diagnosticPath ??= path.join(evidenceDirectory, 'diagnostic.json');
      await writeFile(path.join(evidenceDirectory, 'diagnostic.json'), JSON.stringify({
        ownerPid: process.pid, workspaceRoot, operation, admissionStarted: owner.admissionStarted,
        released, error: wireError(error),
      }, null, 2)).catch(() => {});
    } else {
      owner.overlay?.dispose();
      await rm(evidenceDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

/** Backward-compatible alias for the node:test operation lease. Production
 * calls this ONLY in the keeper process. Dependency seams are explicit and do
 * not disable delegation in the launcher. */
export function runNativeTestLease(files, options = {}, dependencies = {}) {
  return runTrustedNativeLease('test', files, options, dependencies);
}

/** Launch a detached keeper and queue one trusted operation over FIFO IPC.
 * The launcher never owns a reader and never kills the independent keeper;
 * parent-disconnect cancellation is queued to the keeper, never enacted here. */
export function runInNativeTrustedKeeper(operation, invocation, options = {}, { spawnImpl = spawn } = {}) {
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
      else reject(Object.assign(new Error(`Native ${TRUSTED_OPERATIONS[operation]?.label ?? 'test'} keeper lost without a cleanup result${transportError ? `: ${transportError.message}` : ''}; reader lifetime is unknown`), { teardownUnconfirmed: true }));
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
    child.send({ type: 'run', operation, invocation, options: serializable }, (error) => {
      if (error) { transportError = error; if (child.connected) child.disconnect(); }
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Backward-compatible alias for the node:test operation launcher. */
export function runInNativeTestKeeper(files, options = {}, context = {}) {
  return runInNativeTrustedKeeper('test', files, options, context);
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
      try {
        // Older launchers send node:test runs as bare `files` without an
        // operation field; newer launchers describe every trusted operation.
        outcome = { type: 'result', result: await runTrustedNativeLease(message.operation ?? 'test', message.invocation ?? message.files, { ...message.options, signal: controller.signal }) };
      } catch (error) { outcome = { type: 'result', error: wireError(error) }; }
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