process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false';
process.env.CUA_DRIVER_RS_UPDATE_CHECK = 'false';

const [{ ComputerBackend }, { SidecarCore, SidecarJsonlDecoder, encodeSidecarRecord }] = await Promise.all([
  import('./backend.mjs'), import('./sidecar-core.mjs'),
]);

const backend = new ComputerBackend();
const core = new SidecarCore(backend, (record) => process.stdout.write(encodeSidecarRecord(record)));
const decoder = new SidecarJsonlDecoder();
let exiting = false;

process.stdin.on('data', (chunk) => {
  try {
    for (const record of decoder.push(chunk)) {
      if (record?.kind === 'shutdown') void stop(0);
      else core.accept(record);
    }
  } catch (error) { core.protocolError(error); }
});
process.stdin.on('end', () => { void stop(0); });

async function stop(code) {
  if (exiting) return; exiting = true;
  await core.shutdown().catch(() => {});
  process.stdin.pause();
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { void stop(0); });
process.once('uncaughtException', () => { void stop(1); });
process.once('unhandledRejection', () => { void stop(1); });
