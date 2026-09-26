const { serialize } = require('node:v8');

const databasePath = process.env.PIE_ANALYTICS_DATABASE_PATH ?? '';
const telemetryMode = ['success', 'error', 'invalid-identity', 'invalid-range', 'missing', 'cancel']
  .find((mode) => databasePath.includes(`query-telemetry-${mode}`));
const workerIdentity = {
  pid: process.pid,
  spawnedAtMs: Number(process.env.PIE_ANALYTICS_WORKER_SPAWNED_AT_MS),
  instanceId: process.env.PIE_ANALYTICS_WORKER_INSTANCE_ID,
};
const allocation = ['success', 'error', 'cancel'].includes(telemetryMode)
  ? Buffer.alloc(8 * 1024 * 1024)
  : undefined;
if (allocation) {
  for (let index = 0; index < allocation.length; index += 4096) allocation[index] = 0xA5;
}

if (process.env.PIE_ANALYTICS_DATABASE_PATH?.includes('require-owned-exec-argv')) {
  const expected = ['--max-old-space-size=192'];
  if (JSON.stringify(process.execArgv) !== JSON.stringify(expected)) {
    process.stderr.write(`query worker inherited parent execArgv: ${process.execArgv.join(' ')}\n`);
    process.exit(31);
  }
}

const responseDelayMs = databasePath.includes('capacity-observation')
  ? 150
  : telemetryMode === 'cancel' ? 5_000 : 0;

function telemetry(runtimeSamplePhase) {
  const resourceUsage = process.resourceUsage();
  const currentMemory = process.memoryUsage();
  return {
    workerIdentity,
    maxRssBytes: resourceUsage.maxRSS * 1024,
    userCpuTimeMicros: resourceUsage.userCPUTime,
    systemCpuTimeMicros: resourceUsage.systemCPUTime,
    currentMemory: {
      rssBytes: currentMemory.rss,
      heapTotalBytes: currentMemory.heapTotal,
      heapUsedBytes: currentMemory.heapUsed,
      externalBytes: currentMemory.external,
      arrayBuffersBytes: currentMemory.arrayBuffers,
    },
    runtimeSamplePhase,
  };
}

function terminalMessage(requestId) {
  const bytes = serialize({ ok: true, payload: allocation ? Buffer.alloc(128 * 1024, 0x3C) : undefined });
  if (telemetryMode === 'missing') return { type: 'result', requestId, bytes };
  if (!telemetryMode) return { type: 'result', requestId, bytes: serialize({ ok: true }) };
  const sample = telemetry('after-result-serialization');
  if (telemetryMode === 'invalid-identity') sample.workerIdentity = { ...sample.workerIdentity, instanceId: 'forged-worker' };
  if (telemetryMode === 'invalid-range') sample.maxRssBytes = -1;
  return { type: 'result', requestId, bytes, telemetry: sample };
}

process.on('message', (message) => {
  const respond = () => {
    if (telemetryMode === 'error') {
      process.send?.({
        type: 'error',
        requestId: message.requestId,
        error: 'fixture query failure',
        telemetry: telemetry('after-error-message-formatting'),
      });
      return;
    }
    process.send?.(terminalMessage(message.requestId));
  };
  if (responseDelayMs > 0) setTimeout(respond, responseDelayMs);
  else respond();
});

process.once('disconnect', () => process.exit(0));
process.send?.({
  type: 'ready',
  workerIdentity: {
    pid: process.pid,
    spawnedAtMs: Number(process.env.PIE_ANALYTICS_WORKER_SPAWNED_AT_MS),
    instanceId: process.env.PIE_ANALYTICS_WORKER_INSTANCE_ID,
  },
});
