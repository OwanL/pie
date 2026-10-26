import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createImageWorkerGuard } from '../fixtures/image-worker-guard.mjs';

for (const attempt of ["const fs=await import('node:fs/promises'); await fs.readFile('credentials.json')", "const fs=await import('node:fs/promises'); const h=await fs.open('credentials.json','r'); await h.chmod(0o777)", '', "await import('node:net')", "await import('node:child_process')", "const {writeFileSync}=await import('node:fs'); writeFileSync('forbidden', 'x')", "const {Worker}=await import('node:worker_threads'); new Worker('x')", "const {createRequire}=await import('node:module'); createRequire(import.meta.url)('keytar')"]) {
  test(`exact worker guard: ${attempt || 'success'}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pie-image-guard-'));
    try {
      const path = join(dir, 'worker.mjs');
      writeFileSync(path, `import {parentPort} from 'node:worker_threads'; parentPort.once('message', async () => { try { const {readFileSync}=await import('node:fs'); if(!Buffer.isBuffer(readFileSync(new URL(import.meta.url)))) throw Error('buffer read failed'); ${attempt} } catch {} parentPort.postMessage({result:{data:'AA==',mimeType:'image/png',width:1,height:1}}); });`);
      const denials = [];
      const guard = createImageWorkerGuard({ workerPath: realpathSync(path), env: {}, deny: reason => denials.push(reason), timeoutMs: 1000 });
      assert.throws(() => new guard.Worker(pathToFileURL(path), { execArgv: [] }));
      denials.length = 0;
      const worker = new guard.Worker(pathToFileURL(path));
      worker.postMessage({});
      const evidence = await guard.settle();
      assert.equal(evidence[0].results, 1, JSON.stringify(evidence));
      assert.equal(evidence[0].exited, true);
      assert.deepEqual(evidence[0].errors, []);
      assert.equal(denials.length > 0, Boolean(attempt));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
