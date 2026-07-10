import * as fs from 'node:fs/promises';

import { deriveSessionNameFromText, NEW_SESSION_NAME } from '../shared/session-name';
import { parseJsonOrThrow, toErrorMessage } from '../shared/error-message';
import type {
  ModelInfo,
  SessionSummary,
} from '../shared/protocol';
import { normalizeThinkingLevel, resolveModelInputKinds } from './message-inputs';
import type { SdkModule } from './sdk';
import type { SessionContext } from './server-types';
import { loadSubagentProfiles } from './subagent-profiles';
import { summarizeSession, type SessionEntryLike } from './transcript';
import { mergeReviewIntoSummary, readReviews } from './session-review-store';
import { backendTrace } from './diag';

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

export async function listSessions(sdk: SdkModule): Promise<SessionSummary[]> {
  const reviews = readReviews();
  const sessions = await sdk.SessionManager.listAll();
  const summaries = await Promise.all(
    sessions.map(async (session) => {
      const summary = summarizeSession(session);
      if (summary.name === NEW_SESSION_NAME && session.path) {
        const derived = await deriveNameFromFile(session.path);
        if (derived !== NEW_SESSION_NAME) {
          summary.name = derived;
          summary.isPlaceholder = false;
        } else {
          summary.isPlaceholder = true;
        }
      }
      return mergeReviewIntoSummary(summary, reviews);
    }),
  );
  return summaries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
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
 * `context.session.model` only carries the id (plus context-window metadata),
 * so the provider/name are looked up in the registry. Returns an empty object
 * when no model is selected yet or the registry is unavailable — callers
 * should render a neutral "not resolved" state rather than guessing a provider.
 */
export function resolveActiveModel(context: SessionContext): ActiveModelInfo {
  const modelId = context.session.model?.id;
  if (!modelId) {
    return {};
  }

  try {
    const available = context.runtime.services?.modelRegistry?.getAvailable() ?? [];
    const match = available.find((model) => model.id === modelId);
    // Only include provider/modelName when actually resolved so a present key
    // means "known" (callers can branch on key presence rather than undefined).
    return match
      ? { modelId, provider: match.provider, modelName: match.name }
      : { modelId };
  } catch (error) {
    backendTrace('sessionMetadata', 'resolveActiveModel.failed', { level: 'debug', error: toErrorMessage(error), modelId });
    return { modelId };
  }
}

export function listAvailableModels(context?: SessionContext, agentDir?: string): ModelInfo[] {
  if (!context) {
    return [];
  }

  const profiles = agentDir ? loadSubagentProfiles(agentDir) : new Map();

  try {
    const models = context.runtime.services?.modelRegistry?.getAvailable() ?? [];
    return models.map((model) => {
      const info: ModelInfo = {
        id: model.id,
        name: model.name,
        provider: model.provider,
        reasoning: model.reasoning,
        inputKinds: resolveModelInputKinds(model as unknown as Record<string, unknown>),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      };
      const profile = profiles.get(model.id);
      if (profile) info.subagent = profile;
      return info;
    });
  } catch (error) {
    backendTrace('sessionMetadata', 'listAvailableModels.failed', { level: 'debug', error: toErrorMessage(error) });
    return [];
  }
}
