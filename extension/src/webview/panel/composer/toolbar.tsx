/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs, ExtensionInfo, ModelInfo, PruningCatalog, PruningResult, PruningSettings, ProviderGateStats, SystemPromptEntry, ThinkingLevel, ToolResultPruningSettings } from '../../../shared/protocol';
import { THINKING_LEVEL_LABELS } from '../../../shared/thinking-level.js';

import { useMemo } from 'preact/hooks';

import { ToolbarChip, ToolbarIndicatorChip, ToolbarRunStatusChip, ToolbarSelectChip } from '../components/panel-chip';
import { ModelPicker } from '../components/model-picker';
import { SystemPromptToggleMenu } from './system-prompt-toggle-menu';
import { formatModelSpec, orderModelsForPicker, parseModelSpec } from './model-list';
import { ContextWindowBreakdownChart } from '../context-window/breakdown-chart';
import type { ContextWindowBreakdown } from '../context-window/breakdown';
import type { TokenRateIndicatorState } from './use-token-rate';
import { ComposerSettingsMenu } from './settings-menu';
import { SubagentProviderMenu } from './subagent-provider-menu';
import { CompactionButton } from './compaction-button';

interface ComposerToolbarStatus {
  text: string;
  tone: string;
  title: string;
}

interface ComposerToolbarProps {
  sessionPath: string | null;
  busy: boolean;
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  pruningCatalog: PruningCatalog;
  pruningResult: PruningResult | null;
  toolResultPruningSettings: ToolResultPruningSettings;
  providerGateStats: ProviderGateStats;
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
  onSetSystemPromptToggles: (disabledEntries: string[]) => void;
  onSetPruningSettings: (settings: Partial<PruningSettings>) => void;
  onSetToolResultPruningSettings: (settings: Partial<ToolResultPruningSettings>) => void;
  availableExtensions: ExtensionInfo[];
  availableModels: ModelInfo[];
  systemPrompts: SystemPromptEntry[];
  selectedModel: string;
  selectedProvider?: string;
  selectedLevel: ThinkingLevel;
  supportsReasoning: boolean;
  contextIndicator: { label: string | null; ariaLabel: string; severity: string | null } | null;
  contextBreakdown: ContextWindowBreakdown | null;
  sessionCostIndicator: { label: string; ariaLabel: string; tooltip: string } | null;
  tokenRateIndicator: TokenRateIndicatorState;
  runStatus: ComposerToolbarStatus | null;
  onModelChange: (model: string, provider: string | undefined, thinkingLevel: ThinkingLevel) => void;
  onCompact: () => void;
}

export function ComposerToolbar({
  sessionPath,
  busy,
  prefs,
  pruningSettings,
  pruningCatalog,
  pruningResult,
  toolResultPruningSettings,
  providerGateStats,
  onSetPrefs,
  onSetSystemPromptToggles,
  onSetPruningSettings,
  onSetToolResultPruningSettings,
  availableExtensions,
  availableModels,
  systemPrompts,
  selectedModel,
  selectedProvider,
  selectedLevel,
  supportsReasoning,
  contextIndicator,
  contextBreakdown,
  sessionCostIndicator,
  tokenRateIndicator,
  runStatus,
  onModelChange,
  onCompact,
}: ComposerToolbarProps) {
  const filteredModels = useMemo(
    () => availableModels.filter(
      (m) => prefs.providerToggles[m.provider] !== false
        || (m.id === selectedModel && (!selectedProvider || m.provider === selectedProvider)),
    ),
    [availableModels, prefs.providerToggles, selectedModel, selectedProvider],
  );
  const modelEntries = useMemo(
    () => orderModelsForPicker(filteredModels, { useSubagentEligibility: false }),
    [filteredModels],
  );
  const selectedModelEntry = modelEntries.find(
    (entry) => entry.model.id === selectedModel
      && (!selectedProvider || entry.model.provider === selectedProvider),
  ) ?? null;
  const fallbackModelLabel = modelEntries[0]?.selectedLabel ?? '';
  const selectedModelLabel = selectedModelEntry?.selectedLabel ?? (selectedModel || fallbackModelLabel);
  return (
    <>
      <div class="composer-controls">
        <ComposerSettingsMenu prefs={prefs} pruningSettings={pruningSettings} pruningCatalog={pruningCatalog} pruningResult={pruningResult} toolResultPruningSettings={toolResultPruningSettings} availableExtensions={availableExtensions} availableModels={availableModels} providerGateStats={providerGateStats} activeContextWindow={selectedModelEntry?.model.contextWindow} activeModel={{ provider: selectedProvider, id: selectedModel }} onSetPrefs={onSetPrefs} onSetPruningSettings={onSetPruningSettings} onSetToolResultPruningSettings={onSetToolResultPruningSettings} />

        {filteredModels.length > 0 ? (
          <ModelPicker
            label={selectedModelLabel}
            value={selectedProvider ? formatModelSpec({ provider: selectedProvider, id: selectedModel }) : selectedModel}
            ariaLabel="Model"
            title="Select model"
            entries={modelEntries}
            onChange={(spec) => {
              // The picker emits the shared provider-qualified identity so the
              // backend resolves the exact provider for duplicate model ids.
              const { id, provider } = parseModelSpec(spec);
              onModelChange(id, provider, selectedLevel);
            }}
          />
        ) : selectedModel ? (
          <ToolbarChip label={selectedModel} tooltip={selectedModel} />
        ) : null}

        {supportsReasoning && (
          <ToolbarSelectChip
            value={selectedLevel}
            label={THINKING_LEVEL_LABELS[selectedLevel]}
            width="reasoning"
            onChange={(e) => {
              const target = e.target as HTMLSelectElement;
              onModelChange(selectedModel, selectedProvider, target.value as ThinkingLevel);
            }}
            ariaLabel="Reasoning level"
            title="Reasoning level"
          >
            {(Object.keys(THINKING_LEVEL_LABELS) as ThinkingLevel[]).map((level) => (
              <option key={level} value={level}>{THINKING_LEVEL_LABELS[level]}</option>
            ))}
          </ToolbarSelectChip>
        )}

        <SubagentProviderMenu
          sessionPath={sessionPath}
          prefs={prefs}
          availableModels={availableModels}
          onSetPrefs={onSetPrefs}
        />

        <SystemPromptToggleMenu prompts={systemPrompts} onSetToggles={onSetSystemPromptToggles} />

        <CompactionButton
          availability={!sessionPath ? 'no-session' : busy ? 'busy' : 'available'}
          onCompact={onCompact}
        />
      </div>

      <div class="composer-indicators">
        {/* Cumulative cost, then live stats; context window pinned rightmost. */}
        {sessionCostIndicator && !prefs.hideSessionCost && (
          <ToolbarIndicatorChip
            kind="cost"
            ariaLabel={sessionCostIndicator.ariaLabel}
            tooltip={sessionCostIndicator.tooltip}
            label={sessionCostIndicator.label}
            freezeWhileVisible
          />
        )}

        {/* Live stats — throughput, then run state */}
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

        {runStatus && !prefs.hideRunStatus && (
          <ToolbarRunStatusChip
            tone={runStatus.tone}
            tooltip={runStatus.title}
            label={runStatus.text}
          />
        )}

        {contextIndicator?.label && contextBreakdown && !prefs.hideContextIndicator && (
          <ToolbarIndicatorChip
            kind="context"
            severity={contextIndicator.severity}
            ariaLabel={contextIndicator.ariaLabel}
            tooltipNode={<ContextWindowBreakdownChart breakdown={contextBreakdown} />}
            label={contextIndicator.label}
            freezeWhileVisible
          />
        )}
      </div>
    </>
  );
}
