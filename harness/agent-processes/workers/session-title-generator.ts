import * as nodeModule from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PROVIDER_GATE_REQUEST_CLASS_HEADER,
  PROVIDER_GATE_REQUEST_CLASS_SESSION_TITLE,
} from '../../model-providers/concurrency/provider-gate-request-class.js';
import { providerReportedCostUsd } from '../../model-providers/pricing/provider-cost.js';
import type { SessionContext } from '../coordinator/server-types.js';
import type { AssistantUsage } from '../../../analytics/contracts/legacy-run-analytics-contracts.js';
import type { ThinkingLevel } from '../../model-providers/catalog/thinking-level.js';

export const SESSION_TITLE_TIMEOUT_MS = 15_000;
export const SESSION_TITLE_MAX_INPUT_CHARS = 4_000;
/** Base-title budget shared with the coordinator title authority. Automatic
 * collision suffixes are outside this candidate allowance. */
export const SESSION_TITLE_MAX_CHARS = 25;
export const SESSION_TITLE_MAX_WORDS = 6;
export const SESSION_TITLE_MAX_OUTPUT_TOKENS = 48;

export const SESSION_TITLE_SYSTEM_PROMPT = `Write a short title for a coding-agent session from its first user request.

Return only the title, with no quotes, label, punctuation, or explanation.
- Write a complete title of at most 25 characters. Prefer 2 or 3 short words when appropriate for the language.
- Put the primary action and subject first; omit secondary details to fit the character budget.
- Capture the primary task, problem, or question, not the conversational framing.
- Ignore workflow instructions such as using subagents, reading files first, asking questions, being read-only, or making the smallest change.
- Preserve useful identifiers such as ticket IDs, PR numbers, filenames, APIs, and product names.
- For a reported problem, describe the investigation or fix the user wants.
- Do not invent details.

Examples:
User: Could you use subagents to investigate why our Windows tests are flaky?
Title: Fix Flaky Windows Tests
User: I'm deciding between SQLite and JSON for our cache. Compare their trade-offs.
Title: Compare SQLite JSON Cache
User: Review https://github.com/acme/app/pull/42. Do not make changes.
Title: Review PR #42`;

interface AuxiliaryModel {
  id: string;
  provider: string;
  baseUrl?: string;
  [key: string]: unknown;
}

interface TitleCapableSession {
  sessionName?: string;
  sessionManager: { getSessionName(): string | undefined };
  _modelRegistry?: { find(provider: string, id: string): unknown };
  _getCompactionRequestAuth?: (model: unknown) => Promise<{
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  }>;
}

interface CompleteSimpleMessage {
  content?: Array<{ type?: string; text?: string }>;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    reportedCostUsd?: number;
    providerReportedCostUsd?: number;
    cost?: { total?: number; reportedCostUsd?: number; providerReportedCostUsd?: number };
  };
}

interface TitleCompletion {
  text: string;
  usage?: AssistantUsage;
}

type CompleteSimpleFn = (
  model: unknown,
  context: {
    systemPrompt: string;
    messages: Array<{
      role: 'user';
      content: Array<{ type: 'text'; text: string }>;
      timestamp: number;
    }>;
  },
  options: Record<string, unknown>,
) => Promise<CompleteSimpleMessage>;

interface SessionTitleSettlement {
  usage?: AssistantUsage;
  startedAt: string;
  endedAt: string;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  /** 0-based index of the provider invocation within this title operation;
   * retries must be attributable as distinct settlements. */
  attempt: number;
}

export interface SessionTitleGeneratorDeps {
  fetchFn?: typeof fetch;
  completeSimple?: CompleteSimpleFn;
  loadCompleteSimple?: (sdkPath: string) => Promise<CompleteSimpleFn>;
  now?: () => number;
  timeoutMs?: number;
  onSettled?: (settlement: SessionTitleSettlement) => void;
  /** Internal: invoked synchronously when a provider invocation is dispatched
   * for the given attempt, before the provider can honor or ignore the abort
   * signal. The deadline wrapper uses it to attribute attempts that can never
   * settle on their own (noncooperative providers) as cancelled. */
  onDispatch?: (attempt: number, startedAt: string) => void;
}

export type SessionTitleGenerationResult =
  | { generated: true; name: string }
  | { generated: false; reason: 'explicit-name' | 'model-unavailable' | 'auth-unavailable' | 'invalid-output' | 'empty-prompt' | 'unsupported-runtime' };

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

/** Remove bulky code while preserving prose at both ends, where users most often put context and the final ask. */
export function compactSessionTitleInput(text: string): string {
  const normalized = text
    .replace(/```[^\n]*\n[\s\S]*?```/g, '[code omitted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= SESSION_TITLE_MAX_INPUT_CHARS) return normalized;
  const marker = ' … [content omitted] … ';
  const side = Math.floor((SESSION_TITLE_MAX_INPUT_CHARS - marker.length) / 2);
  return `${normalized.slice(0, side).trimEnd()}${marker}${normalized.slice(-side).trimStart()}`;
}

/** Validate a complete title without truncation. The legacy optional flag is ignored. */
export function sanitizeGeneratedSessionTitle(raw: string, _compactOversize = false): string | undefined {
  for (const character of raw) {
    const codePoint = character.codePointAt(0)!;
    if ((codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) || codePoint === 0x7f) {
      return undefined;
    }
  }
  const lines = raw
    .replace(/^```[^\n]*\n?/u, '')
    .replace(/\n?```\s*$/u, '')
    .split(/\r\n?|\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return undefined;
  const title = lines[0]!
    .replace(/^(?:session\s+)?title\s*:\s*/iu, '')
    .replace(/^['"`*_]+|['"`*_.]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title || title.length > SESSION_TITLE_MAX_CHARS || !/[\p{L}\p{N}]/u.test(title)) return undefined;
  return title;
}

function titleUserMessage(prompt: string): string {
  return `<request>\n${prompt}\n</request>`;
}

async function completeOllamaNative(
  model: AuxiliaryModel,
  prompt: string,
  signal: AbortSignal,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  thinkingLevel: ThinkingLevel,
): Promise<TitleCompletion> {
  if (!model.baseUrl) throw new Error('The selected Ollama model has no base URL.');
  const url = new URL(model.baseUrl);
  url.pathname = `${url.pathname.replace(/\/(?:v1)?\/?$/u, '')}/api/chat`;
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    signal,
    body: JSON.stringify({
      model: model.id,
      messages: [
        { role: 'system', content: SESSION_TITLE_SYSTEM_PROMPT },
        { role: 'user', content: titleUserMessage(prompt) },
      ],
      stream: false,
      think: thinkingLevel === 'off' || thinkingLevel === 'minimal'
        ? false
        : thinkingLevel === 'xhigh' || thinkingLevel === 'max' ? 'high' : thinkingLevel,
      options: { temperature: 0, num_predict: SESSION_TITLE_MAX_OUTPUT_TOKENS },
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Ollama title request failed (${response.status}): ${detail || response.statusText}`);
  }
  const payload = await response.json() as {
    message?: { content?: unknown };
    prompt_eval_count?: unknown;
    eval_count?: unknown;
  };
  const inputTokens = finiteNonNegative(payload.prompt_eval_count);
  const outputTokens = finiteNonNegative(payload.eval_count);
  return {
    text: typeof payload.message?.content === 'string' ? payload.message.content : '',
    ...(inputTokens !== undefined && outputTokens !== undefined ? {
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: inputTokens + outputTokens,
      },
    } : {}),
  };
}

type NativeFindPackageJSON = (specifier: string, parentURL?: string | URL) => string | undefined;
const nativeFindPackageJSON = (nodeModule as typeof nodeModule & {
  findPackageJSON?: NativeFindPackageJSON;
}).findPackageJSON;

export async function loadCompleteSimple(sdkPath: string): Promise<CompleteSimpleFn> {
  if (typeof nativeFindPackageJSON !== 'function') {
    throw new Error('The running Node.js does not provide native module.findPackageJSON (requires Node.js >=22.19).');
  }
  const aiPackageJson = nativeFindPackageJSON(
    '@earendil-works/pi-ai',
    pathToFileURL(path.join(sdkPath, 'package.json')),
  );
  if (!aiPackageJson) throw new Error('The pinned Pi runtime dependency graph is missing @earendil-works/pi-ai package metadata.');
  const aiMetadata = JSON.parse(await readFile(aiPackageJson, 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  const rootExport = (aiMetadata.exports as Record<string, unknown> | undefined)?.['./compat'];
  const importTarget = typeof rootExport === 'string'
    ? rootExport
    : rootExport && typeof rootExport === 'object'
      ? (rootExport as { import?: unknown }).import
      : undefined;
  if (typeof importTarget !== 'string' || !importTarget.startsWith('./')) {
    throw new Error('The pinned Pi AI runtime must declare a relative ./compat import export.');
  }
  const moduleUrl = new URL(importTarget, pathToFileURL(aiPackageJson));
  const loaded = await dynamicImport(moduleUrl.href) as { completeSimple?: CompleteSimpleFn };
  if (typeof loaded.completeSimple !== 'function') throw new Error('The pinned Pi AI runtime does not export completeSimple.');
  return loaded.completeSimple;
}

async function completeGeneric(
  sdkPath: string,
  model: AuxiliaryModel,
  prompt: string,
  signal: AbortSignal,
  auth: { apiKey?: string; headers?: Record<string, string> },
  deps: SessionTitleGeneratorDeps,
  thinkingLevel: ThinkingLevel,
  onDispatch?: () => void,
): Promise<TitleCompletion> {
  const completeSimple = deps.completeSimple ?? await (deps.loadCompleteSimple ?? loadCompleteSimple)(sdkPath);
  // Runtime loading may finish after the operation has been abandoned. Do not
  // dispatch the provider or record an attempt after cancellation.
  signal.throwIfAborted();
  onDispatch?.();
  const response = await completeSimple(model, {
    systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: titleUserMessage(prompt) }],
      timestamp: (deps.now ?? Date.now)(),
    }],
  }, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    signal,
    reasoning: thinkingLevel,
    maxTokens: SESSION_TITLE_MAX_OUTPUT_TOKENS,
    maxRetries: 0,
  });
  if (response.errorMessage) throw new Error(response.errorMessage);
  const rawUsage = response.usage;
  const inputTokens = finiteNonNegative(rawUsage?.input);
  const outputTokens = finiteNonNegative(rawUsage?.output);
  const cacheReadTokens = finiteNonNegative(rawUsage?.cacheRead);
  const cacheWriteTokens = finiteNonNegative(rawUsage?.cacheWrite);
  const totalTokens = finiteNonNegative(rawUsage?.totalTokens);
  const reportedCostUsd = providerReportedCostUsd(rawUsage);
  const tokenChannelPresence = {
    input: inputTokens !== undefined,
    output: outputTokens !== undefined,
    cacheRead: cacheReadTokens !== undefined,
    cacheWrite: cacheWriteTokens !== undefined,
  };
  const hasUsageEvidence = Object.values(tokenChannelPresence).some(Boolean)
    || totalTokens !== undefined || reportedCostUsd !== undefined;
  const channelsKnown = Object.values(tokenChannelPresence).every(Boolean);
  const usage = hasUsageEvidence
    ? {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        cacheReadTokens: cacheReadTokens ?? 0,
        cacheWriteTokens: cacheWriteTokens ?? 0,
        totalTokens: totalTokens
          ?? (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
        ...(!channelsKnown ? { tokenChannelsKnown: false, tokenChannelPresence } : {}),
        ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
      }
    : undefined;
  return {
    text: (response.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join(''),
    ...(usage ? { usage } : {}),
  };
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hasExplicitSessionName(session: TitleCapableSession): boolean {
  return Boolean(session.sessionName?.trim() || session.sessionManager.getSessionName()?.trim());
}

/** Generate one candidate title without a final durable write. Every expected
 * failure leaves the prompt snippet untouched. Publication is owned by the
 * coordinator title authority: it reserves a unique name and the owning worker
 * persists the assigned title, so this seam never calls setSessionName and the
 * returned candidate is not authoritative until that flow publishes it. */
export async function generateSessionTitle(
  context: SessionContext,
  options: { sdkPath: string; prompt: string; provider: string; model: string; thinkingLevel?: ThinkingLevel; timeoutSec?: number; signal?: AbortSignal },
  deps: SessionTitleGeneratorDeps = {},
): Promise<SessionTitleGenerationResult> {
  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  /** Attempt indices already reported to analytics. Late or duplicated
   * settlements for the same attempt (for example an inner run that resumes
   * detached after the operation was abandoned) must stay exactly-once. */
  const settledAttempts = new Set<number>();
  const reportSettlement = (settlement: SessionTitleSettlement) => {
    if (settledAttempts.has(settlement.attempt)) return;
    settledAttempts.add(settlement.attempt);
    deps.onSettled?.(settlement);
  };
  /** The provider attempt most recently dispatched by the inner run, recorded
   * at dispatch time so a deadline or caller abort can still settle the active
   * attempt with its true identity and start. */
  let dispatchedAttempt: { attempt: number; startedAt: string } | undefined;
  const abort = () => {
    if (dispatchedAttempt && !settledAttempts.has(dispatchedAttempt.attempt)) {
      reportSettlement({
        startedAt: dispatchedAttempt.startedAt,
        endedAt: new Date((deps.now ?? Date.now)()).toISOString(),
        outcome: 'cancelled',
        attempt: dispatchedAttempt.attempt,
      });
    }
    const error = new Error('Session title generation aborted');
    error.name = 'AbortError';
    controller.abort(error);
    rejectAbort(error);
  };
  const timeout = setTimeout(abort, deps.timeoutMs ?? (options.timeoutSec ?? 15) * 1_000);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    if (controller.signal.aborted) return await cancelled;
    return await Promise.race([
      cancelled,
      generateSessionTitleWithinDeadline(context, { ...options, signal: controller.signal }, {
        ...deps,
        onSettled: (settlement) => { reportSettlement(settlement); },
        onDispatch: (attempt, startedAt) => { dispatchedAttempt = { attempt, startedAt }; },
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

async function generateSessionTitleWithinDeadline(
  context: SessionContext,
  options: { sdkPath: string; prompt: string; provider: string; model: string; thinkingLevel?: ThinkingLevel; timeoutSec?: number; signal?: AbortSignal },
  deps: SessionTitleGeneratorDeps = {},
): Promise<SessionTitleGenerationResult> {
  const prompt = compactSessionTitleInput(options.prompt);
  if (!prompt) return { generated: false, reason: 'empty-prompt' };

  const session = context.session as typeof context.session & TitleCapableSession;
  if (hasExplicitSessionName(session)) return { generated: false, reason: 'explicit-name' };
  if (!session._modelRegistry?.find) return { generated: false, reason: 'unsupported-runtime' };
  const model = session._modelRegistry.find(options.provider, options.model) as AuxiliaryModel | undefined;
  if (!model || typeof model.id !== 'string' || typeof model.provider !== 'string') {
    return { generated: false, reason: 'model-unavailable' };
  }
  if (!session._getCompactionRequestAuth) return { generated: false, reason: 'unsupported-runtime' };
  const auth = await session._getCompactionRequestAuth(model);
  options.signal?.throwIfAborted();
  if (hasExplicitSessionName(session)) return { generated: false, reason: 'explicit-name' };
  if (model.provider !== 'ollama' && !auth.apiKey && !auth.headers) {
    return { generated: false, reason: 'auth-unavailable' };
  }

  const timeoutController = new AbortController();
  const thinkingLevel = options.thinkingLevel ?? 'off';
  const timeout = setTimeout(() => timeoutController.abort(), deps.timeoutMs ?? (options.timeoutSec ?? 15) * 1_000);
  const abort = () => timeoutController.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const headers = {
    ...(auth.headers ?? {}),
    [PROVIDER_GATE_REQUEST_CLASS_HEADER]: PROVIDER_GATE_REQUEST_CLASS_SESSION_TITLE,
  };
  const startedAt = new Date((deps.now ?? Date.now)()).toISOString();
  let attempt = 0;
  let attemptStartedAt = startedAt;
  let settled = false;
  /** True once this attempt's provider invocation was actually dispatched; a
   * cancellation or failure before dispatch fabricates no invocation. */
  let dispatched = false;
  const dispatchAttempt = () => {
    dispatched = true;
    deps.onDispatch?.(attempt, attemptStartedAt);
  };
  try {
    for (; attempt < 2; attempt += 1) {
      attemptStartedAt = new Date((deps.now ?? Date.now)()).toISOString();
      settled = false;
      dispatched = false;
      timeoutController.signal.throwIfAborted();
      if (hasExplicitSessionName(session)) return { generated: false, reason: 'explicit-name' };
      const requestPrompt = attempt === 0 ? prompt : compactSessionTitleInput(`${prompt}\n\nThe previous response was invalid. Write a complete replacement title, one line only, at most 25 characters. Do not truncate a longer title or add explanation.`);
      let completion: TitleCompletion;
      if (model.provider === 'ollama') {
        dispatchAttempt();
        completion = await completeOllamaNative(model, requestPrompt, timeoutController.signal, headers, deps.fetchFn ?? fetch, thinkingLevel);
      } else {
        completion = await completeGeneric(options.sdkPath, model, requestPrompt, timeoutController.signal, { ...auth, headers }, deps, thinkingLevel, dispatchAttempt);
      }
      timeoutController.signal.throwIfAborted();
      settled = true;
      deps.onSettled?.({
        usage: completion.usage,
        startedAt: attemptStartedAt,
        endedAt: new Date((deps.now ?? Date.now)()).toISOString(),
        outcome: 'succeeded',
        attempt,
      });
      const candidate = sanitizeGeneratedSessionTitle(completion.text);
      if (!candidate) continue;

      // A manual rename racing inference always wins; generation never persists.
      if (hasExplicitSessionName(session)) return { generated: false, reason: 'explicit-name' };
      return { generated: true, name: candidate };
    }
    return { generated: false, reason: 'invalid-output' };
  } catch (error) {
    if (!settled && dispatched) {
      deps.onSettled?.({
        startedAt: attemptStartedAt,
        endedAt: new Date((deps.now ?? Date.now)()).toISOString(),
        outcome: timeoutController.signal.aborted ? 'cancelled' : 'failed',
        attempt,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
