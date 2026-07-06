/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs, ExtensionInfo, ModelInfo, PruningCatalog, PruningResult, PruningSettings, ProxyProviderAddInput, ProxySettings, ProxySettingsUpdate, SystemPromptEntry, ThinkingLevel, ToolResultPruningSettings } from '../../../shared/protocol';
import { THINKING_LEVEL_LABELS } from '../../../shared/thinking-level.js';

import { useMemo } from 'preact/hooks';

import { ToolbarChip, ToolbarIndicatorChip, ToolbarRunStatusChip, ToolbarSelectChip } from '../components/panel-chip';
import { ModelPicker } from '../components/model-picker';
import { SystemPromptToggleMenu } from './system-prompt-toggle-menu';
import { orderModelsForPicker } from './model-list';
import type { TokenRateIndicatorState } from './use-token-rate';
import { ComposerSettingsMenu } from './settings-menu';

interface ComposerToolbarStatus {
  text: string;
  tone: string;
  title: string;
}

interface ComposerToolbarProps {
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  pruningCatalog: PruningCatalog;
  pruningResult: PruningResult | null;
  toolResultPruningSettings: ToolResultPruningSettings;
  proxySettings: ProxySettings;
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
  onSetSystemPromptToggles: (disabledEntries: string[]) => void;
  onSetPruningSettings: (settings: Partial<PruningSettings>) => void;
  onSetToolResultPruningSettings: (settings: Partial<ToolResultPruningSettings>) => void;
  onSetProxySettings: (settings: ProxySettingsUpdate) => void;
  onAddProxyProvider: (input: ProxyProviderAddInput) => void;
  availableExtensions: ExtensionInfo[];
  availableModels: ModelInfo[];
  systemPrompts: SystemPromptEntry[];
  selectedModel: string;
  selectedLevel: ThinkingLevel;
  supportsReasoning: boolean;
  contextIndicator: { label: string | null; ariaLabel: string; severity: string | null } | null;
  contextBreakdownTitle: string | null;
  sessionTokenIndicator: { label: string; ariaLabel: string; tooltip: string };
  sessionCostIndicator: { label: string; ariaLabel: string; tooltip: string } | null;
  tokenRateIndicator: TokenRateIndicatorState;
  runStatus: ComposerToolbarStatus | null;
  onModelChange: (model: string, thinkingLevel: ThinkingLevel) => void;
}

export function ComposerToolbar({
  prefs,
  pruningSettings,
  pruningCatalog,
  pruningResult,
  toolResultPruningSettings,
  proxySettings,
  onSetPrefs,
  onSetSystemPromptToggles,
  onSetPruningSettings,
  onSetToolResultPruningSettings,
  onSetProxySettings,
  onAddProxyProvider,
  availableExtensions,
  availableModels,
  systemPrompts,
  selectedModel,
  selectedLevel,
  supportsReasoning,
  contextIndicator,
  contextBreakdownTitle,
  sessionTokenIndicator,
  sessionCostIndicator,
  tokenRateIndicator,
  runStatus,
  onModelChange,
}: ComposerToolbarProps) {
  const filteredModels = useMemo(
    () => availableModels.filter(
      (m) => prefs.providerToggles[m.provider] !== false || m.id === selectedModel,
    ),
    [availableModels, prefs.providerToggles, selectedModel],
  );
  const modelEntries = useMemo(() => orderModelsForPicker(filteredModels), [filteredModels]);
  const selectedModelEntry = modelEntries.find((entry) => entry.model.id === selectedModel) ?? null;
  const fallbackModelLabel = modelEntries[0]?.selectedLabel ?? '';
  const selectedModelLabel = selectedModelEntry?.selectedLabel ?? (selectedModel || fallbackModelLabel);
  return (
    <div class="flex w-full flex-nowrap items-center gap-1.5 [container-name:toolbar] [container-type:inline-size]">
      <div class="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5">
        <ComposerSettingsMenu prefs={prefs} pruningSettings={pruningSettings} pruningCatalog={pruningCatalog} pruningResult={pruningResult} toolResultPruningSettings={toolResultPruningSettings} proxySettings={proxySettings} availableExtensions={availableExtensions} availableModels={availableModels} onSetPrefs={onSetPrefs} onSetPruningSettings={onSetPruningSettings} onSetToolResultPruningSettings={onSetToolResultPruningSettings} onSetProxySettings={onSetProxySettings} onAddProxyProvider={onAddProxyProvider} />

        {filteredModels.length > 0 ? (
          <ModelPicker
            label={selectedModelLabel}
            value={selectedModel}
            ariaLabel="Model"
            title="Select model"
            entries={modelEntries}
            onChange={(modelId) => onModelChange(modelId, selectedLevel)}
          />
        ) : selectedModel ? (
          <ToolbarChip label={selectedModel} title={selectedModel} />
        ) : null}

        {supportsReasoning && (
          <ToolbarSelectChip
            value={selectedLevel}
            label={THINKING_LEVEL_LABELS[selectedLevel]}
            width="reasoning"
            onChange={(e) => {
              const target = e.target as HTMLSelectElement;
              onModelChange(selectedModel, target.value as ThinkingLevel);
            }}
            ariaLabel="Reasoning level"
            title="Reasoning level"
          >
            {(Object.keys(THINKING_LEVEL_LABELS) as ThinkingLevel[]).map((level) => (
              <option key={level} value={level}>{THINKING_LEVEL_LABELS[level]}</option>
            ))}
          </ToolbarSelectChip>
        )}

        <SystemPromptToggleMenu prompts={systemPrompts} onSetToggles={onSetSystemPromptToggles} />
      </div>

      <div class="ml-auto flex min-w-0 shrink-0 flex-nowrap items-center justify-end gap-1.5">
        {tokenRateIndicator.label && !prefs.hideTokenRate && (
          <ToolbarIndicatorChip
            kind="speed"
            state={tokenRateIndicator.paused ? 'paused' : null}
            ariaLabel={tokenRateIndicator.ariaLabel}
            tooltip={tokenRateIndicator.tooltip}
            label={tokenRateIndicator.label}
            freezeWhileVisible
          />
        )}

        {!prefs.hideSessionTokens && (
          <ToolbarIndicatorChip
            kind="tokens"
            ariaLabel={sessionTokenIndicator.ariaLabel}
            tooltip={sessionTokenIndicator.tooltip}
            label={sessionTokenIndicator.label}
            freezeWhileVisible
          />
        )}

        {sessionCostIndicator && !prefs.hideSessionCost && (
          <ToolbarIndicatorChip
            kind="cost"
            ariaLabel={sessionCostIndicator.ariaLabel}
            tooltip={sessionCostIndicator.tooltip}
            label={sessionCostIndicator.label}
            freezeWhileVisible
          />
        )}

        {contextIndicator?.label && contextBreakdownTitle && !prefs.hideContextIndicator && (
          <ToolbarIndicatorChip
            kind="context"
            severity={contextIndicator.severity}
            ariaLabel={contextIndicator.ariaLabel}
            tooltip={contextBreakdownTitle}
            label={contextIndicator.label}
            freezeWhileVisible
          />
        )}

        {runStatus && !prefs.hideRunStatus && (
          <div class="ml-auto mr-0 inline-flex shrink-0 items-center gap-1.5">
            <ToolbarRunStatusChip
              tone={runStatus.tone}
              tooltip={runStatus.title}
              label={runStatus.text}
            />
          </div>
        )}
      </div>
    </div>
  );
}
