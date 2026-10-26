import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { createDeniedFacade, installKeyringFacade, probeKeyringBindings } from '../fixtures/keyring-denied-facade.mjs';

function fixture() {
  let calls = 0, getters = 0;
  class Entry {
    constructor() { calls++; }
    static withTarget() { calls++; }
    static get target() { getters++; return Entry; }
    get credential() { getters++; return 'secret'; }
    getPassword() { calls++; }
  }
  Object.freeze(Entry.prototype);
  Object.freeze(Entry);
  const native = Object.freeze({ Entry, version: 1, absent: null });
  const ledger = [];
  const deny = kind => function () { ledger.push(kind); throw Error(`DENIED ${kind}`); };
  return { native, deny, ledger, counts: () => ({ calls, getters }) };
}

test('fresh frozen-safe facade preserves cycles without reading accessors', () => {
  const f = fixture();
  const original = Object.getOwnPropertyDescriptor(f.native.Entry, 'withTarget');
  const facade = createDeniedFacade(f.native, f.deny);
  assert.notEqual(facade, f.native);
  assert.notEqual(facade.Entry, f.native.Entry);
  assert.notEqual(facade.Entry.prototype, f.native.Entry.prototype);
  assert.equal(facade.Entry.prototype.constructor, facade.Entry);
  assert.equal(facade.version, 1);
  assert.equal(facade.absent, null);
  assert.deepEqual(f.counts(), { calls: 0, getters: 0 });
  assert.equal(f.ledger.length, 0);
  for (const invoke of [() => facade.Entry(), () => new facade.Entry(),
    () => facade.Entry.withTarget(), () => facade.Entry.prototype.getPassword(),
    () => facade.Entry.target, () => facade.Entry.prototype.credential]) {
    assert.throws(invoke, /DENIED keyring/);
  }
  assert.equal(f.ledger.length, 6);
  assert.deepEqual(f.counts(), { calls: 0, getters: 0 });
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.native.Entry, 'withTarget'), original);
});

test('real ESM named/default and CJS routes bind the same facade before calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-keyring-facade-'));
  const require = createRequire(import.meta.url);
  const entry = path.join(dir, 'index.cjs');
  const nativeEntry = path.join(dir, 'keyring.fake.node');
  const other = path.join(dir, 'other.cjs');
  const reload = path.join(dir, 'keyring.reload.node');
  const f = fixture();
  let guard;
  try {
    // The wrapper must not execute; Node still discovers its actual named exports.
    fs.writeFileSync(entry, "throw Error('wrapper executed'); exports.Entry = null; exports.version = null; exports.absent = null;");
    fs.writeFileSync(nativeEntry, 'never execute a native binding');
    fs.writeFileSync(other, "throw Error('subpath executed');");
    fs.writeFileSync(reload, 'never execute a native binding');
    require.cache[nativeEntry] = { id: nativeEntry, filename: nativeEntry, loaded: true, exports: f.native };
    guard = installKeyringFacade({ require, entry, nativeEntry, roots: [dir], canonical: fs.realpathSync, deny: f.deny });
    const facts = await probeKeyringBindings({ require, entry, nativeEntry, facade: guard.facade });
    assert.ok(Object.values(facts.moduleExportLoad).every(Boolean));
    assert.ok(Object.values(facts.facadeBinding).every(Boolean));
    assert.equal(require.cache[entry].exports, guard.facade);
    assert.equal(require.cache[nativeEntry].exports, guard.facade);
    assert.equal(f.ledger.length, 0);
    assert.deepEqual(f.counts(), { calls: 0, getters: 0 });
    delete require.cache[nativeEntry];
    assert.equal(require(nativeEntry), guard.facade);
    assert.throws(() => require(other), /DENIED keyring.load/);
    assert.throws(() => require(reload), /DENIED keyring.load/);
    assert.throws(() => Module._extensions['.node']({}, nativeEntry), /DENIED keyring.native/);
    assert.deepEqual(f.counts(), { calls: 0, getters: 0 });
  } finally {
    guard?.restore();
    for (const file of [entry, nativeEntry, other, reload]) delete require.cache[file];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
