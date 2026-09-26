// Test fixture that reports the recorder child's observable V8 heap ceiling.
//
// The supervisor must bound the child's old space so an idle reservation is not
// reported as worker RSS. This worker echoes back `--max-old-space-size` from
// its own execArgv so the test observes the real flag rather than a mock.

const v8 = require('node:v8');

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

function observedHeapLimitMb() {
  const fromStats = v8.getHeapStatistics().heap_size_limit / (1024 ** 2);
  const flag = process.execArgv.find((argument) => argument.startsWith('--max-old-space-size='));
  return {
    heapSizeLimitMb: Math.round(fromStats),
    flag: flag ?? null,
    execArgv: [...process.execArgv],
  };
}

process.on('message', async (raw) => {
  if (!raw || typeof raw.requestId !== 'number') return;
  try {
    if (raw.type === 'stats') {
      await send({
        type: 'ack',
        requestId: raw.requestId,
        receipt: { process: { rss: process.memoryUsage().rss, workerIdentity }, heap: observedHeapLimitMb() },
      });
      return;
    }
    // Any control command resolves so the supervisor can start and stop cleanly.
    await send({ type: 'ack', requestId: raw.requestId });
    // Shutdown is terminal: exiting is what the supervisor's stop fence waits on.
    if (raw.type === 'shutdown') process.disconnect();
  } catch (error) {
    await send({ type: 'error', requestId: raw.requestId, error: String(error && error.message) });
  }
});

send({ type: 'ready', workerIdentity }).catch(() => process.exit(1));
