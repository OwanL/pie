import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';

import { attachJsonlLineReader } from '../lib/rpc/jsonl.js';
import type { InitialContextEstimate } from '../lib/rpc/session-events.js';
import type { SystemPromptEntry } from '../lib/rpc/session-events.js';
import { estimateTextTokens } from '../../../lib/token-estimation.js';
import { prepareContextFiles } from '../../agent-instructions/prompt-assembly/context-files.js';
import type {
  SdkBuildSystemPromptOptions,
  SdkModule,
  SdkSession,
  SdkSessionEvent,
  SdkSessionManager,
  SdkSystemPromptModule,
  SdkToolInfo,
} from '../lib/sdk-integration/sdk.js';
import { loadSdk, loadSdkInternalModule } from '../lib/sdk-integration/sdk.js';
import {
  assertSdkRuntimeAgreement,
  parseSdkRuntimeSelection,
  sdkRuntimeLoadMode,
  validateSdkRuntimeSelectionShape,
  verifySdkRuntimeSelection,
  type SdkRuntimeSelection,
} from '../lib/sdk-integration/sdk-runtime-selection.js';
import {
  INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION,
  type InitialContextEstimateWorkerInitialization,
  type InitialContextEstimateWorkerReady,
} from './initial-context-estimate-protocol.js';
import { createPieSystemPromptBuilder } from '../../agent-instructions/prompt-assembly/pie-harness-prompt.js';
import { centralAppendSystemPromptOverride } from '../../agent-instructions/prompt-assembly/append-system-prompt.js';
import { createBackendTools } from '../coordinator/backend-tools.js';
import {
  buildSessionSystemPrompts,
  captureOriginalSystemPromptOptions,
  normalizePromptText,
} from '../../agent-instructions/prompt-assembly/system-prompts.js';

const IPC_READ_FD = 4;
const IPC_WRITE_FD = 3;
// The inventory carries the lossless prompt catalog, including complete context
// files and tool schemas. Keep it bounded below the public 32 MiB JSONL ceiling
// without imposing the old 256 KiB text truncation/failure cliff.
const MAX_FRAME_BYTES = 30 * 1024 * 1024;
const PARENT_WATCHDOG_INTERVAL_MS = 1_000;

export interface InitialContextEstimateWorkerInput {
  protocolVersion: typeof INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION;
  kind: 'discover';
  sdkPath: string;
  sdkRuntime: SdkRuntimeSelection;
  cwd: string;
  agentDir: string;
  model: { provider: string; id: string };
}

export interface InitialContextInventory {
  estimate: InitialContextEstimate;
  systemPrompts: SystemPromptEntry[];
}

export interface InitialContextEstimateWorkerTimings {
  /** Selected SDK runtime validation and both dynamic module imports. */
  sdkImportDurationMs?: number;
  /** SDK runtime creation, resource loading, and extension session_start binding. */
  resourceDiscoveryDurationMs?: number;
  /** Prompt projection, system-prompt construction, and token estimation. */
  promptAndEstimateDurationMs?: number;
}

export type InitialContextEstimateWorkerOutput =
  | {
      protocolVersion: typeof INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION;
      kind: 'result';
      ok: true;
      inventory: InitialContextInventory;
      timings?: InitialContextEstimateWorkerTimings;
    }
  | {
      protocolVersion: typeof INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION;
      kind: 'result';
      ok: false;
      error: string;
      timings?: InitialContextEstimateWorkerTimings;
    };

interface RuntimeFactoryArgs {
  cwd: string;
  agentDir: string;
  sessionManager: SdkSessionManager;
  sessionStartEvent?: SdkSessionEvent;
}

interface ServicesLike {
  cwd: string;
  agentDir: string;
  modelRegistry: { find(provider: string, modelId: string): unknown };
  [key: string]: unknown;
}

interface PromptStateLike {
  _baseSystemPromptOptions?: SdkBuildSystemPromptOptions;
  _originalSystemPromptOptions?: SdkBuildSystemPromptOptions;
}

/** Build one fresh inventory of every successfully discovered/registered
 * resource in an in-memory SDK runtime, before Pie runtime filters. Configured
 * resources excluded by Pi resource settings, unavailable packages, and failed
 * discoveries are not registered and therefore are not part of this inventory.
 * The caller owns process isolation and the timeout; this function never prompts. */
export async function collectInitialContextInventory(
  sdk: SdkModule,
  systemPromptModule: SdkSystemPromptModule,
  input: Pick<InitialContextEstimateWorkerInput, 'cwd' | 'agentDir' | 'model'>,
  onTiming?: (
    stage: 'resourceDiscoveryDurationMs' | 'promptAndEstimateDurationMs',
    durationMs: number,
  ) => void,
): Promise<InitialContextInventory> {
  const providerBoundary = installInventoryProviderDenyBoundary();
  try {
    return await collectInitialContextInventoryInsideBoundary(
      sdk,
      systemPromptModule,
      input,
      providerBoundary.assertNoAttempts,
      onTiming,
    );
  } finally {
    providerBoundary.restore();
  }
}

async function collectInitialContextInventoryInsideBoundary(
  sdk: SdkModule,
  systemPromptModule: SdkSystemPromptModule,
  input: Pick<InitialContextEstimateWorkerInput, 'cwd' | 'agentDir' | 'model'>,
  assertNoProviderAttempts: () => void,
  onTiming?: (
    stage: 'resourceDiscoveryDurationMs' | 'promptAndEstimateDurationMs',
    durationMs: number,
  ) => void,
): Promise<InitialContextInventory> {
  const authDir = process.env.PI_CODING_AGENT_AUTH_DIR?.trim();
  const authPath = authDir
    ? path.resolve(authDir, 'auth.json')
    : path.resolve(input.agentDir, 'auth.json');
  const authStorage = sdk.AuthStorage.create(authPath);
  const manager = sdk.SessionManager.inMemory(input.cwd);

  const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: RuntimeFactoryArgs) => {
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir,
      authStorage,
      resourceLoaderOptions: {
        // Mirror the main-session loaders (runtime-factory): attach Pie's
        // centralized appended prompt so inventories estimate the same
        // context real sessions build.
        appendSystemPromptOverride: centralAppendSystemPromptOverride(agentDir),
        agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
          agentsFiles: prepareContextFiles(base.agentsFiles).map((contextFile) => ({
            path: contextFile.path,
            content: contextFile.content,
          })),
        }),
      },
    }) as ServicesLike;
    const model = services.modelRegistry.find(input.model.provider, input.model.id);
    if (!model) {
      throw new Error(`Selected model is unavailable in the fresh inventory: ${input.model.provider}/${input.model.id}`);
    }
    const created = await sdk.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      customTools: createBackendTools({ kind: 'inventory' }),
    }) as Record<string, unknown>;
    return { ...created, services };
  };

  let runtime: Awaited<ReturnType<SdkModule['createAgentSessionRuntime']>> | undefined;
  try {
    const resourceDiscoveryStartedAt = performance.now();
    try {
      runtime = await sdk.createAgentSessionRuntime(createRuntime, {
        cwd: input.cwd,
        agentDir: input.agentDir,
        sessionManager: manager,
        sessionStartEvent: { type: 'session_start', reason: 'startup' },
      });

      const session = runtime.session;
      installInventorySessionGuards(session);
      await bindInventoryExtensions(session, runtime);
      // A handler may catch the deny error and otherwise leave a plausible but
      // incomplete catalog. Convert every attempted network call into fail-open
      // omission instead of publishing a partial estimate.
      assertNoProviderAttempts();
    } finally {
      reportInventoryTiming(onTiming, 'resourceDiscoveryDurationMs', resourceDiscoveryStartedAt);
    }

    const promptEstimateStartedAt = performance.now();
    try {
      return buildInitialContextInventoryProjection(
        runtime.session,
        sdk,
        systemPromptModule,
        input,
      );
    } finally {
      reportInventoryTiming(onTiming, 'promptAndEstimateDurationMs', promptEstimateStartedAt);
    }
  } finally {
    await runtime?.dispose();
  }
}

function reportInventoryTiming(
  onTiming: ((stage: 'resourceDiscoveryDurationMs' | 'promptAndEstimateDurationMs', durationMs: number) => void) | undefined,
  stage: 'resourceDiscoveryDurationMs' | 'promptAndEstimateDurationMs',
  startedAt: number,
): void {
  try {
    onTiming?.(stage, Math.max(0, performance.now() - startedAt));
  } catch {
    // Diagnostics must not change inventory construction or disposal.
  }
}

function buildInitialContextInventoryProjection(
  session: SdkSession,
  sdk: SdkModule,
  systemPromptModule: SdkSystemPromptModule,
  input: Pick<InitialContextEstimateWorkerInput, 'agentDir' | 'model'>,
): InitialContextInventory {
  const promptState = session as SdkSession & PromptStateLike;
  captureOriginalSystemPromptOptions(promptState);
  const promptOptions = promptState._originalSystemPromptOptions ?? promptState._baseSystemPromptOptions;
  if (!promptOptions) throw new Error('Fresh inventory did not expose system prompt options.');

  const tools = session.getAllTools?.() ?? [];
  const inventoryPromptOptions = buildAllRegisteredPromptOptions(session, promptOptions, tools);
  const pieBuildSystemPrompt = createPieSystemPromptBuilder(systemPromptModule.buildSystemPrompt, input.agentDir);
  const fullSystemPrompt = normalizePromptText(pieBuildSystemPrompt(inventoryPromptOptions));
  if (!fullSystemPrompt) throw new Error('Fresh inventory did not build a system prompt.');
  // Match the hot picker exactly: its harness card is rebuilt from only the
  // harness/tool/runtime inputs, while custom/append/context/skill entries
  // are projected independently from the unfiltered options below.
  const harnessPrompt = normalizePromptText(pieBuildSystemPrompt({
    cwd: inventoryPromptOptions.cwd,
    selectedTools: inventoryPromptOptions.selectedTools,
    toolSnippets: inventoryPromptOptions.toolSnippets,
    promptGuidelines: inventoryPromptOptions.promptGuidelines,
  }));

  // Count the exact Pie-owned prompt text used by runtime requests.
  // Provider tool descriptions/schemas are separate request metadata and are
  // added exactly once below.
  const tokens = estimateTextTokens(fullSystemPrompt) + estimateTextTokens(buildToolCatalogText(tools));
  const contextWindow = session.model?.contextWindow;
  if (!Number.isSafeInteger(tokens) || tokens < 0
    || !Number.isSafeInteger(contextWindow) || (contextWindow ?? 0) <= 0) {
    throw new Error('Fresh inventory did not resolve a valid token total and context window.');
  }
  const estimate = { tokens, contextWindow: contextWindow! };
  const systemPrompts = buildSessionSystemPrompts({
    harnessPrompt,
    promptOptions: inventoryPromptOptions,
    formatSkillsForPrompt: sdk.formatSkillsForPrompt,
    tools,
    activeProvider: {
      provider: input.model.provider,
      modelId: input.model.id,
    },
  });
  return { estimate, systemPrompts };
}

function normalizeToolSnippet(value: string | undefined): string | undefined {
  const normalized = value?.replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return normalized || undefined;
}

function buildAllRegisteredPromptOptions(
  session: SdkSession,
  promptOptions: SdkBuildSystemPromptOptions,
  tools: readonly SdkToolInfo[],
): SdkBuildSystemPromptOptions {
  const selectedTools: string[] = [];
  const toolSnippets: Record<string, string> = {};
  const promptGuidelines: string[] = [];
  for (const tool of tools) {
    selectedTools.push(tool.name);
    const definition = session.getToolDefinition?.(tool.name);
    const snippet = normalizeToolSnippet(tool.promptSnippet ?? definition?.promptSnippet);
    if (snippet) toolSnippets[tool.name] = snippet;
    promptGuidelines.push(...(tool.promptGuidelines ?? definition?.promptGuidelines ?? []));
  }
  return {
    ...promptOptions,
    selectedTools,
    toolSnippets,
    promptGuidelines,
  };
}

function buildToolCatalogText(tools: readonly SdkToolInfo[]): string {
  return tools.map((tool) => {
    let entry = `## ${tool.name}\n\n${tool.description || '(no description)'}`;
    if (tool.parameters !== undefined) {
      entry += `\n\n**Parameters:**\n\`\`\`json\n${JSON.stringify(tool.parameters, null, 2)}\n\`\`\``;
    }
    return entry;
  }).join('\n\n---\n\n');
}

export function installInventoryProviderDenyBoundary(): {
  assertNoAttempts: () => void;
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new Error('Provider/network calls are disabled in the initial-context inventory worker.');
  };
  return {
    assertNoAttempts: () => {
      if (attempts > 0) {
        throw new Error('Initial-context inventory attempted outbound network access.');
      }
    },
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

function installInventorySessionGuards(session: SdkSession): void {
  const guarded = session as SdkSession & Record<string, unknown>;
  const rejectTurn = async () => {
    throw new Error('Model turns are disabled in the initial-context inventory worker.');
  };
  // Extension core closures dispatch through these instance methods. Guard all
  // turn-producing surfaces before session_start handlers are emitted.
  for (const method of ['prompt', 'sendUserMessage', 'sendCustomMessage', 'compact'] as const) {
    guarded[method] = rejectTurn;
  }
}

function createInventoryUiContext(): object {
  const asyncUndefined = async () => undefined;
  const noop = () => undefined;
  return new Proxy({}, {
    get: (_target, key) => {
      if (key === 'confirm') return async () => false;
      if (key === 'select' || key === 'input' || key === 'editor' || key === 'custom') return asyncUndefined;
      if (key === 'onTerminalInput') return () => noop;
      if (key === 'getEditorText') return () => '';
      if (key === 'getAllThemes') return () => [];
      if (key === 'getEditorComponent') return () => undefined;
      if (key === 'theme') return undefined;
      return noop;
    },
  });
}

async function bindInventoryExtensions(
  session: SdkSession,
  runtime: Awaited<ReturnType<SdkModule['createAgentSessionRuntime']>>,
): Promise<void> {
  await session.bindExtensions({
    uiContext: createInventoryUiContext(),
    mode: 'rpc',
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => undefined,
    },
    // A temporary inventory must not allow an extension to own process exit.
    shutdownHandler: () => undefined,
    onError: () => undefined,
  });
  // Keep the runtime referenced through binding: extension command contexts
  // are valid for this temporary session until the finally-owned dispose.
  void runtime;
}

export function isInitialization(value: unknown): value is InitialContextEstimateWorkerInitialization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.protocolVersion === INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION
    && frame.kind === 'initialize'
    && typeof frame.sdkPath === 'string'
    && !Object.hasOwn(frame, 'sdkPatchIdentity')
    && validateSdkRuntimeSelectionShape(frame.sdkRuntime) === undefined
    && Number.isSafeInteger(frame.parentPid) && (frame.parentPid as number) > 0;
}

export function isInput(value: unknown): value is InitialContextEstimateWorkerInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  const model = frame.model as Record<string, unknown> | undefined;
  return frame.protocolVersion === INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION
    && frame.kind === 'discover'
    && typeof frame.sdkPath === 'string'
    && !Object.hasOwn(frame, 'sdkPatchIdentity')
    && validateSdkRuntimeSelectionShape(frame.sdkRuntime) === undefined
    && typeof frame.cwd === 'string'
    && typeof frame.agentDir === 'string'
    && !!model && typeof model.provider === 'string' && typeof model.id === 'string';
}

function startParentWatchdog(parentPid: number): () => void {
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      process.exit(1);
    }
  }, PARENT_WATCHDOG_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function readFrame<T>(
  stream: Readable,
  validate: (value: unknown) => value is T,
  description: string,
): Promise<T> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, value?: T) => {
      if (settled) return;
      settled = true;
      detach();
      stream.off('end', onEnd);
      if (error) reject(error); else resolve(value!);
    };
    const onEnd = () => finish(new Error(`${description} ended before a complete frame.`));
    const detach = attachJsonlLineReader(stream, (line) => {
      try {
        const value: unknown = JSON.parse(line);
        if (!validate(value)) throw new Error(`Invalid ${description}.`);
        finish(undefined, value);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }, {
      maxLineBytes: MAX_FRAME_BYTES - 1,
      emitTrailingLineOnEnd: false,
      onOverflow: () => finish(new Error(`${description} exceeded its frame limit.`)),
      onIncomplete: () => finish(new Error(`${description} ended mid-frame.`)),
    });
    stream.once('end', onEnd);
  });
}

async function writeOutput(
  stream: NodeJS.WritableStream,
  output: InitialContextEstimateWorkerOutput | InitialContextEstimateWorkerReady,
): Promise<void> {
  const wire = `${JSON.stringify(output)}\n`;
  if (Buffer.byteLength(wire, 'utf8') > MAX_FRAME_BYTES) throw new Error('Initial-context inventory response exceeded its frame limit.');
  await new Promise<void>((resolve, reject) => {
    stream.write(wire, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  const inputStream = fs.createReadStream('', { fd: IPC_READ_FD, autoClose: false });
  const outputStream = fs.createWriteStream('', { fd: IPC_WRITE_FD, autoClose: false });
  let stopWatchdog: (() => void) | undefined;
  const workerTimings: InitialContextEstimateWorkerTimings = {};
  try {
    const initialization = await readFrame(
      inputStream,
      isInitialization,
      'initial-context inventory initialization',
    );
    stopWatchdog = startParentWatchdog(initialization.parentPid);
    const sdkRuntime = parseSdkRuntimeSelection(initialization.sdkRuntime);
    const sdkImportStartedAt = performance.now();
    let sdk: SdkModule;
    let systemPromptModule: SdkSystemPromptModule;
    try {
      const verifiedRuntime = await verifySdkRuntimeSelection(initialization.sdkPath, sdkRuntime);
      // Preload only validated SDK code. Resource and user extension discovery
      // starts only after the separate request-specific frame arrives.
      const selectedMode = sdkRuntimeLoadMode(verifiedRuntime, 'full');
      // The inventory consumes only the common public services surface; the
      // source loader has already selected and verified its typed factories.
      sdk = await loadSdk(initialization.sdkPath, selectedMode) as unknown as SdkModule;
      systemPromptModule = await loadSdkInternalModule<SdkSystemPromptModule>(
        initialization.sdkPath,
        path.join('core', 'system-prompt.js'),
        selectedMode,
      );
    } finally {
      workerTimings.sdkImportDurationMs = Math.max(0, performance.now() - sdkImportStartedAt);
    }
    await writeOutput(outputStream, {
      protocolVersion: INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION,
      kind: 'ready',
      timings: { sdkImportDurationMs: workerTimings.sdkImportDurationMs },
    });

    const input = await readFrame(inputStream, isInput, 'initial-context inventory discovery request');
    assertSdkRuntimeAgreement(input.sdkPath, sdkRuntime, input.sdkRuntime);
    // Revalidate immediately before request-specific discovery as the selected
    // runtime may have changed while this one-use spare was idle.
    await verifySdkRuntimeSelection(input.sdkPath, sdkRuntime);
    process.chdir(input.cwd);
    const inventory = await collectInitialContextInventory(
      sdk,
      systemPromptModule,
      input,
      (stage, durationMs) => { workerTimings[stage] = durationMs; },
    );
    await writeOutput(outputStream, {
      protocolVersion: INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION,
      kind: 'result',
      ok: true,
      inventory,
      timings: workerTimings,
    });
  } catch (error) {
    await writeOutput(outputStream, {
      protocolVersion: INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION,
      kind: 'result',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(Object.keys(workerTimings).length > 0 ? { timings: workerTimings } : {}),
    }).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    stopWatchdog?.();
    inputStream.destroy();
    outputStream.end();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`[pie-initial-context-inventory] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
