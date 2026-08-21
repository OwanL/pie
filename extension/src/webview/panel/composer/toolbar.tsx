/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs, ExtensionInfo, LastCompactionSummary, McpServerInfo, ModelInfo, PruningCatalog, PruningResult, PruningSettings, ProviderGateStats, SystemPromptEntry, ThinkingLevel, ToolResultPruningSettings } from '../../../shared/protocol';
import { THINKING_LEVEL_LABELS, THINKING_LEVEL_OPTIONS } from '../../../shared/thinking-level.js';
import { isPendingTabPath } from '../../../shared/tab-behavior.js';

import { useMemo } from 'preact/hooks';
import { memo } from 'preact/compat';

import { ToolbarChip, ToolbarIndicatorChip, ToolbarRunStatusChip } from '../components/panel-chip';
import { ChoicePicker } from '../components/choice-picker';
import { ModelPicker } from '../components/model-picker';
import { SystemPromptToggleMenu } from './system-prompt-toggle-menu';
import { McpToggleMenu } from './mcp-toggle-menu';
import { formatModelSpec, getModelThinkingLevels, orderModelsForPicker, parseModelSpec } from './model-list';
import { ContextWindowBreakdownChart } from '../context-window/breakdown-chart';
import type { ContextWindowBreakdown } from '../context-window/breakdown';
import type { TokenRateIndicatorState } from './use-token-rate';
import { ComposerSettingsMenu } from './settings-menu';
import { SubagentProviderMenu } from './subagent-provider-menu';
import { CompactionButton } from './compaction-button';
import { formatCompactTokens } from '../utils/format-tokens';

/** "Compacted · freed N tokens" chip label. Falls back to a plain "Compacted"
 *  when the SDK did not report token metrics. */
function compactionChipLabel(lastCompaction: LastCompactionSummary): string {
  const freed = compactionFreedTokens(lastCompaction);
  return freed !== undefined ? `Compacted · freed ${formatCompactTokens(freed)} tokens` : 'Compacted';
}

function compactionChipAriaLabel(lastCompaction: LastCompactionSummary): string {
  const freed = compactionFreedTokens(lastCompaction);
  return freed !== undefined
    ? `Conversation compacted, freed ${formatCompactTokens(freed)} tokens`
    : 'Conversation compacted';
}

function compactionChipTooltip(lastCompaction: LastCompactionSummary): string {
  const { tokensBefore, estimatedTokensAfter } = lastCompaction;
  if (tokensBefore !== undefined && estimatedTokensAfter !== undefined) {
    return `Compacted conversation history: ${formatCompactTokens(tokensBefore)} → ${formatCompactTokens(estimatedTokensAfter)} tokens. A summary card was added to the transcript.`;
  }
  return 'Compacted conversation history. A summary card was added to the transcript.';
}

/** Absolute token reduction, or undefined when either side is missing. */
function compactionFreedTokens(lastCompaction: LastCompactionSummary): number | undefined {
  const { tokensBefore, estimatedTokensAfter } = lastCompaction;
  if (tokensBefore === undefined || estimatedTokensAfter === undefined) return undefined;
  return Math.max(0, tokensBefore - estimatedTokensAfter);
}

interface ComposerToolbarStatus {
  text: string;
  tone: string;
  title: string;
}

interface ComposerToolbarProps {
  sessionPath: string | null;
  busy: boolean;
  /** False while transport/backend lifecycle work makes mutations unsafe. */
  commandsAvailable?: boolean;
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  pruningCatalog: PruningCatalog;
  pruningResult: PruningResult | null;
  toolResultPruningSettings: ToolResultPruningSettings;
  providerGateStats: ProviderGateStats;
  privacyMode?: boolean;
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
  mcpServers: McpServerInfo[];
  mcpServersStatus?: 'loading' | 'error' | 'ok';
  mcpPendingApply: boolean;
  onMcpListRequested: () => void;
  onMcpSetServerEnabled: (name: string, enabled: boolean) => void;
  onSetPrivacyMode?: (enabled: boolean) => void;
  onSetSystemPromptToggles: (disabledEntries: string[]) => void;
  onSetPruningSettings: (settings: Partial<PruningSettings>) => void;
  onSetToolResultPruningSettings: (settings: Partial<ToolResultPruningSettings>) => void;
  availableExtensions: ExtensionInfo[];
  availableModels: ModelInfo[];
  availableModelsStatus?: 'provisional' | 'loading' | 'authoritative';
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
  /** True while the active session runs a history-compaction LLM call. */
  compacting: boolean;
  /** Most recent completed compaction for the active session (transient chip). */
  lastCompaction: LastCompactionSummary | null;
  onModelChange: (model: string, provider: string | undefined, thinkingLevel: ThinkingLevel) => void;
  onCompact: () => void;
}

export const ComposerToolbar = memo(function ComposerToolbar({
  sessionPath,
  busy,
  commandsAvailable = true,
  prefs,
  pruningSettings,
  pruningCatalog,
  pruningResult,
  toolResultPruningSettings,
  providerGateStats,
  privacyMode = false,
  onSetPrefs,
  mcpServers,
  mcpServersStatus,
  mcpPendingApply,
  onMcpListRequested,
  onMcpSetServerEnabled,
  onSetPrivacyMode,
  onSetSystemPromptToggles,
  onSetPruningSettings,
  onSetToolResultPruningSettings,
  availableExtensions,
  availableModels,
  availableModelsStatus = 'authoritative',
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
  compacting,
  lastCompaction,
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
  const selectedThinkingLevels = getModelThinkingLevels(selectedModelEntry?.model);
  const selectedThinkingOptions = THINKING_LEVEL_OPTIONS.filter((option) =>
    selectedThinkingLevels.includes(option.value));
  const autonomousModeLabel = prefs.autonomousMode
    ? 'Autonomous mode on — ask_user is unavailable'
    : 'Enable autonomous mode — run without the ask_user tool';
  return (
    <>
      <fieldset class="composer-controls" disabled={!commandsAvailable} aria-disabled={!commandsAvailable}>
        <ComposerSettingsMenu prefs={prefs} mcpServers={mcpServers} mcpServersStatus={mcpServersStatus} mcpPendingApply={mcpPendingApply} pruningSettings={pruningSettings} pruningCatalog={pruningCatalog} pruningResult={pruningResult} toolResultPruningSettings={toolResultPruningSettings} availableExtensions={availableExtensions} availableModels={availableModels} providerGateStats={providerGateStats} activeContextWindow={selectedModelEntry?.model.contextWindow} activeModel={{ provider: selectedProvider, id: selectedModel }} onSetPrefs={onSetPrefs} onMcpListRequested={onMcpListRequested} onMcpSetServerEnabled={onMcpSetServerEnabled} onSetPruningSettings={onSetPruningSettings} onSetToolResultPruningSettings={onSetToolResultPruningSettings} />

        {availableModelsStatus !== 'authoritative' && (
          <ToolbarChip
            tone="accent"
            role="status"
            ariaLive="polite"
            label={availableModelsStatus === 'provisional' ? 'Models updating…' : 'Models loading…'}
            tooltip="The visible model list is temporary while Pie loads the authoritative catalog for this session."
          />
        )}

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
              const model = availableModels.find((candidate) =>
                candidate.id === id && (!provider || candidate.provider === provider));
              const supported = getModelThinkingLevels(model);
              const nextLevel = supported.includes(selectedLevel) ? selectedLevel : (supported[0] ?? 'off');
              onModelChange(id, provider, nextLevel);
            }}
          />
        ) : selectedModel ? (
          <ToolbarChip label={selectedModel} tooltip={selectedModel} />
        ) : null}

        {supportsReasoning && selectedThinkingOptions.length > 0 && (
          <ChoicePicker
            value={selectedLevel}
            label={THINKING_LEVEL_LABELS[selectedLevel]}
            ariaLabel="Reasoning level"
            title="Reasoning effort"
            options={selectedThinkingOptions}
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

        <McpToggleMenu prefs={prefs} mcpServers={mcpServers} mcpServersStatus={mcpServersStatus} mcpPendingApply={mcpPendingApply} onSetPrefs={onSetPrefs} onMcpListRequested={onMcpListRequested} onMcpSetServerEnabled={onMcpSetServerEnabled} />

        <CompactionButton
          availability={!sessionPath ? 'no-session' : compacting ? 'compacting' : busy ? 'busy' : 'available'}
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

        <button
          type="button"
          class={`system-prompt-toggle-trigger privacy-mode-trigger${privacyMode ? ' active' : ''}`}
          aria-label={privacyMode ? 'Privacy mode on — this session will not be saved when closed' : 'Enable privacy mode — do not save this session when closed'}
          aria-pressed={privacyMode}
          title={privacyMode ? 'Privacy mode on — analytics disabled and session data will be deleted when closed' : 'Enable privacy mode — disable analytics and delete session data when closed'}
          disabled={!sessionPath || isPendingTabPath(sessionPath)}
          onClick={() => onSetPrivacyMode?.(!privacyMode)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 1.8 13 4v3.7c0 3.2-2.1 5.5-5 6.5-2.9-1-5-3.3-5-6.5V4l5-2.2Z" />
            {privacyMode ? <path d="m5.2 8 1.8 1.8 3.8-4" /> : <path d="M5.5 8h5" />}
          </svg>
        </button>
      </fieldset>

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

        {compacting && !prefs.hideRunStatus && (
          <ToolbarChip
            tone="accent"
            role="status"
            ariaLive="polite"
            ariaLabel="Compacting conversation history"
            tooltip="Summarizing older messages to free context. The conversation resumes when it finishes."
            label={
              <span class="compaction-chip-label">
                <span class="compaction-chip-spinner" aria-hidden="true" />
                Compacting…
              </span>
            }
          />
        )}

        {lastCompaction && !prefs.hideRunStatus && (
          <ToolbarChip
            tone="success"
            role="status"
            ariaLive="polite"
            ariaLabel={compactionChipAriaLabel(lastCompaction)}
            tooltip={compactionChipTooltip(lastCompaction)}
            label={compactionChipLabel(lastCompaction)}
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
});
