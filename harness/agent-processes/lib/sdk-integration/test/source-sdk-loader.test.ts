import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import {
  PI_RUNTIME_PACKAGES,
  PI_RUNTIME_SDK_RELATIVE_PATH,
  verifyPiRuntimeArtifact,
  type GenerationPiRuntimeDescriptor,
  type PiRuntimeTarget,
} from '../../../../../lib/pi-runtime/artifact.mjs';
import { writePiRuntimeManifest } from '../../../../../scripts/lib/pi-runtime-artifact.mjs';
import { loadSdk, loadSdkInternalModule } from '../sdk';

const target: PiRuntimeTarget = {
  platform: process.platform,
  arch: process.arch,
  nodeAbi: process.versions.modules,
};
const provenance = {
  upstreamVersion: '0.80.6',
  upstreamCommit: '2b3fda9921b5590f285165287bd442a25817f17b',
  sourceTreeSha256: 'a'.repeat(64),
  lockSha256: 'b'.repeat(64),
  target,
};
const sdkAssets = [
  'dist/cli.js', 'dist/rpc-entry.js',
  'dist/modes/interactive/theme/dark.json',
  'dist/modes/interactive/theme/light.json',
  'dist/modes/interactive/theme/theme-schema.json',
  'dist/modes/interactive/assets/clankolas.png',
  'dist/core/export-html/template.html',
  'dist/core/export-html/template.css',
  'dist/core/export-html/template.js',
  'dist/core/export-html/vendor/marked.min.js',
  'dist/core/export-html/vendor/highlight.min.js',
];

type ImportRecord = {
  imports: string[];
  prototypes: Array<[string, Record<string, PropertyDescriptor>]>;
  preparations: Array<{ entries: unknown[]; settings: Record<string, unknown> }>;
  compactions: unknown[][];
  runtimeCalls: Array<{ factory: unknown; options: unknown }>;
};

async function put(root: string, relative: string, contents: string): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

function markerCode(key: string, label: string, prototypeNames: string[] = []): string {
  const quotedKey = JSON.stringify(key);
  const quotedLabel = JSON.stringify(label);
  const prototypes = prototypeNames.map((name) => `record.prototypes.push([${JSON.stringify(name)}, Object.getOwnPropertyDescriptors(${name}.prototype)]);`).join('\n');
  return `const record = globalThis[${quotedKey}] ??= { imports: [], prototypes: [], preparations: [], compactions: [], runtimeCalls: [] };\nrecord.imports.push(${quotedLabel});\n${prototypes}\n`;
}

function syntheticSdk(key: string): Record<string, string> {
  const recordImports = (label: string, names: string[] = []) => markerCode(key, label, names);
  const sessionManager = `export class SessionManager {
  static continueRecent() { return new SessionManager(); }
  static create() { return new SessionManager(); }
  static inMemory() { return new SessionManager(); }
  static open() { return new SessionManager(); }
  static forkFrom() { return new SessionManager(); }
  static async listAll() { return []; }
  setContextMessageOmissionsResolver(resolver) { this.resolver = resolver; }
  getBranch() { return []; }
  buildContextEntries() { return []; }
  buildSessionContext() { return { messages: [], thinkingLevel: 'off', model: null }; }
}
${recordImports('session-manager', ['SessionManager'])}`;
  const authStorage = `${recordImports('auth-storage')}
export class AuthStorage { static create() { return new AuthStorage(); } }
`;
  const modelRegistry = `${recordImports('model-registry')}
export class ModelRegistry {
  static create() { return new ModelRegistry(); }
  getAvailable() { return []; }
  find() { return undefined; }
}
`;
  const agentSession = `export class AgentSession {
  async getCompactionRequestAuth() { return {}; }
  async continueAfterInterruption() { return; }
}
${recordImports('agent-session', ['AgentSession'])}`;
  const compaction = `${recordImports('compaction')}
export function prepareCompaction(entries, settings) {
  const preparation = { entries, settings };
  globalThis[${JSON.stringify(key)}].preparations.push(preparation);
  return preparation;
}
export async function compact(...args) {
  globalThis[${JSON.stringify(key)}].compactions.push(args);
  return { summary: 'synthetic Pie summary', firstKeptEntryId: 'kept-entry', tokensBefore: 123, details: { source: 'synthetic' } };
}
`;
  const config = `${recordImports('config')}
export const VERSION = '0.80.6';
export function getAgentDir() { return '/synthetic-agent-dir'; }
`;
  const sdkFactories = `${recordImports('sdk-factories')}
export async function createAgentSession() { return { session: new AgentSession() }; }
export async function createAgentSessionServices() { return {}; }
export async function createAgentSessionFromServices(options = {}) { return { session: options.session ?? new AgentSession(), options }; }
export async function createAgentSessionRuntime(factory, options) {
  globalThis[${JSON.stringify(key)}].runtimeCalls.push({ factory, options });
  return { ...(await factory(options)), runtimeOptions: options };
}
`;
  const root = `${recordImports('index')}
export { VERSION, getAgentDir } from './config.js';
export { AuthStorage } from './core/auth-storage.js';
export { ModelRegistry } from './core/model-registry.js';
export { SessionManager } from './core/session-manager.js';
export { AgentSession } from './core/agent-session.js';
export { prepareCompaction, compact } from './core/compaction/index.js';
export { createAgentSession, createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime } from './core/sdk.js';
`;

  return {
    'dist/config.js': config,
    'dist/core/auth-storage.js': authStorage,
    'dist/core/model-registry.js': modelRegistry,
    'dist/core/session-manager.js': sessionManager,
    'dist/core/agent-session.js': agentSession,
    'dist/core/compaction/index.js': compaction,
    'dist/core/sdk.js': `${sdkFactories}\nimport { AgentSession } from './agent-session.js';\n`,
    'dist/index.js': root,
    'outside.js': `${recordImports('outside')}export const marker = true;\n`,
  };
}

async function fixture(t: TestContext, artifactTarget: PiRuntimeTarget = target) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pie-source-sdk-loader-'));
  const marker = `__pieSourceSdkLoader_${randomUUID().replaceAll('-', '')}`;
  t.after(async () => {
    Reflect.deleteProperty(globalThis, marker);
    await rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const artifactDir = path.join(parent, 'pi-runtime');
  for (const packageName of PI_RUNTIME_PACKAGES) {
    const prefix = `node_modules/${packageName}/`;
    const packageJson = { name: packageName, version: '0.80.6', type: 'module' };
    await put(artifactDir, `${prefix}package.json`, JSON.stringify(packageJson));
    await put(artifactDir, `${prefix}dist/index.js`, 'export {}\n');
    await put(artifactDir, `${prefix}LICENSE`, 'fixture license\n');
  }
  const sdkRoot = `${PI_RUNTIME_SDK_RELATIVE_PATH}/`;
  await put(artifactDir, `${sdkRoot}package.json`, JSON.stringify({
    name: '@earendil-works/pi-coding-agent', version: '0.80.6', type: 'module',
  }));
  for (const relative of sdkAssets) {
    await put(artifactDir, `${sdkRoot}${relative}`, `fixture:${relative}\n`);
  }
  for (const [relative, contents] of Object.entries(syntheticSdk(marker))) {
    await put(artifactDir, `${sdkRoot}${relative}`, contents);
  }
  await writePiRuntimeManifest(artifactDir, { ...provenance, target: artifactTarget });
  return { parent, artifactDir, sdkPath: path.join(artifactDir, PI_RUNTIME_SDK_RELATIVE_PATH), marker };
}

async function descriptorFor(artifactDir: string, backendTarget: PiRuntimeTarget): Promise<GenerationPiRuntimeDescriptor> {
  const verified = await verifyPiRuntimeArtifact(artifactDir, { target: backendTarget });
  const sdkPath = await realpath(verified.sdkPath);
  const cliPath = await realpath(path.join(sdkPath, 'dist', 'cli.js'));
  return {
    schemaVersion: 1,
    artifactDir: verified.artifactDir,
    sdkPath,
    cliPath,
    identity: verified.identity,
    manifest: verified.manifest,
  };
}

function sourceMode(descriptor: unknown, backendTarget?: PiRuntimeTarget, surface?: 'full'):
  { mode: 'source-artifact'; descriptor: unknown; backendTarget: PiRuntimeTarget; surface: 'full' };
function sourceMode(descriptor: unknown, backendTarget: PiRuntimeTarget, surface: 'cold'):
  { mode: 'source-artifact'; descriptor: unknown; backendTarget: PiRuntimeTarget; surface: 'cold' };
function sourceMode(
  descriptor: unknown,
  backendTarget: PiRuntimeTarget = target,
  surface: 'cold' | 'full' = 'full',
) {
  return { mode: 'source-artifact', descriptor, backendTarget, surface } as const;
}

function importRecord(marker: string): ImportRecord | undefined {
  return Reflect.get(globalThis, marker) as ImportRecord | undefined;
}

async function assertRejectsMessage(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    return true;
  });
}

async function snapshot(root: string): Promise<Record<string, { mtimeMs: number; size: number; bytes?: string }>> {
  const result: Record<string, { mtimeMs: number; size: number; bytes?: string }> = {};
  async function walk(relative = ''): Promise<void> {
    for (const entry of (await readdir(path.join(root, relative))).sort()) {
      const name = relative ? `${relative}/${entry}` : entry;
      const absolute = path.join(root, name);
      const stat = await lstat(absolute);
      result[name] = { mtimeMs: stat.mtimeMs, size: stat.size };
      if (stat.isDirectory()) await walk(name);
      else result[name].bytes = (await readFile(absolute)).toString('base64');
    }
  }
  await walk();
  return result;
}

function assertPrototypeSnapshots(
  record: ImportRecord,
  prototypes: Record<string, object | undefined>,
): void {
  for (const [name, descriptors] of record.prototypes) {
    const prototype = prototypes[name];
    assert.ok(prototype, `${name} prototype is exported`);
    assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), descriptors, `${name} prototype was not patched`);
  }
}

test('source-artifact loader validates and loads cold and full surfaces without patching files or prototypes', async (t) => {
  const cold = await fixture(t);
  const coldDescriptor = await descriptorFor(cold.artifactDir, target);
  const coldBefore = await snapshot(cold.artifactDir);
  const coldSdk = await loadSdk(cold.sdkPath, sourceMode(coldDescriptor, target, 'cold'));
  assert.equal(coldSdk.VERSION, '0.80.6');
  assert.equal(typeof coldSdk.getAgentDir, 'function');
  assert.deepEqual(await snapshot(cold.artifactDir), coldBefore);
  const coldImports = importRecord(cold.marker);
  assert.ok(coldImports && coldImports.imports.length > 0);
  assertPrototypeSnapshots(coldImports, { SessionManager: coldSdk.SessionManager.prototype });

  const full = await fixture(t);
  const fullDescriptor = await descriptorFor(full.artifactDir, target);
  const fullBefore = await snapshot(full.artifactDir);
  const fullSdk = await loadSdk(full.sdkPath, sourceMode(fullDescriptor, target, 'full'));
  assert.equal(fullSdk.VERSION, '0.80.6');
  assert.equal(typeof fullSdk.AgentSession?.prototype.getCompactionRequestAuth, 'function');
  assert.equal(typeof fullSdk.AgentSession?.prototype.continueAfterInterruption, 'function');
  assert.equal(typeof fullSdk.createAgentSessionRuntime, 'function');
  assert.deepEqual(await snapshot(full.artifactDir), fullBefore);
  const fullImports = importRecord(full.marker);
  assert.ok(fullImports && fullImports.imports.includes('index'));
  assertPrototypeSnapshots(fullImports, {
    AgentSession: fullSdk.AgentSession?.prototype,
    SessionManager: fullSdk.SessionManager.prototype,
  });
});

test('source-artifact loader rejects verified SDKs missing required cold or full exports without fallback', async (t) => {
  for (const surface of ['cold', 'full'] as const) {
    const current = await fixture(t);
    const relative = surface === 'cold' ? 'dist/config.js' : 'dist/core/sdk.js';
    const exportName = surface === 'cold' ? 'VERSION' : 'createAgentSessionRuntime';
    const file = path.join(current.sdkPath, relative);
    const source = await readFile(file, 'utf8');
    const declaration = surface === 'cold' ? 'export const VERSION' : 'export async function createAgentSessionRuntime';
    assert.ok(source.includes(declaration));
    await writeFile(file, source.replace(declaration, declaration.replace(exportName, `missing_${exportName}`)));
    if (surface === 'full') {
      const index = path.join(current.sdkPath, 'dist/index.js');
      const indexSource = await readFile(index, 'utf8');
      assert.ok(indexSource.includes(', createAgentSessionRuntime }'));
      await writeFile(index, indexSource.replace(', createAgentSessionRuntime }', ' }'));
    }
    // Missing exports are a contract failure, not an integrity failure: seal and
    // independently verify this private fixture before requesting the surface.
    await writePiRuntimeManifest(current.artifactDir, provenance);
    const descriptor = await descriptorFor(current.artifactDir, target);
    const before = await snapshot(current.artifactDir);
    await assertRejectsMessage(
      loadSdk(current.sdkPath, surface === 'cold'
        ? sourceMode(descriptor, target, 'cold') : sourceMode(descriptor, target, 'full')),
      surface === 'cold' ? /missing required cold coordinator exports/ : /missing required source exports/,
    );
    const record = importRecord(current.marker);
    assert.ok(record?.imports.includes(surface === 'cold' ? 'config' : 'index'),
      'the verified synthetic SDK was evaluated, but no installed SDK was returned');
    assert.deepEqual(await snapshot(current.artifactDir), before);
  }
});

test('source-artifact beforeCompact bridge uses public session APIs and Pie summary settings', async (t) => {
  const envKey = 'PIE_HISTORY_COMPACTION_JSON';
  const previousSettings = process.env[envKey];
  process.env[envKey] = JSON.stringify({
    enabled: true,
    thresholdMode: 'tokens',
    softThreshold: 10_000,
    hardThreshold: 12_000,
    keepRecentTokens: 500,
    summaryInstructions: 'Keep decisions and unresolved work.',
    summaryThinkingLevel: 'low',
    summaryModel: { provider: 'summary-provider', id: 'summary-model' },
    modelProfiles: {
      'chat-provider/chat-model': { softThreshold: 5_000, hardThreshold: 8_000, keepRecentTokens: 2_345 },
    },
  });
  t.after(() => {
    if (previousSettings === undefined) delete process.env[envKey];
    else process.env[envKey] = previousSettings;
  });

  const current = await fixture(t);
  const descriptor = await descriptorFor(current.artifactDir, target);
  const sdk = await loadSdk(current.sdkPath, sourceMode(descriptor));
  const createFromServices = sdk.createAgentSessionFromServices as unknown as (
    options: Record<string, unknown>,
  ) => Promise<{
    session: unknown;
    options: { compactionHooks?: { beforeCompact?: (event: unknown, session: unknown) => Promise<unknown> } };
  }>;
  const activeModel = { provider: 'chat-provider', id: 'chat-model', contextWindow: 50_000 };
  const summaryModel = { provider: 'summary-provider', id: 'summary-model', contextWindow: 8_000 };
  const nativeSettings = { enabled: true, reserveTokens: 321, keepRecentTokens: 17 };
  const streamFn = () => { throw new Error('synthetic compact must not access the network'); };
  const createSession = (summaryModelAvailable: boolean) => {
    const calls: { modelLookups: Array<[string, string]>; authModels: unknown[] } = {
      modelLookups: [],
      authModels: [],
    };
    const session = {
      model: activeModel,
      thinkingLevel: 'high',
      settingsManager: { getCompactionSettings: () => nativeSettings },
      agent: { streamFn },
      modelRegistry: {
        find(provider: string, id: string) {
          calls.modelLookups.push([provider, id]);
          return summaryModelAvailable && provider === summaryModel.provider && id === summaryModel.id
            ? summaryModel
            : undefined;
        },
      },
      async getCompactionRequestAuth(model: unknown) {
        calls.authModels.push(model);
        return {
          apiKey: 'synthetic-summary-key',
          headers: { 'x-summary': 'loader-test' },
          env: { SUMMARY_TEST: 'offline' },
        };
      },
    };
    return { session, calls };
  };
  const event = {
    type: 'session_before_compact',
    reason: 'manual',
    branchEntries: [{ id: 'source-entry' }],
    customInstructions: 'Review the final request.',
    signal: new AbortController().signal,
  };
  const invokeBeforeCompact = async (session: unknown) => {
    const created = await createFromServices({ session });
    const hook = created.options.compactionHooks?.beforeCompact;
    assert.equal(typeof hook, 'function', 'fromServices receives the installed source hooks');
    return hook!(event, created.session) as Promise<{
      cancel?: boolean;
      compaction?: { summary: string; details?: Record<string, unknown> };
    }>;
  };

  const available = createSession(true);
  const decision = await invokeBeforeCompact(available.session);
  assert.equal(decision.cancel, undefined);
  assert.equal(decision.compaction?.summary, 'synthetic Pie summary');
  assert.deepEqual(available.calls.modelLookups, [['summary-provider', 'summary-model']],
    'the bridge resolves the configured summary model through public session.modelRegistry');
  assert.deepEqual(available.calls.authModels, [summaryModel],
    'the bridge requests auth through public session.getCompactionRequestAuth');
  assert.equal(Object.hasOwn(available.session, '_modelRegistry'), false);
  assert.equal(Object.hasOwn(available.session, '_getCompactionRequestAuth'), false);

  const record = importRecord(current.marker);
  assert.ok(record);
  assert.equal(record.preparations.length, 1);
  assert.strictEqual(record.preparations[0].entries, event.branchEntries);
  const preparation = record.preparations[0];
  assert.deepEqual(preparation.settings, { ...nativeSettings, keepRecentTokens: 2_345 },
    'Pie retention overrides the source setting using the active model profile');
  assert.equal(record.compactions.length, 1);
  const [receivedPreparation, receivedModel, apiKey, headers, instructions, signal, thinkingLevel, receivedStreamFn, env] =
    record.compactions[0];
  assert.strictEqual(receivedPreparation, preparation);
  assert.strictEqual(receivedModel, summaryModel);
  assert.equal(apiKey, 'synthetic-summary-key');
  assert.deepEqual(headers, { 'x-summary': 'loader-test' });
  assert.equal(instructions, 'Keep decisions and unresolved work.\n\nAdditional one-time focus:\nReview the final request.');
  assert.strictEqual(signal, event.signal);
  assert.equal(thinkingLevel, 'low');
  assert.strictEqual(receivedStreamFn, streamFn);
  assert.deepEqual(env, { SUMMARY_TEST: 'offline' });
  assert.deepEqual(decision.compaction?.details, {
    source: 'synthetic',
    pieCompaction: {
      version: 1,
      reason: 'manual',
      modelId: 'summary-model',
      provider: 'summary-provider',
      thinkingLevel: 'low',
      keepRecentTokens: 2_345,
      instructionsApplied: true,
    },
  });

  const unavailable = createSession(false);
  const unavailableDecision = await invokeBeforeCompact(unavailable.session);
  assert.deepEqual(unavailableDecision, { cancel: true },
    'an unavailable configured summary model cancels rather than delegating to the active chat model');
  assert.deepEqual(unavailable.calls.modelLookups, [['summary-provider', 'summary-model']]);
  assert.equal(unavailable.calls.authModels.length, 0);
  assert.equal(record.compactions.length, 1, 'no compact request is made with the active model as fallback');
});

test('source-artifact runtime route forwards its compaction hooks once', async (t) => {
  const current = await fixture(t);
  const descriptor = await descriptorFor(current.artifactDir, target);
  const sdk = await loadSdk(current.sdkPath, sourceMode(descriptor));
  const callerDecision = { compaction: { summary: 'caller-owned summary' } };
  let callerBeforeCompactCalls = 0;
  const callerHooks = {
    beforeCompact: async () => {
      callerBeforeCompactCalls += 1;
      return callerDecision;
    },
  };
  const runtimeOptions = {
    cwd: '/synthetic-cwd',
    agentDir: '/synthetic-agent-dir',
    sessionManager: {},
    compactionHooks: callerHooks,
  };
  type ReceivedOptions = { compactionHooks?: { beforeCompact?: (event: unknown, session: unknown) => Promise<unknown> } };
  const createRuntime = sdk.createAgentSessionRuntime as unknown as (
    factory: (options: unknown) => Promise<{ session: object }>,
    options: unknown,
  ) => Promise<{ runtimeOptions: ReceivedOptions }>;
  let factoryOptions: ReceivedOptions | undefined;
  const runtime = await createRuntime(async (options) => {
    factoryOptions = options as ReceivedOptions;
    return { session: {} };
  }, runtimeOptions);

  assert.ok(factoryOptions?.compactionHooks?.beforeCompact);
  assert.strictEqual(factoryOptions.compactionHooks, runtime.runtimeOptions.compactionHooks,
    'the runtime forwards the loader-installed hooks without wrapping them a second time');
  assert.notStrictEqual(factoryOptions.compactionHooks, callerHooks,
    'the caller hooks are wrapped once with Pie policy');
  const result = await factoryOptions.compactionHooks.beforeCompact!({ type: 'session_before_compact', branchEntries: [] }, {});
  assert.strictEqual(result, callerDecision);
  assert.equal(callerBeforeCompactCalls, 1);
  assert.equal(importRecord(current.marker)?.runtimeCalls.length, 1);
});

test('source-artifact internal module loader accepts canonical modules and rejects escapes before import', async (t) => {
  const current = await fixture(t);
  const descriptor = await descriptorFor(current.artifactDir, target);
  const mode = sourceMode(descriptor);
  const before = await snapshot(current.artifactDir);

  const compaction = await loadSdkInternalModule<{ prepareCompaction: () => undefined }>(
    current.sdkPath,
    'core/compaction/index.js',
    mode,
  );
  assert.equal(typeof compaction.prepareCompaction, 'function');
  const afterValidImport = importRecord(current.marker)?.imports.length ?? 0;
  for (const invalidPath of [
    '../outside.js',
    'core/../../outside.js',
    path.join(current.sdkPath, 'dist', 'core', 'compaction', 'index.js'),
  ]) {
    await assertRejectsMessage(loadSdkInternalModule(current.sdkPath, invalidPath, mode), /path|relative|absolute|contain/i);
    assert.equal(importRecord(current.marker)?.imports.length ?? 0, afterValidImport);
  }
  assert.deepEqual(await snapshot(current.artifactDir), before);
});

test('source-artifact loader rejects a wrong SDK path and descriptor before importing modules', async (t) => {
  const current = await fixture(t);
  const descriptor = await descriptorFor(current.artifactDir, target);
  const before = await snapshot(current.artifactDir);
  const wrongSdkPath = path.join(current.parent, 'wrong-sdk-path');
  await mkdir(wrongSdkPath);

  await assertRejectsMessage(
    loadSdk(wrongSdkPath, sourceMode(descriptor)),
    /SDK path|canonical|descriptor.*(?:path|mismatch)/i,
  );
  await assertRejectsMessage(loadSdk(current.sdkPath, sourceMode({
    ...descriptor,
    sdkPath: path.join(current.parent, 'wrong-descriptor-sdk-path'),
  })), /Invalid Pi runtime descriptor|canonical|descriptor.*(?:path|mismatch)/i);
  assert.equal(importRecord(current.marker), undefined);
  assert.deepEqual(await snapshot(current.artifactDir), before);
});

test('source-artifact loader rejects tampered payloads and backend target mismatches before importing', async (t) => {
  const tampered = await fixture(t);
  const tamperedDescriptor = await descriptorFor(tampered.artifactDir, target);
  await put(
    tampered.artifactDir,
    `${PI_RUNTIME_SDK_RELATIVE_PATH}/dist/index.js`,
    `globalThis[${JSON.stringify(tampered.marker)}] = { imports: ['tampered'], prototypes: [] };\n`,
  );
  const tamperedBefore = await snapshot(tampered.artifactDir);
  for (const surface of ['cold', 'full'] as const) {
    await assertRejectsMessage(loadSdk(tampered.sdkPath, surface === 'cold'
      ? sourceMode(tamperedDescriptor, target, 'cold') : sourceMode(tamperedDescriptor, target, 'full')), /hash mismatch/);
  }
  await assertRejectsMessage(loadSdkInternalModule(
    tampered.sdkPath, 'core/compaction/index.js', sourceMode(tamperedDescriptor),
  ), /hash mismatch/);
  assert.equal(importRecord(tampered.marker), undefined);
  assert.deepEqual(await snapshot(tampered.artifactDir), tamperedBefore);

  const mismatched = await fixture(t);
  const descriptor = await descriptorFor(mismatched.artifactDir, target);
  const backendTarget = {
    ...target,
    platform: target.platform === 'linux' ? 'darwin' : 'linux',
  };
  const before = await snapshot(mismatched.artifactDir);
  await assertRejectsMessage(
    loadSdk(mismatched.sdkPath, sourceMode(descriptor, backendTarget)),
    /target\.platform mismatch/,
  );
  assert.equal(importRecord(mismatched.marker), undefined);
  assert.deepEqual(await snapshot(mismatched.artifactDir), before);
});
