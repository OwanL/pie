import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as native from '../../dictation/native.mjs';

async function fixture(t, extra = '', version = '1.2.9', faults = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pie-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, 'node_modules/@picovoice/pvrecorder-node');
  await mkdir(join(pkg, 'lib'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ version, main: 'lib/index.js' }));
  await writeFile(join(pkg, 'lib/index.js'), `const fs=require('node:fs'); const log=${JSON.stringify(join(root, 'events'))}; const event=x=>fs.appendFileSync(log,x+'\\n'); event('import'); exports.PvRecorder=class { constructor(){event('construct');this.sampleRate=16000;${extra}} start(){event('start')} readSync(){${faults.read ?? ''}return new Int16Array(512)} stop(){event('stop');${faults.stop ?? ''}} release(){event('release');${faults.release ?? ''}} };`);
  return { root, events: async () => (await readFile(join(root, 'events'), 'utf8')).trim().split('\n') };
}

test('standby imports without opening and reuses binding across captures', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  assert.equal(typeof native.createCaptureStandby, 'function');
  const standby = native.createCaptureStandby(f.root);
  t.after(() => standby.shutdown());
  await standby.ready;
  assert.deepEqual(await f.events(), ['import']);
  for (let i = 0; i < 2; i++) {
    let resolve;
    const frame = new Promise(r => { resolve = r; });
    const capture = standby.start(pcm => { assert.equal(pcm.length, 512); resolve(); }, () => {}, assert.fail);
    await frame;
    await capture.stop();
  }
  assert.deepEqual(await f.events(), ['import', 'construct', 'start', 'stop', 'release', 'construct', 'start', 'stop', 'release']);
  await standby.shutdown();
});

test('idle shutdown and immediate start/stop', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const standby = native.createCaptureStandby(f.root);
  await standby.start(() => assert.fail('late frame'), () => {}, assert.fail).stop();
  await standby.shutdown();
  const idle = native.createCaptureStandby(f.root);
  await idle.ready;
  await idle.shutdown();
});

test('qualification failure rejects ready and confirms shutdown', { timeout: 5000 }, async t => {
  const f = await fixture(t, '', '0.0.0');
  const standby = native.createCaptureStandby(f.root);
  await assert.rejects(standby.ready);
  await assert.rejects(standby.shutdown());
});

test('malformed package rejects preparation without construction', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'node_modules/@picovoice/pvrecorder-node/package.json'), '{');
  const standby = native.createCaptureStandby(f.root);
  await assert.rejects(standby.ready);
  await assert.rejects(standby.shutdown());
});

test('constructor failure confirms teardown and permits retry on the same standby', { timeout: 5000 }, async t => {
  const f = await fixture(t, "if(!fs.existsSync(log+'.fault')){fs.writeFileSync(log+'.fault','');throw new Error('fake');}");
  const standby = native.createCaptureStandby(f.root);
  await standby.ready;
  let resolve;
  const failed = new Promise(r => { resolve = r; });
  const capture = standby.start(() => {}, () => {}, resolve);
  await failed;
  await assert.rejects(capture.stop(), error => error.teardownConfirmed === true);
  await successfulRetry(standby);
  await standby.shutdown();
  assert.equal((await f.events()).filter(x => x === 'construct').length, 2);
});

async function successfulRetry(standby) {
  let resolve;
  const frame = new Promise(r => { resolve = r; });
  const capture = standby.start(resolve, () => {}, assert.fail);
  await frame;
  await capture.stop();
}

test('read failure confirms teardown and permits retry on the same standby', { timeout: 5000 }, async t => {
  const f = await fixture(t, '', '1.2.9', {
    read: "if(!fs.existsSync(log+'.fault')){fs.writeFileSync(log+'.fault','');throw new Error('read');}",
  });
  const standby = native.createCaptureStandby(f.root);
  await standby.ready;
  let resolve;
  const failed = new Promise(r => { resolve = r; });
  const capture = standby.start(() => {}, () => {}, resolve);
  await failed;
  await assert.rejects(capture.stop(), error => error.teardownConfirmed === true);
  await successfulRetry(standby);
  await standby.shutdown();
  assert.equal((await f.events()).filter(x => x === 'release').length, 2);
});

for (const method of ['stop', 'release']) {
  test(`${method} failure leaves teardown uncertain and retires standby`, { timeout: 5000 }, async t => {
    const f = await fixture(t, '', '1.2.9', { [method]: "throw new Error('teardown');" });
    const standby = native.createCaptureStandby(f.root);
    await standby.ready;
    let resolve;
    const frame = new Promise(r => { resolve = r; });
    const capture = standby.start(resolve, () => {}, assert.fail);
    await frame;
    const uncertain = error => error.teardownConfirmed !== true;
    await assert.rejects(capture.stop(), uncertain);
    assert.throws(() => standby.start(() => {}, () => {}, () => {}));
    await assert.rejects(standby.shutdown(), uncertain);
    assert.deepEqual((await f.events()).slice(-2), ['stop', 'release']);
  });
}

test('callback throw rejects stop; active shutdown releases', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const standby = native.createCaptureStandby(f.root);
  await standby.ready;
  let resolve;
  const failed = new Promise(r => { resolve = r; });
  const capture = standby.start(() => { throw new Error('callback'); }, () => {}, resolve);
  assert.throws(() => standby.start(() => {}, () => {}, () => {}), /already active/);
  await failed;
  await assert.rejects(capture.stop(), error => error.message === 'callback' && error.teardownConfirmed === true);
  let started;
  const running = new Promise(r => { started = r; });
  standby.start(() => {}, started, assert.fail);
  await running;
  await standby.shutdown();
  assert.equal((await f.events()).filter(x => x === 'release').length, 2);
});
