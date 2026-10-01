import assert from 'node:assert/strict';
import { createRequire, isBuiltin, registerHooks, syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  verifyPiRuntimeArtifact,
  type PiRuntimeTarget,
} from '../../../../../lib/pi-runtime/artifact.mjs';
import { verifySdkRuntimeArtifactDescriptor } from '../sdk-runtime-artifact';
import { loadSdk, loadSdkInternalModule, type SdkModule } from '../sdk';
import { createRuntimeFactory, ServiceLoadingGate } from '../../../workers/runtime-factory';
import { HISTORY_COMPACTION_ENV } from '../../../../session-storage/settings/history-compaction.js';

// --sdk-path binds sourceFixture to a materialized graph. Workspace runs skip
// this integration rather than accidentally exercising the installed SDK.
const TARGET: PiRuntimeTarget = {
  platform: process.platform,
  arch: process.arch,
  nodeAbi: process.versions.modules,
};

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithin(file: string, root: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).replaceAll('/', '\\');
    const withoutDevicePrefix = resolved.startsWith('\\\\?\\') ? resolved.slice(4) : resolved;
    return process.platform === 'win32' ? withoutDevicePrefix.toLowerCase() : withoutDevicePrefix;
  };
  const normalizedFile = normalize(file);
  const normalizedRoot = normalize(root).replace(/[\\]+$/u, '');
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}\\`);
}

function denyNetwork(): () => void {
  const require = createRequire(import.meta.url);
  const restorers: Array<() => void> = [];
  const block = (): never => { throw new Error('Network access is forbidden in source SDK artifact tests.'); };
  for (const [moduleName, names] of [
    ['node:net', ['connect', 'createConnection']],
    ['node:tls', ['connect']],
    ['node:http', ['request', 'get']],
    ['node:https', ['request', 'get']],
  ] as const) {
    const moduleExports = require(moduleName) as Record<string, unknown>;
    for (const name of names) {
      const original = moduleExports[name];
      if (typeof original !== 'function') continue;
      moduleExports[name] = block;
      restorers.push(() => { moduleExports[name] = original; });
    }
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Network access is forbidden in source SDK artifact tests.'); }) as typeof fetch;
  syncBuiltinESMExports();
  return () => {
    globalThis.fetch = originalFetch;
    for (const restore of restorers.reverse()) restore();
    syncBuiltinESMExports();
  };
}

function prototypeSnapshot(prototype: object): PropertyDescriptorMap {
  return Object.getOwnPropertyDescriptors(prototype);
}

function appendOverflowFixture(manager: any, currentPrompt: string): { overflowId: string; rawMessage: unknown } {
  const overflow = {
    role: 'assistant',
    content: [],
    provider: 'offline-fixture',
    model: 'offline-fixture',
    stopReason: 'error',
    errorMessage: 'prompt is too long: 201000 tokens > 200000 maximum',
    timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const overflowId = manager.appendMessage(overflow);
  manager.appendCompaction('offline summary', overflowId, 201000, { pieCompaction: { reason: 'overflow' } });
  manager.appendMessage({ role: 'user', content: currentPrompt, timestamp: 2 });
  return { overflowId, rawMessage: overflow };
}

function assertManagerProjection(manager: any, currentPrompt: string): void {
  const { overflowId, rawMessage } = appendOverflowFixture(manager, currentPrompt);
  const entriesBefore = structuredClone(manager.getEntries());
  const sessionFile = manager.getSessionFile();
  const bytesBefore = sessionFile ? readFileSync(sessionFile) : undefined;
  const context = manager.buildSessionContext();
  const serializedContext = JSON.stringify(context.messages);

  assert.match(serializedContext, /offline summary/u);
  assert.match(serializedContext, new RegExp(currentPrompt));
  assert.doesNotMatch(serializedContext, /201000 tokens|offline-fixture/u,
    'the consumed overflow assistant is omitted only from the manager instance projection');
  assert.deepEqual(manager.getEntry(overflowId)?.message, rawMessage,
    'the persisted overflow row remains available through point lookup');
  assert.deepEqual(manager.getEntries(), entriesBefore,
    'building initial context leaves raw manager entries unchanged');
  if (sessionFile) assert.deepEqual(readFileSync(sessionFile), bytesBefore,
    'building initial context does not rewrite the session file');
}

async function sourceGraph(): Promise<{ piRoot: string; packageRoots: Record<string, string> } | undefined> {
  try {
    return (await import('./source-fixture.js')).sourceFixture;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

test('real final source artifact loads cold/full/internal surfaces and creates an offline source session', async (t: TestContext) => {
  const graph = await sourceGraph();
  if (!graph) {
    t.skip('sourceFixture has no materialized SDK graph; run with the explicit final artifact --sdk-path');
    return;
  }
  let artifactRoot: string;
  try {
    artifactRoot = await realpath(graph.piRoot);
    if (!existsSync(path.join(artifactRoot, 'manifest.json'))) {
      t.skip('pass a verified materialized artifact SDK with --sdk-path');
      return;
    }
  } catch {
    t.skip('the candidate source artifact is not materialized');
    return;
  }
  if (!samePath(await realpath(graph.piRoot), artifactRoot)
      || !samePath(await realpath(graph.packageRoots.codingAgent), path.join(artifactRoot, 'node_modules/@earendil-works/pi-coding-agent'))) {
    t.skip('sourceFixture is not bound to the final materialized artifact; pass its coding-agent directory with --sdk-path');
    return;
  }

  const verified = await verifyPiRuntimeArtifact(artifactRoot, { target: TARGET });
  const canonicalSdkPath = await realpath(verified.sdkPath);
  const canonicalCliPath = await realpath(path.join(canonicalSdkPath, 'dist', 'cli.js'));
  const descriptor = await verifySdkRuntimeArtifactDescriptor({
    schemaVersion: 1,
    artifactDir: verified.artifactDir,
    sdkPath: canonicalSdkPath,
    cliPath: canonicalCliPath,
    identity: verified.identity,
    manifest: verified.manifest,
  }, TARGET);
  assert.deepEqual(descriptor.manifest.target, TARGET,
    'the independently verified descriptor is bound to this backend target');
  assert.equal(descriptor.cliPath, canonicalCliPath,
    'descriptor construction uses the canonical artifact CLI path');

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'pie-source-sdk-artifact-'));
  t.after(async () => { await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const originalCompactionPolicy = process.env[HISTORY_COMPACTION_ENV];
  delete process.env[HISTORY_COMPACTION_ENV];
  t.after(() => {
    if (originalCompactionPolicy === undefined) delete process.env[HISTORY_COMPACTION_ENV];
    else process.env[HISTORY_COMPACTION_ENV] = originalCompactionPolicy;
  });

  const artifactFiles = [
    'dist/index.js',
    'dist/core/agent-session.js',
    'dist/core/agent-session-runtime.js',
    'dist/core/agent-session-services.js',
    'dist/core/sdk.js',
    'dist/core/session-manager.js',
    'dist/core/compaction/index.js',
  ].map((relative) => path.join(canonicalSdkPath, relative));
  const artifactBytesBefore = artifactFiles.map((file) => readFileSync(file));

  t.after(denyNetwork());
  const importArtifactRoots = [
    artifactRoot,
    path.resolve(graph.packageRoots.codingAgent, '../../..'),
    ...Object.values(graph.packageRoots),
  ];
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isBuiltin(specifier)) return nextResolve(specifier, context);
      const result = nextResolve(specifier, context);
      assert.ok(result.url.startsWith('file:'), `non-file SDK import is forbidden: ${specifier} -> ${result.url}`);
      const resolved = realpathSync(fileURLToPath(result.url));
      assert.ok(importArtifactRoots.some((root) => isWithin(resolved, root)),
        `SDK import escaped the verified artifact: ${specifier} -> ${resolved}`);
      return result;
    },
  });

  const sourceMode = {
    mode: 'source-artifact' as const,
    descriptor,
    backendTarget: TARGET,
  };
  const coldSdk = await loadSdk(canonicalSdkPath, { ...sourceMode, surface: 'cold' });
  const coldManagerClass = coldSdk.SessionManager as unknown as {
    prototype: object;
    inMemory: (cwd?: string) => any;
    create: (cwd: string, sessionDir: string) => any;
  };
  const coldManagerPrototype = coldManagerClass.prototype;
  const coldManagerPrototypeBefore = prototypeSnapshot(coldManagerPrototype);
  assert.equal(typeof coldSdk.VERSION, 'string');
  assert.equal(typeof coldManagerClass.inMemory, 'function');

  const coldRoot = path.join(tempRoot, 'cold');
  const coldCwd = path.join(coldRoot, 'cwd');
  const coldSessionDir = path.join(coldRoot, 'sessions');
  mkdirSync(coldCwd, { recursive: true });
  mkdirSync(coldSessionDir, { recursive: true });
  assertManagerProjection(coldManagerClass.inMemory(coldCwd), 'cold in-memory current prompt');
  assertManagerProjection(coldManagerClass.create(coldCwd, coldSessionDir), 'cold created current prompt');
  assert.equal(Object.hasOwn(coldManagerPrototype, '__pieOverflowCompactionContextPatched'), false,
    'the source loader projects through manager instances without patching the SDK prototype');
  assert.deepEqual(prototypeSnapshot(coldManagerPrototype), coldManagerPrototypeBefore);

  const fullSdk = await loadSdk(canonicalSdkPath, { ...sourceMode, surface: 'full' });
  const runtimeSdk = fullSdk as any;
  assert.equal(typeof runtimeSdk.createAgentSessionFromServices, 'function');
  assert.equal(typeof runtimeSdk.createAgentSessionRuntime, 'function');
  assert.equal(typeof runtimeSdk.AgentSession?.prototype.continueAfterInterruption, 'function');
  const agentSessionPrototype = runtimeSdk.AgentSession.prototype as object;
  const agentSessionPrototypeBefore = prototypeSnapshot(agentSessionPrototype);
  const fullManagerPrototypeBefore = prototypeSnapshot(runtimeSdk.SessionManager.prototype);
  assert.equal(Object.hasOwn(agentSessionPrototype, '__pieHistoryCompactionPatched'), false);

  const internal = await loadSdkInternalModule<{ prepareCompaction: (...args: unknown[]) => unknown; compact: (...args: unknown[]) => unknown }>(
    canonicalSdkPath,
    'core/compaction/index.js',
    { ...sourceMode, surface: 'full' },
  );
  assert.equal(typeof internal.prepareCompaction, 'function');
  assert.equal(typeof internal.compact, 'function');

  const ai = await import(pathToFileURL(path.join(graph.packageRoots.ai, 'dist', 'compat.js')).href) as {
    EventStream: new (isDone: (event: { type: string }) => boolean, getResult: (event: any) => unknown) => any;
    getModel: (provider: string, modelId: string) => any;
  };
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const cwd = path.join(runtimeRoot, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const agentDir = path.join(runtimeRoot, 'agent');
  const modelsPath = path.join(agentDir, 'models.json');
  const authPath = path.join(agentDir, 'auth.json');
  const authStorage = runtimeSdk.AuthStorage.inMemory();
  const settingsManager = runtimeSdk.SettingsManager.inMemory({
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
    compaction: { enabled: false },
  });
  const modelRegistry = runtimeSdk.ModelRegistry.create(authStorage, modelsPath);
  const model = ai.getModel('anthropic', 'claude-sonnet-4-5');
  const manager: any = runtimeSdk.SessionManager.inMemory(cwd);
  manager.appendModelChange(model.provider, model.id);
  const sentinel = {
    role: 'assistant', content: [{ type: 'text', text: 'POLICY_OMISSION_SENTINEL' }],
    provider: 'offline-fixture', model: 'offline-fixture', stopReason: 'stop', timestamp: 3,
  };
  const sentinelId = manager.appendMessage(sentinel);
  const overflow = {
    role: 'assistant', content: [], provider: 'offline-fixture', model: 'offline-fixture',
    stopReason: 'error', errorMessage: 'prompt is too long: 202000 tokens > 200000 maximum', timestamp: 4,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const overflowId = manager.appendMessage(overflow);
  manager.appendCompaction('sanitized offline summary', sentinelId, 202000, { pieCompaction: { reason: 'overflow' } });
  manager.appendMessage({ role: 'user', content: 'sanitized current request', timestamp: 5 });
  manager.appendModelChange(model.provider, model.id);
  const initialEntries = structuredClone(manager.getEntries());
  const factoryOrder: string[] = [];
  const policyResolver = (branchEntries: readonly any[]) => {
    factoryOrder.push('policy-resolver');
    return new Set(branchEntries.flatMap((entry) => entry.type === 'message' && entry.id === sentinelId ? [entry.id] : []));
  };
  const contextMessageOmissions = (branchEntries: readonly any[]) => {
    factoryOrder.push('caller-resolver');
    return policyResolver(branchEntries);
  };
  const originalSetResolver = manager.setContextMessageOmissionsResolver.bind(manager);
  manager.setContextMessageOmissionsResolver = (resolver: any) => {
    factoryOrder.push('resolver-installed');
    originalSetResolver(resolver);
  };
  const originalBuildContext = manager.buildSessionContext.bind(manager);
  manager.buildSessionContext = (...args: any[]) => {
    factoryOrder.push('context-built');
    return originalBuildContext(...args);
  };
  const compactionPolicyCalls: string[] = [];
  const compactionHooks = {
    shouldCompact: () => { compactionPolicyCalls.push('shouldCompact'); return false; },
    isEstimatedContextOverflow: () => { compactionPolicyCalls.push('isEstimatedContextOverflow'); return false; },
  };
  const extensionsRuntime = runtimeSdk.createExtensionRuntime();
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: extensionsRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'offline source artifact integration',
    getAppendSystemPrompt: () => [],
  };
  const services = {
    cwd,
    agentDir,
    authStorage,
    settingsManager,
    modelRegistry,
    resourceLoader,
    diagnostics: [],
  };
  // Only discovery is faked; exercise Pie's actual runtime factory and the
  // verified source runtime/fromServices routes end to end.
  const factorySdk = {
    ...runtimeSdk,
    createAgentSessionServices: async () => services,
  } as SdkModule;
  const factory = createRuntimeFactory(factorySdk, authStorage, cwd, new ServiceLoadingGate());
  const created = await runtimeSdk.createAgentSessionRuntime(factory, {
    cwd,
    agentDir,
    sessionManager: manager,
    contextMessageOmissions,
    compactionHooks,
  });
  t.after(async () => { await created.dispose(); });

  assert.ok(factoryOrder.indexOf('resolver-installed') >= 0);
  assert.ok(factoryOrder.indexOf('resolver-installed') < factoryOrder.indexOf('context-built'),
    'the source factory installs merged Pie/caller policy before its first context build');
  assert.ok(factoryOrder.includes('caller-resolver'), 'the caller omission policy ran during initial context construction');
  assert.deepEqual(manager.getEntries().slice(0, initialEntries.length), initialEntries,
    'initial context projection preserves every source entry');
  assert.deepEqual(manager.getEntry(overflowId)?.message, overflow,
    'the consumed overflow entry remains unchanged in raw history');
  assert.doesNotMatch(JSON.stringify(created.session.messages), /POLICY_OMISSION_SENTINEL|202000 tokens/u,
    'initial source AgentSession context receives both caller and Pie omissions');
  assert.match(JSON.stringify(created.session.messages), /sanitized current request/u);

  const beforeContinuation = structuredClone(manager.getEntries());
  const userRowsBefore = beforeContinuation.filter((entry: any) => entry.type === 'message' && entry.message.role === 'user').length;
  const providerCalls: Array<{ messages: any[] }> = [];
  created.session.agent.streamFn = (_model: unknown, context: { messages: any[] }) => {
    providerCalls.push({ messages: structuredClone(context.messages) });
    const response = new ai.EventStream(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => event.message,
    );
    const reply = {
      role: 'assistant', content: [{ type: 'text', text: 'offline continuation response' }],
      api: 'anthropic-messages', provider: model.provider, model: model.id,
      stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 8, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(() => {
      response.push({ type: 'start', partial: reply });
      response.push({ type: 'done', reason: 'stop', message: reply });
    });
    return response;
  };
  const sessionEvents: any[] = [];
  created.session.subscribe((event: any) => sessionEvents.push(event));
  await created.session.continueAfterInterruption();

  assert.equal(providerCalls.length, 1, 'continuation issues one offline provider turn');
  const providerMessages = providerCalls[0].messages;
  assert.equal(providerMessages.filter((message) => message.role === 'user'
    && JSON.stringify(message.content).includes('sanitized current request')).length, 1,
  'continuation retains the original user prompt exactly once alongside its compaction summary');
  assert.match(JSON.stringify(providerMessages), /sanitized current request/u);
  assert.doesNotMatch(JSON.stringify(providerMessages), /POLICY_OMISSION_SENTINEL|202000 tokens/u);
  assert.equal(sessionEvents.filter((event) => event.type === 'message_start' && event.message?.role === 'user').length, 0,
    'zero-prompt continuation emits no extra user message');
  const userRowsAfter = manager.getEntries().filter((entry: any) => entry.type === 'message' && entry.message.role === 'user').length;
  assert.equal(userRowsAfter, userRowsBefore, 'continuation appends no prompt to raw session history');
  assert.deepEqual(manager.getEntries().slice(0, beforeContinuation.length), beforeContinuation,
    'continuation preserves the original transcript prefix');
  assert.ok(compactionPolicyCalls.includes('shouldCompact'),
    'the source-owned continuation ran through the injected compaction policy hook');
  assert.equal(existsSync(authPath), false, 'the fixture did not read or create an auth file');
  assert.equal(existsSync(modelsPath), false, 'the fixture did not read or create a models file');

  assert.deepEqual(prototypeSnapshot(coldManagerPrototype), coldManagerPrototypeBefore,
    'cold manager prototype is unchanged by projection and later SDK loads');
  assert.deepEqual(prototypeSnapshot(runtimeSdk.SessionManager.prototype), fullManagerPrototypeBefore,
    'full manager prototype is unchanged by construction and continuation');
  assert.deepEqual(prototypeSnapshot(agentSessionPrototype), agentSessionPrototypeBefore,
    'AgentSession prototype is unchanged by factory and continuation');
  assert.deepEqual(artifactFiles.map((file) => readFileSync(file)), artifactBytesBefore,
    'SDK source bytes are unchanged by all artifact loads and runtime integration');
  const after = await verifyPiRuntimeArtifact(artifactRoot, { target: TARGET });
  assert.equal(after.identity, verified.identity, 'the complete verified artifact payload remains byte-identical');
  assert.deepEqual(after.manifest, verified.manifest);
});
