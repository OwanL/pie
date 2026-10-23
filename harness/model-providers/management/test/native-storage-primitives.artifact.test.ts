import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type * as NativeSdk from '@earendil-works/pi-coding-agent';
import { watchChildProcess, withProcessTreeIsolation } from './artifact-process-watchdog';
import { sourceDescriptor } from '../../../agent-processes/lib/sdk-integration/test/source-fixture';

const key = (value: string) => ({ type: 'api_key' as const, key: value });

let sdk: typeof NativeSdk;
before(async () => {
  // Keep native ESM export conditions even when test:file uses its CJS compatibility wrapper.
  sdk = await import(pathToFileURL(join(sourceDescriptor.sdkPath, 'dist/index.js')).href);
});

test('fresh public SDK exports provide async construction, reload, cancellable CRUD and backend wiring', async () => {
  const { AuthStorage, InMemoryAuthStorageBackend } = sdk;
  const backend = new InMemoryAuthStorageBackend();
  const storage = await AuthStorage.fromStorageAsync(backend);
  const controller = new AbortController();
  const options: NativeSdk.AuthStorageAsyncOptions = { signal: controller.signal };
  await storage.setAsync('saved', key('synthetic'), options);
  await storage.reloadAsync();
  assert.deepEqual(storage.list(), ['saved']);
  controller.abort();
  await assert.rejects(storage.removeAsync('saved', options), { name: 'AbortError' });
  assert.deepEqual(storage.get('saved'), key('synthetic'));
  assert.equal(storage.drainErrors()[0]?.name, 'AbortError');
  await storage.removeAsync('saved');
  assert.deepEqual(storage.list(), []);
  assert.deepEqual(storage.drainErrors(), []);
});

test('public SDK async CRUD respects a live cross-process lock, merges fresh contents and prevents late cancellation writes', async t => {
  const { AuthStorage } = sdk;
  const directory = await mkdtemp(join(tmpdir(), 'pie-native-auth-primitives-'));
  const path = join(directory, 'auth.json');
  await writeFile(path, JSON.stringify({ kept: key('kept') }));
  const storage = await AuthStorage.createAsync(path);
  const runner = join(directory, 'holder.mjs');
  // Import the selected artifact's actual public exports, never workspace source.
  await writeFile(runner, `import { FileAuthStorageBackend } from ${JSON.stringify(pathToFileURL(join(sourceDescriptor.sdkPath, 'dist/index.js')).href)};
const backend = new FileAuthStorageBackend(process.argv[2]);
await backend.withLockAsync(async current => {
  await new Promise(resolve => {
    process.once('message', resolve);
    process.once('disconnect', resolve);
    process.send('locked');
  });
  return { result: undefined, next: JSON.stringify({ ...JSON.parse(current), holder: { type: 'api_key', key: 'holder' } }) };
});
if (process.connected) process.disconnect();
`);
  const child = spawn(process.execPath, [runner, path], withProcessTreeIsolation({
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  }));
  const watchdog = watchChildProcess(child, { timeoutMs: 30_000, label: 'native credential lock holder' });
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { output += chunk; });
  const closed = new Promise<number | null>(resolve => {
    child.once('close', resolve);
  });
  const pending: Promise<unknown>[] = [];
  t.after(async () => {
    if (child.connected) child.send('release');
    await closed;
    const cleanup = await watchdog.settle();
    await Promise.allSettled(pending);
    assert.equal(cleanup.gone, true, `Child teardown uncertain; retained fixture: ${directory}`);
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    child.once('message', message => message === 'locked' ? resolve() : reject(new Error('Unexpected holder response')));
    child.once('error', reject);
    child.once('close', () => reject(new Error(`Holder closed before acquiring: ${output}`)));
  });
  const controller = new AbortController();
  const cancelled = assert.rejects(storage.removeAsync('kept', { signal: controller.signal }), { name: 'AbortError' });
  const constructed = AuthStorage.createAsync(path);
  const mutation = storage.setAsync('parent', key('parent'));
  pending.push(cancelled, constructed, mutation);
  controller.abort();
  // Causal heartbeat: the other process still owns the lock at this point.
  await delay(25);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { kept: key('kept') });
  child.send('release');
  const [, loaded] = await Promise.all([cancelled, constructed, mutation]);
  await loaded.reloadAsync();
  assert.deepEqual(loaded.getAll(), { kept: key('kept'), holder: key('holder'), parent: key('parent') });
  assert.deepEqual(loaded.drainErrors(), []);
  assert.equal(await closed, 0, output);
  assert.equal(watchdog.timedOut, false, output);
});
