import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { packingBuild } from '../pi-packing-compiler.mjs';

function held(value, teardown, flags = {}) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  let captured = false, settled = false;
  child.send = () => {
    assert.equal(captured, true, 'capture must precede work');
    queueMicrotask(() => child.emit('message', value));
  };
  return {
    dependencies: {
      fork() { queueMicrotask(() => child.emit('message', { type: 'ready' })); return child; },
      watchChildProcess() {
        captured = true;
        return { ...flags, async settle() { settled = true; return teardown; } };
      },
    },
    settled: () => settled,
  };
}
const value = { type: 'result', value: { version: 'fixture', warnings: [], metafile: {}, outputFiles: [{ contents: Buffer.from('bundle').toString('base64') }] } };
test('held result returns only after verified tree extinction', async () => {
  const fixture = held(value, { gone: true });
  const result = await packingBuild('/private/compiler', {}, fixture.dependencies);
  assert.equal(fixture.settled(), true);
  assert.equal(result.outputFiles[0].contents.toString(), 'bundle');
});
test('primary compiler error survives unconfirmed teardown with diagnostics', async () => {
  const fixture = held({ type: 'result', error: { message: 'primary build failure', errors: ['fixture'] } }, { gone: false, survivors: [42], diagnostics: ['unknown identity'] });
  await assert.rejects(packingBuild('/private/compiler', {}, fixture.dependencies), error => error.message === 'primary build failure' && error.teardownUnconfirmed && error.teardownDiagnostics.survivors[0] === 42);
});
test('successful build fails closed on survivors and on timeout', async () => {
  const leak = held(value, { gone: false, survivors: [42] });
  await assert.rejects(packingBuild('/private/compiler', {}, leak.dependencies), error => error.teardownUnconfirmed);
  const timeout = held(value, { gone: true }, { timedOut: true });
  await assert.rejects(packingBuild('/private/compiler', {}, timeout.dependencies), /timed out/);
});
