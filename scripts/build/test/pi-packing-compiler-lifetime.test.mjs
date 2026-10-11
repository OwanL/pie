import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packingBuild } from '../pi-packing-compiler.mjs';
import { snapshotProcessTree, watchChildProcess } from '../../lib/process-watchdog.mjs';

const compilerPath = createRequire(import.meta.url).resolve('esbuild');
for (const mode of ['success', 'failure', 'timeout', 'cancel', 'disconnect']) {
  test(`real private compiler service: ${mode}`, { timeout: 45_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pie-packing-lifetime-'));
    const modulePath = path.join(dir, 'compiler.mjs');
    await writeFile(modulePath, `
import compiler from ${JSON.stringify(pathToFileURL(compilerPath).href)};
export const version = compiler.version;
export const stop = compiler.stop;
export async function build(options) {
  const context = await compiler.context({ stdin: { contents: 'export const n = 1' }, write: false });
  await context.rebuild();
  await new Promise(resolve => {
    process.once('message', resolve);
    process.send({ type: 'service-active' });
  });
  if (${JSON.stringify(mode)} === 'failure') throw new Error('real compiler fixture failure');
  return compiler.build(options);
}
`);
    const controller = new AbortController();
    let captured, receipt, active = false;
    const dependencies = {
      signal: controller.signal,
      timeoutMs: mode === 'timeout' ? 8_000 : 30_000,
      fork(...args) {
        const child = fork(...args);
        // Independent live root capture precedes permission to load compiler.
        assert.ok(snapshotProcessTree(child.pid).some(row => row.pid === child.pid));
        child.on('message', message => {
          if (message.type !== 'service-active') return;
          active = true;
          captured = snapshotProcessTree(child.pid);
          assert.ok(captured.length >= 2, 'live service captured under held root');
          if (mode === 'cancel') controller.abort();
          else if (mode === 'disconnect') child.disconnect();
          else if (mode !== 'timeout') child.send({ type: 'continue' });
        });
        return child;
      },
      watchChildProcess(child, options) {
        const watchdog = watchChildProcess(child, options);
        return {
          get timedOut() { return watchdog.timedOut; },
          get aborted() { return watchdog.aborted; },
          async settle() { receipt = await watchdog.settle(); return receipt; },
        };
      },
    };
    try {
      const work = packingBuild(modulePath, { stdin: { contents: 'export const n = 2' }, write: false }, dependencies);
      if (mode === 'success') assert.equal((await work).outputFiles.length, 1);
      else await assert.rejects(work, mode === 'failure' ? /real compiler fixture failure/ : /timeout|abort|exited|disconnected/);
      assert.equal(active, true);
      assert.equal(receipt.gone, true, JSON.stringify(receipt));
      for (const row of captured) {
        assert.equal(snapshotProcessTree(row.pid).some(now => now.pid === row.pid && now.identity === row.identity), false, `independent census: ${row.pid}`);
      }
      console.log(JSON.stringify({ mode, captured, receipt }));
    } finally {
      if (receipt?.gone) await rm(dir, { recursive: true, force: true });
    }
  });
}
