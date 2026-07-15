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
  activeThinkingLevel?: ThinkingLevel;
  modelSettings: ModelSettings | null;
  availableModels: ModelInfo[];
}

export function resolveComposerModelState({
  activeModelId,
  activeThinkingLevel,
  modelSettings,
  availableModels,
}: ResolveComposerModelStateOptions): ComposerModelState {
  const selectedModel = activeModelId?.trim() || modelSettings?.defaultModel || '';
  const selectedProvider = modelSettings?.defaultModel === selectedModel
    ? modelSettings.defaultProvider
    : undefined;
  const selectedLevel = activeThinkingLevel ?? modelSettings?.defaultThinkingLevel ?? 'medium';
  const selectedModelInfo = availableModels.find(
    (model) => model.id === selectedModel && (!selectedProvider || model.provider === selectedProvider),
  ) ?? availableModels.find((model) => model.id === selectedModel);

  return {
    selectedModel,
    selectedProvider: selectedModelInfo?.provider ?? selectedProvider,
    selectedLevel,
    selectedModelInfo,
    supportsReasoning: selectedModelInfo?.reasoning ?? false,
  };
}
