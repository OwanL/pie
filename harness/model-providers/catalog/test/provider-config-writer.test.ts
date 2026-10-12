import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { editProviderConfig, type ProviderConfigWriteIO } from '../provider-config-writer.js';
import { providerConfigRevision, readProviderConfig } from '../provider-config.js';

const source = `# user-owned heading
version: 1
providers:
  local:
    enabled: true # keep enabled comment
    baseUrl: "http://localhost:1234/v1"
    manualModels: ['example'] # keep list
    modelOverrides:
      example:
        name: 'Quoted model' # keep name comment
        pricing: unknown
    modelPreferences:
      example:
        visible: true # keep preference comment
        subagentEligible: false
`;
const preference = ['providers', 'local', 'modelPreferences', 'example', 'visible'];
const change = [{ op: 'set' as const, path: preference, value: false }];
const failure = () => Object.assign(new Error('Injected fixture failure'), { code: 'EIO' });

async function fixture(run: (directory: string, file: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-provider-writer-'));
  try { await run(directory, path.join(directory, 'providers.yaml')); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
async function onlyConfig(directory: string, file: string, text: string) {
  assert.equal(await fs.readFile(file, 'utf8'), text);
  assert.deepEqual(await fs.readdir(directory), ['providers.yaml']);
}

// Override only the staging handle; never interfere with the cooperative lock handle.
function stagingWrite(action: (handle: fs.FileHandle, args: Parameters<fs.FileHandle['writeFile']>) => Promise<void>): ProviderConfigWriteIO['open'] {
  return (async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (String(args[0]).endsWith('.lock')) return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'writeFile') return (...writeArgs: Parameters<fs.FileHandle['writeFile']>) => action(target, writeArgs);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as ProviderConfigWriteIO['open'];
}

test('leaf edits preserve comments, quotes and untouched YAML nodes; unknown and zero are explicit', async () => fixture(async (directory, file) => {
  await fs.writeFile(file, source);
  const result = await editProviderConfig(file, providerConfigRevision(source), [
    ...change,
    { op: 'set', path: ['providers', 'local', 'modelOverrides', 'example', 'pricing'], value: { input: 0, output: 0 } },
    { op: 'set', path: ['providers', 'local', 'modelOverrides', 'other', 'pricing'], value: 'unknown' },
    { op: 'delete', path: ['providers', 'local', 'modelPreferences', 'example', 'subagentEligible'] },
  ]);
  assert.equal(result.status, 'saved');
  if (result.status !== 'saved') throw new Error('Expected saved');
  const text = await fs.readFile(file, 'utf8');
  for (const kept of ['# user-owned heading', 'enabled: true # keep enabled comment', 'baseUrl: "http://localhost:1234/v1"', "name: 'Quoted model' # keep name comment", 'visible: false # keep preference comment']) assert.ok(text.includes(kept), kept);
  assert.match(text, /manualModels:\s*\[\s*'example'\s*\]\s*# keep list/);
  assert.deepEqual(result.config.providers.local.manualModels, ['example']);
  assert.equal(result.revision, providerConfigRevision(text));
  assert.deepEqual(result.config.providers.local.modelOverrides?.example.pricing, { input: 0, output: 0 });
  assert.equal(result.config.providers.local.modelOverrides?.other.pricing, 'unknown');
  assert.equal(result.config.providers.local.modelPreferences?.example.subagentEligible, undefined);
  assert.deepEqual(await fs.readdir(directory), ['providers.yaml']);
}));

test('valid explicit edit creates a config in a new private nested path', async () => fixture(async (directory) => {
  const file = path.join(directory, 'private', 'nested', 'providers.yaml');
  const result = await editProviderConfig(file, null, [{ op: 'set', path: ['providers', 'local'], value: { enabled: false } }]);
  assert.equal(result.status, 'saved');
  const read = await readProviderConfig(file);
  assert.equal(read.status, 'valid');
  if (read.status !== 'valid' || result.status !== 'saved') throw new Error('Expected saved valid config');
  assert.deepEqual(read.config, { version: 1, providers: { local: { enabled: false } } });
  assert.equal(read.revision, result.revision);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['providers.yaml']);
}));

test('reader revisions include comment-only changes and stale saves preserve external bytes', async () => fixture(async (directory, file) => {
  await fs.writeFile(file, source);
  const before = await readProviderConfig(file);
  assert.equal(before.status, 'valid');
  if (before.status !== 'valid') throw new Error('Expected valid');
  const external = source + '# external edit\n';
  await fs.writeFile(file, external);
  const after = await readProviderConfig(file);
  assert.equal(after.status, 'valid');
  if (after.status !== 'valid') throw new Error('Expected valid');
  assert.notEqual(before.revision, after.revision);
  assert.equal(after.revision, providerConfigRevision(external));
  assert.match(after.revision, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await editProviderConfig(file, before.revision, change)).status, 'conflict');
  await onlyConfig(directory, file, external);
}));

test('missing snapshot conflicts if a file has appeared', async () => fixture(async (directory, file) => {
  const snapshot = await readProviderConfig(file);
  assert.equal(snapshot.status, 'missing');
  if (snapshot.status !== 'missing') throw new Error('Expected missing');
  assert.equal(snapshot.revision, null);
  await fs.writeFile(file, source);
  assert.equal((await editProviderConfig(file, null, change)).status, 'conflict');
  await onlyConfig(directory, file, source);
}));

test('invalid edits and malformed current YAML never write', async () => fixture(async (directory, file) => {
  await fs.writeFile(file, source);
  const invalid = await editProviderConfig(file, providerConfigRevision(source), [{ op: 'set', path: ['providers', 'local', 'enabled'], value: 'not boolean' }]);
  assert.equal(invalid.status, 'invalid');
  await onlyConfig(directory, file, source);
  const malformed = 'providers: [';
  await fs.writeFile(file, malformed);
  assert.equal((await editProviderConfig(file, providerConfigRevision(malformed), change)).status, 'invalid');
  await onlyConfig(directory, file, malformed);
}));

test('ambiguous mapping keys and numeric mapping edits are rejected without losing preferences', async () => fixture(async (directory, file) => {
  const ambiguous = `version: 1
providers:
  local:
    enabled: true
    modelPreferences:
      123: {visible: false}
      "123": {subagentEligible: true}
`;
  await fs.writeFile(file, ambiguous);
  assert.equal((await editProviderConfig(file, providerConfigRevision(ambiguous), change)).status, 'invalid');
  await onlyConfig(directory, file, ambiguous);
  const nonJson = '%YAML 1.1\n---\nversion: 1\nproviders: !!set {}\n';
  await fs.writeFile(file, nonJson);
  assert.equal((await editProviderConfig(file, providerConfigRevision(nonJson), change)).status, 'invalid');
  await onlyConfig(directory, file, nonJson);
  await fs.writeFile(file, source);
  assert.equal((await editProviderConfig(file, providerConfigRevision(source), [{
    op: 'set', path: ['providers', 'local', 'modelPreferences', 123], value: { visible: false },
  }])).status, 'invalid');
  await onlyConfig(directory, file, source);
}));

test('semantic no-op preserves exact bytes; missing no-op creates no directories or files', async () => fixture(async (directory, file) => {
  await fs.writeFile(file, source);
  for (const edits of [[], [{ op: 'set' as const, path: preference, value: true }], [{ op: 'delete' as const, path: ['providers', 'absent'] }]]) {
    const result = await editProviderConfig(file, providerConfigRevision(source), edits);
    assert.equal(result.status, 'unchanged');
    if (result.status === 'unchanged') assert.equal(result.revision, providerConfigRevision(source));
    await onlyConfig(directory, file, source);
  }
  await fs.unlink(file);
  const missingFile = path.join(directory, 'not-created', 'providers.yaml');
  for (const edits of [[], [{ op: 'delete' as const, path: ['providers', 'absent'] }]]) {
    const result = await editProviderConfig(missingFile, null, edits);
    assert.equal(result.status, 'unchanged');
    if (result.status === 'unchanged') assert.equal(result.revision, null);
    assert.deepEqual(await fs.readdir(directory), []);
  }
}));

test('an existing old lock is busy and is never reclaimed or removed', async () => fixture(async (directory, file) => {
  await fs.writeFile(file, source);
  const lock = file + '.lock';
  await fs.writeFile(lock, 'other owner');
  await fs.utimes(lock, new Date(0), new Date(0));
  assert.equal((await editProviderConfig(file, providerConfigRevision(source), change)).status, 'busy');
  assert.equal(await fs.readFile(lock, 'utf8'), 'other owner');
  assert.equal(await fs.readFile(file, 'utf8'), source);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['providers.yaml', 'providers.yaml.lock']);
}));

for (const primitive of ['rename', 'write', 'link'] as const) {
  test(`injected ${primitive} failure leaves original state and cleans owned artifacts`, async () => fixture(async (directory, file) => {
    const missing = primitive === 'link';
    if (!missing) await fs.writeFile(file, source);
    const io: Partial<ProviderConfigWriteIO> = primitive === 'write'
      ? { open: stagingWrite(async () => { throw failure(); }) }
      : { [primitive]: async () => { throw failure(); } };
    const result = await editProviderConfig(file, missing ? null : providerConfigRevision(source), missing
      ? [{ op: 'set', path: ['providers', 'local'], value: { enabled: false } }] : change, { io });
    assert.equal(result.status, 'error');
    if (missing) assert.deepEqual(await fs.readdir(directory), []);
    else await onlyConfig(directory, file, source);
  }));
}

test('external edit during staging is detected by the final revision recheck', async () => fixture(async (directory, file) => {
  await fs.writeFile(file, source);
  const external = source + '# changed while staging\n';
  let staged = false;
  const result = await editProviderConfig(file, providerConfigRevision(source), change, { io: {
    open: stagingWrite(async (handle, args) => {
      await handle.writeFile(...args);
      staged = true;
      await fs.writeFile(file, external);
    }),
  } });
  assert.ok(staged);
  assert.equal(result.status, 'conflict');
  await onlyConfig(directory, file, external);
}));

test('a failed conflict cleanup is reported without hiding the external edit', async () => fixture(async (directory, file) => {
  await fs.writeFile(file, source);
  const external = source + '# external edit\n';
  const result = await editProviderConfig(file, providerConfigRevision(source), change, { io: {
    open: stagingWrite(async (handle, args) => {
      await handle.writeFile(...args);
      await fs.writeFile(file, external);
    }),
    unlink: async selected => {
      if (String(selected).endsWith('.tmp')) throw failure();
      return fs.unlink(selected);
    },
  } });
  assert.equal(result.status, 'conflict');
  assert.ok(result.cleanupWarning);
  assert.equal(await fs.readFile(file, 'utf8'), external);
  const files = await fs.readdir(directory);
  assert.equal(files.includes('providers.yaml.lock'), false);
  assert.equal(files.filter(name => name.endsWith('.tmp')).length, 1);
}));

test('atomic create EEXIST preserves a noncooperative file created at commit', async () => fixture(async (directory, file) => {
  const result = await editProviderConfig(file, null, [{ op: 'set', path: ['providers', 'local'], value: { enabled: false } }], { io: {
    link: async (...args) => {
      await fs.writeFile(file, source, { flag: 'wx' });
      return fs.link(...args);
    },
  } });
  assert.equal(result.status, 'conflict');
  await onlyConfig(directory, file, source);
}));

test('unreadable input is distinct and does not mutate fixture state', async () => fixture(async (directory, file) => {
  await fs.writeFile(file, source);
  const result = await editProviderConfig(file, providerConfigRevision(source), change, { io: {
    readFile: (async () => { throw Object.assign(failure(), { code: 'EACCES' }); }) as ProviderConfigWriteIO['readFile'],
  } });
  assert.equal(result.status, 'unreadable');
  await onlyConfig(directory, file, source);
}));

test('postcommit cleanup failure is saved with a warning, not an unsaved error', async () => fixture(async (_directory, file) => {
  await fs.writeFile(file, source);
  const result = await editProviderConfig(file, providerConfigRevision(source), change, { io: {
    unlink: async selected => {
      if (String(selected) === file + '.lock') throw failure();
      return fs.unlink(selected);
    },
  } });
  assert.equal(result.status, 'saved');
  if (result.status !== 'saved') throw new Error('Expected saved');
  assert.ok(typeof result.cleanupWarning === 'string' && result.cleanupWarning.length > 0);
  const read = await readProviderConfig(file);
  assert.equal(read.status, 'valid');
  if (read.status === 'valid') {
    assert.equal(read.revision, result.revision);
    assert.equal(read.config.providers.local.modelPreferences?.example.visible, false);
  }
}));

test('concurrent cooperative saves from one revision cannot both succeed', async () => fixture(async (directory, file) => {
  await fs.writeFile(file, source);
  const revision = providerConfigRevision(source);
  const results = await Promise.all([
    editProviderConfig(file, revision, change),
    editProviderConfig(file, revision, [{ op: 'set', path: ['providers', 'local', 'enabled'], value: false }]),
  ]);
  assert.equal(results.filter(result => result.status === 'saved').length, 1);
  assert.ok(results.every(result => ['saved', 'busy', 'conflict'].includes(result.status)));
  assert.equal((await readProviderConfig(file)).status, 'valid');
  assert.deepEqual(await fs.readdir(directory), ['providers.yaml']);
}));
