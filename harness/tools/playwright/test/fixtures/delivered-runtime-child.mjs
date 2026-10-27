import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [extensionRootArgument, sdkPackageArgument, sandboxArgument, proofPathArgument] = process.argv.slice(2);
for (const [name, value] of Object.entries({
  extensionRoot: extensionRootArgument,
  sdkPackage: sdkPackageArgument,
  sandbox: sandboxArgument,
  proofPath: proofPathArgument,
})) {
  assert.ok(value && path.isAbsolute(value), `${name} must be an absolute path`);
}
const extensionRoot = path.resolve(extensionRootArgument);
const sdkPackage = path.resolve(sdkPackageArgument);
const sandbox = path.resolve(sandboxArgument);
const proofPath = path.resolve(proofPathArgument);
assert.equal(path.dirname(proofPath), sandbox, 'proof must be written directly in the private sandbox');

const extensionEntry = path.join(extensionRoot, 'out', 'playwright.js');
const sdkEntry = path.join(sdkPackage, 'dist', 'index.js');
const runtimeRoot = path.join(extensionRoot, 'out', 'resources', 'tool-runtimes');
const sidecarEntry = path.join(runtimeRoot, 'harness', 'tools', 'playwright', 'sidecar.mjs');
const browserRoot = path.join(runtimeRoot, 'playwright-runtime', 'browsers');
const moduleRoot = path.join(runtimeRoot, 'playwright-runtime', 'node_modules');
for (const file of [extensionEntry, sdkEntry, sidecarEntry, path.join(runtimeRoot, 'manifest.json')]) {
  assert.ok(existsSync(file), `missing delivered file: ${file}`);
}

function assertPrivate(name) {
  const value = process.env[name];
  assert.ok(value, `${name} must be explicitly isolated`);
  const relative = path.relative(sandbox, path.resolve(value));
  assert.ok(relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)), `${name} escaped the private sandbox: ${value}`);
}
for (const name of [
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'PIE_DATA_ROOT', 'PIE_DATA_DIR', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_AUTH_DIR',
  'PI_CODING_AGENT_SESSION_DIR', 'PSModulePath', 'PSModuleAnalysisCachePath', 'NPM_CONFIG_CACHE',
  'PLAYWRIGHT_BROWSERS_PATH', 'PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT', 'PUPPETEER_CACHE_DIR',
]) assertPrivate(name);
assert.equal(process.env['NODE_OPTIONS'], undefined);
assert.equal(process.env['NODE_PATH'], undefined);

const requestedSessionPath = path.join(process.env['PI_CODING_AGENT_SESSION_DIR'], 'delivered-session.jsonl');
const cwd = path.join(sandbox, 'workspace');
const agentDir = process.env['PI_CODING_AGENT_DIR'];
const directories = [
  cwd,
  agentDir,
  process.env['PI_CODING_AGENT_AUTH_DIR'],
  process.env['PI_CODING_AGENT_SESSION_DIR'],
  process.env['PIE_DATA_DIR'],
  process.env['XDG_CACHE_HOME'],
  process.env['XDG_RUNTIME_DIR'],
  process.env['APPDATA'],
  process.env['LOCALAPPDATA'],
  process.env['XDG_CONFIG_HOME'],
  process.env['PSModulePath'],
  path.dirname(process.env['PSModuleAnalysisCachePath']),
  path.dirname(process.env['NPM_CONFIG_CACHE']),
];
await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));
await writeFile(requestedSessionPath, '', { flag: 'wx' });
const sessionPath = await realpath(requestedSessionPath);
const sessionArtifactsRoot = path.join(path.dirname(sessionPath), 'playwright');

// Instrument the shared child_process module before the delivered SDK loader or
// extension factory is imported. This records the actual prepared sidecar entry,
// Node executable, and only the relevant private/payload environment fields.
const repoRequire = createRequire(path.join(sandbox, 'loader-owner.cjs'));
const childProcess = repoRequire('node:child_process');
const originalSpawn = childProcess.spawn;
const sidecarLaunches = [];
childProcess.spawn = function (command, args, options) {
  const entry = Array.isArray(args) && typeof args[0] === 'string' ? args[0] : undefined;
  if (entry && path.resolve(entry) === path.resolve(sidecarEntry)) {
    const childEnv = options?.env ?? {};
    sidecarLaunches.push({
      executable: String(command),
      entry,
      env: {
        PLAYWRIGHT_BROWSERS_PATH: childEnv['PLAYWRIGHT_BROWSERS_PATH'],
        PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT: childEnv['PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT'],
        NODE_OPTIONS: childEnv['NODE_OPTIONS'],
        NODE_PATH: childEnv['NODE_PATH'],
        HOME: childEnv['HOME'],
        USERPROFILE: childEnv['USERPROFILE'],
        TEMP: childEnv['TEMP'],
        PIE_DATA_DIR: childEnv['PIE_DATA_DIR'],
        PI_CODING_AGENT_DIR: childEnv['PI_CODING_AGENT_DIR'],
      },
    });
  }
  return originalSpawn.call(this, command, args, options);
};

const sdk = await import(pathToFileURL(sdkEntry).href);
const resourceLoader = new sdk.DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager: sdk.SettingsManager.inMemory(),
  additionalExtensionPaths: [extensionEntry],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await resourceLoader.reload();
const loaded = resourceLoader.getExtensions();
assert.deepEqual(loaded.errors, [], 'the delivered factory must load without extension errors');
assert.equal(loaded.extensions.length, 1, 'load only the delivered Playwright factory');
const extension = loaded.extensions[0];
assert.equal(path.resolve(extension.resolvedPath), path.resolve(extensionEntry));
const toolEntries = [...extension.tools.values()];
assert.deepEqual(toolEntries.map((entry) => entry.definition.name), ['playwright']);
const tool = toolEntries[0].definition;
assert.equal(typeof tool.execute, 'function');
const shutdownHandlers = extension.handlers.get('session_shutdown') ?? [];
assert.equal(shutdownHandlers.length, 1, 'the delivered factory must register its real session_shutdown handler');
const shutdownHandler = shutdownHandlers[0];

const context = {
  sessionManager: { getSessionFile: () => sessionPath },
  model: { input: ['text', 'image'] },
};
const runtimeState = globalThis[Symbol.for('pie.playwright.runtime')];
assert.ok(runtimeState?.registry, 'the delivered factory must expose its actual RuntimeRegistry singleton');
const registry = runtimeState.registry;
let operationError;
let opened;
let routed;
let observed;
let closed;
let pids;
let shutdownHandlerInvoked = false;
let registryEntryBeforeShutdown = false;
let sidecarAliveBeforeShutdown = false;
let browserPidsAfterClose = [];
let registryEntryAfterShutdown = true;
const cleanupErrors = [];

try {
  opened = await tool.execute('delivered-open', {
    action: 'open', sessionId: 'delivered-artifact', url: 'about:blank', navigationTimeoutMs: 10_000,
  }, undefined, undefined, context);
  const openText = opened.content.find((part) => part.type === 'text')?.text ?? '';
  assert.match(openText, /browser: headless Chromium/);
  assert.match(openText, /isolated context/);

  routed = await tool.execute('delivered-network-guard', {
    action: 'run_code',
    sessionId: 'delivered-artifact',
    timeout: 10_000,
    code: "await page.route('**/*', (route) => route.abort('blockedbyclient')); return 'external page requests blocked';",
    observation: { mode: 'none' },
  }, undefined, undefined, context);
  const routedText = routed.content.find((part) => part.type === 'text')?.text ?? '';
  assert.match(routedText, /external page requests blocked/);

  const client = await registry.peek(sessionPath);
  assert.ok(client, 'the actual tool must register its RuntimeClient under the private session path');
  pids = await client.request('debug_pids', {}, { timeoutMs: 10_000 });
  assert.ok(Number.isInteger(pids.sidecarPid) && pids.sidecarPid > 0);
  assert.ok(Array.isArray(pids.browserPids) && pids.browserPids.length > 0);

  observed = await tool.execute('delivered-observe', {
    action: 'observe', sessionId: 'delivered-artifact', observation: { screenshot: true },
  }, undefined, undefined, context);
  const observeText = observed.content.find((part) => part.type === 'text')?.text ?? '';
  assert.match(observeText, /url: about:blank/);
  assert.equal(observed.content.filter((part) => part.type === 'image').length, 1);

  closed = await tool.execute('delivered-close', {
    action: 'close', scope: 'session', sessionId: 'delivered-artifact',
  }, undefined, undefined, context);
  assert.match(closed.content.find((part) => part.type === 'text')?.text ?? '', /closed_session: delivered-artifact/);
  const clientAfterClose = await registry.peek(sessionPath);
  assert.ok(clientAfterClose, 'close must not substitute for the owning session_shutdown event');
  registryEntryBeforeShutdown = true;
  const pidsAfterClose = await clientAfterClose.request('debug_pids', {}, { timeoutMs: 10_000 });
  assert.equal(pidsAfterClose.sidecarPid, pids.sidecarPid);
  browserPidsAfterClose = pidsAfterClose.browserPids;
  assert.deepEqual(browserPidsAfterClose, [], 'close must leave no browser process before owner shutdown');
  sidecarAliveBeforeShutdown = isProcessAlive(pids.sidecarPid);
  assert.equal(sidecarAliveBeforeShutdown, true, 'the sidecar must still be live for session_shutdown to terminate');
} catch (error) {
  operationError = error;
} finally {
  try {
    shutdownHandlerInvoked = true;
    await shutdownHandler(undefined, context);
  } catch (error) {
    cleanupErrors.push(`session_shutdown handler: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    registryEntryAfterShutdown = (await registry.peek(sessionPath)) !== undefined;
    if (registryEntryAfterShutdown) {
      cleanupErrors.push('session_shutdown left the runtime registry entry installed');
      await registry.shutdownSession(sessionPath);
    }
  } catch (error) {
    cleanupErrors.push(`registry verification/fallback: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (pids) {
    try {
      await waitForExit([pids.sidecarPid, ...pids.browserPids], 15_000);
    } catch (error) {
      cleanupErrors.push(`process-tree exit: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
if (operationError) throw operationError;
assert.deepEqual(cleanupErrors, [], 'the real shutdown path must clean up without fallback');

function textOf(result) {
  return result?.content?.find((part) => part.type === 'text')?.text ?? '';
}
function field(text, name) {
  const match = text.match(new RegExp(`^${name}: (.+)$`, 'm'));
  assert.ok(match, `missing ${name} in tool result:\n${text}`);
  return match[1];
}
function assertInside(base, candidate) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  assert.ok(relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${candidate} escaped ${base}`);
}

const observeText = textOf(observed);
const screenshotPaths = [field(observeText, 'display_png'), field(observeText, 'full_png')];
for (const screenshotPath of screenshotPaths) assertInside(sessionArtifactsRoot, screenshotPath);
const screenshotStats = await Promise.all(screenshotPaths.map((screenshotPath) => stat(screenshotPath)));
const sessionStats = await stat(sessionPath);
const deadPids = await waitForExit([pids.sidecarPid, ...pids.browserPids], 1_000);
assert.equal((await registry.peek(sessionPath)), undefined);

await writeFile(proofPath, `${JSON.stringify({
  nodeExecutable: process.execPath,
  extensionRoot,
  extensionEntry,
  sdkEntry,
  loadedExtensions: loaded.extensions.map((entry) => entry.resolvedPath),
  registeredTools: toolEntries.map((entry) => entry.definition.name),
  sessionPath,
  sessionFileBytes: sessionStats.size,
  sessionArtifactsRoot,
  screenshotPaths,
  screenshotBytes: screenshotStats.map((entry) => entry.size),
  openText: textOf(opened),
  routedText: textOf(routed),
  observeText,
  closeText: textOf(closed),
  screenshotImageParts: observed.content.filter((part) => part.type === 'image').length,
  sidecarLaunches,
  pids,
  shutdownHandlerInvoked,
  registryEntryBeforeShutdown,
  sidecarAliveBeforeShutdown,
  browserPidsAfterClose,
  registryEntryAfterShutdown,
  deadPids,
  cleanupErrors,
}, null, 2)}\n`, { flag: 'wx' });

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === 'ESRCH' || error?.code === 'EINVAL') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForExit(pidsToCheck, timeoutMs) {
  const pending = new Set(pidsToCheck);
  const deadline = Date.now() + timeoutMs;
  while (pending.size && Date.now() < deadline) {
    for (const pid of pending) {
      try { process.kill(pid, 0); }
      catch (error) {
        if (error?.code === 'ESRCH' || error?.code === 'EINVAL') pending.delete(pid);
      }
    }
    if (pending.size) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual([...pending], [], `processes did not exit within ${timeoutMs}ms: ${[...pending].join(', ')}`);
  return pidsToCheck;
}
