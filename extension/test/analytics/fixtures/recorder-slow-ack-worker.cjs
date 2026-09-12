// Fixture worker that deliberately delays acknowledgements, so a control
// request can exceed the supervisor's timeout and trigger its deliberate kill.
//
// The test asserts the supervisor reports the *real* cause rather than a bare
// "(SIGTERM)", which is what a Windows `child.kill()` otherwise looks like.

const delayMs = Math.max(0, Number(process.env.PIE_ANALYTICS_REHEARSAL_ACK_DELAY_MS ?? 0) || 0);

const workerIdentity = {
  pid: process.pid,
  spawnedAtMs: Number(process.env.PIE_ANALYTICS_WORKER_SPAWNED_AT_MS),
  instanceId: process.env.PIE_ANALYTICS_WORKER_INSTANCE_ID,
};

function send(message) {
  return new Promise((resolve, reject) => {
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

process.on('message', async (raw) => {
  if (!raw || typeof raw.requestId !== 'number') return;
  try {
    // Never acknowledge stats within the caller's window: the supervisor must
    // time out the request, kill this worker, and report why.
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await send({ type: 'ack', requestId: raw.requestId });
    if (raw.type === 'shutdown') process.disconnect();
  } catch {
    process.exit(0);
  }
});

send({ type: 'ready', workerIdentity }).catch(() => process.exit(1));
