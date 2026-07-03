import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import type { SessionEntryLike } from './transcript';

// ─── Minimal SDK contract ────────────────────────────────────────────────────
// We type only the surface the backend actually consumes. SDK breaking changes
// surface as TypeScript errors here instead of late runtime failures.

export interface SdkSessionEvent {
  type:
    | 'session_start'
    | 'agent_start'
    | 'agent_end'
    | 'message_start'
    | 'message_update'
    | 'message_end'
    | 'tool_execution_start'
    | 'tool_execution_update'
    | 'tool_execution_end'
    | string;
  message?: {
    role?: 'user' | 'assistant' | 'custom';
    content?: unknown;
    stopReason?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
    };
  };
  assistantMessageEvent?: {
    type: 'text_delta' | 'thinking_delta' | string;
    delta?: string;
    thinking?: string;
  };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  /** Partial result from onUpdate callback, present on tool_execution_update events. */
  partialResult?: unknown;
}

export interface SdkSessionManager {
  getCwd: () => string;
  getSessionFile: () => string | undefined;
  getSessionName: () => string | undefined;
  getBranch: () => SessionEntryLike[];
  getEntries: () => SessionEntryLike[];
}

export interface SdkImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface SdkPromptOptions {
  expandPromptTemplates?: boolean;
  images?: SdkImageContent[];
  streamingBehavior?: 'steer' | 'followUp';
  source?: string;
  preflightResult?: (success: boolean) => void;
}

export interface SdkToolInfo {
  name: string;
  description: string;
  parameters?: unknown;
  sourceInfo?: unknown;
}

export interface SdkSession {
  model?: { id: string; contextWindow?: number; maxTokens?: number };
  thinkingLevel?: string;
  sessionFile?: string;
  sessionName?: string;
  isStreaming: boolean;
  messages: unknown[];
  sessionManager: SdkSessionManager;
  subscribe: (listener: (event: SdkSessionEvent) => void) => () => void;
  prompt: (text: string, options?: SdkPromptOptions) => Promise<void>;
  abort: () => Promise<void>;
  setModel?: (model: unknown) => Promise<void>;
  setThinkingLevel?: (level: string) => void;
  getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  getAllTools?: () => SdkToolInfo[];
}

export interface SdkContextFile {
  path: string;
  content: string;
}

export interface SdkSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  sourceInfo: unknown;
  disableModelInvocation: boolean;
}

export interface SdkBuildSystemPromptOptions {
  cwd: string;
  customPrompt?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  contextFiles?: SdkContextFile[];
  skills?: SdkSkill[];
  /** Names of extensions that are currently active/enabled. */
  activeExtensions?: string[];
}

export interface SdkSystemPromptModule {
  buildSystemPrompt: (options: SdkBuildSystemPromptOptions) => string;
}

export interface SdkRuntime {
  session: SdkSession;
  services: {
    modelRegistry: {
      getAvailable: () => Array<{
        id: string;
        name: string;
        provider: string;
        reasoning: boolean;
        input: Array<'text' | 'image'>;
        contextWindow?: number;
        maxTokens?: number;
      }>;
      find: (provider: string, modelId: string) => unknown;
    };
    resourceLoader?: unknown;
    diagnostics?: unknown[];
  };
  dispose: () => Promise<void>;
}

export interface SdkSessionInfo {
  path: string;
  cwd: string;
  name?: string;
  modified: Date;
  messageCount: number;
}

export interface SdkModule {
  VERSION: string;
  getAgentDir: () => string;
  formatSkillsForPrompt?: (skills: SdkSkill[]) => string;
  AuthStorage: {
    create: (filePath?: string) => unknown;
  };
  SessionManager: {
    continueRecent: (cwd: string) => SdkSessionManager;
    create: (cwd: string) => SdkSessionManager;
    open: (sessionPath: string) => SdkSessionManager;
    forkFrom: (sourcePath: string, targetCwd: string, sessionDir?: string) => SdkSessionManager;
    listAll: () => Promise<SdkSessionInfo[]>;
  };
  createAgentSessionServices: (options: unknown) => Promise<unknown>;
  createAgentSessionFromServices: (options: unknown) => Promise<unknown>;
  createAgentSessionRuntime: (factory: unknown, options: unknown) => Promise<SdkRuntime>;
}

// ─── Loader ──────────────────────────────────────────────────────────────────

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

/**
 * Permitted parent directories for the SDK. The configured `sdkPath` must
 * resolve to a child of one of these locations to be loaded — defence in depth
 * against an attacker-controlled `--sdkPath` pointing at arbitrary code.
 *
 * Beyond the user profile and system program directories, the npm global
 * prefix (`NPM_CONFIG_PREFIX`, set by npm in every process it spawns) and the
 * host-supplied `PIE_TRUSTED_SDK_ROOT` are allowed so an SDK installed globally
 * under a non-standard prefix (e.g. `C:\nvm4w\nodejs` for nvm-windows, or a
 * proto-managed prefix) is loadable. The host derives `PIE_TRUSTED_SDK_ROOT`
 * from the sdkPath it resolved via `npm root -g`, so that root is
 * trusted-by-construction.
 */
function isPathAllowed(sdkPath: string): boolean {
  const normalized = path.resolve(sdkPath);
  const allowedRoots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'],
    process.env['APPDATA'],
    process.env['HOME'],
    process.env['USERPROFILE'],
    process.env['NPM_CONFIG_PREFIX'],
    process.env['PIE_TRUSTED_SDK_ROOT'],
    '/usr/local',
    '/usr/lib',
    '/opt',
  ].filter((r): r is string => typeof r === 'string' && r.length > 0);

  return allowedRoots.some((root) => {
    const r = path.resolve(root);
    return normalized === r || normalized.startsWith(r + path.sep);
  });
}

function assertAllowedSdkPath(sdkPath: string): void {
  if (!isPathAllowed(sdkPath)) {
    throw new Error(
      `Refusing to load SDK from disallowed path: ${sdkPath}. ` +
        `Set pie.sdkPath in VS Code settings (or the PI_SDK_PATH env var) to a directory under your user profile, system program directories, or the npm global prefix.`,
    );
  }
}

const RETRY_HOT_PATCH_FILE = path.join('dist', 'core', 'agent-session.js');
const RETRY_HOT_PATCH_NEEDLE = 'stream ended before message_stop';
const RETRY_HOT_PATCH_INSERT = 'stream ended before a terminal response event';

function logRetryHotPatchResult(sdkPath: string, result: SdkRetryHotPatchResult): void {
  console.warn(`[pie:backend] ${JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    scope: 'backend-sdk',
    event: 'retry-hotpatch',
    sdkPath,
    result,
  })}`);
}

export type SdkRetryHotPatchResult =
  | 'patched'
  | 'already-present'
  | 'missing-target'
  | 'unsupported-shape';

export async function applySdkRetryHotPatch(sdkPath: string): Promise<SdkRetryHotPatchResult> {
  assertAllowedSdkPath(sdkPath);

  const filePath = path.join(sdkPath, RETRY_HOT_PATCH_FILE);
  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing-target';
    throw error;
  }

  if (source.includes(RETRY_HOT_PATCH_INSERT)) return 'already-present';
  if (!source.includes(RETRY_HOT_PATCH_NEEDLE)) return 'unsupported-shape';

  await fs.writeFile(
    filePath,
    source.replace(RETRY_HOT_PATCH_NEEDLE, `${RETRY_HOT_PATCH_NEEDLE}|${RETRY_HOT_PATCH_INSERT}`),
    'utf8',
  );
  return 'patched';
}

export async function loadSdk(sdkPath: string): Promise<SdkModule> {
  assertAllowedSdkPath(sdkPath);
  const patchResult = await applySdkRetryHotPatch(sdkPath);
  logRetryHotPatchResult(sdkPath, patchResult);

  const entryUrl = pathToFileURL(path.join(sdkPath, 'dist', 'index.js')).href;
  const mod = (await dynamicImport(entryUrl)) as Partial<SdkModule>;

  if (
    typeof mod.VERSION !== 'string' ||
    typeof mod.getAgentDir !== 'function' ||
    typeof mod.SessionManager?.listAll !== 'function' ||
    typeof mod.createAgentSessionRuntime !== 'function'
  ) {
    throw new Error(
      `SDK at ${sdkPath} is missing required exports (expected pi-coding-agent contract).`,
    );
  }

  return mod as SdkModule;
}

export async function loadSdkInternalModule<TModule>(
  sdkPath: string,
  relativePath: string,
): Promise<TModule> {
  assertAllowedSdkPath(sdkPath);
  const entryUrl = pathToFileURL(path.join(sdkPath, 'dist', relativePath)).href;
  return (await dynamicImport(entryUrl)) as TModule;
}
