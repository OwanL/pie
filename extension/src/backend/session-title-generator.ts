import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PROVIDER_GATE_REQUEST_CLASS_HEADER,
  PROVIDER_GATE_REQUEST_CLASS_SESSION_TITLE,
} from '../../../shared/provider-gate-request-class.js';
import type { SessionContext } from './server-types.js';
import type { AssistantUsage } from '../shared/protocol.js';

export const SESSION_TITLE_TIMEOUT_MS = 15_000;
export const SESSION_TITLE_MAX_INPUT_CHARS = 4_000;
export const SESSION_TITLE_MAX_CHARS = 40;
export const SESSION_TITLE_MAX_WORDS = 6;
export const SESSION_TITLE_MAX_OUTPUT_TOKENS = 48;

export const SESSION_TITLE_SYSTEM_PROMPT = `Write a short title for a coding-agent session from its first user request.

Return only the title, with no quotes, label, punctuation, or explanation.
- Use 3 to 6 words and at most 40 characters.
- Capture the primary task, problem, or question, not the conversational framing.
- Ignore workflow instructions such as using subagents, reading files first, asking questions, being read-only, or making the smallest change.
- Preserve useful identifiers such as ticket IDs, PR numbers, filenames, APIs, and product names.
- For a reported problem, describe the investigation or fix the user wants.
- Do not invent details.

Examples:
User: Could you use subagents to investigate why our Windows tests are flaky?
Title: Investigate Flaky Windows Tests
User: I'm deciding between SQLite and JSON for our cache. Compare their trade-offs.
Title: Compare SQLite and JSON Caches
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
  setSessionName?: (name: string) => void;
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
    cost?: { total?: number };
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

export interface SessionTitleGeneratorDeps {
  fetchFn?: typeof fetch;
  completeSimple?: CompleteSimpleFn;
  now?: () => number;
  timeoutMs?: number;
  onSettled?: (settlement: {
    usage?: AssistantUsage;
    startedAt: string;
    endedAt: string;
    outcome: 'succeeded' | 'failed' | 'cancelled';
  }) => void;
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

/** Parse the deliberately tiny output contract. Invalid prose fails soft to the prompt snippet. */
export function sanitizeGeneratedSessionTitle(raw: string): string | undefined {
  for (const character of raw) {
    const codePoint = character.codePointAt(0)!;
    if ((codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) || codePoint === 0x7f) {
      return undefined;
    }
  }
  const lines = raw
    .replace(/^```[^\n]*\n?/u, '')
    .replace(/\n?```\s*$/u, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return undefined;
  const title = lines[0]!
    .replace(/^(?:session\s+)?title\s*:\s*/iu, '')
    .replace(/^['"`*_]+|['"`*_.]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = title.split(' ').filter(Boolean);
  if (title.length < 2 || title.length > SESSION_TITLE_MAX_CHARS) return undefined;
  if (words.length < 2 || words.length > SESSION_TITLE_MAX_WORDS) return undefined;
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
  thinkingLevel: import('../shared/protocol.js').ThinkingLevel,
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

async function loadCompleteSimple(sdkPath: string): Promise<CompleteSimpleFn> {
  const modulePath = path.join(sdkPath, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js');
  const loaded = await dynamicImport(pathToFileURL(modulePath).href) as { completeSimple?: CompleteSimpleFn };
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
  thinkingLevel: import('../shared/protocol.js').ThinkingLevel,
): Promise<TitleCompletion> {
  const completeSimple = deps.completeSimple ?? await loadCompleteSimple(sdkPath);
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
  const usage = inputTokens !== undefined && outputTokens !== undefined
    && cacheReadTokens !== undefined && cacheWriteTokens !== undefined
    ? {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: finiteNonNegative(rawUsage?.totalTokens)
          ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        ...(finiteNonNegative(rawUsage?.cost?.total) !== undefined
          ? { reportedCostUsd: finiteNonNegative(rawUsage?.cost?.total) }
          : {}),
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

/** Generate and durably append one title. Every expected failure leaves the prompt snippet untouched. */
export async function generateSessionTitle(
  context: SessionContext,
  options: { sdkPath: string; prompt: string; provider: string; model: string; thinkingLevel?: import('../shared/protocol.js').ThinkingLevel; timeoutSec?: number; signal?: AbortSignal },
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
  if (model.provider !== 'ollama' && !auth.apiKey && !auth.headers) {
    return { generated: false, reason: 'auth-unavailable' };
  }

  const timeoutController = new AbortController();
  const thinkingLevel = options.thinkingLevel ?? 'off';
  const timeout = setTimeout(() => timeoutController.abort(), deps.timeoutMs ?? (options.timeoutSec ?? 15) * 1_000);
  const abort = () => timeoutController.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const headers = {
    ...(auth.headers ?? {}),
    [PROVIDER_GATE_REQUEST_CLASS_HEADER]: PROVIDER_GATE_REQUEST_CLASS_SESSION_TITLE,
  };
  const startedAt = new Date((deps.now ?? Date.now)()).toISOString();
  let settled = false;
  try {
    const completion = model.provider === 'ollama'
      ? await completeOllamaNative(model, prompt, timeoutController.signal, headers, deps.fetchFn ?? fetch, thinkingLevel)
      : await completeGeneric(options.sdkPath, model, prompt, timeoutController.signal, { ...auth, headers }, deps, thinkingLevel);
    settled = true;
    deps.onSettled?.({
      usage: completion.usage,
      startedAt,
      endedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      outcome: 'succeeded',
    });
    const name = sanitizeGeneratedSessionTitle(completion.text);
    if (!name) return { generated: false, reason: 'invalid-output' };

    // A TUI/manual rename that landed while the model was running always wins.
    if (hasExplicitSessionName(session)) return { generated: false, reason: 'explicit-name' };
    if (!session.setSessionName) return { generated: false, reason: 'unsupported-runtime' };
    session.setSessionName(name);
    return { generated: true, name };
  } catch (error) {
    if (!settled) {
      deps.onSettled?.({
        startedAt,
        endedAt: new Date((deps.now ?? Date.now)()).toISOString(),
        outcome: timeoutController.signal.aborted ? 'cancelled' : 'failed',
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
