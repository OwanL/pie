/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { memo } from 'preact/compat';
import { useMemo } from 'preact/hooks';
import type { ModelSettings, SessionSummary } from '../../lib/protocol/index.js';
import { resolveComposerModelState } from '../composer/model-state';
import { orderModelsForPicker } from '../composer/model-list';
import { ComposerSettingsMenu, type ComposerSettingsMenuProps } from './settings-menu';

type Props = Omit<ComposerSettingsMenuProps, 'activeContextWindow' | 'activeModel' | 'selectedModel' | 'selectedProvider' | 'selectedLevel' | 'chatModelEntries'> & {
  activeSession: SessionSummary | null;
  modelSettings: ModelSettings | null;
};

export const SessionSettings = memo(function SessionSettings({ activeSession, modelSettings, ...props }: Props) {
  const { selectedModel, selectedProvider, selectedLevel } = resolveComposerModelState({
    activeModelId: activeSession?.modelId,
    activeProvider: activeSession?.provider,
    activeThinkingLevel: activeSession?.thinkingLevel,
    modelSettings,
    availableModels: props.availableModels,
  });
  const removedProviderIds = props.providerManagement?.view.removedProviderIds;
  const chatModelEntries = useMemo(() => orderModelsForPicker(props.availableModels.filter(model =>
    !removedProviderIds?.includes(model.provider) && (props.prefs.providerToggles[model.provider] !== false
      || (model.id === selectedModel && (!selectedProvider || model.provider === selectedProvider)))),
  { useSubagentEligibility: false }), [props.availableModels, props.prefs.providerToggles, removedProviderIds, selectedModel, selectedProvider]);
  const selectedEntry = chatModelEntries.find(entry => entry.model.id === selectedModel
    && (!selectedProvider || entry.model.provider === selectedProvider));
  return <ComposerSettingsMenu {...props} selectedModel={selectedModel} selectedProvider={selectedProvider}
    selectedLevel={selectedLevel} chatModelEntries={chatModelEntries} activeModel={{ provider: selectedProvider, id: selectedModel }}
    activeContextWindow={selectedEntry?.model.contextWindow} />;
});
