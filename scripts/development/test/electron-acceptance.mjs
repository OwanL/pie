#!/usr/bin/env node
// Explicit, visible, isolated Electron acceptance; consumes existing out-dev only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareDevelopment } from '../launch.mjs';
import { resolveOwnerModule } from '../../lib/package-resolution.mjs';
import { snapshotProcessTree, watchChildProcess } from '../../lib/process-watchdog.mjs';

// A browser-level CDP attachment survives Playwright's stale OOPIF topology.
// Only this isolated acceptance endpoint is inspected; no installed host target.
async function connectTargetInspector(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    } else for (const listener of listeners) listener(message);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Isolated CDP endpoint closed')); }
    pending.clear();
  });
  return {
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 3000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    listeners,
    close: () => socket.close(),
  };
}
const sidebarProof = () => ({ transport: document.querySelector('meta[name="pie-transport"]')?.content, assetVersion: document.querySelector('meta[name="pie-asset-version"]')?.content, viewGeneration: Number(document.querySelector('meta[name="pie-view-generation"]')?.content), scripts: [...document.scripts].map(s => s.src), text: document.body?.innerText, rootChildren: document.querySelector('#app')?.childElementCount, visible: document.visibilityState, bounds: document.querySelector('#app')?.getBoundingClientRect().toJSON() });
const visibleSidebar = proof => Boolean(proof?.assetVersion && proof.rootChildren > 0 && proof.bounds?.width > 0 && proof.bounds?.height > 0 && proof.visible === 'visible');
const sidebarDeadlineMs = 15000;
const sha256 = value => createHash('sha256').update(value).digest('hex');
function assertCommittedSidebar(debug, identity) {
  const sidebar = debug?.sidebar;
  assert.ok(sidebar, 'Missing sidebar commit debug evidence');
  assert.equal(sidebar.hasView, true);
  assert.equal(sidebar.visible, true);
  assert.equal(sidebar.webviewReady, true);
  assert.equal(debug.viewState?.backendReady, true);
  assert.equal(sidebar.globalDirty, false, 'Sidebar still has undelivered state');
  assert.ok(Number.isSafeInteger(sidebar.lastStateAppliedRevision) && sidebar.lastStateAppliedRevision > 0, 'No transcript committed revision');
  assert.equal(sidebar.lastStateAppliedRevision, sidebar.globalRevision, 'Latest sidebar revision has not transcript-committed');
  assert.equal(sidebar.pendingStateAppliedRevision, null, 'An accepted revision is still waiting for transcript commit');
  assert.ok(Number.isSafeInteger(sidebar.viewGeneration) && sidebar.viewGeneration > 0);
  assert.equal(sidebar.viewGeneration, identity.viewGeneration, 'Sidebar generation changed/reloaded');
  assert.equal(sidebar.hostInstanceId, identity.hostInstanceId, 'Host instance changed');
}
function assertNoRecovery(trace) {
  assert.doesNotMatch(trace, /delivery\.(?:commit-timeout|post-timeout)|reload\.started|host\.recovery|readiness probe force-cleared|render evidence protocol defect/iu, 'Sidebar timed out, reloaded, or recovered during acceptance');
}
if (process.argv.includes('--self-test')) {
  const identity = { viewGeneration: 1, hostInstanceId: 'test-host' };
  const good = { sidebar: { hasView: true, visible: true, webviewReady: true, globalDirty: false, globalRevision: 3, lastStateAppliedRevision: 3, pendingStateAppliedRevision: null, ...identity }, viewState: { backendReady: true } };
  assertCommittedSidebar(good, identity);
  for (const patch of [{ lastStateAppliedRevision: 0 }, { lastStateAppliedRevision: 2 }, { pendingStateAppliedRevision: 4 }, { viewGeneration: 2 }, { hostInstanceId: 'retired' }, { globalDirty: true }]) {
    assert.throws(() => assertCommittedSidebar({ ...good, sidebar: { ...good.sidebar, ...patch } }, identity));
  }
  assert.throws(() => assertCommittedSidebar({ viewState: { backendReady: true } }, identity));
  for (const trace of ['delivery.commit-timeout', 'delivery.post-timeout', 'reload.started', 'host.recovery.action']) assert.throws(() => assertNoRecovery(trace));
  assertNoRecovery('delivery.commit-advanced');
  const visible = { assetVersion: 'requested', rootChildren: 1, bounds: { width: 297, height: 794 }, visible: 'visible' };
  assert.equal(visibleSidebar(visible), true);
  for (const patch of [{ assetVersion: undefined }, { rootChildren: 0 }, { bounds: { width: 0, height: 794 } }, { visible: 'hidden' }]) assert.equal(visibleSidebar({ ...visible, ...patch }), false);
  console.log('Electron acceptance assertion self-tests passed (no window launched).');
  process.exit(0);
}
assert.equal(process.env.PIE_RUN_ELECTRON_ACCEPTANCE, '1', 'Visible Electron acceptance requires explicit opt-in.');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const profile = await mkdtemp(path.join(os.tmpdir(), 'pie-electron-acceptance-'));
console.log(`Evidence: ${profile}`);
const evidence = { profile };
const save = async () => writeFile(path.join(profile, 'acceptance.json'), JSON.stringify(evidence, null, 2));
const wait = async (probe, label, ms = 60000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timeout: ${label}`);
};
const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
const available = async port => {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  const bound = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return bound;
};
const sourceEnvironment = { ...process.env };
for (const key of Object.keys(sourceEnvironment)) if (/API_KEY|TOKEN|SECRET|CREDENTIAL|AUTH|PASSWORD|BEARER|COOKIE|PRIVATE_KEY|LIVE_TEST|LIVE_MODEL/iu.test(key)) delete sourceEnvironment[key];
delete sourceEnvironment.NODE_OPTIONS;
delete sourceEnvironment.ELECTRON_RUN_AS_NODE;
// Do not carry installed-host state authorities into this fresh profile.
for (const key of ['PIE_SESSION_SETTINGS_DIR', 'PIE_LEGACY_SESSION_SETTINGS_DIR', 'PIE_STATE_DIR']) delete sourceEnvironment[key];
sourceEnvironment.PI_BOOT_LOG = '1';
const prepared = await prepareDevelopment({ repositoryRoot: root, profileRoot: profile, sourceEnvironment });
for (const key of ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_AUTH_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PIE_DATA_DIR', 'PIE_SESSION_SETTINGS_DIR', 'PIE_LEGACY_SESSION_SETTINGS_DIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR']) assert.ok(prepared.env[key].startsWith(profile + path.sep));
await available(prepared.coordinatorPort);
await available(prepared.browserPort);
const cdpPort = await available(0);
const settings = path.join(profile, 'vscode-user/User/settings.json');
const settingsValue = JSON.parse(await readFile(settings));
Object.assign(settingsValue, { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'pie.browserServer.allowLan': false });
await writeFile(settings, JSON.stringify(settingsValue));
const output = prepared.output;
const buildId = (await readFile(path.join(output, 'pie-build-id.txt'), 'utf8')).trim();
const digest = async file => sha256(await readFile(file));
const rendererRoot = path.join(output, 'webview/panel');
const manifestPath = path.join(rendererRoot, '.vite/manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const entry = Object.values(manifest).find(chunk => chunk.isEntry);
assert.ok(entry?.file, 'Missing requested renderer entry');
const rendererEntry = path.join(rendererRoot, entry.file);
const rendererSource = await readFile(rendererEntry, 'utf8');
const rendererBuildId = (await readFile(path.join(rendererRoot, 'pie-build-id.txt'), 'utf8')).trim();
assert.ok(buildId && rendererBuildId && rendererSource.includes(rendererBuildId), 'Requested renderer script does not contain its compiled renderer build identity');
// Incremental renderer rebuilds may differ from the running host build. The
// contract permits this for the same protocol; compare each delivered payload
// to its own compiled marker rather than requiring a full host rebuild.
evidence.build = { buildId, rendererBuildId, output, extensionSha256: await digest(path.join(output, 'extension.js')), manifestSha256: await digest(manifestPath), assetVersion: sha256(JSON.stringify(manifest)).slice(0, 16), rendererEntry, rendererSha256: sha256(rendererSource), wrapper: await readFile(path.join(prepared.extension, 'development.cjs'), 'utf8') };
evidence.isolation = { coordinatorPort: prepared.coordinatorPort, browserPort: prepared.browserPort, cdpPort, env: Object.fromEntries(Object.entries(prepared.env).filter(([key]) => /^(PI_|PIE_|HOME$|USERPROFILE$|TEMP$|TMP$|TMPDIR$)/u.test(key))) };
const readersDir = path.join(root, 'harness/pi/.cache/development-runtime/readers');
assert.deepEqual(await readdir(readersDir), [], 'Shared reader gate must initially be empty');
const runner = path.join(profile, 'electron-tests.cjs');
await writeFile(runner, `const vscode=require('vscode');const fs=require('node:fs/promises');const path=require('node:path');const profile=${JSON.stringify(profile)};exports.run=async()=>{const ext=vscode.extensions.getExtension('pie.pie');if(!ext)throw Error('Missing real extension');await ext.activate();await vscode.commands.executeCommand('pie.openChat');await fs.writeFile(path.join(profile,'activation.json'),JSON.stringify({id:ext.id,isActive:ext.isActive,extensionPath:ext.extensionPath,entry:ext.packageJSON.main,vscodeVersion:vscode.version,pid:process.pid}));while(true){try{await fs.access(path.join(profile,'close-request'));await require(ext.extensionPath+'/development.cjs').deactivate();return;}catch{}try{await fs.access(path.join(profile,'dump-request'));await fs.unlink(path.join(profile,'dump-request'));void vscode.commands.executeCommand('pie.dumpDebugState').catch(()=>{});}catch{}await new Promise(r=>setTimeout(r,200));}};`);
const executable = process.env.PIE_ACCEPTANCE_CODE_EXECUTABLE || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
await stat(executable);
const args = ['--new-window', '--user-data-dir', path.join(profile, 'vscode-user'), '--extensions-dir', path.join(profile, 'vscode-extensions'), `--extensionDevelopmentPath=${prepared.extension}`, `--extensionTestsPath=${runner}`, `--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1', '--skip-welcome', '--skip-release-notes', root];
evidence.launch = { executable, args };
let log = '';
const child = spawn(executable, args, { cwd: root, env: prepared.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
child.stdout.on('data', data => { log += data; });
child.stderr.on('data', data => { log += data; });
const watchdog = watchChildProcess(child, { timeoutMs: 180000, label: 'owned visible Electron acceptance' });
let browser;
let headlessBrowser;
let headlessOwned = [];
let owned;
let targetInspector;
try {
  evidence.activation = await wait(async () => readJson(path.join(profile, 'activation.json')), 'real VS Code activation');
  assert.equal(evidence.activation.isActive, true);
  await wait(async () => (await readdir(readersDir)).length === 1, 'development SDK reader');
  evidence.readersActive = await Promise.all((await readdir(readersDir)).map(async name => ({ name, record: JSON.parse(await readFile(path.join(readersDir, name), 'utf8')) })));
  assert.equal(evidence.readersActive.length, 1);
  assert.equal(evidence.readersActive[0].record.pid, evidence.activation.pid);
  const playwright = await import(pathToFileURL(resolveOwnerModule('playwright', { dependencyOwnerRoot: path.join(root, 'extensions/playwright') })).href);
  const { chromium } = playwright.default ?? playwright;
  await wait(async () => fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(r => r.ok).catch(() => false), 'loopback CDP');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  evidence.cdp = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(r => r.json());
  const page = await wait(async () => browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('workbench')), 'Electron workbench');
  await page.bringToFront();
  evidence.workbench = { url: page.url(), title: await page.title(), status: await page.locator('body').innerText() };
  targetInspector = await connectTargetInspector(evidence.cdp.webSocketDebuggerUrl);
  const attachments = new Map();
  const targetEvents = [];
  targetInspector.listeners.add(message => {
    const attachment = [...attachments.values()].find(item => item.sessionId === message.sessionId);
    if (message.method === 'Runtime.executionContextCreated' && attachment) attachment.contexts.set(message.params.context.id, message.params.context);
    if (message.method === 'Runtime.executionContextDestroyed' && attachment) attachment.contexts.delete(message.params.executionContextId);
    if (message.method === 'Runtime.executionContextsCleared' && attachment) attachment.contexts.clear();
    if (message.method === 'Debugger.scriptParsed' && attachment) attachment.scripts.push(message.params);
    if (['Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Target.detachedFromTarget'].includes(message.method)) targetEvents.push({ method: message.method, sessionId: message.sessionId ?? message.params.sessionId, params: message.params, at: new Date().toISOString() });
  });
  const evaluateProof = async (attachment, contextId) => {
    const result = await targetInspector.send('Runtime.evaluate', { expression: `(${sidebarProof.toString()})()`, contextId, returnByValue: true }, attachment.sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  let rendererTarget;
  let rendererContext;
  evidence.targetInspection = { targets: [], probes: [] };
  evidence.sidebar = await wait(async () => {
    const { targetInfos } = await targetInspector.send('Target.getTargets');
    evidence.targetInspection.targets = targetInfos;
    for (const target of targetInfos.filter(item => item.url.startsWith('vscode-webview://'))) {
      let attachment = attachments.get(target.targetId);
      if (!attachment) {
        const { sessionId } = await targetInspector.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        attachment = { sessionId, contexts: new Map(), scripts: [], target };
        attachments.set(target.targetId, attachment);
        await targetInspector.send('Runtime.enable', {}, sessionId);
      }
      for (const context of attachment.contexts.values()) {
        if (!context.auxData?.isDefault) continue;
        const proof = await evaluateProof(attachment, context.id).catch(error => ({ error: String(error) }));
        evidence.targetInspection.probes = evidence.targetInspection.probes.filter(item => !(item.targetId === target.targetId && item.contextId === context.id));
        evidence.targetInspection.probes.push({ targetId: target.targetId, contextId: context.id, context, proof });
        if (visibleSidebar(proof)) {
          rendererTarget = attachment;
          rendererContext = context.id;
          return { targetId: target.targetId, sessionId: attachment.sessionId, contextId: context.id, url: target.url, ...proof };
        }
      }
    }
  }, 'visible sidebar DOM via exact isolated CDP target', sidebarDeadlineMs);
  await save();
  assert.equal(evidence.sidebar.assetVersion, evidence.build.assetVersion, 'Sidebar selected a different renderer manifest');
  // Debugger reads the executing payload in the same target/context as the DOM.
  await targetInspector.send('Debugger.enable', {}, rendererTarget.sessionId);
  const loadedScript = await wait(async () => rendererTarget.scripts.find(script => script.executionContextId === rendererContext && evidence.sidebar.scripts.includes(script.url) && decodeURIComponent(script.url).includes(entry.file)), 'exact executing sidebar entry', 5000);
  const loadedSource = await targetInspector.send('Debugger.getScriptSource', { scriptId: loadedScript.scriptId }, rendererTarget.sessionId);
  evidence.loadedRenderer = { targetId: evidence.sidebar.targetId, contextId: rendererContext, url: loadedScript.url, scriptId: loadedScript.scriptId, sha256: sha256(loadedSource.scriptSource), buildIdPresent: loadedSource.scriptSource.includes(rendererBuildId) };
  assert.equal(evidence.loadedRenderer.sha256, evidence.build.rendererSha256, 'Executing sidebar payload differs from requested script');
  assert.equal(evidence.loadedRenderer.buildIdPresent, true);
  await targetInspector.send('Debugger.disable', {}, rendererTarget.sessionId);

  const debugPath = path.join(profile, 'vscode-user/User/globalStorage/pie.pie/pie-debug-state.json');
  const freshDebug = async () => {
    await unlink(debugPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await writeFile(path.join(profile, 'dump-request'), '');
    const debug = await wait(async () => readJson(debugPath), 'fresh sidebar debug state', 3000);
    // Dismiss dump notification; readiness/app receipt alone never satisfy commit.
    await page.keyboard.press('Escape');
    evidence.debug = debug;
    return debug;
  };
  const committed = await wait(async () => {
    const debug = await freshDebug();
    try {
      assertCommittedSidebar(debug, { viewGeneration: evidence.sidebar.viewGeneration, hostInstanceId: debug.sidebar?.hostInstanceId });
      return debug;
    } catch (error) {
      evidence.commitPending = String(error);
      return null;
    }
  }, 'current-generation latest transcript commit (not app receipt)', sidebarDeadlineMs);
  const identity = { viewGeneration: committed.sidebar.viewGeneration, hostInstanceId: committed.sidebar.hostInstanceId };
  assert.ok(identity.hostInstanceId, 'Missing committed host identity');
  evidence.stability = { identity, intervalMs: sidebarDeadlineMs, startedAt: new Date().toISOString(), samples: [] };
  const stableEventOffset = targetEvents.length;
  const assertStableRenderer = async () => {
    const events = targetEvents.slice(stableEventOffset).filter(event => event.sessionId === rendererTarget.sessionId && (event.method !== 'Runtime.executionContextDestroyed' || event.params.executionContextId === rendererContext));
    assert.deepEqual(events, [], 'Sidebar target/context destroyed during commit stability interval');
    const proof = await evaluateProof(rendererTarget, rendererContext);
    assert.ok(visibleSidebar(proof), 'Sidebar is no longer visibly rendered');
    assert.equal(proof.viewGeneration, identity.viewGeneration);
    assert.equal(proof.assetVersion, evidence.build.assetVersion);
    evidence.stability.renderer = { targetId: evidence.sidebar.targetId, contextId: rendererContext, ...proof };
  };
  const stableUntil = Date.now() + sidebarDeadlineMs;
  do {
    const debug = await freshDebug();
    evidence.stability.samples.push({ capturedAt: debug.capturedAt, ...debug.sidebar });
    assertCommittedSidebar(debug, identity);
    await assertStableRenderer();
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < stableUntil);
  // Include a fresh observation after the whole deadline interval has elapsed.
  assertCommittedSidebar(await freshDebug(), identity);
  await assertStableRenderer();
  evidence.stability.targetEvents = targetEvents.slice(stableEventOffset);
  evidence.stability.finishedAt = new Date().toISOString();
  const bootTrace = await readFile(path.join(prepared.env.TEMP, 'pie-boot-trace.jsonl'), 'utf8');
  evidence.stability.bootTrace = bootTrace;
  assertNoRecovery(bootTrace);
  delete evidence.commitPending;
  headlessBrowser = await chromium.launch({ headless: true });
  headlessOwned = snapshotProcessTree(process.pid).filter(p => !snapshotProcessTree(child.pid).some(code => code.pid === p.pid) && p.pid !== process.pid);
  const browserPage = await headlessBrowser.newPage();
  const socketMessages = [];
  browserPage.on('websocket', socket => socket.on('framereceived', event => { try { const value = JSON.parse(String(event.payload)); if (['rendererHello', 'state', 'snapshot'].includes(value.type)) socketMessages.push(value); } catch {} }));
  await browserPage.goto(`http://127.0.0.1:${prepared.browserPort}/`);
  await wait(async () => socketMessages.some(m => JSON.stringify(m).includes('"backendReady":true')), 'browser backendReady');
  evidence.browser = { url: browserPage.url(), dom: await browserPage.locator('body').innerText(), scripts: await browserPage.locator('script[src]').evaluateAll(nodes => nodes.map(n => n.src)), handshake: socketMessages };
  evidence.backendReady = true;
  assertCommittedSidebar(await freshDebug(), identity);
  assertNoRecovery(await readFile(path.join(prepared.env.TEMP, 'pie-boot-trace.jsonl'), 'utf8'));
  assert.equal(await digest(path.join(output, 'extension.js')), evidence.build.extensionSha256, 'Host payload changed during acceptance');
  assert.equal((await readFile(path.join(output, 'pie-build-id.txt'), 'utf8')).trim(), buildId, 'Build identity changed during acceptance');
  assert.equal(await digest(manifestPath), evidence.build.manifestSha256, 'Renderer manifest changed during acceptance');
  assert.equal(await digest(rendererEntry), evidence.build.rendererSha256, 'Requested renderer payload changed during acceptance');
  evidence.accepted = true;
} catch (error) {
  evidence.accepted = false;
  evidence.error = String(error.stack ?? error);
  if (targetInspector) evidence.targetsAtFailure = await targetInspector.send('Target.getTargets').catch(error => ({ error: String(error) }));
  process.exitCode = 1;
} finally {
  await headlessBrowser?.close().catch(() => {});
  evidence.headlessOwned = headlessOwned;
  evidence.headlessSurvivors = headlessOwned.filter(p => { try { process.kill(p.pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } });
  owned = snapshotProcessTree(child.pid);
  evidence.ownedBeforeClosure = owned;
  await save();
  // Returning from VS Code's test runner is its scoped, graceful app exit path.
  await writeFile(path.join(profile, 'close-request'), '');
  evidence.close = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 20000))]);
  const tree = await watchdog.settle();
  const stillLive = owned.filter(p => { try { process.kill(p.pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } });
  evidence.teardown = { tree, stillLive, readers: await readdir(readersDir), watchdogTimedOut: watchdog.timedOut };
  evidence.teardown.confirmed = evidence.close.code === 0 && tree.gone && stillLive.length === 0 && evidence.teardown.readers.length === 0 && owned.every(p => p.identity != null);
  if (!evidence.teardown.confirmed) process.exitCode = 1;
  await writeFile(path.join(profile, 'electron.log'), log);
  await save();
  targetInspector?.close();
  await browser?.close().catch(() => {});
  console.log(JSON.stringify({ evidence: path.join(profile, 'acceptance.json'), accepted: evidence.accepted ?? false, teardownConfirmed: evidence.teardown.confirmed, error: evidence.error }));
}
