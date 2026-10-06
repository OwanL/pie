import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { withoutPiHarnessEnv } from '../../lib/pi-harness-env.mjs';
import { createOwnerRequire } from '../../lib/package-resolution.mjs';
import { watchChildProcess, withProcessTreeIsolation } from '../../lib/process-watchdog.mjs';
import { verificationChildEnv } from '../verification-runtime.mjs';
import { validateBrowserExecutable } from '../qualify-delivery.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const vscodePreloader = path.join(repositoryRoot, 'scripts/development/test/vscode-development-stub.cjs');
const fixtureScript = fileURLToPath(new URL('./fixtures/delivered-host-vscode.cjs', import.meta.url));
const credentialName = /API_KEY|TOKEN|SECRET|CREDENTIAL|AUTH|PASSWORD|BEARER|COOKIE|PRIVATE_KEY|LIVE_TEST|LIVE_MODEL/iu;
const optIn = process.env.PIE_RUN_DELIVERED_HOST_TESTS === '1';
const browserOptIn = process.env.PIE_RUN_DELIVERED_BROWSER_TESTS === '1';
const browserFixtureScript = fileURLToPath(new URL('./fixtures/delivered-host-browser.mjs', import.meta.url));
const SDK_SELECTORS = [
  'PI_SDK_PATH', 'PIE_SDK_PATH', 'NODE_PATH',
  'PIE_DEVELOPMENT_PI_RUNTIME', 'PIE_DEVELOPMENT_PI_WORKSPACE',
  'PIE_ALLOW_DEVELOPMENT_RUNTIME', 'PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK',
  'PIE_BUILD_PI_RUNTIME_SDK_PATH', 'PIE_BUILD_PI_RUNTIME_IDENTITY', 'PIE_BUILD_OUTPUT_DIR',
];
const startupBudgetMs = 72_000;
const usedTestPorts = new Set([1996, 1997]);

let releasePromise;
let browserAssetVersion;
async function verifiedRelease() {
  releasePromise ??= (async () => {
    const supplied = process.env.PIE_DELIVERED_HOST_ROOT;
    assert.ok(supplied && path.isAbsolute(supplied), 'PIE_DELIVERED_HOST_ROOT must be an absolute package-root path when the delivered-host lane is enabled.');
    const root = path.resolve(supplied);
    const canonicalRoot = await realpath(root);
    assert.equal(await isRegularDirectory(root), true, `delivered package root must be a real directory: ${root}`);
    const canonicalCheckout = await realpath(repositoryRoot);
    assert.equal(isWithin(canonicalCheckout, canonicalRoot), false, 'delivered package root must be outside the checkout.');
    assert.equal(isWithin(canonicalRoot, canonicalCheckout), false, 'delivered package root must not contain the checkout.');

    await requireRegularFile(path.join(canonicalRoot, 'package.json'));
    const manifest = JSON.parse(await readFile(path.join(canonicalRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.publisher, 'pie', 'release root must contain the Pie extension package manifest.');
    assert.equal(manifest.name, 'pie');
    assert.equal(manifest.main, './runtime/bootstrap.cjs');
    await requireRegularFile(path.join(canonicalRoot, manifest.main));
    const output = path.join(canonicalRoot, 'out');
    assert.equal(await isRegularDirectory(output), true, `release output must be a real directory: ${output}`);
    const files = {};
    for (const relative of [
      'extension.js', 'standalone.js', 'backend.js', 'worker-entry.js',
      'analytics-recorder-worker.js', 'analytics-query-worker.js',
      'webview/panel/.vite/manifest.json',
    ]) files[relative] = await requireRegularFile(path.join(output, relative));
    await requireRegularFile(path.join(canonicalRoot, 'media/icon.svg'));

    const runtimeRoot = path.join(output, 'pi-runtime');
    const { verifyPiRuntimeArtifact } = await import('../../lib/pi-runtime-artifact.mjs');
    const artifact = await verifyPiRuntimeArtifact(runtimeRoot);
    assert.equal(artifact.artifactDir, await realpath(runtimeRoot));
    assert.equal(isWithin(canonicalRoot, artifact.sdkPath), true, 'the verified production SDK must be contained by this delivered package.');
    assert.equal(isWithin(canonicalCheckout, artifact.sdkPath), false, 'the delivered SDK must not alias the checkout.');
    files.sdkEntry = await requireRegularFile(path.join(artifact.sdkPath, 'dist/index.js'));
    return { root: canonicalRoot, output, files, artifact };
  })();
  return releasePromise;
}

// Deliberately scoped to immutable delivered payload, not lifecycle metadata.
async function payloadFingerprint(release) {
  const hash = createHash('sha256');
  let files = 0;
  async function visit(relative) {
    const absolute = path.join(release.root, relative);
    const info = await lstat(absolute);
    assert.equal(info.isSymbolicLink(), false, `immutable payload must not contain links: ${relative}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(path.join(relative, name));
    } else {
      assert.ok(info.isFile(), `unexpected payload type: ${relative}`);
      hash.update(relative.replaceAll('\\', '/'));
      hash.update('\0');
      hash.update(await readFile(absolute));
      hash.update('\0');
      files += 1;
    }
  }
  await visit('out');
  await visit('package.json');
  for (const name of (await readdir(path.join(release.root, 'runtime'))).sort()) {
    if (name.endsWith('.cjs')) await visit(path.join('runtime', name));
  }
  return { sha256: hash.digest('hex'), files };
}

async function isRegularDirectory(directory) {
  try {
    const info = await lstat(directory);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function requireRegularFile(file) {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `release payload must be a regular copied file, not a link: ${file}`);
  const canonical = await realpath(file);
  assert.equal(samePath(canonical, path.resolve(file)), true, `release payload must resolve to its physical package copy: ${file}`);
  return canonical;
}

function samePath(left, right) {
  const normalize = value => path.resolve(value).replaceAll('\\', '/');
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function allocatePort(excluded = new Set()) {
  for (;;) {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (address && typeof address === 'object' && !excluded.has(address.port) && !usedTestPorts.has(address.port)) {
      usedTestPorts.add(address.port);
      return address.port;
    }
  }
}

async function createProfile(release, { adapter, browserPort } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-delivered-host-'));
  const profile = path.join(root, 'profile');
  const workspace = path.join(root, 'workspace');
  const paths = {
    agent: path.join(profile, 'agent'),
    auth: path.join(profile, 'auth'),
    sessions: path.join(profile, 'sessions'),
    data: path.join(profile, 'data'),
    home: path.join(profile, 'home'),
    temp: path.join(profile, 'temp'),
    vscode: path.join(profile, 'vscode'),
  };
  await Promise.all([profile, workspace, ...Object.values(paths)].map(directory => mkdir(directory, { recursive: true })));

  const defaults = JSON.parse(await readFile(path.join(repositoryRoot, 'settings.defaults.json'), 'utf8'));
  defaults.sessionDir = paths.sessions;
  defaults.packages = [];
  defaults.skills = [];
  await writeFile(path.join(paths.agent, 'settings.json'), `${JSON.stringify(defaults, null, 2)}\n`, { flag: 'wx' });
  await writeFile(path.join(paths.agent, 'models.json'), await readFile(path.join(repositoryRoot, 'models.json')), { flag: 'wx' });

  const environment = verificationChildEnv(withoutPiHarnessEnv(process.env));
  for (const name of Object.keys(environment)) if (credentialName.test(name)) delete environment[name];
  for (const name of SDK_SELECTORS) delete environment[name];
  const coordinatorPort = await allocatePort(new Set([1996, browserPort].filter(Number.isInteger)));
  const networkLog = path.join(profile, 'external-network-denied.jsonl');
  const startLog = path.join(profile, 'backend-start-options.jsonl');
  Object.assign(environment, {
    PIE_DELIVERED_HOST_ROOT: release.root,
    PIE_DELIVERED_HOST_PROFILE_DIR: profile,
    PIE_DELIVERED_HOST_ADAPTER: adapter,
    PIE_DELIVERED_HOST_START_RECORD_FILE: startLog,
    PIE_DEVELOPMENT_PROFILE_DIR: profile,
    PIE_HOST_PROFILE: `delivered-${adapter}-${randomUUID()}`,
    PIE_HOST_COORDINATOR_PORT: String(coordinatorPort),
    PI_CODING_AGENT_DIR: paths.agent,
    PI_CODING_AGENT_AUTH_DIR: paths.auth,
    PI_CODING_AGENT_SESSION_DIR: paths.sessions,
    PIE_DATA_DIR: paths.data,
    PI_NODE_PATH: process.execPath,
    HOME: paths.home,
    USERPROFILE: paths.home,
    XDG_CONFIG_HOME: path.join(paths.home, '.config'),
    XDG_DATA_HOME: path.join(paths.home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(paths.home, '.cache'),
    APPDATA: path.join(profile, 'appdata'),
    LOCALAPPDATA: path.join(profile, 'localappdata'),
    TEMP: paths.temp,
    TMP: paths.temp,
    TMPDIR: paths.temp,
    PIE_VSCODE_DEVELOPMENT_WORKSPACE: workspace,
    PIE_VSCODE_FIXTURE_NETWORK_DENIED_FILE: networkLog,
    NODE_OPTIONS: `--require ${JSON.stringify(vscodePreloader.replaceAll('\\', '/'))}`,
  });
  if (browserPort !== undefined) environment.PIE_VSCODE_DEVELOPMENT_BROWSER_PORT = String(browserPort);
  else delete environment.PIE_VSCODE_DEVELOPMENT_BROWSER_PORT;

  for (const name of SDK_SELECTORS) assert.equal(environment[name], undefined, `delivered host must not inherit development or installed SDK selector ${name}.`);
  for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_AUTH_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PIE_DATA_DIR']) {
    assert.ok(isWithin(profile, environment[name]), `${name} must resolve inside the private temp profile: ${environment[name]}`);
  }
  assert.notEqual(environment.PIE_HOST_PROFILE, 'production');
  assert.notEqual(coordinatorPort, 1996);
  assert.ok(browserPort === undefined || (browserPort !== coordinatorPort && browserPort !== 1996));
  return { root, profile, workspace, environment, coordinatorPort, networkLog, startLog };
}

function startChild(command, args, { cwd, env, label, ipc = false }) {
  const child = spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    ...withProcessTreeIsolation({}),
  });
  let output = '';
  child.stdout?.on('data', chunk => { output += chunk; });
  child.stderr?.on('data', chunk => { output += chunk; });
  child.on('error', error => { output += `${error.stack ?? error}\n`; });
  let closed = false;
  const completion = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true;
    resolve({ code, signal });
  }));
  const messages = [];
  child.on('message', message => messages.push(message));
  const watchdog = watchChildProcess(child, { timeoutMs: browserOptIn ? 180_000 : 90_000, label });
  return { child, completion, watchdog, messages, get output() { return output; }, get closed() { return closed; } };
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForHttp(baseUrl, pathname, child, timeoutMs = startupBudgetMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.closed) {
      const result = await child.completion;
      throw new Error(`host exited before ${pathname} became ready (code ${result.code}, signal ${result.signal}).\n${child.output}`);
    }
    try {
      const response = await fetch(new URL(pathname, baseUrl), { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${pathname} at ${baseUrl}: ${lastError?.message ?? 'no response'}\n${child.output}`);
}

async function verifyHealthAndAssets(baseUrl, child) {
  const health = await waitForHttp(baseUrl, '/health', child);
  assert.equal(health.status, 200);
  await health.arrayBuffer();
  const pageResponse = await waitForHttp(baseUrl, '/', child);
  const page = await pageResponse.text();
  const assets = [...page.matchAll(/(?:src|href)=["']([^"']*assets\/[^"']+)["']/gu)].map(match => match[1]);
  assert.ok(assets.some(asset => /assets\/panel-/u.test(asset)), 'delivered host must serve the compiled panel document and asset reference.');
  const assetUrl = new URL(assets.find(asset => /assets\/panel-/u.test(asset)), baseUrl);
  const assetResponse = await waitForHttp(assetUrl.origin, assetUrl.pathname, child);
  assert.ok((await assetResponse.arrayBuffer()).byteLength > 0, `compiled renderer asset must be served: ${assetUrl.pathname}`);
}

async function verifyOptionalBrowserFirstPaint(t, baseUrl, profile) {
  if (!browserOptIn) return;
  let executablePath;
  try {
    // The qualifier resolves the pinned browser before the native runner
    // isolates cache roots. Standalone callers keep the original resolution.
    executablePath = await validateBrowserExecutable(process.env.PIE_DELIVERED_BROWSER_EXECUTABLE
      ?? createOwnerRequire()('@playwright/test').chromium.executablePath());
  } catch (error) {
    throw new Error(`Delivered-browser blocker: installed VS Code-owner pinned @playwright/test Chromium is required; no download/install is attempted. ${error.message}`);
  }
  const browserFixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'pie-delivered-browser-'));
  assert.equal(isWithin(profile.root, browserFixtureRoot), false, 'browser fixture must be separate from the app profile');
  const environment = { ...profile.environment };
  delete environment.NODE_OPTIONS;
  for (const name of ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA']) {
    environment[name] = browserFixtureRoot;
  }
  let browserChild;
  let result;
  let passed = false;
  try {
    browserChild = startChild(process.execPath, [browserFixtureScript, baseUrl, browserFixtureRoot, executablePath], {
      cwd: browserFixtureRoot,
      env: environment,
      label: 'delivered private headless browser fixture',
      ipc: true,
    });
    result = await waitForMessage(browserChild, 'browser-result', 75_000);
    const completion = await withTimeout(browserChild.completion, 10_000);
    assert.ok(completion, 'browser fixture did not exit after reporting teardown');
    assert.equal(completion.code, 0, `${result.error ?? ''}\n${browserChild.output}`);
    assert.equal(result.safe, true, `browser teardown unconfirmed: ${browserFixtureRoot}`);
    assert.match(result.assetVersion, /^[0-9a-f]{16}$/u);
    browserAssetVersion ??= result.assetVersion;
    assert.equal(result.assetVersion, browserAssetVersion, 'both delivered peers must paint the same compiled renderer asset build');
    passed = true;
    t.diagnostic('Private headless compiled empty-session UI first paint and connected/backend-ready New session control verified; composer/Settings correctly absent without open tabs. No user actions, external browser network or renderer errors.');
  } finally {
    const teardown = await closeChildTree(browserChild);
    if (passed && teardown.safe && result?.safe) await rm(browserFixtureRoot, { recursive: true, force: true });
    else t.diagnostic(`Browser evidence retained outside the app profile at ${browserFixtureRoot}; assertions passed=${passed}, teardown confirmed=${!!(teardown.safe && result?.safe)}. Tree: ${JSON.stringify(teardown.tree ?? {})}`);
    assert.ok(teardown.safe && result?.safe, `browser-owned tree was not confirmed gone; retained ${browserFixtureRoot}. ${result?.error ?? browserChild?.output ?? ''}`);
  }
}

async function assertNoExternalNetwork(profile) {
  const attempts = await readFile(profile.networkLog, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
  assert.equal(attempts.trim(), '', `host attempted external network access despite the headless deny preloader:\n${attempts}`);
}

function assertNoFixtureErrors(childState) {
  const error = childState.messages.find(message => ['fixture-error', 'extension-error', 'deactivation-error', 'shutdown-error'].includes(message?.type));
  assert.equal(error, undefined, error?.error ?? error?.message ?? 'headless delivered host reported an error');
  assert.equal(childState.messages.some(message => message?.type === 'production-handoff-attempt'), false,
    'delivered startup must not invoke the production VS Code handoff UI.');
}

async function closeChildTree(childState, { graceful } = {}) {
  if (!childState) return { safe: true };
  const { child, completion, watchdog } = childState;
  let close;
  if (!childState.closed && graceful) {
    try { await graceful(); } catch {}
  }
  if (!childState.closed) {
    close = await withTimeout(completion, 18_000);
  } else {
    close = await completion;
  }
  if (!close && !childState.closed) {
    try { child.kill('SIGTERM'); } catch {}
    close = await withTimeout(completion, 8_000);
  }
  const tree = await watchdog.settle();
  const safe = Boolean(close) && tree.gone && tree.survivors.length === 0 && !watchdog.timedOut;
  return { safe, close, tree };
}

async function finishProfile(t, profile, childState, graceful, shutdownConfirmed) {
  if (!childState) {
    t.diagnostic(`Delivered-host shutdown was not acknowledged; private evidence retained at ${profile.root}.`);
    return { safe: true, shutdownConfirmed: false };
  }
  const teardown = await closeChildTree(childState, { graceful });
  const confirmed = typeof shutdownConfirmed === 'function' ? shutdownConfirmed() : shutdownConfirmed;
  if (teardown.safe && confirmed) await rm(profile.root, { recursive: true, force: true });
  else t.diagnostic(`Delivered-host shutdown or process-tree teardown unconfirmed; private evidence retained at ${profile.root}. Tree result: ${JSON.stringify(teardown.tree ?? {})}`);
  return { ...teardown, shutdownConfirmed: confirmed };
}

function waitForMessage(childState, type, timeoutMs = 20_000) {
  const { child } = childState;
  const existing = childState.messages.find(message => message?.type === type);
  if (existing) return Promise.resolve(existing);
  const failure = childState.messages.find(message => ['fixture-error', 'deactivation-error', 'shutdown-error'].includes(message?.type));
  if (failure) return Promise.reject(new Error(failure.error));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      child.removeListener('close', onClose);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for fixture message ${type}.\n${childState.output}`));
    }, timeoutMs);
    const onMessage = message => {
      if (message?.type === type) {
        cleanup();
        resolve(message);
      } else if (['fixture-error', 'deactivation-error', 'shutdown-error'].includes(message?.type)) {
        cleanup();
        reject(new Error(message.error));
      }
    };
    const onClose = (code, signal) => {
      cleanup();
      reject(new Error(`fixture exited before ${type} (code ${code}, signal ${signal}).\n${childState.output}`));
    };
    child.on('message', onMessage);
    child.once('close', onClose);
  });
}

async function startRecordPathIsRelease(profile) {
  return realpath(path.join(profile.environment.PIE_DELIVERED_HOST_ROOT, 'out/pi-runtime/node_modules/@earendil-works/pi-coding-agent'));
}

async function verifySdkRecords(profile) {
  const raw = await readFile(profile.startLog, 'utf8');
  const records = raw.trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const recorded = records.filter(record => typeof record.sdkPath === 'string');
  assert.ok(recorded.length > 0, `expected at least one backend startup options record; saw:\n${raw}`);
  const expected = await startRecordPathIsRelease(profile);
  const checkout = await realpath(repositoryRoot);
  for (const record of recorded) {
    const selected = await realpath(record.sdkPath);
    assert.ok(samePath(selected, expected), `production host selected SDK outside the private release: ${record.sdkPath}`);
    assert.equal(isWithin(checkout, selected), false, 'backend SDK may not resolve through the checkout alias.');
  }
}

const skipReason = 'Set PIE_RUN_DELIVERED_HOST_TESTS=1 and PIE_DELIVERED_HOST_ROOT=<absolute external package root> to opt into the bounded delivered-host lane.';

test('delivered compiled standalone entry starts from one verified private release with isolated profile', { timeout: browserOptIn ? 210_000 : 120_000, skip: optIn ? false : skipReason }, async t => {
  const release = await verifiedRelease();
  const profile = await createProfile(release, { adapter: 'standalone' });
  let childState;
  let shutdownConfirmed = false;
  try {
    childState = startChild(process.execPath, [fixtureScript], {
      cwd: profile.workspace,
      env: profile.environment,
      label: 'delivered compiled standalone entry fixture',
      ipc: true,
    });
    const started = await waitForMessage(childState, 'started', 30_000);
    const baseUrl = started.url;
    assert.equal(new URL(baseUrl).hostname, '127.0.0.1');
    const httpPort = Number(new URL(baseUrl).port);
    assert.ok(httpPort > 0, 'standalone API must report its OS-assigned private HTTP port.');
    assert.notEqual(httpPort, profile.coordinatorPort, 'browser HTTP and coordinator ports must be distinct.');
    await verifyHealthAndAssets(baseUrl, childState);
    await verifyOptionalBrowserFirstPaint(t, baseUrl, profile);
    assertNoFixtureErrors(childState);
    await verifySdkRecords(profile);
    await assertNoExternalNetwork(profile);

    childState.child.send({ type: 'shutdown' });
    await waitForMessage(childState, 'resolved shutdown', 25_000);
    const result = await withTimeout(childState.completion, 18_000);
    assert.ok(result, `compiled standalone entry did not close after awaited shutdown.\n${childState.output}`);
    assert.equal(result.code, 0, childState.output);
    shutdownConfirmed = true;
  } finally {
    const teardown = await finishProfile(t, profile, childState, async () => {
      if (!childState?.child?.connected || childState.closed) return;
      try {
        const acknowledged = waitForMessage(childState, 'resolved shutdown', 20_000);
        childState.child.send({ type: 'shutdown' });
        await acknowledged;
        shutdownConfirmed = true;
      } catch {}
    }, () => shutdownConfirmed);
    assert.ok(teardown.safe, `standalone process-tree shutdown was not confirmed; profile retained at ${profile.root}.`);
  }
});

test('delivered VS Code packaged main bootstrap activates against fake vscode and the same private release', { timeout: browserOptIn ? 210_000 : 120_000, skip: optIn ? false : skipReason }, async t => {
  const release = await verifiedRelease();
  const immutableBefore = await payloadFingerprint(release);
  const browserPort = await allocatePort();
  const profile = await createProfile(release, { adapter: 'vscode', browserPort });
  let childState;
  let shutdownConfirmed = false;
  let deactivationRequested = false;
  try {
    childState = startChild(process.execPath, [fixtureScript], {
      cwd: profile.workspace,
      env: profile.environment,
      label: 'delivered VS Code compiled extension fixture',
      ipc: true,
    });
    const activated = await waitForMessage(childState, 'activated', 30_000);
    assert.equal(activated.output, path.join(release.root, 'out'));
    assert.equal(activated.extensionPath, release.root);
    assert.equal(activated.bootstrapEntry, path.join(release.root, 'runtime', 'bootstrap.cjs'));
    assert.equal(activated.activationPromise, true, 'packaged main must return an awaited activation promise');
    assert.deepEqual(activated.selectedRuntime, { runtimeOutDir: release.output, generation: null, publishedAt: 0 },
      'packaged bootstrap must delegate using the verified flat out fallback, not a published generation');
    assert.equal(activated.lastLoadedMarker, null, 'flat fallback must not counterfeit a loaded-generation marker');
    assert.equal(activated.selectionWatcherCount, 1, 'real bootstrap must watch private package selections');
    assert.equal(activated.progressCalls, 0, 'headless VS Code startup must not ask for a production host handoff.');
    assert.ok(isWithin(profile.profile, activated.globalStorage));
    assert.ok(isWithin(profile.profile, activated.storage));
    const baseUrl = `http://127.0.0.1:${browserPort}`;
    await verifyHealthAndAssets(baseUrl, childState);
    await verifyOptionalBrowserFirstPaint(t, baseUrl, profile);
    assertNoFixtureErrors(childState);
    await verifySdkRecords(profile);
    await assertNoExternalNetwork(profile);

    deactivationRequested = true;
    const deactivated = waitForMessage(childState, 'deactivated', 20_000);
    childState.child.send({ type: 'deactivate' });
    const cleanup = await deactivated;
    assert.equal(cleanup.selectionWatcherCount, 0, 'bootstrap selection watcher close must be confirmed');
    assert.deepEqual(cleanup.leases, [], 'flat fallback must leave no generation lease');
    assert.deepEqual(cleanup.selections, [], 'startup must not publish a generation selection');
    const result = await withTimeout(childState.completion, 18_000);
    assert.ok(result, `compiled extension process did not close after awaited deactivate.\n${childState.output}`);
    assert.equal(result.code, 0, childState.output);
    shutdownConfirmed = true;
  } finally {
    const teardown = await finishProfile(t, profile, childState, () => {
      if (!deactivationRequested && childState?.child?.connected && !childState.closed) {
        childState.child.send({ type: 'deactivate' });
        deactivationRequested = true;
      }
    }, shutdownConfirmed);
    assert.ok(teardown.safe, `VS Code fixture process-tree shutdown was not confirmed; profile retained at ${profile.root}.`);
    assert.deepEqual(await payloadFingerprint(release), immutableBefore, 'packaged bootstrap must leave all out/SDK, runtime CJS and manifest bytes unchanged');
    t.diagnostic(`Packaged main used flat out fallback and awaited activation; watcher closed, no generation leases/selections; ${immutableBefore.files} immutable payload files unchanged. Full Electron startup remains unqualified.`);
  }
});
