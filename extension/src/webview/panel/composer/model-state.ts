import type {
  ModelInfo,
  ModelSettings,
  ThinkingLevel,
} from '../../../shared/protocol';

export interface ComposerModelState {
  selectedModel: string;
  selectedProvider?: string;
  selectedLevel: ThinkingLevel;
  selectedModelInfo?: ModelInfo;
  supportsReasoning: boolean;
}

interface ResolveComposerModelStateOptions {
  activeModelId?: string;
  /** Serving provider for the active session model. Model ids are not globally unique. */
  activeProvider?: string;
  activeThinkingLevel?: ThinkingLevel;
  modelSettings: ModelSettings | null;
  availableModels: ModelInfo[];
}

export function resolveComposerModelState({
  activeModelId,
  activeProvider,
  activeThinkingLevel,
  modelSettings,
  availableModels,
}: ResolveComposerModelStateOptions): ComposerModelState {
  const hasActiveModel = Boolean(activeModelId?.trim());
  const selectedModel = activeModelId?.trim() || modelSettings?.defaultModel || '';
  const selectedProvider = hasActiveModel ? activeProvider : modelSettings?.defaultProvider;
  const selectedLevel = activeThinkingLevel ?? modelSettings?.defaultThinkingLevel ?? 'medium';
  const matchingModels = availableModels.filter((model) => model.id === selectedModel);
  // Never guess from registry order when multiple providers expose the same id.
  // An absent provider is only safe to resolve when the id itself is unique.
  const selectedModelInfo = selectedProvider
    ? matchingModels.find((model) => model.provider === selectedProvider)
    : matchingModels.length === 1 ? matchingModels[0] : undefined;

  return {
    selectedModel,
    selectedProvider: selectedProvider ?? selectedModelInfo?.provider,
    selectedLevel,
    selectedModelInfo,
    supportsReasoning: selectedModelInfo?.reasoning ?? false,
  };
}
