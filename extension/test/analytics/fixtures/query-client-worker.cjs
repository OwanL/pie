const { serialize } = require('node:v8');

if (process.env.PIE_ANALYTICS_DATABASE_PATH?.includes('require-owned-exec-argv')) {
  const expected = ['--max-old-space-size=192'];
  if (JSON.stringify(process.execArgv) !== JSON.stringify(expected)) {
    process.stderr.write(`query worker inherited parent execArgv: ${process.execArgv.join(' ')}\n`);
    process.exit(31);
  }
}

process.on('message', (message) => {
  process.send?.({ type: 'result', requestId: message.requestId, bytes: serialize({ ok: true }) });
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
