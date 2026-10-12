import test from 'node:test';
import assert from 'node:assert/strict';
import { Endpoint, MAX_SAMPLES, PreviewQueue, safeHypothesis, audioLevel } from '../../dictation/engine.mjs';
import { DictationHelper, verifyBootstrap } from '../../dictation/helper.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('public prewarm is shared and performs no capture or transcript', async () => {
  const f = fixture();
  assert.equal(typeof f.helper.prewarm, 'function');
  const warm = f.helper.prewarm();
  assert.equal(f.helper.prewarm(), warm);
  await warm;
  assert.equal(f.counts().warms, 1);
  assert.deepEqual(f.events, []);
  await f.helper.start(1); await f.helper.stop(1);
  await f.helper.start(2); await f.helper.stop(2);
  assert.equal(f.counts().warms, 1);
  await f.helper.shutdown();
});
test('RMS is normalized and silence endpoint is exact and reset by speech', () => {
  assert.equal(audioLevel(new Float32Array(512)), 0);
  assert.equal(audioLevel(new Float32Array(512).fill(1)), 1);
  assert.equal(audioLevel(new Float32Array(512).fill(2)), 1);
  const endpoint = new Endpoint();
  endpoint.accept(1, 4000);
  assert.equal(endpoint.accept(0, 159999), null);
  assert.equal(endpoint.accept(1, 1), null);
  assert.equal(endpoint.accept(0, 159999), null);
  assert.equal(endpoint.accept(0, 1), 'silence');
});
test('activity starts only after captureStarted, is sample throttled, includes zeros and stops', async () => {
  const f = fixture(); await f.helper.start(1);
  for (let i = 0; i < 4; i++) f.frame(0);
  const levels = () => f.events.filter(e => e.observation?.kind === 'level');
  assert.equal(levels().length, 0);
  f.startCapture();
  for (let i = 0; i < 3; i++) f.frame(0);
  assert.equal(levels().length, 0);
  f.frame(0); assert.equal(levels()[0].observation.level, 0);
  for (let i = 0; i < 4; i++) f.frame(1);
  assert.equal(levels().length, 2);
  assert.ok(levels()[1].observation.level > 0);
  await f.helper.stop(1);
  f.frame(1); f.startCapture();
  assert.equal(levels().length, 2);
  await f.helper.shutdown();
});
test('endpoint requires 250ms continuous speech and ten seconds negative frames', () => {
  const endpoint = new Endpoint();
  for (let i = 0; i < 7; i++) assert.equal(endpoint.accept(1), null);
  assert.equal(endpoint.admitted, false);
  endpoint.accept(0); // reset initial gate
  for (let i = 0; i < 8; i++) endpoint.accept(1);
  assert.equal(endpoint.admitted, true);
  for (let i = 0; i < 312; i++) assert.equal(endpoint.accept(0), null);
  assert.equal(endpoint.accept(0), 'silence');
});
test('initial silence and maximum are sample bounded', () => {
  const endpoint = new Endpoint();
  for (let i = 0; i < 468; i++) assert.equal(endpoint.accept(0), null);
  assert.equal(endpoint.accept(0), 'initial-silence');
  const maximum = new Endpoint();
  maximum.samples = MAX_SAMPLES - 512;
  assert.equal(maximum.accept(1), 'maximum');
});
test('hypotheses permit revisions but reject pathological repeated word runs', () => {
  assert.equal(safeHypothesis('Run the U.S.'), 'Run the U.S.');
  assert.equal(safeHypothesis('Run the unit tests and summary.'), 'Run the unit tests and summary.');
  assert.equal(safeHypothesis('yes '.repeat(12)), null);
  assert.equal(safeHypothesis('x'.repeat(32769)), null);
  assert.equal(safeHypothesis('yes '.repeat(3)), 'yes yes yes');
});
test('preview queue is serial and latest-only; flush waits without a stale replay', async () => {
  let release;
  const seen = [];
  const queue = new PreviewQueue(async value => {
    seen.push(value);
    if (value === 1) await new Promise(resolve => { release = resolve; });
  });
  queue.offer(1); queue.offer(2); queue.offer(3);
  release(); await tick();
  assert.deepEqual(seen, [1, 3]);
  queue.offer(4); await queue.flush(); queue.offer(5);
  assert.deepEqual(seen, [1, 3, 4]);
});
function fixture({ delayed = false, captureFailure = false, transcript, finalTranscript, decodeFailure = false, warmWork, standby } = {}) {
  const events = [], order = [], options = [];
  let frame, started, release;
  let decodes = 0, resets = 0, contexts = 0, warms = 0;
  const api = {
    getGpuDevices: () => [{ index: 0, name: 'Vulkan0', description: 'NVIDIA', type: 'gpu' }],
    createWhisperContext: value => { options.push(value); contexts++; return { free: () => order.push('free') }; },
    createVadContext: value => { options.push(value); return { getWindowSamples: () => 512, getSampleRate: () => 16000, reset: () => { resets++; }, process: pcm => pcm[0], free: () => order.push('vad-free') }; },
    transcribeAsync: async (_context, options) => {
      if (options.pcmf32.length === 16000 && options.pcmf32.every(value => value === 0)) {
        warms++;
        await warmWork?.(warms);
        return { segments: [{ text: 'MUST NEVER EMIT' }] };
      }
      decodes++; order.push('decode');
      if (delayed && decodes === 1) await new Promise(resolve => { release = resolve; });
      if (decodeFailure) throw new Error('native failure');
      return { segments: [{ text: decodes > 1 ? (finalTranscript ?? transcript ?? 'fresh final') : (transcript ?? 'old hypothesis') }] };
    },
  };
  const helper = new DictationHelper({ root: '/unused', cache: '/unused', emit: value => events.push(value), models: async () => ['base', 'vad'], native: () => api,
    standby,
    capture: (_root, onFrame, onStarted) => { frame = onFrame; started = onStarted; return { stop: async () => { order.push('mic-stop'); if (captureFailure) throw Object.assign(new Error('capture exit failed'), { teardownConfirmed: captureFailure === 'confirmed' }); } }; },
  });
  return { helper, events, order, options, startCapture: () => started(), frame: probability => { const pcm = new Float32Array(512); pcm[0] = probability; frame(pcm); }, release: () => release(), counts: () => ({ decodes, resets, contexts, warms }) };
}
test('no microphone before preparation; no-speech returns empty without ASR; context stays warm', async () => {
  const f = fixture();
  await f.helper.start(1);
  assert.equal(f.events.some(event => event.observation?.phase === 'recording'), false);
  f.startCapture();
  assert.equal(f.events.at(-1).observation.phase, 'recording');
  f.frame(0); await f.helper.stop(1);
  assert.equal(f.counts().decodes, 0);
  assert.deepEqual(f.events.at(-2).observation, { kind: 'transcript', text: '', final: true });
  await f.helper.start(2); await f.helper.stop(2);
  assert.deepEqual(f.counts(), { decodes: 0, resets: 4, contexts: 1, warms: 1 });
  assert.equal(f.options[0].use_gpu, true);
  assert.equal(f.options[0].gpu_device, 0);
  assert.equal(f.options[1].n_threads, 1);
  await f.helper.shutdown();
});
for (const repeats of [12, 202]) {
  test(`rejected ${repeats}-word repeated final preserves the accepted preview and final marker`, async () => {
    const f = fixture({ finalTranscript: 'yes '.repeat(repeats) }); await f.helper.start(7);
    for (let i = 0; i < 16; i++) f.frame(1);
    await f.helper.stop(7);
    assert.deepEqual(f.events.at(-2).observation, { kind: 'transcript', text: 'old hypothesis', final: true });
    await f.helper.shutdown();
  });
}
test('genuinely empty final remains empty after a nonempty preview', async () => {
  const f = fixture({ finalTranscript: '' }); await f.helper.start(7);
  for (let i = 0; i < 16; i++) f.frame(1);
  await f.helper.stop(7);
  assert.deepEqual(f.events.at(-2).observation, { kind: 'transcript', text: '', final: true });
  await f.helper.shutdown();
});
test('stop releases mic immediately, waits active preview, then fresh whole-utterance final', async () => {
  const f = fixture({ delayed: true });
  await f.helper.start(7); f.startCapture();
  for (let i = 0; i < 16; i++) f.frame(1);
  assert.equal(f.counts().decodes, 1);
  const stopped = f.helper.stop(7);
  assert.equal(f.order.at(-1), 'mic-stop');
  await tick(); assert.equal(f.counts().decodes, 1);
  f.release(); await stopped;
  assert.deepEqual(f.order, ['decode', 'mic-stop', 'decode']);
  assert.deepEqual(f.events.at(-2).observation, { kind: 'transcript', text: 'fresh final', final: true });
  await f.helper.shutdown();
});
test('cancel rejects in-flight hypotheses and skips final inference', async () => {
  const f = fixture({ delayed: true });
  await f.helper.start(1);
  for (let i = 0; i < 16; i++) f.frame(1);
  const stopped = f.helper.stop(1, true);
  f.release(); await stopped;
  assert.equal(f.counts().decodes, 1);
  assert.equal(f.events.some(event => event.observation?.kind === 'transcript'), false);
  assert.equal(f.events.at(-2).observation.kind, 'cancelled');
  await f.helper.shutdown();
});
test('shutdown drains native work before freeing contexts and stops microphone first', async () => {
  const f = fixture({ delayed: true }); await f.helper.start(1);
  for (let i = 0; i < 16; i++) f.frame(1);
  const shutdown = f.helper.shutdown();
  assert.equal(f.order.at(-1), 'mic-stop');
  await tick(); assert.equal(f.order.includes('free'), false);
  f.release(); await shutdown;
  assert.deepEqual(f.order, ['decode', 'mic-stop', 'vad-free', 'free']);
});
test('capture teardown failure still drains active ASR and reports uncertain lifetime', async () => {
  const f = fixture({ delayed: true, captureFailure: true }); await f.helper.start(1);
  for (let i = 0; i < 16; i++) f.frame(1);
  const stop = f.helper.stop(1);
  await tick(); assert.equal(f.helper.current !== null, true);
  assert.equal(f.order.includes('free'), false);
  f.release(); await stop;
  assert.equal(f.events.at(-2).observation.kind, 'error');
  await assert.rejects(f.helper.shutdown(), /Unconfirmed capture teardown/);
});
test('confirmed device release preserves the warm helper after capture failure', async () => {
  const f = fixture({ captureFailure: 'confirmed' });
  await f.helper.start(1); await f.helper.stop(1);
  assert.equal(f.events.at(-2).observation.kind, 'error');
  assert.equal(f.helper.teardownUncertain, false);
  await f.helper.start(2); await f.helper.stop(2);
  assert.equal(f.counts().contexts, 1);
  assert.equal(f.counts().warms, 1);
  await f.helper.shutdown();
});
test('preparation cancellation never starts capture', async () => {
  let captured = false;
  const events = [];
  const helper = new DictationHelper({ root: '/unused', cache: '/unused', emit: value => events.push(value),
    models: async (_cache, _notice, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }), native: () => { throw new Error('must not import'); }, capture: () => { captured = true; },
  });
  const starting = helper.start(1);
  await helper.stop(1, true); await starting;
  assert.equal(captured, false);
  assert.equal(events.some(value => value.observation?.kind === 'error'), false);
  assert.equal(events.at(-2).observation.kind, 'cancelled');
  await helper.shutdown();
});
test('silence autoendpoint releases capture and does not call ASR', async () => {
  const f = fixture(); await f.helper.start(1);
  for (let i = 0; i < 469; i++) f.frame(0);
  await tick(); await tick();
  assert.equal(f.helper.current, null);
  assert.equal(f.counts().decodes, 0);
  assert.equal(f.order[0], 'mic-stop');
  await f.helper.shutdown();
});
for (const transcript of ['漢'.repeat(32768), '\\'.repeat(32768)]) {
  test('oversized serialized final produces terminal error and done', async () => {
    const f = fixture({ transcript }); await f.helper.start(1);
    for (let i = 0; i < 8; i++) f.frame(1);
    await f.helper.stop(1);
    assert.deepEqual(f.events.at(-2).observation, { kind: 'error', message: 'Dictation transcript exceeds output byte limit' });
    assert.deepEqual(f.events.at(-1), { token: 1, done: true });
    assert.equal(f.helper.current, null);
    await f.helper.shutdown();
  });
}
test('final native failure settles and permits another recording', async () => {
  const f = fixture({ decodeFailure: true }); await f.helper.start(1);
  for (let i = 0; i < 8; i++) f.frame(1);
  await f.helper.stop(1);
  assert.equal(f.events.at(-2).observation.kind, 'error');
  await f.helper.start(2); await f.helper.stop(2); await f.helper.shutdown();
});
test('cold cancel settles promptly but shares the pending warm with later capture', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ warmWork: () => gate });
  const first = f.helper.start(1);
  await tick();
  await f.helper.stop(1, true); await first;
  assert.equal(f.helper.current, null);
  const second = f.helper.start(2);
  await tick();
  assert.equal(f.counts().warms, 1);
  assert.equal(f.events.some(e => e.observation?.phase === 'recording'), false);
  release(); await second;
  f.startCapture();
  assert.equal(f.events.at(-1).token, 2);
  await f.helper.stop(2); await f.helper.shutdown();
});
test('cold stop does not abort lifetime model work and shutdown does', async () => {
  let signal;
  const events = [];
  const helper = new DictationHelper({ root: '/unused', cache: '/unused', emit: event => events.push(event),
    models: (_cache, notice, lifetimeSignal) => {
      signal = lifetimeSignal;
      notice('verifying');
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }, capture: () => { throw new Error('must not capture'); }, native: () => { throw new Error('must not load'); },
  });
  const starting = helper.start(1);
  await helper.stop(1); await starting;
  assert.equal(signal.aborted, false);
  assert.deepEqual(events.at(-2).observation, { kind: 'transcript', text: '', final: true });
  await helper.shutdown();
  assert.equal(signal.aborted, true);
});
test('shutdown drains cold synthetic inference before freeing and never captures', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ warmWork: () => gate });
  const starting = f.helper.start(1);
  await tick();
  let closed = false;
  const shutdown = f.helper.shutdown().then(() => { closed = true; });
  await starting; await tick();
  assert.equal(closed, false);
  assert.equal(f.order.includes('free'), false);
  release(); await shutdown;
  assert.deepEqual(f.order, ['vad-free', 'free']);
  assert.equal(f.events.some(e => e.observation?.phase === 'recording'), false);
});
test('synthetic warm failure frees contexts and permits one GPU-only retry', async () => {
  const f = fixture({ warmWork: attempt => { if (attempt === 1) throw new Error('private native detail'); } });
  await assert.rejects(f.helper.prewarm());
  assert.deepEqual(f.order, ['vad-free', 'free']);
  await f.helper.prewarm();
  assert.equal(f.counts().contexts, 2);
  assert.equal(f.counts().warms, 2);
  assert.equal(f.options.filter(o => 'use_gpu' in o).every(o => o.use_gpu), true);
  assert.deepEqual(f.events, []);
  await f.helper.shutdown();
});
test('prewarm awaits injected standby readiness and shutdown confirmation', async () => {
  let ready, drained, starts = 0, factories = 0;
  const readiness = new Promise(resolve => { ready = resolve; });
  const drain = new Promise(resolve => { drained = resolve; });
  const f = fixture({ standby: () => {
    factories++;
    return { ready: readiness, start: () => { starts++; return { stop: async () => {} }; }, shutdown: () => drain };
  } });
  let prepared = false;
  const warming = f.helper.prewarm().then(() => { prepared = true; });
  await tick(); assert.equal(prepared, false); assert.equal(starts, 0);
  ready(); await warming;
  await f.helper.start(1); await f.helper.stop(1);
  await f.helper.start(2); await f.helper.stop(2);
  assert.equal(factories, 1); assert.equal(starts, 2);
  let closed = false;
  const shutdown = f.helper.shutdown().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  drained(); await shutdown;
});
test('child rejects oversized or invalid startup before native loading', async () => {
  await assert.rejects(verifyBootstrap('x'.repeat(16385)), /bootstrap/);
  await assert.rejects(verifyBootstrap(JSON.stringify({ hostPid: 0 })), /bootstrap/);
});
