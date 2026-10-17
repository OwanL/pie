// Private packing compiler: held before work and through full-tree verification.
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { abortOnProcessSignals, watchChildProcess, withProcessTreeIsolation } from '../lib/process-watchdog.mjs';

export async function packingBuild(modulePath, options, dependencies = {}) {
  const signals = abortOnProcessSignals();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signals.signal.addEventListener('abort', abort, { once: true });
  dependencies.signal?.addEventListener('abort', abort, { once: true });
  if (dependencies.signal?.aborted) abort();
  try {
  const child = (dependencies.fork ?? fork)(fileURLToPath(import.meta.url), ['--packing-child'], withProcessTreeIsolation({ execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true }));
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  // The child cannot load the compiler or spawn its service before capture.
  let rejectWork;
  const work = new Promise((resolve, reject) => {
    rejectWork = reject;
    child.once('error', reject);
    child.once('disconnect', () => reject(new Error('Packing compiler IPC disconnected')));
    child.once('exit', (code, signal) => reject(new Error(`Packing compiler exited before result (${signal ?? code}) ${stderr}`)));
    child.on('message', message => {
      if (message.type === 'ready' && !controller.signal.aborted) child.send({ modulePath, options });
      if (message.type === 'result') resolve(message);
    });
  });
  const watchdog = (dependencies.watchChildProcess ?? watchChildProcess)(child, {
    timeoutMs: dependencies.timeoutMs ?? 120_000, signal: controller.signal, label: 'private packing compiler',
    onTerminate: ({ reason }) => rejectWork?.(new Error(`Packing compiler ${reason}`)),
  });
  let result, primary;
  try {
    result = await work;
    if (result.error) {
      primary = Object.assign(new Error(result.error.message), result.error);
    }
  } catch (error) { primary = error; }
  // Result delivery is NOT exit proof. The child and service stay held so the
  // watchdog captures live ancestry before termination, including on Windows.
  let teardown;
  try { teardown = await watchdog.settle(); }
  catch (error) { teardown = { gone: false, diagnostics: [error.message] }; }
  if (!teardown.gone) {
    // The child is deliberately held over IPC until its owner settles. An
    // uncertain census must retain uncertainty, not keep the failed runner
    // alive forever. Disconnect requests the child's existing bounded shutdown;
    // releasing local handles is NOT evidence that its service tree is gone.
    try { if (child.connected) child.disconnect(); } catch {}
    child.stderr?.destroy?.();
    child.unref?.();
    const error = primary ?? new Error('Packing compiler teardown unconfirmed');
    error.teardownUnconfirmed = true;
    error.teardownDiagnostics = teardown;
    throw error;
  }
  if (primary) throw primary;
  if (watchdog.timedOut || watchdog.aborted) throw new Error('Packing compiler timed out or cancelled');
  return { ...result.value, outputFiles: result.value.outputFiles.map(file => ({ ...file, contents: Buffer.from(file.contents, 'base64') })) };
  } finally {
    signals.dispose();
    signals.signal.removeEventListener('abort', abort);
    dependencies.signal?.removeEventListener('abort', abort);
  }
}

if (process.argv[2] === '--packing-child') {
  // IPC keeps this root live even after build failure; never self-exit before
  // the owner has captured and verified the service tree.
  let compiler;
  let disconnected = false;
  process.once('disconnect', () => {
    disconnected = true;
    // stop() requests service shutdown; it is not proof of service extinction.
    // The owner's captured-tree watchdog remains the extinction authority.
    const deadline = setTimeout(() => process.exit(1), 2_000);
    try { compiler?.stop(); } catch {}
    // Keep the root held for the owner's live ancestry capture until deadline.
    deadline.ref();
  });
  const send = message => { if (process.connected && !disconnected) process.send(message, () => {}); };
  process.once('message', async ({ modulePath, options }) => {
    try {
      compiler = await import(pathToFileURL(modulePath).href);
      if (disconnected) { compiler.stop?.(); return; }
      const value = await compiler.build(options);
      send({ type: 'result', value: { version: compiler.version, warnings: value.warnings, metafile: value.metafile, outputFiles: value.outputFiles.map(file => ({ path: file.path, contents: Buffer.from(file.contents).toString('base64') })) } });
    } catch (error) {
      send({ type: 'result', error: { message: error.message, stack: error.stack, errors: error.errors, warnings: error.warnings } });
    }
  });
  process.send({ type: 'ready' });
}
