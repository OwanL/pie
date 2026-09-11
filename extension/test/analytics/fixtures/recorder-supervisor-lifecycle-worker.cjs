const fs = require('node:fs');
const path = require('node:path');
const { deserialize } = require('node:v8');

const databasePath = process.env.PIE_ANALYTICS_DATABASE_PATH;
const logPath = `${databasePath}.lifecycle.jsonl`;
const mode = path.basename(databasePath);

function append(value) {
  fs.appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}

function send(message) {
  return new Promise((resolve, reject) => {
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}

append({ type: 'started', pid: process.pid });

if (mode.includes('fatal-start')) {
  void send({ type: 'fatal', error: 'schema initialization is corrupt' })
    .finally(() => process.disconnect());
} else {
  const readyDelayMs = mode.includes('slow-start') ? 500 : 0;
  setTimeout(() => {
    void send({ type: 'ready' }).then(() => {
      let processing = Promise.resolve();
      process.on('message', (request) => {
        processing = processing.then(async () => {
          if (request.type === 'captureBatch') {
            const envelopes = request.items.map((item) => deserialize(Buffer.from(item)));
            if (mode.includes('crash-recovery')) process.exit(23);
            append({ type: 'capture', count: envelopes.length });
            await send({ type: 'ack', requestId: request.requestId });
            return;
          }
          if (request.type === 'flush' || request.type === 'stats') {
            if (mode.includes('control-crash')) process.exit(24);
            await send({ type: 'ack', requestId: request.requestId, receipt: {} });
            return;
          }
          if (request.type === 'shutdown') {
            await send({ type: 'ack', requestId: request.requestId });
            if (mode.includes('shutdown-slow-exit')) setTimeout(() => process.disconnect(), 200);
            else process.disconnect();
          }
        });
      });
    });
  }, readyDelayMs);
}
