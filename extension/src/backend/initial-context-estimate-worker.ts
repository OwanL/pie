import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';

import { attachJsonlLineReader } from '../shared/jsonl';
import type { InitialContextEstimate } from '../shared/protocol';
import { estimateTextTokens } from '../shared/tokenize';
import { prepareContextFiles } from './context-files';
import type {
  SdkBuildSystemPromptOptions,
  SdkModule,
  SdkSession,
  SdkSessionEvent,
  SdkSessionManager,
  SdkSystemPromptModule,
  SdkToolInfo,
} from './sdk';
import { loadSdk, loadSdkInternalModule } from './sdk';
import type { SdkPatchIdentity } from './sdk-patch-barrier';
import {
  captureOriginalSystemPromptOptions,
  normalizePromptText,
} from './system-prompts';

const IPC_READ_FD = 3;
const IPC_WRITE_FD = 4;
const MAX_FRAME_BYTES = 256 * 1024;
const PARENT_WATCHDOG_INTERVAL_MS = 1_000;

export interface InitialContextEstimateWorkerInput {
  sdkPath: string;
  sdkPatchIdentity: SdkPatchIdentity;
  cwd: string;
  agentDir: string;
  parentPid: number;
  model: { provider: string; id: string };
}

export type InitialContextEstimateWorkerOutput =
  | { ok: true; estimate: InitialContextEstimate }
  | { ok: false; error: string };

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
export async function collectInitialContextEstimate(
  sdk: SdkModule,
  systemPromptModule: SdkSystemPromptModule,
  input: Pick<InitialContextEstimateWorkerInput, 'cwd' | 'agentDir' | 'model'>,
): Promise<InitialContextEstimate> {
  const providerBoundary = installInventoryProviderDenyBoundary();
  try {
    return await collectInitialContextEstimateInsideBoundary(
      sdk,
      systemPromptModule,
      input,
      providerBoundary.assertNoAttempts,
    );
  } finally {
    providerBoundary.restore();
  }
}

async function collectInitialContextEstimateInsideBoundary(
  sdk: SdkModule,
  systemPromptModule: SdkSystemPromptModule,
  input: Pick<InitialContextEstimateWorkerInput, 'cwd' | 'agentDir' | 'model'>,
  assertNoProviderAttempts: () => void,
): Promise<InitialContextEstimate> {
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
    }) as Record<string, unknown>;
    return { ...created, services };
  };

  const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
    cwd: input.cwd,
    agentDir: input.agentDir,
    sessionManager: manager,
    sessionStartEvent: { type: 'session_start', reason: 'startup' },
  });

  try {
    const session = runtime.session;
    installInventorySessionGuards(session);
    await bindInventoryExtensions(session, runtime);
    // A handler may catch the deny error and otherwise leave a plausible but
    // incomplete catalog. Convert every attempted network call into fail-open
    // omission instead of publishing a partial estimate.
    assertNoProviderAttempts();

    const promptState = session as SdkSession & PromptStateLike;
    captureOriginalSystemPromptOptions(promptState);
    const promptOptions = promptState._originalSystemPromptOptions ?? promptState._baseSystemPromptOptions;
    if (!promptOptions) throw new Error('Fresh inventory did not expose system prompt options.');

    const tools = session.getAllTools?.() ?? [];
    const inventoryPromptOptions = buildAllRegisteredPromptOptions(session, promptOptions, tools);
    const fullSystemPrompt = normalizePromptText(systemPromptModule.buildSystemPrompt(inventoryPromptOptions));
    if (!fullSystemPrompt) throw new Error('Fresh inventory did not build a system prompt.');

    // Count the exact SDK-built prompt text rather than Pie's display-only
    // rewritten harness. Provider tool descriptions/schemas are separate
    // request metadata and are added exactly once below.
    const tokens = estimateTextTokens(fullSystemPrompt) + estimateTextTokens(buildToolCatalogText(tools));
    const contextWindow = session.model?.contextWindow;
    if (!Number.isSafeInteger(tokens) || tokens < 0
      || !Number.isSafeInteger(contextWindow) || (contextWindow ?? 0) <= 0) {
      throw new Error('Fresh inventory did not resolve a valid token total and context window.');
    }
    return { tokens, contextWindow: contextWindow! };
  } finally {
    await runtime.dispose();
  }
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

function isInput(value: unknown): value is InitialContextEstimateWorkerInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  const model = frame.model as Record<string, unknown> | undefined;
  return typeof frame.sdkPath === 'string'
    && !!frame.sdkPatchIdentity && typeof frame.sdkPatchIdentity === 'object'
    && typeof frame.cwd === 'string'
    && typeof frame.agentDir === 'string'
    && Number.isSafeInteger(frame.parentPid) && (frame.parentPid as number) > 0
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

async function readInput(stream: Readable): Promise<InitialContextEstimateWorkerInput> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, value?: InitialContextEstimateWorkerInput) => {
      if (settled) return;
      settled = true;
      detach();
      if (error) reject(error); else resolve(value!);
    };
    const detach = attachJsonlLineReader(stream, (line) => {
      try {
        const value: unknown = JSON.parse(line);
        if (!isInput(value)) throw new Error('Invalid initial-context inventory request.');
        finish(undefined, value);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }, {
      maxLineBytes: MAX_FRAME_BYTES - 1,
      emitTrailingLineOnEnd: false,
      onOverflow: () => finish(new Error('Initial-context inventory request exceeded its frame limit.')),
      onIncomplete: () => finish(new Error('Initial-context inventory request ended mid-frame.')),
    });
  });
}

async function writeOutput(stream: NodeJS.WritableStream, output: InitialContextEstimateWorkerOutput): Promise<void> {
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
  try {
    const input = await readInput(inputStream);
    stopWatchdog = startParentWatchdog(input.parentPid);
    const sdk = await loadSdk(input.sdkPath, { mode: 'worker', patchIdentity: input.sdkPatchIdentity });
    const systemPromptModule = await loadSdkInternalModule<SdkSystemPromptModule>(
      input.sdkPath,
      path.join('core', 'system-prompt.js'),
      { mode: 'worker', patchIdentity: input.sdkPatchIdentity },
    );
    const estimate = await collectInitialContextEstimate(sdk, systemPromptModule, input);
    await writeOutput(outputStream, { ok: true, estimate });
  } catch (error) {
    await writeOutput(outputStream, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
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
