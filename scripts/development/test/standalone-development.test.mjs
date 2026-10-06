import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareDevelopment } from '../launch.mjs';
import { snapshotProcessTree, watchChildProcess, withProcessTreeIsolation } from '../../lib/process-watchdog.mjs';
import { createRefreshRepository, offlineEnvironment } from './refresh-fixtures.mjs';

const preloader = fileURLToPath(new URL('./vscode-development-stub.cjs', import.meta.url));
const runner = String.raw`
const path = require('node:path');
const send = message => process.send?.(message);
(async () => {
  const app = await require(path.join(process.env.PIE_STANDALONE_FIXTURE_OUTPUT, 'standalone.js')).main(['--cwd', process.cwd()], {
    extensionPath: process.env.PIE_STANDALONE_FIXTURE_HOST,
    runtimeOutputDirectory: process.env.PIE_STANDALONE_FIXTURE_OUTPUT,
    dataRoot: process.env.PIE_DATA_DIR,
    browserServerSettings: { port: Number(process.env.PIE_VSCODE_DEVELOPMENT_BROWSER_PORT), allowLan: false },
    installSignalHandlers: false,
  });
  let stopping = false;
  process.on('message', async message => {
    try {
      if (message === 'list') send({ type: 'list', result: await app.runtime.backend.request('session.list') });
      if (message === 'stop' && !stopping) {
        stopping = true;
        await app.shutdown();
        send({ type: 'stopped' });
        process.disconnect();
      }
    } catch (error) {
      send({ type: 'failure', error: String(error.stack ?? error) });
      if (stopping) {
        // A failed product shutdown is not an idle IPC fixture. Surface the
        // failure without process.exit(), which would conceal live producers.
        process.exitCode = 1;
        process.disconnect();
      }
    }
  });
  send({ type: 'started' });
})().catch(error => { send({ type: 'failure', error: String(error.stack ?? error) }); process.exitCode = 1; process.disconnect?.(); });
`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('private clean standalone lists persisted history and awaits owned shutdown', { timeout: 120_000 }, async t => {
  if (process.env.PIE_RUN_DEVELOPMENT_HOST_TESTS !== '1') return t.skip('Opt-in current compiled standalone qualification; no build or installed host.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pie-standalone-development-'));
  let child, watchdog, completion, owned, readerDirectory;
  let closed = false;
  let output = '';
  const messages = [];
  t.after(async () => {
    if (!child) { await rm(directory, { recursive: true, force: true }); return; }
    owned ??= snapshotProcessTree(child.pid);
    let timer, code, tree;
    try {
      if (!closed && child.connected) child.send('stop');
      code = await Promise.race([completion, new Promise(resolve => { timer = setTimeout(() => resolve('uncertain'), 20_000); })]);
    } finally {
      clearTimeout(timer);
      tree = await watchdog.settle();
    }
    const stillLive = owned.filter(entry => {
      try { process.kill(entry.pid, 0); return true; }
      catch (error) { return error.code !== 'ESRCH'; }
    });
    const readers = await readdir(readerDirectory);
    const ownershipKnown = owned.length > 0 && owned.every(entry => entry.identity != null);
    const confirmed = code === 0 && ownershipKnown && stillLive.length === 0 && tree.gone
      && !watchdog.timedOut && readers.length === 0 && messages.some(message => message.type === 'stopped');
    await writeFile(path.join(directory, 'teardown.json'), JSON.stringify({ code, owned, ownershipKnown, stillLive, tree, readers, messages, confirmed, output }, null, 2));
    assert.ok(confirmed, `Standalone teardown unconfirmed; private evidence retained at ${directory}.\n${output}`);
    await rm(directory, { recursive: true, force: true });
  });
  const root = await createRefreshRepository(directory);
  const prepared = await prepareDevelopment({ repositoryRoot: root, profileRoot: path.join(directory, 'profile'), sourceEnvironment: offlineEnvironment() });
  readerDirectory = path.join(root, 'harness/pi/.cache/development-runtime/readers');
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  await writeFile(path.join(prepared.env.PI_CODING_AGENT_SESSION_DIR, 'history.jsonl'), [
    { type: 'session', version: 3, id: sessionId, timestamp, cwd: root },
    { type: 'message', id: 'history-entry', parentId: null, timestamp, message: { role: 'user', content: [{ type: 'text', text: 'private clean history' }], timestamp: Date.now() } },
    { type: 'session_info', id: 'name-entry', parentId: 'history-entry', timestamp, name: 'private clean history' },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  const networkLog = path.join(directory, 'network-denied.jsonl');
  child = spawn(process.execPath, ['-e', runner], withProcessTreeIsolation({ cwd: root, env: {
    ...prepared.env,
    PIE_STANDALONE_FIXTURE_OUTPUT: prepared.output,
    PIE_STANDALONE_FIXTURE_HOST: path.join(root, 'application/hosts/vscode'),
    PIE_VSCODE_DEVELOPMENT_BROWSER_PORT: String(prepared.browserPort),
    PIE_VSCODE_DEVELOPMENT_WORKSPACE: root,
    PIE_VSCODE_FIXTURE_NETWORK_DENIED_FILE: networkLog,
    NODE_OPTIONS: `--require ${JSON.stringify(preloader.replace(/\\/gu, '/'))}`,
  }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }));
  watchdog = watchChildProcess(child, { timeoutMs: 90_000, label: 'private clean standalone fixture' });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  child.on('message', message => messages.push(message));
  completion = new Promise(resolve => child.once('close', code => { closed = true; resolve(code); }));
  async function wait(type) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const failure = messages.find(message => message.type === 'failure');
      assert.equal(failure, undefined, `${failure?.error ?? ''}\n${output}`);
      const found = messages.find(message => message.type === type);
      if (found) return found;
      assert.equal(closed, false, output);
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${type}.\n${output}`);
  }
  await wait('started');
  const health = await fetch(`http://127.0.0.1:${prepared.browserPort}/health`);
  assert.equal(health.status, 200);
  const page = await fetch(`http://127.0.0.1:${prepared.browserPort}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /assets\/panel-/u);
  child.send('list');
  assert.match(JSON.stringify((await wait('list')).result), new RegExp(sessionId));
  assert.equal((await readdir(readerDirectory)).length, 1);
  assert.equal(await readFile(networkLog, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error)), '', 'no external network attempts');
  owned = snapshotProcessTree(child.pid);
});
