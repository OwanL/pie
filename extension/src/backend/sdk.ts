import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SessionEntryLike } from './transcript';
import type { MessageLike } from './transcript/types';

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
    errorMessage?: string;
    usage?: MessageLike['usage'];
  };
  assistantMessageEvent?: {
    type: 'text_delta' | 'thinking_delta' | 'toolcall_start' | 'toolcall_delta' | string;
    delta?: string;
    thinking?: string;
    contentIndex?: number;
    partial?: {
      content?: Array<{ type?: string; id?: string; name?: string }>;
    };
  };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  /** Partial result from onUpdate callback, present on tool_execution_update events. */
  partialResult?: unknown;
  /** `agent_end` is re-emitted by AgentSession with `willRetry: true` when the
   *  SDK will auto-retry the turn (a transient error occurred and the backoff
   *  sleep + retry are pending). The backend gates `agent_end` finalization on
   *  `!willRetry` so a mid-retry `agent_end` does not clear `activeRequest`
   *  (which would break the retry turn's streaming) or flicker `busy` false. */
  willRetry?: boolean;
  /** `auto_retry_start`: 1-based retry attempt about to sleep/retry. */
  attempt?: number;
  /** `auto_retry_start`: configured max retry attempts. */
  maxAttempts?: number;
  /** `auto_retry_start`: backoff delay (ms) before this attempt. */
  delayMs?: number;
  /** `auto_retry_start`: verbatim provider error that triggered the retry. */
  errorMessage?: string;
  /** `auto_retry_end`: whether the retry attempt succeeded. */
  success?: boolean;
  /** `auto_retry_end`: final error on a failed/exhausted/cancelled retry. */
  finalError?: string;
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
  model?: { id: string; provider?: string; contextWindow?: number; maxTokens?: number };
  thinkingLevel?: string;
  sessionFile?: string;
  sessionName?: string;
  isStreaming: boolean;
  messages: unknown[];
  sessionManager: SdkSessionManager;
  subscribe: (listener: (event: SdkSessionEvent) => void) => () => void;
  prompt: (text: string, options?: SdkPromptOptions) => Promise<void>;
  abort: () => Promise<void>;
  /** Queue a follow-up message to run as a fresh turn after the current turn
   *  completes. Used by `message.send` when a turn is already running (steering)
   *  on an older SDK without `steer`. Throws synchronously if the text is an
   *  extension command. */
  followUp: (text: string, images?: SdkImageContent[]) => Promise<void>;
  /** Inject a steering message into the CURRENT turn (delivered after in-flight
   *  tool calls finish, before the next LLM call), preferred over `followUp`
   *  by `message.send` when a turn is already running. The agent loop emits
   *  `message_start` (role 'user') when it injects the message, which the
   *  backend forwards as `message.queuedDelivered` so the host promotes its
   *  optimistic 'queued' message to 'completed'. Optional: older SDKs only
   *  expose `followUp`. */
  steer?: (text: string, images?: SdkImageContent[]) => Promise<void>;
  /** Clear all queued steering + follow-up messages and return what was cleared.
   *  Synchronous. Used by `message.clearQueue` and on interrupt. */
  clearQueue: () => { steering: string[]; followUp: string[] };
  /** Billable windows that may still be running after `agent_end` (the backend
   *  already cleared `activeRequest` + emitted busy=false). `message.interrupt`
   *  treats any of these as "running" so a Stop hard-stops the spend instead of
   *  being rejected as SESSION_NOT_RUNNING. Optional: an older SDK that doesn't
   *  expose a predicate is `undefined` → falsy → the legacy guard behaviour. */
  isCompacting?: boolean;
  isRetrying?: boolean;
  isBashRunning?: boolean;
  /** Hard-stop the corresponding billable window. `session.abort()` alone does
   *  NOT stop these post-agent_end LLM/tool calls, so `message.interrupt` calls
   *  them synchronously before the un-awaited `abort()` runs. Each is a no-op
   *  when its window isn't running. Optional: older SDKs that don't expose them
   *  are unaffected (optional-chained at the call site). */
  abortCompaction?: () => void;
  abortBranchSummary?: () => void;
  abortBash?: () => void;
  abortRetry?: () => void;
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

// ─── SDK retry-classifier hot-patch ──────────────────────────────────────────
// The SDK's transient-error retry classifier has moved between versions:
//  - Legacy: an inline regex in `dist/core/agent-session.js`
//    (`/...|stream ended before message_stop|.../i.test(err)`).
//  - Current: a pattern array in
//    `node_modules/@earendil-works/pi-ai/dist/utils/retry.js`
//    (`"stream ended before message_stop",`), joined into a RegExp by
//    `buildProviderErrorPattern`. The host prefers the local extension
//    `node_modules` SDK (runtime-resolution priority 3), which ships this
//    current shape. The hot-patch MUST handle the array shape or it silently
//    no-ops (`unsupported-shape`) and stream cuts/stalls are never retried.
//
// The patterns added cover saturation-induced failure modes that pi-ai
// surfaces as `stopReason=error` but the upstream classifier does NOT match:
//  - `stream ended before a terminal response event`: pi-ai throws this when
//    an OpenAI Responses SSE stream ends without `response.completed`/
//    `response.incomplete`/`response.failed`. This is EXACTLY what the
//    host-side ProviderGate's stream-liveness watchdog produces when it
//    terminates a stalled upstream (it errors the stream, which the Responses
//    parser does not recognise as a terminal event) — and what an upstream
//    truncation produces. Without this pattern, a stalled/truncated stream is
//    a silent interruption (never retried) instead of a retried turn.
//  - `upstream stream stalled` / `upstream header phase stalled`: the
//    ProviderGate's own terminal error texts, should they ever surface in an
//    errorMessage. Belt-and-suspenders — the 504 header-phase path already
//    matches `504`.
const RETRY_HOT_PATCH_INSERTS = [
  'stream ended before a terminal response event',
  'upstream stream stalled',
  'upstream header phase stalled',
] as const;
// Idempotency marker: the primary insert. If present, the file is already patched.
const RETRY_HOT_PATCH_MARKER = RETRY_HOT_PATCH_INSERTS[0];

type RetryHotPatchShape = 'array' | 'inline';
interface RetryHotPatchCandidate {
  /** Path segments relative to the SDK root. */
  rel: readonly string[];
  /** Literal substring unique to this file's shape. The replacement appends the
   *  missing patterns in the shape-appropriate syntax at this location. */
  needle: string;
  shape: RetryHotPatchShape;
}
// Current shape first (the host-preferred local SDK ships it), then the legacy
// inline shape so a global npm install that still has the inline classifier is
// also covered.
const RETRY_HOT_PATCH_CANDIDATES: readonly RetryHotPatchCandidate[] = [
  {
    // Quoted array entry WITH trailing comma so it does NOT match the comment
    // line above that also mentions `stream ended before message_stop`.
    rel: ['node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'retry.js'],
    needle: '"stream ended before message_stop",',
    shape: 'array',
  },
  {
    rel: ['dist', 'core', 'agent-session.js'],
    needle: 'stream ended before message_stop',
    shape: 'inline',
  },
];

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

/** Build the replacement text for `needle` in the given shape, appending the
 *  missing retryable patterns in the shape-appropriate syntax.
 *  - `array`: `"stream ended before message_stop", "pat1", "pat2", ...,`
 *    (new array entries after the matched one).
 *  - `inline`: `stream ended before message_stop|pat1|pat2|...` (new regex
 *    alternatives after the matched alternative). */
function buildRetryHotPatchReplacement(needle: string, shape: RetryHotPatchShape): string {
  if (shape === 'array') {
    return `${needle} ${RETRY_HOT_PATCH_INSERTS.map((p) => `"${p}"`).join(', ')},`;
  }
  return `${needle}|${RETRY_HOT_PATCH_INSERTS.join('|')}`;
}

export async function applySdkRetryHotPatch(sdkPath: string): Promise<SdkRetryHotPatchResult> {
  assertAllowedSdkPath(sdkPath);

  let foundAnyFile = false;
  for (const candidate of RETRY_HOT_PATCH_CANDIDATES) {
    const filePath = path.join(sdkPath, ...candidate.rel);
    let source: string;
    try {
      source = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    foundAnyFile = true;

    // Idempotent: the primary insert is already present in this file.
    if (source.includes(RETRY_HOT_PATCH_MARKER)) return 'already-present';

    if (!source.includes(candidate.needle)) continue; // wrong shape — try next candidate

    await fs.writeFile(
      filePath,
      source.replace(candidate.needle, buildRetryHotPatchReplacement(candidate.needle, candidate.shape)),
      'utf8',
    );
    return 'patched';
  }

  return foundAnyFile ? 'unsupported-shape' : 'missing-target';
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
