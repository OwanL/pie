/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ModelInfo, ThinkingLevel } from '../../../shared/protocol';
import { ModelAssignmentRow } from '../components/model-assignment-row';
import type { ModelPickerEntry } from './model-list';

export const CHAT_DEFAULT_MODEL_SETTING_LABELS = [
  'Chat default',
  'Thinking',
] as const;

interface ChatDefaultModelAssignmentProps {
  selectedModel: string;
  selectedProvider?: string;
  selectedLevel: ThinkingLevel;
  modelEntries: ModelPickerEntry[];
  availableModels: ModelInfo[];
  onModelChange: (model: string, provider: string | undefined, thinkingLevel: ThinkingLevel) => void;
}

/** Models-tab mirror of the active session's toolbar model and reasoning controls. */
export function ChatDefaultModelAssignment({
  selectedModel,
  selectedProvider,
  selectedLevel,
  modelEntries,
  availableModels,
  onModelChange,
}: ChatDefaultModelAssignmentProps) {
  const selectedModelInfo = availableModels.find((model) =>
    model.id === selectedModel && (!selectedProvider || model.provider === selectedProvider)) ?? null;
  const resolvedProvider = selectedProvider ?? selectedModelInfo?.provider ?? '';

  return (
    <ModelAssignmentRow
      label="Chat default"
      entries={modelEntries}
      current={selectedModel ? { provider: resolvedProvider, model: selectedModel } : null}
      emptyLabel="Select model…"
      modelAriaLabel="Chat default model"
      modelTitle="Select chat default model"
      fallbackModel={selectedModelInfo}
      thinking={{
        value: selectedLevel,
        ariaLabel: 'Chat default thinking level',
        onChange: (value) => {
          if (value !== '' && value !== 'inherit') {
            onModelChange(selectedModel, selectedProvider, value);
          }
        },
      }}
      onChange={(next, normalizedThinking) => {
        if (!next) return;
        onModelChange(
          next.model,
          next.provider,
          normalizedThinking !== undefined && normalizedThinking !== '' && normalizedThinking !== 'inherit'
            ? normalizedThinking
            : selectedLevel,
        );
      }}
      dropdownDirection="down"
    />
  );
}
