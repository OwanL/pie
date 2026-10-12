import { createRequire } from 'node:module';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { realpathSync, readFileSync, existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
// Loaded only by the standalone Node helper, never by the host/Electron process.
export function loadNative(packageRoot) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Dictation requires the qualified Windows x64 Vulkan package');
  const root = realpathSync(packageRoot);
  const require = createRequire(join(root, 'package.json'));
  const resolved = realpathSync(require.resolve('whisper-cpp-node'));
  const local = relative(root, resolved);
  if (local.startsWith('..') || isAbsolute(local)) throw new Error('Dictation native dependency resolved outside selected package root');
  const wrapperRoot = dirname(dirname(resolved));
  if (JSON.parse(readFileSync(join(wrapperRoot, 'package.json'), 'utf8')).version !== '0.2.12') throw new Error('Unqualified whisper wrapper version');
  const wrapperRequire = createRequire(resolved);
  const binary = realpathSync(wrapperRequire.resolve('@whisper-cpp-node/win32-x64/whisper.node'));
  const binaryLocal = relative(root, binary);
  if (binaryLocal.startsWith('..') || isAbsolute(binaryLocal)) throw new Error('Whisper binary outside selected package root');
  if (JSON.parse(readFileSync(join(dirname(binary), 'package.json'), 'utf8')).version !== '0.2.11') throw new Error('Unqualified whisper binary version');
  // The published wrapper tries monorepo workspace binaries before its npm
  // optional dependency. Refuse that alternate toolchain route entirely.
  for (const workspace of [join(wrapperRoot, '..', 'win32-x64/whisper.node'), join(wrapperRoot, '../..', 'win32-x64/whisper.node')]) {
    if (existsSync(workspace)) throw new Error('Whisper workspace binary fallback is not allowed');
  }
  return require(resolved);
}
const captureSource = `
const {parentPort,workerData}=require('node:worker_threads');
const {createRequire}=require('node:module');
const {join,dirname,relative,isAbsolute}=require('node:path');
const {realpathSync,readFileSync}=require('node:fs');
let PvRecorder, active;
const send=(kind,token,message,teardownConfirmed)=>parentPort.postMessage({kind,token,message,teardownConfirmed});
async function capture(token){
 const state={token,stopping:false,ack:null};active=state;
 let recorder,failed=false,teardownConfirmed=true;
 try{
  recorder=new PvRecorder(512,-1,50);
  if(recorder.sampleRate!==16000)throw new Error('Unsupported capture sample rate');
  recorder.start();send('started',token);
  while(!state.stopping){
   const input=recorder.readSync();
   if(input.length!==512)throw new Error('Invalid capture frame');
   const pcm=new Float32Array(512);
   for(let i=0;i<512;i++)pcm[i]=input[i]/32768;
   const waiting=new Promise(resolve=>{state.ack=resolve;});
   parentPort.postMessage({kind:'frame',token,pcm},[pcm.buffer]);
   await waiting;
   await new Promise(resolve=>setImmediate(resolve));
  }
 }catch{failed=true;send('error',token,'Microphone capture failed');}
 finally{
  if(recorder){try{recorder.stop();}catch{failed=true;teardownConfirmed=false;}try{recorder.release();}catch{failed=true;teardownConfirmed=false;}}
  active=null;send('stopped',token,failed?'Microphone capture failed':undefined,teardownConfirmed);
 }
}
parentPort.on('message',message=>{
 if(message.kind==='start'){
  if(active){send('error',message.token,'Capture already active');return;}
  void capture(message.token);
 }
 if(active&&message.token===active.token){
  if(message.kind==='stop')active.stopping=true;
  if((message.kind==='stop'||message.kind==='ack')&&active.ack){active.ack();active.ack=null;}
 }
 if(message.kind==='close'&&!active)parentPort.close();
});
try{
 const root=realpathSync(workerData.root);
 const nativeRequire=createRequire(join(root,'package.json'));
 const resolved=realpathSync(nativeRequire.resolve('@picovoice/pvrecorder-node'));
 const local=relative(root,resolved);
 if(local.startsWith('..')||isAbsolute(local))throw new Error('Capture dependency outside selected package root');
 const version=JSON.parse(readFileSync(join(dirname(dirname(resolved)),'package.json'),'utf8')).version;
 if(version!=='1.2.9')throw new Error('Unqualified capture package version');
 ({PvRecorder}=nativeRequire(resolved));
 if(typeof PvRecorder!=='function')throw new Error('Invalid capture binding');
 send('ready');
}catch{send('bootError',undefined,'Capture preparation failed');parentPort.close();}
`;

export function createCaptureStandby(root) {
  const worker = new Worker(captureSource, { eval: true, workerData: { root } });
  let readyResolve, readyReject, exitResolve;
  let failure, active, sequence = 0, closing = false, exited = false, shutdownPromise;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  const exit = new Promise(resolve => { exitResolve = resolve; });
  function notify(state, error) {
    if (!(error instanceof Error)) error = new Error(String(error));
    state.failure ??= error;
    try { state.onError(error); } catch { /* Callback errors cannot interrupt teardown. */ }
  }
  function fail(error) {
    failure ??= error;
    readyReject(error);
    if (active) { notify(active, error); active.reject(error); active = undefined; }
  }
  worker.on('error', fail);
  worker.on('exit', code => {
    exited = true;
    if (!closing || code !== 0) fail(new Error('Capture worker exit failed'));
    exitResolve();
  });
  worker.on('message', message => {
    if (message.kind === 'ready') { readyResolve(); return; }
    if (message.kind === 'bootError') { fail(new Error(message.message)); return; }
    const state = active;
    if (!state || message.token !== state.token) return;
    if (message.kind === 'error') { notify(state, new Error(message.message)); state.stop(); }
    if (message.kind === 'stopped') {
      active = undefined;
      if (message.message) state.failure ??= new Error(message.message);
      if (message.teardownConfirmed !== true) {
        state.failure ??= new Error('Capture stop was not confirmed');
        failure ??= state.failure;
      } else if (state.failure) {
        state.failure.teardownConfirmed = true;
      }
      if (state.failure) state.reject(state.failure); else state.resolve();
      return;
    }
    try {
      if (!state.stopping && message.kind === 'started') state.onStarted();
      if (!state.stopping && message.kind === 'frame') state.onFrame(message.pcm);
    } catch (error) { notify(state, error); state.stop(); }
    finally { if (message.kind === 'frame') worker.postMessage({ kind: 'ack', token: state.token }); }
  });
  function start(onFrame, onStarted, onError) {
    if (closing || failure || exited) throw failure ?? new Error('Capture standby is closed');
    if (active) throw new Error('Capture already active');
    const state = { token: ++sequence, onFrame, onStarted, onError, stopping: false };
    const stopped = new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; });
    stopped.catch(() => {});
    state.stop = () => {
      if (!state.stopping) {
        state.stopping = true;
        worker.postMessage({ kind: 'stop', token: state.token });
        state.timer = setTimeout(() => {
          const error = new Error('Capture stop was not confirmed');
          fail(error);
          void worker.terminate();
        }, 5000);
        stopped.finally(() => clearTimeout(state.timer)).catch(() => {});
      }
      return stopped;
    };
    active = state;
    // Worker messages are ordered: an immediate stop follows this start even during boot.
    worker.postMessage({ kind: 'start', token: state.token });
    return { stop: state.stop };
  }
  function shutdown() {
    if (!shutdownPromise) shutdownPromise = (async () => {
      closing = true;
      let error;
      const timer = setTimeout(() => {
        fail(new Error('Capture worker shutdown was not confirmed'));
        void worker.terminate();
      }, 5000);
      try { if (active) await active.stop(); await ready; } catch (caught) { error = caught; }
      if (!exited) worker.postMessage({ kind: 'close' });
      await exit;
      clearTimeout(timer);
      if (error || failure) throw error ?? failure;
    })();
    shutdownPromise.catch(() => {});
    return shutdownPromise;
  }
  return { ready, start, shutdown };
}

export function createCapture(root, onFrame, onStarted, onError) {
  const standby = createCaptureStandby(root);
  const capture = standby.start(onFrame, onStarted, onError);
  return { async stop() {
    try { await capture.stop(); } finally { await standby.shutdown(); }
  } };
}
