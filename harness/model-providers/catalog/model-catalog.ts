import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parseJsonOrThrow, toErrorMessage } from '../../../lib/structured-logging/error-message';
import type { ModelInfo } from './model-contract.js';
import type { ThinkingLevel } from './thinking-level.js';
import { resolveModelInputKinds } from '../request-validation/model-input-kinds.js';
import { THINKING_LEVELS } from './thinking-level.js';
import type { SdkCatalogModel, SdkModelRegistry } from '../../agent-processes/lib/sdk-integration/sdk';
import { findSubagentProfile, loadSubagentProfiles } from '../../tools/subagent/subagent-profiles';
import { backendTrace } from '../../../lib/structured-logging/backend-log';

export interface ModelCatalogContext {
  session: { model?: { id?: string; provider?: string } };
  runtime: { services?: { modelRegistry?: Pick<SdkModelRegistry, 'getAvailable'> } };
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
export function resolveActiveModel(context: ModelCatalogContext): ActiveModelInfo {
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

/** Mirror Pi's model-level reasoning contract for the webview catalog. Standard
 * levels through `high` (including `off`) exist unless explicitly mapped to
 * null; extended `xhigh`/`max` exist only when the model maps them. */
export function resolveModelThinkingLevels(model: Record<string, unknown>): ThinkingLevel[] {
  if (model.reasoning !== true) return ['off'];
  const rawMap = model.thinkingLevelMap;
  const map = rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)
    ? rawMap as Record<string, unknown>
    : undefined;
  return THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

export type ModelCatalogLoadResult =
  | { ok: true; models: ModelInfo[] }
  | { ok: false; models: []; error: string };

export function projectRegistryModels(
  models: SdkCatalogModel[],
  agentDir?: string,
): ModelInfo[] {
  const profiles = agentDir ? loadSubagentProfiles(agentDir) : new Map();
  return models.map((model) => {
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
  });
}

/** Load configured models without conflating a valid empty catalog with an I/O
 * or parse failure. When the runtime-free coordinator registry is supplied it
 * resolves built-in models plus `modelOverrides`, matching hot worker catalog
 * semantics without creating an AgentSession. Callers that publish catalog
 * authority must inspect `ok`. */
export async function loadConfiguredModels(
  agentDir: string,
  modelRegistry?: SdkModelRegistry,
): Promise<ModelCatalogLoadResult> {
  try {
    if (modelRegistry) {
      modelRegistry.refresh?.();
      const registryError = modelRegistry.getError?.();
      if (registryError) return { ok: false, models: [], error: registryError };
      return { ok: true, models: projectRegistryModels(modelRegistry.getAvailable(), agentDir) };
    }
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
    backendTrace('sessionMetadata', 'loadConfiguredModels.failed', { level: 'debug', error: message });
    return { ok: false, models: [], error: message };
  }
}

export function loadAvailableModels(context?: ModelCatalogContext, agentDir?: string): ModelCatalogLoadResult {
  if (!context) {
    return { ok: true, models: [] };
  }

  try {
    const models = context.runtime.services?.modelRegistry?.getAvailable() ?? [];
    return { ok: true, models: projectRegistryModels(models, agentDir) };
  } catch (error) {
    const message = toErrorMessage(error);
    backendTrace('sessionMetadata', 'loadAvailableModels.failed', { level: 'debug', error: message });
    return { ok: false, models: [], error: message };
  }
}
