import { Worker as NativeWorker } from 'node:worker_threads';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const IMAGE_WORKER_DENIAL = '__pieImageWorkerDenial';

// Caller verifies artifact identity; this is a narrow fixture guard, not a sandbox.
export function createImageWorkerGuard({ workerPath, env, deny, nativeWorker = NativeWorker, timeoutMs = 5000 }) {
  if (!isAbsolute(workerPath) || realpathSync(workerPath) !== workerPath) throw new Error('Expected exact canonical worker path');
  const authorized = pathToFileURL(workerPath).href;
  const privateEnv = { ...env };
  delete privateEnv.NODE_OPTIONS;
  delete privateEnv.NODE_PATH;
  privateEnv.PIE_IMAGE_WORKER_PATH = workerPath;
  const records = [];
  let settling = false;
  function denied(reason) { deny(reason); throw new Error(reason); }
  class Worker extends nativeWorker {
    constructor(url, options = {}) {
      if (settling || !(url instanceof URL) || url.href !== authorized) denied('image-worker: unauthorized worker URL');
      if (Object.keys(options).some(key => !['name'].includes(key))) denied('image-worker: caller options forbidden');
      if (records.length >= 16) denied('image-worker: worker limit');
      super(url, { ...options, env: { ...privateEnv }, execArgv: ['--import', new URL('./image-worker-preload.mjs', import.meta.url).href] });
      const record = { messages: 0, results: 0, errors: [], exited: false, exitCode: null, terminated: false };
      let finish;
      record.done = new Promise(resolve => { finish = resolve; });
      records.push({ worker: this, record });
      const emit = this.emit;
      this.emit = function(event, ...args) {
        if (event === 'message') {
          const message = args[0];
          if (message && typeof message[IMAGE_WORKER_DENIAL] === 'string') { deny(message[IMAGE_WORKER_DENIAL]); return true; }
          record.messages++;
          if (record.messages > 8) { deny('image-worker: message limit'); void this.terminate(); return true; }
          if (message?.result && typeof message.result.data === 'string' && typeof message.result.mimeType === 'string' && Number.isFinite(message.result.width) && Number.isFinite(message.result.height)) record.results++;
        }
        return emit.call(this, event, ...args);
      };
      this.on('error', error => { if (record.errors.length < 4) record.errors.push(error.message.slice(0, 500)); });
      this.once('exit', code => { record.exited = true; record.exitCode = code; finish(); });
    }
  }
  return {
    Worker,
    async settle() {
      settling = true;
      await Promise.all(records.map(async ({ worker, record }) => {
        let timer;
        await Promise.race([record.done, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
        clearTimeout(timer);
        if (!record.exited) {
          await Promise.race([worker.terminate().then(() => { record.terminated = record.exited; }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('image-worker termination unconfirmed')), timeoutMs); })]).finally(() => clearTimeout(timer));
        }
      }));
      return records.map(({ record: { done, ...evidence } }) => evidence);
    },
  };
}
