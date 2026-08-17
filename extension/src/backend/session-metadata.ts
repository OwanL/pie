import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { deriveSessionNameFromText, NEW_SESSION_NAME } from '../shared/session-name';
import { parseJsonOrThrow, toErrorMessage } from '../shared/error-message';
import type {
  ModelInfo,
  SessionSummary,
  ThinkingLevel,
} from '../shared/protocol';
import { normalizeThinkingLevel, resolveModelInputKinds } from './message-inputs';
import type { SdkModule, SdkSessionInfo } from './sdk';
import type { SessionContext } from './server-types';
import { findSubagentProfile, loadSubagentProfiles } from './subagent-profiles';
import { summarizeSession, type SessionEntryLike } from './transcript';
import { mergeReviewIntoSummary, mergeReviewsIntoSummaries, readReviews } from './session-review-store';
import { backendTrace } from './log';
import { backendSessionPathKey } from './session-directory';

function textFromSessionMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
  }

  return '';
}

export async function deriveNameFromFile(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = parseJsonOrThrow<SessionEntryLike>(line, `session metadata line ${i + 1}`);
        if (entry.type === 'message' && entry.message?.role === 'user') {
          const derived = deriveSessionNameFromText(
            textFromSessionMessageContent(entry.message.content),
          );
          if (!derived.isPlaceholder) {
            return derived.name;
          }
        }
      } catch (error) {
        backendTrace('sessionMetadata', 'deriveName.lineParseFailed', { level: 'warn', error: toErrorMessage(error), line: i + 1 });
      }
    }
  } catch (error) {
    backendTrace('sessionMetadata', 'deriveName.readFailed', { level: 'warn', error: toErrorMessage(error), filePath });
  }
  return NEW_SESSION_NAME;
}

async function deriveSessionInfoName(session: SdkSessionInfo): Promise<string> {
  const firstMessage = session.firstMessage?.trim();
  if (firstMessage === '(no messages)') return NEW_SESSION_NAME;
  if (firstMessage) return deriveSessionNameFromText(firstMessage).name;
  return await deriveNameFromFile(session.path);
}

export async function discoverSessionSummaries(
  sdk: SdkModule,
  sessionDir?: string,
): Promise<SessionSummary[]> {
  let configuredDirs: string[] = [];
  if (sessionDir) {
    configuredDirs = [sessionDir];
    try {
      const entries = await fs.readdir(sessionDir, { withFileTypes: true });
      configuredDirs.push(...entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(sessionDir, entry.name)));
    } catch {
      // A missing/unreadable configured directory still lists its top-level
      // path via listAll(sessionDir) below; canonical-only sources no longer
      // fall back to the SDK default while a root is configured.
    }
  }
  // Canonical-only listing: with a configured session directory, read it
  // (plus its per-cwd subdirectories) exclusively — the installer's verified
  // migration moved legacy sessions into the canonical store, and `npm run
  // doctor` surfaces any newly stranded legacy sessions rather than scanning
  // the legacy root forever. With nothing configured, the embedded SDK keeps
  // its own default via the bare listAll().
  const sources = await Promise.all(
    configuredDirs.length > 0
      ? configuredDirs.map((dir) => sdk.SessionManager.listAll(dir))
      : [sdk.SessionManager.listAll()],
  );
  const byPath = new Map<string, SdkSessionInfo>();
  for (const session of sources.flat()) {
    const key = backendSessionPathKey(session.path);
    if (!byPath.has(key)) byPath.set(key, session);
  }
  const sessions = [...byPath.values()];
  const summaries = await Promise.all(
    sessions.map(async (session) => {
      const summary = summarizeSession(session);
      if (summary.name === NEW_SESSION_NAME && session.path) {
        const derived = await deriveSessionInfoName(session);
        if (derived !== NEW_SESSION_NAME) {
          summary.name = derived;
          summary.isPlaceholder = false;
        } else {
          summary.isPlaceholder = true;
        }
      }
      return summary;
    }),
  );
  return summaries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

export function applySessionReviews(summaries: readonly SessionSummary[]): SessionSummary[] {
  return mergeReviewsIntoSummaries(summaries, readReviews());
}

export async function listSessions(
  sdk: SdkModule,
  sessionDir?: string,
): Promise<SessionSummary[]> {
  return applySessionReviews(await discoverSessionSummaries(sdk, sessionDir));
}

export function deriveSessionName(context: SessionContext): { name: string; isPlaceholder: boolean } {
  const sdkName = context.session.sessionName || context.session.sessionManager.getSessionName();
  if (sdkName) {
    return { name: sdkName, isPlaceholder: false };
  }

  const entries = context.session.sessionManager.getBranch() ?? [];
  for (const entry of entries) {
    if (entry.type === 'message' && entry.message?.role === 'user') {
      const derived = deriveSessionNameFromText(
        textFromSessionMessageContent(entry.message.content),
      );
      if (!derived.isPlaceholder) {
        return derived;
      }
    }
  }

  return { name: NEW_SESSION_NAME, isPlaceholder: true };
}

export function buildCurrentSummary(
  context: SessionContext,
  startupCwd: string,
): SessionSummary {
  const messageCount = context.session.messages.length ?? 0;
  const { name, isPlaceholder } = deriveSessionName(context);
  const summary: SessionSummary = {
    path: context.sessionPath,
    cwd: context.session.sessionManager.getCwd() ?? startupCwd,
    name,
    isPlaceholder,
    modifiedAt: new Date().toISOString(),
    messageCount,
    modelId: context.session.model?.id,
    provider: resolveActiveModel(context).provider,
    thinkingLevel: normalizeThinkingLevel(context.session.thinkingLevel),
  };
  return mergeReviewIntoSummary(summary, readReviews());
}

export interface ActiveModelInfo {
  /** Resolved provider name (e.g. 'umans', 'anthropic'), when the active model is found in the registry. */
  provider?: string;
  /** Active model id, when a model is selected for the session. */
  modelId?: string;
  /** Human-readable model name from the registry, when available. */
  modelName?: string;
}

/**
 * Resolve the session's active model and its provider from the model registry.
 *
 * `context.session.model` carries the selected provider when available; the
 * registry supplies its display name and provides a legacy fallback for older
 * id-only sessions. Returns an empty object when no model is selected yet or
 * the registry is unavailable — callers should render a neutral "not resolved"
 * state rather than guessing a provider.
 */
export function resolveActiveModel(context: SessionContext): ActiveModelInfo {
  const modelId = context.session.model?.id;
  if (!modelId) {
    return {};
  }

  try {
    const available = context.runtime.services?.modelRegistry?.getAvailable() ?? [];
    // The session model carries its selected provider. Prefer that exact pair:
    // model IDs such as GPT-5.6 are available through both Copilot and Codex,
    // so an id-only registry lookup can attribute a Codex turn to Copilot.
    const selectedProvider = context.session.model?.provider;
    const match = selectedProvider
      ? available.find((model) => model.id === modelId && model.provider === selectedProvider)
      : available.find((model) => model.id === modelId);
    // A provider recorded on the session remains authoritative even if the
    // currently available registry no longer contains that model.
    return match
      ? { modelId, provider: selectedProvider ?? match.provider, modelName: match.name }
      : selectedProvider ? { modelId, provider: selectedProvider } : { modelId };
  } catch (error) {
    backendTrace('sessionMetadata', 'resolveActiveModel.failed', { level: 'debug', error: toErrorMessage(error), modelId });
    return { modelId };
  }
}

const MODEL_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

/** Mirror Pi's model-level reasoning contract for the webview catalog. Standard
 * levels through `high` (including `off`) exist unless explicitly mapped to
 * null; extended `xhigh`/`max` exist only when the model maps them. */
export function resolveModelThinkingLevels(model: Record<string, unknown>): ThinkingLevel[] {
  if (model.reasoning !== true) return ['off'];
  const rawMap = model.thinkingLevelMap;
  const map = rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)
    ? rawMap as Record<string, unknown>
    : undefined;
  return MODEL_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

export type ModelCatalogLoadResult =
  | { ok: true; models: ModelInfo[] }
  | { ok: false; models: []; error: string };

/** Load configured models without conflating a valid empty catalog with an I/O
 * or parse failure. Callers that publish catalog authority must inspect `ok`. */
export async function loadConfiguredModels(agentDir: string): Promise<ModelCatalogLoadResult> {
  try {
    const raw = await fs.readFile(path.join(agentDir, 'models.json'), 'utf8');
    const parsed = parseJsonOrThrow<{ providers?: Record<string, { models?: Array<Record<string, unknown>> }> }>(raw, 'models.json');
    const profiles = loadSubagentProfiles(agentDir);
    const result: ModelInfo[] = [];
    for (const [provider, config] of Object.entries(parsed.providers ?? {})) {
      for (const model of config.models ?? []) {
        if (typeof model.id !== 'string' || typeof model.name !== 'string') continue;
        const info: ModelInfo = {
          id: model.id,
          name: model.name,
          provider,
          reasoning: model.reasoning === true,
          thinkingLevels: resolveModelThinkingLevels(model),
          inputKinds: resolveModelInputKinds(model),
          ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
          ...(typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {}),
        };
        const profile = findSubagentProfile(profiles, provider, model.id);
        if (profile) info.subagent = profile;
        result.push(info);
      }
    }
    return { ok: true, models: result };
  } catch (error) {
    const message = toErrorMessage(error);
    backendTrace('sessionMetadata', 'listConfiguredModels.failed', { level: 'debug', error: message });
    return { ok: false, models: [], error: message };
  }
}

/** Compatibility projection for callers where an empty fallback is explicitly
 * acceptable. Authority-publishing paths use `loadConfiguredModels` instead. */
export async function listConfiguredModels(agentDir: string): Promise<ModelInfo[]> {
  return (await loadConfiguredModels(agentDir)).models;
}

export function loadAvailableModels(context?: SessionContext, agentDir?: string): ModelCatalogLoadResult {
  if (!context) {
    return { ok: true, models: [] };
  }

  const profiles = agentDir ? loadSubagentProfiles(agentDir) : new Map();

  try {
    const models = context.runtime.services?.modelRegistry?.getAvailable() ?? [];
    return {
      ok: true,
      models: models.map((model) => {
        const info: ModelInfo = {
          id: model.id,
          name: model.name,
          provider: model.provider,
          reasoning: model.reasoning,
          thinkingLevels: resolveModelThinkingLevels(model as unknown as Record<string, unknown>),
          inputKinds: resolveModelInputKinds(model as unknown as Record<string, unknown>),
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        };
        const profile = findSubagentProfile(profiles, model.provider, model.id);
        if (profile) info.subagent = profile;
        return info;
      }),
    };
  } catch (error) {
    const message = toErrorMessage(error);
    backendTrace('sessionMetadata', 'listAvailableModels.failed', { level: 'debug', error: message });
    return { ok: false, models: [], error: message };
  }
}

export function listAvailableModels(context?: SessionContext, agentDir?: string): ModelInfo[] {
  return loadAvailableModels(context, agentDir).models;
}
