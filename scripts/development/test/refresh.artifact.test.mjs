import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { prepareDevelopment } from '../launch.mjs';
import { withDevelopmentWriter } from '../../../lib/development-runtime/lifetime.mjs';
import { resolveOwnerModule } from '../../lib/package-resolution.mjs';
import { snapshotProcessTree, watchChildProcess, withProcessTreeIsolation } from '../../lib/process-watchdog.mjs';
import { repositoryRoot, createRefreshRepository, offlineEnvironment, rebuildPrivateOutput } from './refresh-fixtures.mjs';

const preloader = fileURLToPath(new URL('./vscode-development-stub.cjs', import.meta.url));
const runner = String.raw`
const path = require('node:path');
const output = process.env.PIE_REFRESH_OUTPUT;
let app, backend;
const send = value => process.send?.(value);
(async () => {
  if (process.env.PIE_REFRESH_ADAPTER === 'standalone') {
    app = await require(path.join(output, 'standalone.js')).main(['--cwd', process.cwd()], {
      extensionPath: process.env.PIE_REFRESH_HOST, runtimeOutputDirectory: output,
      dataRoot: process.env.PIE_DATA_DIR, browserServerSettings: {
        port: Number(process.env.PIE_VSCODE_DEVELOPMENT_BROWSER_PORT), allowLan: false
      }, installSignalHandlers: false
    });
    backend = app.runtime.backend;
  } else {
    const fixture = globalThis.__PIE_VSCODE_DEVELOPMENT_FIXTURE__;
    const runtime = require(path.join(output, 'extension.js'));
    const context = {
      extensionMode: 1, extensionPath: process.env.PIE_REFRESH_HOST,
      extensionUri: fixture.vscode.Uri.file(process.env.PIE_REFRESH_HOST),
      globalStorageUri: fixture.vscode.Uri.file(path.join(process.env.PIE_DEVELOPMENT_PROFILE_DIR, 'global')),
      storageUri: fixture.vscode.Uri.file(path.join(process.env.PIE_DEVELOPMENT_PROFILE_DIR, 'storage')),
      globalState: fixture.makeMemento(), workspaceState: fixture.makeMemento(),
      extension: { packageJSON: { publisher: 'pie', name: 'pie', version: '0.3.0' } }, subscriptions: []
    };
    runtime.activate(context, { runtimeOutDir: output, generation: null, publishedAt: 0 });
    backend = context.subscriptions.find(item => item?.backend)?.backend;
    app = { shutdown: () => runtime.deactivate() };
  }
  if (!backend) throw new Error('Compiled adapter did not expose its real backend');
  process.on('message', async message => {
    try {
      if (message === 'list') send({ type: 'list', result: await backend.request('session.list') });
      if (message === 'stop') { await app.shutdown(); process.send({ type: 'stopped' }, () => { process.disconnect(); process.exit(0); }); }
    } catch (error) { send({ type: 'failure', error: String(error.stack ?? error) }); }
  });
  send({ type: 'started' });
})().catch(error => { send({ type: 'failure', error: String(error.stack ?? error) }); process.exitCode = 1; process.disconnect?.(); });
`;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hash = text => createHash('sha256').update(text).digest('hex');

for (const adapter of ['standalone', 'vscode']) test(`private refresh: ${adapter === 'standalone' ? 'real headless standalone' : 'compiled VS Code adapter with mocked VS Code API'}`, { timeout: 240_000 }, async t => {
  if (process.env.PIE_RUN_DEVELOPMENT_HOST_TESTS !== '1') return t.skip('Opt-in current compiled out-dev acceptance; no shared outputs are rebuilt.');
  const directory = await mkdtemp(path.join(os.tmpdir(), `pie-refresh-${adapter}-`));
  let active;
  t.after(async () => {
    if (active && !active.settled) await active.stop();
    if (!active?.uncertain) await rm(directory, { recursive: true, force: true });
  });
  const root = await createRefreshRepository(directory);
  const prepared = await prepareDevelopment({ repositoryRoot: root, profileRoot: path.join(directory, 'profile'), sourceEnvironment: offlineEnvironment() });
  const workspace = path.join(root, 'harness/pi');
  const readerDirectory = path.join(workspace, '.cache/development-runtime/readers');
  const history = path.join(prepared.env.PI_CODING_AGENT_SESSION_DIR, 'refresh-history.jsonl');
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  // A valid persisted Pi transcript fixture, not a paid/live turn or a marker
  // masquerading as backend behavior. Both actual backends must discover it.
  const transcript = [
    { type: 'session', version: 3, id: sessionId, timestamp, cwd: root },
    { type: 'message', id: 'history-entry', parentId: null, timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'private development history' }], timestamp: Date.now() } },
    { type: 'session_info', id: 'name-entry', parentId: 'history-entry', timestamp, name: 'private refresh history' },
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
  await writeFile(history, transcript);
  const env = {
    ...prepared.env,
    PIE_REFRESH_OUTPUT: prepared.output, PIE_REFRESH_HOST: path.join(root, 'application/hosts/vscode'), PIE_REFRESH_ADAPTER: adapter,
    PIE_VSCODE_DEVELOPMENT_BROWSER_PORT: String(prepared.browserPort), PIE_VSCODE_DEVELOPMENT_WORKSPACE: root,
    PIE_VSCODE_FIXTURE_NETWORK_DENIED_FILE: path.join(directory, 'network-denied.jsonl'),
    NODE_OPTIONS: `--require ${JSON.stringify(preloader.replace(/\\/gu, '/'))}`,
  };
  async function start() {
    const child = spawn(process.execPath, ['-e', runner], withProcessTreeIsolation({ cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }));
    const watchdog = watchChildProcess(child, { timeoutMs: 180_000, label: `private refresh ${adapter}` });
    let output = '';
    const messages = [];
    const state = { closed: false, settled: false, uncertain: true };
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('message', message => messages.push(message));
    const completion = new Promise(resolve => child.once('close', code => { state.closed = true; resolve(code); }));
    async function wait(type) {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const failure = messages.find(message => message.type === 'failure' || message.type === 'extension-error');
        assert.equal(failure, undefined, `${failure?.error ?? ''}\n${output}`);
        const index = messages.findIndex(message => message.type === type);
        if (index >= 0) return messages.splice(index, 1)[0];
        assert.equal(state.closed, false, output);
        await delay(50);
      }
      throw new Error(`Timed out waiting for ${type}: ${output}`);
    }
    state.stop = async () => {
      if (state.settled) return;
      // Capture while ancestry is intact, before graceful shutdown can reparent
      // descendants. A post-close root snapshot alone is not teardown evidence.
      const owned = snapshotProcessTree(child.pid);
      let code;
      let tree;
      try {
        if (!state.closed && child.connected) child.send('stop');
        let timer;
        code = await Promise.race([completion, new Promise(resolve => { timer = setTimeout(() => resolve('uncertain'), 20_000); })]);
        clearTimeout(timer);
      } finally {
        tree = await watchdog.settle();
        state.settled = true;
      }
      const stillLive = owned.filter(entry => {
        try { process.kill(entry.pid, 0); return true; }
        catch (error) { return error.code !== 'ESRCH'; }
      });
      const ownershipKnown = owned.length > 0 && owned.every(entry => entry.identity != null);
      const readers = await readdir(readerDirectory).catch(error => ({ error: String(error) }));
      state.uncertain = !ownershipKnown || stillLive.length > 0 || !tree.gone || tree.survivors.length > 0 || watchdog.timedOut || !Array.isArray(readers) || readers.length > 0;
      const evidence = { adapter, code, ownershipKnown, owned, stillLive, tree, readers, uncertain: state.uncertain };
      await writeFile(path.join(directory, `teardown-${child.pid}.json`), JSON.stringify(evidence, null, 2));
      t.diagnostic(`Owned teardown: ${JSON.stringify(evidence)}`);
      assert.equal(state.uncertain, false, `Owned teardown unconfirmed; sandbox evidence retained at ${directory}. ${output}`);
      assert.equal(code, 0, `Graceful shutdown failed. ${output}`);
    };
    state.list = async () => { child.send('list'); return (await wait('list')).result; };
    active = state;
    await wait('started');
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${prepared.browserPort}/health`)).ok) return state; } catch {}
      assert.equal(state.closed, false, output);
      await delay(100);
    }
    throw new Error(`HTTP startup failed: ${output}`);
  }
  const first = await start();
  assert.match(JSON.stringify(await first.list()), new RegExp(sessionId), 'real backend must discover the private transcript');
  assert.equal((await readdir(readerDirectory)).length, 1);
  let rebuildStarted = false;
  await assert.rejects(withDevelopmentWriter(workspace, async () => { rebuildStarted = true; await rebuildPrivateOutput(prepared.output, 'node'); }), /writer denied/u);
  assert.equal(rebuildStarted, false, 'live Pi reader denies build before Vite starts');

  // Real socket, real production renderer build, real changed manifest/assets:
  // no fabricated pie-build-id or injected transport probe is reload evidence.
  const wsModule = await import(pathToFileURL(resolveOwnerModule('ws')).href);
  const WebSocket = wsModule.WebSocket ?? wsModule.default.WebSocket ?? wsModule.default;
  const socket = new WebSocket(`ws://127.0.0.1:${prepared.browserPort}/ws`, { origin: `http://127.0.0.1:${prepared.browserPort}` });
  t.after(() => socket.close());
  // A scripted protocol peer, not a browser DOM/render qualification.
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type === 'rendererHello') socket.send(JSON.stringify({ type: 'ready', buildId: message.buildId, viewGeneration: message.viewGeneration, assetVersion: message.assetVersion }));
    if (message.type === 'state') {
      const payload = { revision: message.revision, viewGeneration: message.viewGeneration };
      socket.send(JSON.stringify({ type: 'stateReceived', payload: { ...payload, snapshotBytes: data.length } }));
      socket.send(JSON.stringify({ type: 'appCommitted', payload }));
    }
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const closed = new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  const manifestPath = path.join(prepared.output, 'webview/panel/.vite/manifest.json');
  const beforeManifest = await readFile(manifestPath, 'utf8');
  // Compile an actual local CSS edit alongside the unchanged production panel.
  // It changes emitted renderer content, not merely the reload marker. Keeping
  // the entry shim private avoids editing source another worker may be using.
  const rendererInput = path.join(directory, 'panel.js');
  await writeFile(path.join(directory, 'refresh.css'), ':root { color-scheme: dark; }\n');
  await writeFile(rendererInput, `import ${JSON.stringify(path.join(repositoryRoot, 'application/frontend/shell/panel.tsx').replace(/\\/gu, '/'))};\nimport './refresh.css';\n`);
  await rebuildPrivateOutput(prepared.output, undefined, rendererInput);
  const afterManifest = await readFile(manifestPath, 'utf8');
  assert.notEqual(hash(afterManifest), hash(beforeManifest), 'current source rebuild must actually change compiled renderer bytes/manifest; unchanged source is not refresh evidence');
  let timer;
  const reload = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(null), 10_000); })]);
  clearTimeout(timer);
  assert.equal(reload?.reason, 'development-renderer-rebuilt');
  const html = await (await fetch(`http://127.0.0.1:${prepared.browserPort}/`)).text();
  const manifest = JSON.parse(afterManifest);
  const entry = Object.values(manifest).find(value => value.isEntry);
  assert.ok(html.includes(entry.file.replace(/^assets\//u, '/assets/')), 'reloaded document references the actual newly built entry');
  const served = await (await fetch(`http://127.0.0.1:${prepared.browserPort}/${entry.file}`)).text();
  assert.equal(hash(served), hash(await readFile(path.join(prepared.output, 'webview/panel', entry.file), 'utf8')));
  const styles = await Promise.all((entry.css ?? []).map(async file => {
    const response = await fetch(`http://127.0.0.1:${prepared.browserPort}/${file}`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(hash(text), hash(await readFile(path.join(prepared.output, 'webview/panel', file), 'utf8')));
    return text;
  }));
  assert.match(styles.join('\n'), /color-scheme:dark/u, 'actual CSS edit was compiled and served, not just a build marker');
  assert.equal((await readdir(readerDirectory)).length, 1, 'renderer rebuild does not relinquish backend/Pi lifetime');

  await first.stop();
  assert.deepEqual(await readdir(readerDirectory), []);
  await withDevelopmentWriter(workspace, () => rebuildPrivateOutput(prepared.output, 'node'));
  await prepareDevelopment({ repositoryRoot: root, profileRoot: prepared.profile, sourceEnvironment: offlineEnvironment() });
  const second = await start();
  assert.match(JSON.stringify(await second.list()), new RegExp(sessionId), 'rebuilt/relaunched backend rediscovers persistent private history');
  assert.equal(await readFile(history, 'utf8'), transcript);
  await second.stop();
  assert.deepEqual(await readdir(readerDirectory), []);
  const attempts = await readFile(env.PIE_VSCODE_FIXTURE_NETWORK_DENIED_FILE, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
  assert.equal(attempts, '', 'no provider or external network calls');
});
