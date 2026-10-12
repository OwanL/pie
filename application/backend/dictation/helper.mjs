import { realpath } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { verifyPiRuntimeArtifact } from '../../../lib/pi-runtime/artifact.mjs';
import { acquireDevelopmentReader } from '../../../lib/development-runtime/lifetime.mjs';
import { Endpoint, MAX_SAMPLES, PreviewQueue, safeHypothesis, audioLevel } from './engine.mjs';
import { ensureModels } from './models.mjs';
import { createCapture, createCaptureStandby, loadNative } from './native.mjs';
const transcriptionOptions = pcmf32 => ({ pcmf32, language: 'en', n_threads: 4, no_context: true, beam_size: 1, best_of: 1, temperature: 0, print_progress: false, print_realtime: false, print_timestamps: false });
export class DictationHelper {
  context = null;
  vad = null;
  current = null;
  closing = false;
  teardownUncertain = false;
  constructor({ root, cache, emit, models = ensureModels, native = loadNative, capture = createCapture, standby = capture === createCapture ? createCaptureStandby : null }) {
    Object.assign(this, { root, cache, emit, models, native, capture, standbyFactory: standby });
    this.lifetime = new AbortController();
  }
  preparingDetail(detail) {
    const record = this.current;
    if (record && !record.capture && !record.finishing) this.send(record, { kind: 'status', phase: 'preparing', detail });
  }
  prewarm() {
    if (this.closing || this.teardownUncertain) return Promise.reject(new Error('Dictation closed or teardown uncertain'));
    if (!this.warming) {
      this.warming = this.prepare().catch(async error => {
        this.vad?.free(); this.vad = null;
        this.context?.free(); this.context = null;
        try { await this.standby?.shutdown(); }
        catch { this.teardownUncertain = true; }
        this.standby = null;
        this.warming = null;
        throw error;
      });
    }
    return this.warming;
  }
  async prepare() {
    this.standby ??= this.standbyFactory?.(this.root);
    // Observe import failure immediately even while model verification/download runs.
    this.standby?.ready.catch(() => {});
    const [model, vadModel] = await this.models(this.cache, detail => this.preparingDetail(detail), this.lifetime.signal);
    if (this.closing) throw new Error('Dictation closed');
    this.preparingDetail('Initializing Vulkan model');
    this.api = this.native(this.root);
    const devices = this.api.getGpuDevices();
    const candidates = devices.filter(device => /vulkan/i.test(`${device.name} ${device.description}`));
    const gpu = candidates.find(device => /nvidia/i.test(device.description)) ?? candidates.find(device => device.type === 'gpu') ?? candidates[0];
    if (!gpu) throw new Error('Vulkan GPU unavailable; CPU fallback is disabled');
    const context = this.api.createWhisperContext({ model, use_gpu: true, gpu_device: gpu.index, use_coreml: false, use_openvino: false, no_prints: true });
    let vad;
    try {
      vad = this.api.createVadContext({ model: vadModel, n_threads: 1, threshold: 0.5, no_prints: true });
      if (vad.getWindowSamples() !== 512 || vad.getSampleRate() !== 16000) throw new Error('Unsupported native VAD format');
      this.context = context; this.vad = vad;
    } catch (error) { vad?.free(); context.free(); throw error; }
    // Exercise both inference paths with silence, then discard recurrent VAD state.
    this.vad.reset();
    this.vad.process(new Float32Array(512));
    this.vad.reset();
    await this.api.transcribeAsync(this.context, transcriptionOptions(new Float32Array(16000)));
    await this.standby?.ready;
    if (this.closing) throw new Error('Dictation closed');
  }
  send(record, observation) { if (this.current === record && !record.cancelled) this.emit({ token: record.token, observation }); }
  async decode(record, samples, final) {
    const result = await this.api.transcribeAsync(this.context, transcriptionOptions(record.pcm.slice(0, samples)));
    const rawText = result.segments.map(segment => segment.text).join('');
    const text = safeHypothesis(rawText);
    // A rejected model hypothesis is not an empty correction. Keep only the
    // latest bounded, accepted nonempty text for this utterance as fallback.
    if (text !== null && text && text.length <= 32768) record.lastSafeText = text;
    const finalText = final && text === null ? record.lastSafeText : text;
    if (finalText !== null && Buffer.byteLength(JSON.stringify({ token: record.token, observation: { kind: 'transcript', text: finalText, final } }) + '\n') > 65536) throw new Error('Dictation transcript exceeds output byte limit');
    if (final ? finalText !== null : (text !== null && text && !record.finishing)) this.send(record, { kind: 'transcript', text: final ? finalText : text, final });
  }
  async start(token) {
    if (this.current || this.closing || this.teardownUncertain) throw new Error('Dictation already active or teardown uncertain');
    const record = { token, abort: new AbortController(), cancelled: false, finishing: null, capture: null, endpoint: new Endpoint(), pcm: new Float32Array(MAX_SAMPLES), nextPreview: 8000, levelSamples: 0, captureStarted: false, lastSafeText: null };
    this.current = record;
    record.queue = new PreviewQueue(samples => this.decode(record, samples, false).catch(error => {
      record.failureMessage = error?.message === 'Dictation transcript exceeds output byte limit' ? error.message : 'Local dictation failed';
      void this.finish(record, false, true);
    }));
    record.preparing = Promise.race([this.prewarm(), new Promise(resolve => record.abort.signal.addEventListener('abort', resolve, { once: true }))]);
    this.send(record, { kind: 'status', phase: 'preparing' });
    try {
      await record.preparing;
      if (record.cancelled || this.closing || record.finishing) return;
      this.vad.reset(); // Also required before the very first native stream.
      const capture = this.standby ? (_root, ...callbacks) => this.standby.start(...callbacks) : this.capture;
      record.capture = capture(this.root, pcm => {
        if (record.finishing || record.cancelled) return;
        if (!(pcm instanceof Float32Array) || pcm.length !== 512) throw new Error('Invalid capture frame');
        const offset = record.endpoint.samples;
        const available = Math.min(pcm.length, MAX_SAMPLES - offset);
        record.pcm.set(pcm.subarray(0, available), offset);
        const reason = record.endpoint.accept(this.vad.process(pcm), available);
        if (record.captureStarted && !reason) {
          record.levelSamples += available;
          if (record.levelSamples >= 2048) {
            record.levelSamples %= 2048;
            this.send(record, { kind: 'level', level: audioLevel(pcm) });
          }
        }
        if (reason) { void this.finish(record, false); return; }
        if (record.endpoint.admitted && record.endpoint.samples >= record.nextPreview) {
          record.nextPreview = record.endpoint.samples + 8000;
          record.queue.offer(record.endpoint.samples);
        }
      }, () => {
        if (record.finishing || record.cancelled) return;
        record.captureStarted = true;
        this.send(record, { kind: 'status', phase: 'recording' });
      }, () => { void this.finish(record, false, true); });
    } catch (error) {
      if (!record.finishing) {
        if (!record.cancelled) this.send(record, { kind: 'error', message: 'Unable to prepare local dictation' });
        await this.finish(record, true);
      }
    }
  }
  finish(record, cancelled, failed = false) {
    if (cancelled) { record.cancelled = true; record.abort.abort(); }
    if (record.finishing) return record.finishing;
    if (!record.capture) record.abort.abort();
    record.finishing = (async () => {
      try {
        // Release capture BEFORE waiting for preview/final native inference.
        let captureError;
        try { await record.capture?.stop(); }
        catch (error) {
          // A capture failure may still acknowledge successful device release.
          if (error?.teardownConfirmed !== true) this.teardownUncertain = true;
          captureError = error;
        }
        if (!record.cancelled && !failed) this.send(record, { kind: 'status', phase: 'finalizing' });
        await record.preparing.catch(() => {});
        await record.queue.flush(); // Even capture failure must drain native ASR before free.
        if (captureError) throw captureError;
        if (failed) this.send(record, { kind: 'error', message: record.failureMessage ?? 'Local dictation failed' });
        else if (!record.cancelled) {
          if (record.endpoint.admitted) await this.decode(record, record.endpoint.samples, true);
          else this.send(record, { kind: 'transcript', text: '', final: true });
        }
      } catch (error) {
        this.send(record, { kind: 'error', message: error?.message === 'Dictation transcript exceeds output byte limit' ? error.message : 'Local dictation failed' });
      } finally {
        if (record.cancelled) this.emit({ token: record.token, observation: { kind: 'cancelled' } });
        this.emit({ token: record.token, done: true });
        record.pcm = null;
        if (this.current === record) this.current = null;
      }
    })();
    return record.finishing;
  }
  async stop(token, cancel = false) { if (this.current?.token === token) await this.finish(this.current, cancel); }
  async shutdown() {
    this.closing = true;
    this.lifetime.abort();
    if (this.current) await this.finish(this.current, true);
    await this.warming?.catch(() => {});
    try { await this.standby?.shutdown(); }
    catch { this.teardownUncertain = true; }
    this.vad?.free(); this.vad = null;
    this.context?.free(); this.context = null;
    if (this.teardownUncertain) throw new Error('Unconfirmed capture teardown');
  }
}
export async function verifyBootstrap(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16384) throw new Error('Invalid dictation bootstrap');
  const value = JSON.parse(raw);
  if (!Number.isSafeInteger(value.hostPid) || value.hostPid < 1 || !isAbsolute(value.sdkPath) || !isAbsolute(value.packageRoot) || !isAbsolute(value.cache)) throw new Error('Invalid dictation bootstrap');
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const sdk = await realpath(value.sdkPath);
  let root, reader;
  if (value.sdkRuntimeSelection) {
    if (value.sourceArtifactDescriptor || value.sdkRuntimeSelection.kind !== 'workspace-development' || process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK !== '1') throw new Error('Invalid development dictation route');
    const workspace = await realpath(value.sdkRuntimeSelection.workspaceRoot);
    if (!same(sdk, await realpath(resolve(workspace, 'packages/coding-agent')))) throw new Error('Development SDK mismatch');
    root = await realpath(resolve(workspace, '../..'));
    if (!same(root, await realpath(value.packageRoot))) throw new Error('Dictation package root mismatch');
    reader = await acquireDevelopmentReader(workspace);
  } else {
    const descriptor = value.sourceArtifactDescriptor;
    if (!descriptor) throw new Error('Missing dictation runtime descriptor');
    const verified = await verifyPiRuntimeArtifact(descriptor.artifactDir, { target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules } });
    if (verified.identity !== descriptor.identity || !same(sdk, verified.sdkPath)) throw new Error('Dictation runtime mismatch');
    root = await realpath(resolve(verified.sdkPath, '../../..'));
    if (!same(root, await realpath(value.packageRoot))) throw new Error('Dictation package root mismatch');
  }
  return { root, cache: value.cache, hostPid: value.hostPid, reader };
}
export async function runHelper() {
  const { root, cache, hostPid, reader } = await verifyBootstrap(process.argv[2]);
  let outputBlocked = false;
  const helper = new DictationHelper({ root, cache, emit: message => {
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > 65536 || process.stdout.writableLength > 262144) {
      if (!outputBlocked) { outputBlocked = true; void close(); }
      return;
    }
    process.stdout.write(line);
    if (message.done && helper.teardownUncertain) void close();
  } });
  let closing;
  const close = () => {
    if (!closing) {
      process.stdin.pause();
      // Also bound host-death/EOF cleanup when no controller remains to kill us.
      const deadline = setTimeout(() => process.exit(1), 30000);
      closing = helper.shutdown().then(async () => {
        await reader?.release({ teardownConfirmed: !helper.teardownUncertain });
        clearTimeout(deadline); clearInterval(watch); process.stdin.destroy();
      }, () => { process.exit(1); });
    }
    return closing;
  };
  const watch = setInterval(() => {
    try { process.kill(Number(hostPid), 0); } catch { void close(); }
  }, 1000);
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (closing) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 8192) { buffer = ''; void close(); return; }
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const command = JSON.parse(line);
        if (command.kind === 'shutdown') { void close(); return; }
        if (!Number.isSafeInteger(command.token) || command.token < 1) throw new Error('Invalid token');
        if (command.kind === 'prewarm') {
          void helper.prewarm().then(() => true, () => false).then(prepared => {
            if (!closing && !outputBlocked) process.stdout.write(JSON.stringify({ token: command.token, prepared }) + '\n');
          });
        }
        else if (command.kind === 'start') void helper.start(command.token).catch(() => close());
        else if (command.kind === 'stop' || command.kind === 'cancel') void helper.stop(command.token, command.kind === 'cancel');
        else throw new Error('Invalid command');
      } catch { buffer = ''; void close(); return; }
    }
  });
  process.stdin.on('end', () => { void close(); });
  process.stdin.on('error', () => { void close(); });
  process.stdout.on('error', () => { void close(); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void close(); });
  // Runtime/bootstrap verification and input handlers are ready, not the model.
  process.stdout.write(JSON.stringify({ ready: true }) + '\n');
}
