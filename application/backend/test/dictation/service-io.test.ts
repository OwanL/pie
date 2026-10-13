import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DictationService } from '../../dictation/service.js';
import type { DictationObservation } from '../../../lib/protocol/dictation.js';
async function fixture(t: { after: (callback: () => unknown) => void }, code: string) {
  const directory = await mkdtemp(join(tmpdir(), 'pie-dictation-io-'));
  const sdkPath = join(directory, 'packages/coding-agent');
  await mkdir(sdkPath, { recursive: true });
  const helperScript = join(directory, 'helper.cjs');
  await writeFile(helperScript, code);
  const previous = process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK;
  process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK = '1';
  t.after(async () => {
    if (previous === undefined) delete process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK;
    else process.env.PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const service = new DictationService({ helperScript, cacheDirectory: directory,
    resolveLaunch: async () => ({ nodePath: process.execPath, sdkPath, sdkRuntimeSelection: { kind: 'workspace-development', workspaceRoot: directory } }),
  });
  t.after(() => service.shutdown().catch(() => {}));
  return { service, directory, readers: join(directory, '.cache/development-runtime/readers') };
}
async function received(path: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8'); } catch { /* Wait for the helper to create the acknowledgement file. */ }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`Helper did not acknowledge ${path}`);
}

test('pending launch is bounded without falsely confirming teardown or spawning late', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveLaunch!: (value: never) => void;
  const pending = new Promise<never>(resolve => { resolveLaunch = resolve; });
  const service = new DictationService({ helperScript: 'unused', cacheDirectory: 'unused', resolveLaunch: () => pending });
  const observations: DictationObservation[] = [];
  const started = assert.rejects(service.start('pending', value => observations.push(value)), /deadline/);
  t.mock.timers.tick(30000);
  await started;
  assert.equal(service.isLifetimeTeardownConfirmed(), false);
  const shutdown = assert.rejects(service.shutdown(), /deadline/);
  t.mock.timers.tick(30000);
  await shutdown;
  assert.equal(service.isLifetimeTeardownConfirmed(), false);
  const count = observations.length;
  // Actual resolution fails validation before spawn, but must clear the pending fence.
  resolveLaunch({ nodePath: 'relative', sdkPath: 'relative' } as never);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(service.isLifetimeTeardownConfirmed(), true);
  assert.equal(observations.length, count);
});
const fakeHelper = `
const readline=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
send({ready:true});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);
 if(c.kind==='shutdown')process.exit(0);
 if(c.kind==='start'){
  send({token:c.token+1000,observation:{kind:'transcript',text:'stale',final:false}});
  send({token:c.token,observation:{kind:'status',phase:'recording'}});
 }
 if(c.kind==='stop'||c.kind==='cancel'){
  send({token:c.token,observation:c.kind==='cancel'?{kind:'cancelled'}:{kind:'transcript',text:'fresh',final:true}});
  send({token:c.token,done:true});
 }
});`;
const gatedWarmHelper = `
const fs=require('node:fs'),path=require('node:path');
const cache=JSON.parse(process.argv[2]).cache;
let warmToken;
` + fakeHelper.replace("if(c.kind==='start'){", `
 if(c.kind==='prewarm'){warmToken=c.token;fs.writeFileSync(path.join(cache,'warm'),String(c.token));}
 if(c.kind==='cancel')send({token:warmToken,prepared:true});
 if(c.kind==='start')fs.writeFileSync(path.join(cache,'start'),String(c.token));
 if(c.kind==='start'){
`);
test('prewarm coalesces, remains private, and an early click queues without awaiting warm', async t => {
  const { service, directory } = await fixture(t, gatedWarmHelper);
  const warm = service.prewarm();
  let settled = false;
  void warm.then(() => { settled = true; });
  assert.equal(service.prewarm(), warm);
  const warmToken = Number(await received(join(directory, 'warm')));
  const values: DictationObservation[] = [];
  await service.start('early', value => values.push(value));
  const startToken = Number(await received(join(directory, 'start')));
  assert.equal(startToken, warmToken + 1);
  assert.equal(settled, false);
  await service.cancel('early'); // The helper releases its warm gate only on cancel.
  await warm;
  assert.equal(values.some(value => !['status', 'cancelled'].includes(value.kind)), false);
  assert.equal(values.at(-1)?.kind, 'cancelled');
  await service.prewarm();
});
test('private prewarm actually sent has a 390s watchdog and retains its reader fence', async t => {
  const { service, directory, readers } = await fixture(t, gatedWarmHelper);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warm = service.prewarm();
  const rejected = assert.rejects(warm, /preparation deadline exceeded/);
  await received(join(directory, 'warm'));
  let settled = false;
  void warm.catch(() => { settled = true; });
  t.mock.timers.tick(389999);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal((await readdir(readers)).length, 1);
  t.mock.timers.tick(1);
  await rejected;
  await service.shutdown();
  assert.equal(service.isLifetimeTeardownConfirmed(), false);
  assert.equal((await readdir(readers)).length, 1);
  await assert.rejects(readFile(join(directory, 'start')), /ENOENT/);
});
test('shutdown during private warm ignores late prepared/ready replies without callbacks or watchdogs', async t => {
  const helper = gatedWarmHelper.replace("if(c.kind==='shutdown')process.exit(0);", `if(c.kind==='shutdown'){
    send({token:warmToken,prepared:true});send({ready:true});
    send({token:warmToken+1,observation:{kind:'transcript',text:'late',final:true}});
    setTimeout(()=>process.exit(0),10);return;
  }`);
  const { service, directory, readers } = await fixture(t, helper);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warm = service.prewarm();
  const rejected = assert.rejects(warm, /unavailable/);
  await received(join(directory, 'warm'));
  const values: DictationObservation[] = [];
  await service.start('closing', value => values.push(value));
  await received(join(directory, 'start'));
  const count = values.length;
  await service.shutdown();
  await rejected;
  assert.equal((service as unknown as { prepared: boolean }).prepared, false);
  t.mock.timers.tick(390000);
  assert.equal(values.length, count);
  assert.equal(service.isLifetimeTeardownConfirmed(), true);
  assert.equal((await readdir(readers)).length, 0);
  await assert.rejects(service.prewarm(), /unavailable/);
});
test('shutdown fences a pending opaque prewarm launch and its late resolution', async t => {
  let resolveLaunch!: (value: never) => void;
  const pending = new Promise<never>(resolve => { resolveLaunch = resolve; });
  const service = new DictationService({ helperScript: 'unused', cacheDirectory: 'unused', resolveLaunch: () => pending });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warm = assert.rejects(service.prewarm(), /deadline/);
  const shutdown = assert.rejects(service.shutdown(), /deadline/);
  t.mock.timers.tick(30000);
  await Promise.all([warm, shutdown]);
  assert.equal(service.isLifetimeTeardownConfirmed(), false);
  resolveLaunch({ nodePath: 'relative', sdkPath: 'relative' } as never);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(390000);
  assert.equal(service.isLifetimeTeardownConfirmed(), true);
  await assert.rejects(service.prewarm(), /unavailable/);
});
test('partial private warm reply resolves idempotently without a recording', async t => {
  const { service } = await fixture(t, fakeHelper.replace("if(c.kind==='start'){", `if(c.kind==='prewarm'){
    const frame=JSON.stringify({token:c.token,prepared:true})+'\\n';
    process.stdout.write(frame.slice(0,8));setTimeout(()=>process.stdout.write(frame.slice(8)),5);
  } if(c.kind==='start'){`));
  await service.prewarm();
  await service.prewarm();
  await service.start('after', () => {});
  await service.cancel('after');
  await service.shutdown();
  assert.equal(service.isLifetimeTeardownConfirmed(), true);
});
test('failed prewarm leaves helper available for subsequent capture', async t => {
  const { service } = await fixture(t, fakeHelper.replace("if(c.kind==='start'){", "if(c.kind==='prewarm')send({token:c.token,prepared:false}); if(c.kind==='start'){"));
  await assert.rejects(service.prewarm(), /Local dictation preparation failed/);
  await service.start('retry', () => {});
  await service.cancel('retry');
  await service.shutdown();
  assert.equal(service.isLifetimeTeardownConfirmed(), true);
});
test('parent correlates recordings, reuses child, and releases development reader only after exit', async t => {
  const { service, readers } = await fixture(t, fakeHelper);
  const first: DictationObservation[] = [], second: DictationObservation[] = [];
  await service.start('first', value => first.push(value));
  assert.equal(service.isLifetimeTeardownConfirmed(), false);
  assert.equal((await readdir(readers)).length, 1);
  await service.stop('wrong');
  await service.stop('first');
  await service.start('second', value => second.push(value));
  await service.cancel('second');
  assert.equal(first.some(value => value.kind === 'transcript' && value.text === 'stale'), false);
  assert.equal(second.some(value => value.kind === 'transcript'), false);
  assert.equal(second.at(-1)?.kind, 'cancelled');
  assert.equal((await readdir(readers)).length, 1);
  await service.shutdown();
  assert.equal(service.isLifetimeTeardownConfirmed(), true);
  assert.equal((await readdir(readers)).length, 0);
});
test('silent preparation has a fixed watchdog and never emits audio', async t => {
  const { service } = await fixture(t, `process.stdout.write('{"ready":true}\\n');process.stdin.resume();setInterval(()=>{},1000);`);
  const observations: DictationObservation[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await service.start('silent', value => observations.push(value));
  t.mock.timers.tick(390000);
  assert.deepEqual(observations, [{ kind: 'error', message: 'Local dictation preparation deadline exceeded' }]);
  await service.shutdown();
  assert.equal(service.isLifetimeTeardownConfirmed(), false);
});
test('invalid bounded stdout forces owned teardown and retains uncertainty/reader', async t => {
  const { service, readers } = await fixture(t, `process.stdout.write('{"ready":true}\\n');process.stdin.once('data',()=>process.stdout.write('x'.repeat(70000)));setInterval(()=>{},1000);`);
  const failed = new Promise<void>(resolve => {
    void service.start('bad', value => { if (value.kind === 'error') resolve(); });
  });
  await failed;
  await service.shutdown();
  assert.equal(service.isLifetimeTeardownConfirmed(), false);
  assert.equal((await readdir(readers)).length, 1);
});
