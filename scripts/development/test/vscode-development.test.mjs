import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareDevelopment } from '../launch.mjs';
import { withDevelopmentWriter } from '../../../lib/development-runtime/lifetime.mjs';
import { snapshotProcessTree, watchChildProcess, withProcessTreeIsolation } from '../../lib/process-watchdog.mjs';
import { createRefreshRepository } from './refresh-fixtures.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixturePreloader = fileURLToPath(new URL('./vscode-development-stub.cjs', import.meta.url));
const credentialName = /API_KEY|TOKEN|SECRET|CREDENTIAL|AUTH|PASSWORD|BEARER|COOKIE|PRIVATE_KEY|LIVE_TEST|LIVE_MODEL/iu;
const childRunner = String.raw`
const path = require('node:path');
const { mkdir } = require('node:fs/promises');
const fixture = globalThis.__PIE_VSCODE_DEVELOPMENT_FIXTURE__;
const output = process.env.PIE_VSCODE_DEVELOPMENT_OUTPUT;
const profile = process.env.PIE_DEVELOPMENT_PROFILE_DIR;
const extensionPath = path.join(profile, 'headless-extension');
const runtime = require(path.join(output, 'extension.js'));
const context = {
  extensionMode: 1,
  extensionPath,
  extensionUri: fixture.vscode.Uri.file(extensionPath),
  globalStorageUri: fixture.vscode.Uri.file(path.join(profile, 'vscode-global-storage')),
  storageUri: fixture.vscode.Uri.file(path.join(profile, 'vscode-storage')),
  globalState: fixture.makeMemento(),
  workspaceState: fixture.makeMemento(),
  extension: { packageJSON: { publisher: 'pie', name: 'pie', version: '0.3.0' } },
  subscriptions: [],
};
const send = message => { if (process.send) process.send(message); };
let allowReaderRelease;
let readerReleaseGate = new Promise(resolve => { allowReaderRelease = resolve; });
let deactivationStarted = false;
process.on('message', message => {
  if (message?.type === 'allow-reader-release') {
    allowReaderRelease();
    return;
  }
  if (message?.type === 'deactivate' && !deactivationStarted) {
    deactivationStarted = true;
    send({ type: 'deactivating' });
    void runtime.deactivate().then(() => {
      send({ type: 'deactivated' });
      process.disconnect?.();
    }, error => {
      send({ type: 'deactivation-error', error: String(error?.stack ?? error) });
      process.exitCode = 1;
      process.disconnect?.();
    });
  }
});
(async () => {
  await mkdir(context.globalStorageUri.fsPath, { recursive: true });
  await mkdir(context.storageUri.fsPath, { recursive: true });
  runtime.activate(context, { runtimeOutDir: output, generation: null, publishedAt: 0 });
  const extension = context.subscriptions.find(item => item?.backend?.releaseDevelopmentReaders);
  if (!extension) throw new Error('The compiled VS Code adapter did not register its extension instance.');
  const releaseReaders = extension.backend.releaseDevelopmentReaders.bind(extension.backend);
  extension.backend.releaseDevelopmentReaders = async teardownConfirmed => {
    send({ type: 'reader-release-entered', teardownConfirmed });
    await readerReleaseGate;
    return releaseReaders(teardownConfirmed);
  };
  send({
    type: 'activated',
    progressCalls: fixture.progressCalls(),
    output,
    profile,
    globalStorage: context.globalStorageUri.fsPath,
    storage: context.storageUri.fsPath,
  });
})().catch(error => {
  send({ type: 'fixture-error', error: String(error?.stack ?? error) });
  process.exitCode = 1;
  process.disconnect?.();
});
`;

function scrubbedEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (credentialName.test(name)) delete environment[name];
  return environment;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

test('compiled VS Code development adapter starts headlessly with isolated profile and reader lifetime', { timeout: 120_000 }, async t => {
  if (process.env.PIE_RUN_DEVELOPMENT_HOST_TESTS !== '1') return t.skip('Explicit headless compiled-adapter qualification; this is not Electron/F5 acceptance.');

  const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'pie-vscode-development-'));
  let child;
  let childClosed = false;
  let completion;
  let watchdog;
  let owned;
  let readerDirectory;
  const messages = [];
  const waiters = [];
  let childOutput = '';
  const waitForMessage = (type, timeoutMs = 60_000) => {
    const existing = messages.find(message => message.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject };
      waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for child fixture message ${type}.\n${childOutput}`));
      }, timeoutMs);
      waiter.resolve = message => { clearTimeout(timer); resolve(message); };
    });
  };
  const handleMessage = message => {
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].type === message.type) {
        const [waiter] = waiters.splice(index, 1);
        waiter.resolve(message);
      }
    }
  };

  t.after(async () => {
    if (!child) { await rm(profileRoot, { recursive: true, force: true }); return; }
    // A root 'close' does not await descendants that inherited private TEMP.
    // Capture before deactivate can sever ancestry, then settle the canonical
    // watchdog before considering any recursive profile removal.
    owned ??= snapshotProcessTree(child.pid);
    let code;
    let timer;
    let tree;
    try {
      if (!childClosed && child.connected) {
        child.send({ type: 'allow-reader-release' });
        child.send({ type: 'deactivate' });
      }
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
      && !watchdog.timedOut && readers.length === 0 && messages.some(message => message.type === 'deactivated');
    const evidence = { code, owned, ownershipKnown, stillLive, tree, readers, confirmed, childOutput };
    await writeFile(path.join(profileRoot, 'teardown.json'), JSON.stringify(evidence, null, 2));
    assert.ok(confirmed, `Headless VS Code fixture teardown unconfirmed; evidence retained at ${profileRoot}.\n${childOutput}`);
    await rm(profileRoot, { recursive: true, force: true });
  });

  // Copy only the current root's compiled bytes; no rebuild or installed host.
  // Gate evidence belongs to this private workspace, not the shared checkout.
  const fixtureRepository = await createRefreshRepository(profileRoot);
  const developmentWorkspace = path.join(fixtureRepository, 'harness/pi');
  const sourceEnvironment = scrubbedEnvironment();
  const productionCoordinatorPort = Number(sourceEnvironment.PIE_HOST_COORDINATOR_PORT) || 1996;
  const prepared = await prepareDevelopment({ repositoryRoot: fixtureRepository, profileRoot, sourceEnvironment });
  const compiledEntry = path.join(prepared.output, 'extension.js');
  await stat(compiledEntry);
  assert.ok(isInside(await realpath(profileRoot), await realpath(prepared.output)), 'compiled output must be private');
  assert.deepEqual(await readFile(compiledEntry), await readFile(path.join(repositoryRoot, 'application/hosts/vscode/out-dev/extension.js')), 'fixture must consume current root compiled bytes without rebuilding');
  const isolatedRoots = ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_AUTH_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PIE_DATA_DIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR'];
  for (const name of isolatedRoots) assert.ok(isInside(profileRoot, prepared.env[name]), `${name} must stay under the explicit temp profile: ${prepared.env[name]}`);
  assert.notEqual(prepared.env.PIE_HOST_PROFILE, 'production');
  assert.notEqual(prepared.coordinatorPort, productionCoordinatorPort, 'development startup must not target the production coordinator port');
  assert.equal(prepared.env.PIE_HOST_COORDINATOR_PORT, String(prepared.coordinatorPort));
  assert.equal(prepared.env.PIE_DEVELOPMENT_PROFILE_DIR, profileRoot);

  readerDirectory = path.join(developmentWorkspace, '.cache/development-runtime/readers');
  const readersBefore = await readdir(readerDirectory).catch(() => []);
  const env = {
    ...prepared.env,
    PIE_VSCODE_DEVELOPMENT_OUTPUT: prepared.output,
    PIE_VSCODE_DEVELOPMENT_BROWSER_PORT: String(prepared.browserPort),
    PIE_VSCODE_DEVELOPMENT_WORKSPACE: fixtureRepository,
    PIE_VSCODE_FIXTURE_NETWORK_DENIED_FILE: path.join(profileRoot, 'external-network-denied.jsonl'),
    NODE_OPTIONS: `--require ${JSON.stringify(fixturePreloader.replace(/\\/gu, '/'))}`,
  };
  child = spawn(process.execPath, ['-e', childRunner], withProcessTreeIsolation({
    cwd: fixtureRepository,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  }));
  watchdog = watchChildProcess(child, { timeoutMs: 90_000, label: 'private compiled VS Code fixture' });
  child.stdout.on('data', data => { childOutput += data; });
  child.stderr.on('data', data => { childOutput += data; });
  child.on('message', handleMessage);
  completion = new Promise(resolve => child.once('close', code => { childClosed = true; resolve(code); }));

  const activated = await waitForMessage('activated');
  assert.equal(activated.output, prepared.output);
  assert.equal(activated.profile, profileRoot);
  assert.ok(isInside(profileRoot, activated.globalStorage), 'VS Code global extension storage must stay under the temp profile');
  assert.ok(isInside(profileRoot, activated.storage), 'VS Code extension storage must stay under the temp profile');
  assert.equal(activated.progressCalls, 0, 'development profile must not ask VS Code to perform a production-host handoff');

  const errors = () => messages.filter(message => ['fixture-error', 'extension-error', 'deactivation-error'].includes(message.type));
  const deadline = Date.now() + 60_000;
  let health;
  while (Date.now() < deadline && !childClosed) {
    const failure = errors()[0];
    assert.equal(failure, undefined, failure?.error ?? 'compiled adapter startup failed');
    try {
      const response = await fetch(`http://127.0.0.1:${prepared.browserPort}/health`);
      if (response.ok) { health = response; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(health, `shared browser HTTP health endpoint did not become ready.\n${childOutput}`);

  const pageResponse = await fetch(`http://127.0.0.1:${prepared.browserPort}/`);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  const assetReferences = [...page.matchAll(/(?:src|href)=["']([^"']*assets\/[^"']+)["']/gu)].map(match => match[1]);
  assert.ok(assetReferences.length > 0 && /assets\/panel-/u.test(page), 'the shared browser server must serve the compiled panel asset document');
  const assetPath = new URL(assetReferences[0], `http://127.0.0.1:${prepared.browserPort}/`).pathname;
  const assetResponse = await fetch(`http://127.0.0.1:${prepared.browserPort}${assetPath}`);
  assert.equal(assetResponse.status, 200, `compiled renderer asset unavailable at ${assetPath}`);
  assert.ok((await assetResponse.arrayBuffer()).byteLength > 0);

  const readersWhileActive = await readdir(readerDirectory);
  const newReaderRecords = [];
  for (const name of readersWhileActive.filter(name => !readersBefore.includes(name))) {
    const record = JSON.parse(await readFile(path.join(readerDirectory, name), 'utf8'));
    if (record.pid === child.pid && record.workspaceRoot === await realpath(developmentWorkspace)) newReaderRecords.push({ name, record });
  }
  assert.equal(newReaderRecords.length, 1, 'the active adapter must hold exactly one identifiable development SDK reader');
  const activeReaderName = newReaderRecords[0].name;

  let writeStarted = false;
  await assert.rejects(withDevelopmentWriter(developmentWorkspace, async () => { writeStarted = true; }), /writer denied/u);
  assert.equal(writeStarted, false, 'the development output writer must be rejected while the adapter retains its reader');

  owned = snapshotProcessTree(child.pid);
  child.send({ type: 'deactivate' });
  await waitForMessage('deactivating');
  const releaseBoundary = await waitForMessage('reader-release-entered');
  assert.equal(releaseBoundary.teardownConfirmed, true, 'reader release must follow confirmed backend runtime teardown');
  writeStarted = false;
  await assert.rejects(withDevelopmentWriter(developmentWorkspace, async () => { writeStarted = true; }), /writer denied/u);
  assert.equal(writeStarted, false, 'writer remains blocked at the adapter reader-release boundary until deactivate completes');
  child.send({ type: 'allow-reader-release' });
  await waitForMessage('deactivated');
  assert.equal(await completion, 0, childOutput);

  const finalReaders = await readdir(readerDirectory);
  assert.equal(finalReaders.includes(activeReaderName), false, 'completed deactivate releases the adapter reader');
  await withDevelopmentWriter(developmentWorkspace, async () => {});
  assert.deepEqual(errors(), [], 'compiled adapter and its awaited deactivate must not report runtime failures');

  const networkAttempts = messages.filter(message => message.type === 'external-network-denied');
  const networkLog = await readFile(env.PIE_VSCODE_FIXTURE_NETWORK_DENIED_FILE, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const descendantAttempts = networkLog.trim() ? networkLog.trim().split(/\r?\n/u).map(line => JSON.parse(line)) : [];
  assert.deepEqual([...networkAttempts, ...descendantAttempts], [], 'the headless fixture must deny and report any external provider traffic');
  assert.equal(messages.some(message => message.type === 'production-handoff-attempt'), false, 'no production coordinator handoff UI may be invoked');
});
