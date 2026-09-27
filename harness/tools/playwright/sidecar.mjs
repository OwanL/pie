import { Console } from 'node:console';

// stdout is exclusively JSONL protocol traffic. Trusted run_code bodies and
// imported libraries may use any console method, including in later callbacks;
// keep diagnostics on stderr for the entire sidecar lifetime.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

const [{ PlaywrightBackend }, { SidecarCore, SidecarJsonlDecoder, encodeSidecarRecord }] = await Promise.all([
  import('./backend.mjs'), import('./sidecar-core.mjs'),
]);

const backend = new PlaywrightBackend();
const core = new SidecarCore(backend, (record) => process.stdout.write(encodeSidecarRecord(record)));
const decoder = new SidecarJsonlDecoder();
let exiting = false;

process.stdin.on('data', (chunk) => {
  try {
    const records = decoder.push(chunk);
    for (const error of decoder.takeErrors()) core.protocolError(error);
    for (const record of records) {
      if (record?.kind === 'shutdown') void stop(0);
      else core.accept(record);
    }
  } catch (error) { core.protocolError(error); }
});
// The parent owns every browser through this process: if the parent's end of
// the pipe closes (session shutdown, reload, or parent death), clean up all
// Chromium descendants before exiting.
process.stdin.on('end', () => { void stop(0); });

async function stop(code) {
  if (exiting) return; exiting = true;
  // A zero exit is the parent's existing cleanup acknowledgement: backend and
  // browser-server teardown must have completed, not merely been attempted.
  let cleanupConfirmed = false;
  let shutdownError;
  let shutdownTimer;
  try {
    await Promise.race([
      core.shutdown(),
      new Promise((_, reject) => { shutdownTimer = setTimeout(() => reject(new Error('Sidecar shutdown exceeded its cleanup budget.')), 5000); }),
    ]);
    cleanupConfirmed = true;
  } catch (error) { shutdownError = error; }
  finally { if (shutdownTimer) clearTimeout(shutdownTimer); }
  // closeSession can consume its grace budget before it reaches browserServer.
  // Parent death has no surviving RuntimeClient watchdog, so force every live
  // or in-flight-closing dedicated browser tree before exit and retain failure.
  try {
    await backend.forceKillAll();
    cleanupConfirmed = true;
  } catch (error) {
    cleanupConfirmed = false;
    const detail = [shutdownError, error].filter(Boolean).map((failure) => failure?.message ?? String(failure)).join(' ');
    console.error(`[pie:playwright-cleanup] ${detail || 'Runtime cleanup could not be confirmed.'}`);
  }
  process.stdin.pause();
  process.exit(code === 0 && cleanupConfirmed ? 0 : 1);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { void stop(0); });
process.once('uncaughtException', () => { void stop(1); });
process.once('unhandledRejection', () => { void stop(1); });

// Backstop for a parent that died without closing the pipe: if the owner
// process is gone, shut down so no Chromium outlives the owning pie session.
if (typeof process.ppid === 'number' && process.ppid > 1) {
  const watchdog = setInterval(() => {
    try { process.kill(process.ppid, 0); } catch { void stop(0); }
  }, 1000);
  watchdog.unref();
}
