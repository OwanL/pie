/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs, ExtensionInfo, ModelInfo, PruningCatalog, PruningResult, PruningSettings, ProviderGateStats, SystemPromptEntry, ThinkingLevel, ToolResultPruningSettings } from '../../../shared/protocol';
import { THINKING_LEVEL_LABELS, THINKING_LEVEL_OPTIONS } from '../../../shared/thinking-level.js';

import { useMemo } from 'preact/hooks';

import { ToolbarChip, ToolbarIndicatorChip, ToolbarRunStatusChip } from '../components/panel-chip';
import { ChoicePicker } from '../components/choice-picker';
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
  const autonomousModeLabel = prefs.autonomousMode
    ? 'Autonomous mode on — ask_user is unavailable'
    : 'Enable autonomous mode — run without the ask_user tool';
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
          <ChoicePicker
            value={selectedLevel}
            label={THINKING_LEVEL_LABELS[selectedLevel]}
            ariaLabel="Reasoning level"
            title="Reasoning effort"
            options={THINKING_LEVEL_OPTIONS}
            onChange={(level) => onModelChange(selectedModel, selectedProvider, level)}
          />
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

        <button
          type="button"
          class={`system-prompt-toggle-trigger autonomous-mode-trigger${prefs.autonomousMode ? ' active' : ''}`}
          aria-label={autonomousModeLabel}
          aria-pressed={prefs.autonomousMode}
          title={autonomousModeLabel}
          onClick={() => onSetPrefs({ autonomousMode: !prefs.autonomousMode })}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 2v2" />
            <rect x="3" y="4" width="10" height="8" rx="2" />
            <path d="M1.5 7.5v2M14.5 7.5v2M6 9h4" />
            <circle cx="6" cy="7" r=".5" fill="currentColor" stroke="none" />
            <circle cx="10" cy="7" r=".5" fill="currentColor" stroke="none" />
            <path d="M5 14h6" />
          </svg>
        </button>
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
