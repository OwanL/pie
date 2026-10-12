import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { acquireDevelopmentReader, type DevelopmentReader } from '../../../lib/development-runtime/lifetime.mjs';
import { verifyPiRuntimeArtifact } from '../../../lib/pi-runtime/artifact.mjs';
import type { BackendLaunchPaths } from '../../lib/platform-contracts/session-platform.js';
import type { DictationObservation } from '../../lib/protocol/dictation.js';
export interface DictationServiceOptions {
  resolveLaunch: () => Promise<BackendLaunchPaths>;
  helperScript: string;
  cacheDirectory: string;
}
interface Recording {
  id: string;
  token: number;
  observe: (observation: DictationObservation) => void;
  terminal: boolean;
  preparationTimer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  settle: () => void;
}
function observation(value: unknown): value is DictationObservation {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.kind === 'level') return typeof v.level === 'number' && Number.isFinite(v.level) && v.level >= 0 && v.level <= 1;
  if (v.kind === 'cancelled') return true;
  if (v.kind === 'error') return typeof v.message === 'string' && v.message.length <= 1024;
  if (v.kind === 'transcript') return typeof v.text === 'string' && v.text.length <= 32768 && typeof v.final === 'boolean';
  return v.kind === 'status' && ['preparing', 'recording', 'finalizing'].includes(String(v.phase)) && (v.detail === undefined || (typeof v.detail === 'string' && v.detail.length <= 1024));
}
export class DictationService {
  private child?: ChildProcessWithoutNullStreams;
  private launching?: Promise<void>;
  private reader?: DevelopmentReader;
  private ready?: { resolve: () => void; reject: (error: Error) => void };
  private warm?: { token: number; resolve: () => void; reject: (error: Error) => void };
  private warming?: Promise<void>;
  private prepared = false;
  private recording?: Recording;
  private sequence = 0;
  private closing = false;
  private forced = false;
  private killing = false;
  private exit?: Promise<void>;
  private closeTask?: Promise<void>;
  constructor(private readonly options: DictationServiceOptions) {}
  isLifetimeTeardownConfirmed(): boolean { return !this.child && !this.launching && !this.forced; }
  private async launch(): Promise<void> {
    const launch = await this.options.resolveLaunch();
    let packageRoot: string;
    if (!isAbsolute(launch.nodePath) || !isAbsolute(launch.sdkPath)) throw new Error('Dictation requires resolved absolute runtime paths');
    if (launch.sdkRuntimeSelection && launch.sourceArtifactDescriptor) throw new Error('Conflicting dictation runtime routes');
    if (launch.sdkRuntimeSelection) {
      if (process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK !== '1') throw new Error('Development SDK requires explicit opt-in');
      const root = await realpath(launch.sdkRuntimeSelection.workspaceRoot);
      const expected = await realpath(resolve(root, 'packages/coding-agent'));
      if ((await realpath(launch.sdkPath)).toLowerCase() !== expected.toLowerCase()) throw new Error('Development SDK selection mismatch');
      this.reader ??= await acquireDevelopmentReader(root);
      packageRoot = await realpath(resolve(root, '../..')); // repository root above harness/pi
    } else {
      const descriptor = launch.sourceArtifactDescriptor;
      if (!descriptor) throw new Error('Verified production runtime descriptor required for dictation');
      // resolveLaunch is the host's verified standalone-Node resolver; the host
      // process may have an Electron ABI different from that selected Node.
      const verified = await verifyPiRuntimeArtifact(descriptor.artifactDir, { target: descriptor.manifest.target });
      const actualSdk = await realpath(launch.sdkPath);
      const sameSdk = process.platform === 'win32' ? actualSdk.toLowerCase() === verified.sdkPath.toLowerCase() : actualSdk === verified.sdkPath;
      if (verified.identity !== descriptor.identity || !sameSdk) throw new Error('Dictation runtime artifact mismatch');
      packageRoot = await realpath(resolve(verified.sdkPath, '../../..'));
    }
    if (this.closing) return;
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())) delete env[key];
    }
    const bootstrap = JSON.stringify({ packageRoot, cache: this.options.cacheDirectory, hostPid: process.pid, sdkPath: launch.sdkPath, sourceArtifactDescriptor: launch.sourceArtifactDescriptor, sdkRuntimeSelection: launch.sdkRuntimeSelection });
    if (Buffer.byteLength(bootstrap) > 16384) throw new Error('Dictation startup bootstrap too large');
    const child = spawn(launch.nodePath, [this.options.helperScript, bootstrap], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    this.child = child;
    const readiness = new Promise<void>((resolveReady, reject) => { this.ready = { resolve: resolveReady, reject }; });
    void readiness.catch(() => {});
    let buffer = '';
    let stderrBytes = 0;
    this.exit = new Promise(resolveExit => {
      child.once('close', (code, signal) => {
        if (code !== 0 || signal) this.forced = true;
        this.ready?.reject(new Error('Local dictation helper exited')); this.ready = undefined;
        this.warm?.reject(new Error('Local dictation helper exited')); this.warm = undefined;
        this.prepared = false;
        if (this.child === child) this.child = undefined;
        if (this.recording) this.clearPreparation(this.recording);
        if (this.recording && !this.closing) this.deliver(this.recording, { kind: 'error', message: 'Local dictation helper exited' });
        this.recording?.settle(); this.recording = undefined;
        resolveExit();
      });
    });
    child.on('error', () => { this.forced = true; this.fail('Local dictation helper failed'); });
    child.stdin.on('error', () => { this.fail('Local dictation helper input failed'); });
    child.stderr.on('data', (chunk: Buffer) => {
      // Drain without logging native output (it may contain sensitive text).
      stderrBytes += chunk.length;
      if (stderrBytes > 1024 * 1024) this.killOwned();
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          if (Buffer.byteLength(line + '\n') > 65536) throw new Error('Oversized observation');
          const message = JSON.parse(line) as { ready?: boolean; token: number; prepared?: boolean; observation?: unknown; done?: boolean };
          if (this.closing) continue;
          if (message.ready === true && message.token === undefined && message.observation === undefined && message.done === undefined && message.prepared === undefined) {
            this.ready?.resolve(); this.ready = undefined; continue;
          }
          if (Number.isSafeInteger(message.token) && message.token > 0 && typeof message.prepared === 'boolean' && message.observation === undefined && message.done === undefined) {
            if (this.warm?.token === message.token) {
              const warm = this.warm; this.warm = undefined;
              if (message.prepared) { this.prepared = true; warm.resolve(); }
              else warm.reject(new Error('Local dictation preparation failed'));
            }
            continue;
          }
          if (!Number.isSafeInteger(message.token) || message.token < 1
            || (message.done !== undefined && message.done !== true)
            || (message.done === true ? message.observation !== undefined : !observation(message.observation))) throw new Error('Invalid observation');
          const record = this.recording;
          if (!record || message.token !== record.token) continue;
          if (message.done === true) { this.clearPreparation(record); record.settle(); this.recording = undefined; }
          else this.deliver(record, message.observation as DictationObservation);
        } catch { buffer = ''; this.fail('Invalid dictation helper output'); return; }
      }
      if (Buffer.byteLength(buffer) > 65536) { buffer = ''; this.fail('Invalid dictation helper output'); }
    });
    await readiness;
  }
  private ensureLaunched(): Promise<void> {
    if (!this.launching && !this.child) {
      const work = this.launch().finally(async () => {
        if (this.closing && !this.child && this.reader) {
          await this.reader.release({ teardownConfirmed: !this.forced });
          if (!this.forced) this.reader = undefined;
        }
      });
      this.launching = work;
      void work.finally(() => { if (this.launching === work) this.launching = undefined; }).catch(() => {});
    }
    return this.launching ? this.bounded(this.launching) : Promise.resolve();
  }
  prewarm(): Promise<void> {
    if (this.closing || this.forced) return Promise.reject(new Error('Dictation is unavailable'));
    if (this.warming) return this.warming;
    if (this.prepared || this.recording) return Promise.resolve();
    const work = (async () => {
      await this.ensureLaunched();
      if (this.closing) throw new Error('Dictation is unavailable');
      if (this.recording || this.prepared) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolveWarm, reject) => {
          const token = ++this.sequence;
          this.warm = { token, resolve: resolveWarm, reject };
          timer = setTimeout(() => { this.fail('Local dictation preparation deadline exceeded'); }, 390000);
          try { this.send('prewarm', token); } catch { this.fail('Local dictation helper input failed'); }
        });
      } finally { clearTimeout(timer); this.warm = undefined; }
    })();
    this.warming = work;
    void work.finally(() => { if (this.warming === work) this.warming = undefined; }).catch(() => {});
    return work;
  }
  private send(kind: string, token?: number): void {
    const child = this.child;
    if (!child || child.stdin.destroyed || child.stdin.writableLength > 8192) throw new Error('Dictation helper unavailable');
    child.stdin.write(JSON.stringify({ kind, token }) + '\n');
  }
  private clearPreparation(record: Recording): void {
    clearTimeout(record.preparationTimer);
    record.preparationTimer = undefined;
  }
  private deliver(record: Recording, value: DictationObservation): void {
    if (this.closing || record.terminal) return;
    if (value.kind !== 'level' && (value.kind !== 'status' || value.phase !== 'preparing')) this.clearPreparation(record);
    if (value.kind === 'status' && value.phase === 'finalizing') {
      record.preparationTimer = setTimeout(() => {
        if (this.recording === record) this.fail('Local dictation finalization deadline exceeded');
      }, 30000);
    }
    if (value.kind === 'cancelled' || value.kind === 'error' || (value.kind === 'transcript' && value.final)) record.terminal = true;
    try { record.observe(value); } catch { this.killOwned(); }
  }
  private fail(message: string): void {
    this.ready?.reject(new Error(message)); this.ready = undefined;
    this.warm?.reject(new Error(message)); this.warm = undefined;
    this.child?.stdout.pause();
    if (this.recording) this.deliver(this.recording, { kind: 'error', message });
    this.killOwned();
  }
  private killOwned(): void {
    const child = this.child;
    if (!child || this.killing) return;
    this.killing = true;
    this.forced = true;
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill('SIGKILL'); });
      killer.once('exit', code => { if (code !== 0) child.kill('SIGKILL'); });
    } else child.kill('SIGKILL');
  }
  async start(recordingId: string, observe: (obs: DictationObservation) => void): Promise<void> {
    if (this.closing || this.forced) throw new Error('Dictation is unavailable or already active');
    const previous = this.recording;
    if (previous) {
      if (previous.id === recordingId || !previous.terminal) throw new Error('Dictation is unavailable or already active');
      await this.bounded(previous.done);
      if (this.closing || this.forced || this.recording) throw new Error('Dictation is unavailable or already active');
    }
    let settle!: () => void;
    const done = new Promise<void>(resolveDone => { settle = resolveDone; });
    const record: Recording = { id: recordingId, token: ++this.sequence, observe, terminal: false, done, settle };
    this.recording = record;
    try {
      await this.ensureLaunched();
      if (this.closing || this.recording !== record) return;
      this.send('start', record.token);
      // Fixed wall-clock allowance: two 180s downloads plus native context initialization.
      record.preparationTimer = setTimeout(() => {
        if (this.recording === record) this.fail('Local dictation preparation deadline exceeded');
      }, 390000);
    } catch (error) {
      if (this.recording === record) this.recording = undefined;
      this.clearPreparation(record);
      record.settle();
      if (!this.launching && !this.child && this.reader) { await this.reader.release({ teardownConfirmed: !this.forced }); if (!this.forced) this.reader = undefined; }
      throw error;
    }
  }
  private async finish(id: string, cancel: boolean): Promise<void> {
    const record = this.recording;
    if (!record || record.id !== id) return;
    if (this.launching) await this.bounded(this.launching);
    if (this.closing || this.recording !== record) return;
    this.clearPreparation(record);
    try { this.send(cancel ? 'cancel' : 'stop', record.token); }
    catch (error) { this.killOwned(); await this.bounded(this.exit!); throw error; }
    await this.bounded(record.done);
  }
  stop(id: string): Promise<void> { return this.finish(id, false); }
  cancel(id: string): Promise<void> { return this.finish(id, true); }
  private async bounded(work: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired: boolean;
    try {
      expired = await Promise.race([work.then(() => false), new Promise<boolean>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(true), 30000); })]);
    } finally { if (timer) clearTimeout(timer); }
    if (expired) {
      if (this.recording) this.deliver(this.recording, { kind: 'error', message: 'Local dictation deadline exceeded' });
      this.closing = true; // Pending opaque I/O must never spawn after its caller times out.
      this.killOwned();
      // Never claim teardown merely because an owned kill was requested.
      await Promise.race([this.exit, new Promise<void>(resolveWait => { const wait = setTimeout(resolveWait, 5000); wait.unref(); })]);
      throw new Error('Dictation teardown deadline exceeded');
    }
  }
  shutdown(): Promise<void> {
    return this.closeTask ??= (async () => {
      this.closing = true;
      this.warm?.reject(new Error('Dictation is unavailable')); this.warm = undefined;
      this.ready?.reject(new Error('Dictation is unavailable')); this.ready = undefined;
      try {
        if (this.recording) this.clearPreparation(this.recording);
        if (this.launching) await this.bounded(this.launching.catch(() => {}));
        if (this.child) {
          try { this.send('shutdown'); } catch { this.killOwned(); }
          await this.bounded(this.exit!);
        }
        else { this.recording?.settle(); this.recording = undefined; }
      } finally {
        await this.reader?.release({ teardownConfirmed: this.isLifetimeTeardownConfirmed() });
        if (this.isLifetimeTeardownConfirmed()) this.reader = undefined;
      }
    })();
  }
}
