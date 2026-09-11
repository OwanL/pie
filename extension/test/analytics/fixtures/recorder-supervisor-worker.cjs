const fs = require('node:fs');
const { deserialize } = require('node:v8');

const logPath = process.env.PIE_ANALYTICS_DATABASE_PATH;
const crashMarker = `${logPath}.crashed`;
const workerIdentity = {
  pid: process.pid,
  spawnedAtMs: Number(process.env.PIE_ANALYTICS_WORKER_SPAWNED_AT_MS),
  instanceId: process.env.PIE_ANALYTICS_WORKER_INSTANCE_ID,
};

function send(message) {
  return new Promise((resolve, reject) => {
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}

function append(value) {
  fs.appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}

async function handle(request) {
  if (request.type === 'captureBatch') {
    const envelopes = request.items.map((item) => deserialize(Buffer.from(item)));
    if (envelopes.some((envelope) => envelope.value.sourceKey === 'crash-once') && !fs.existsSync(crashMarker)) {
      fs.writeFileSync(crashMarker, '1');
      process.exit(12);
      return;
    }
    const rejections = [];
    for (let index = 0; index < envelopes.length; index++) {
      const envelope = envelopes[index];
      const value = envelope.value;
      if (value.sourceKey === 'deleted-subject') {
        rejections.push({ index, code: 'subject_deleted', error: 'Analytics capture subject is deleted: deleted-root' });
        continue;
      }
      append({
        type: envelope.kind,
        subject: envelope.subject,
        sourceKey: value.sourceKey,
        payloadId: value.payloadId,
        detail: envelope.kind === 'detail' ? deserialize(Buffer.from(value.bytes)) : undefined,
      });
    }
    await send({
      type: 'ack',
      requestId: request.requestId,
      receipt: rejections.length > 0 ? { rejections } : undefined,
    });
    return;
  }
  if (request.type === 'bindPendingCreate') {
    append({ type: 'bind', pendingOperationId: request.pendingOperationId, rootSessionId: request.rootSessionId });
    await send({
      type: 'ack',
      requestId: request.requestId,
      receipt: {
        pendingOperationId: request.pendingOperationId,
        rootSessionId: request.rootSessionId,
        movedObservationCount: 1,
        movedPayloadCount: 0,
        duplicate: false,
      },
    });
    return;
  }
  if (request.type === 'stats') {
    await send({ type: 'ack', requestId: request.requestId, receipt: { process: {}, recorder: {}, detailStorage: {} } });
    return;
  }
  if (request.type === 'flush') {
    await send({ type: 'ack', requestId: request.requestId });
    return;
  }
  if (request.type === 'deleteSession') {
    append({ type: 'delete', rootSessionId: request.rootSessionId });
    await send({ type: 'ack', requestId: request.requestId, receipt: {} });
    return;
  }
  if (request.type === 'shutdown') {
    await send({ type: 'ack', requestId: request.requestId });
    process.disconnect();
  }
}

void send({ type: 'ready', workerIdentity }).then(() => {
  let processing = Promise.resolve();
  process.on('message', (message) => {
    processing = processing.then(() => handle(message));
  });
});
