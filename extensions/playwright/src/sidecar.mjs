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
  // browser.close() can hang on a wedged renderer; never let shutdown block exit.
  await Promise.race([core.shutdown(), new Promise((resolve) => setTimeout(resolve, 5000))]).catch(() => {});
  // closeSession can consume its grace budget before it reaches browserServer.
  // Parent death has no surviving RuntimeClient watchdog, so force every live
  // or in-flight-closing dedicated browser tree synchronously before exit.
  backend.forceKillAll();
  process.stdin.pause();
  process.exit(code);
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
