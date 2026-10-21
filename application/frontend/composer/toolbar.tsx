/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { BrowserServerViewState, ChatPrefs, ExtensionInfo, LastCompactionSummary, McpServerInfo, ModelInfo, PruningCatalog, PruningResult, PruningSettings, ProviderGateStats, SessionTitlesSettings, SystemPromptEntry, ThinkingLevel, ToolResultPruningSettings } from '../../lib/protocol/index.js';
import { THINKING_LEVEL_LABELS, THINKING_LEVEL_OPTIONS } from './thinking-level-options.js';
import { isPendingTabPath } from '../../lib/session-tabs/tab-behavior.js';

import { useMemo, useRef } from 'preact/hooks';
import { memo } from 'preact/compat';

import { ToolbarChip, ToolbarIndicatorChip, ToolbarRunStatusChip, ToolbarActionChip } from '../lib/components/panel-chip';
import { ChoicePicker } from '../lib/components/choice-picker';
import { ModelPicker } from '../settings/model-picker';
import { SystemPromptToggleMenu } from './system-prompt-toggle-menu';
import { McpToggleMenu } from './mcp-toggle-menu';
import { BrowserServerMenu } from './browser-server-menu';
import { formatModelSpec, getModelThinkingLevels, orderModelsForPicker, parseModelSpec } from './model-list';
import { ContextWindowBreakdownChart } from '../context-inspector/breakdown-chart';
import type { ContextWindowBreakdown } from '../context-inspector/breakdown';
import type { ProviderSetupPreviewProps } from '../../lib/protocol/provider-setup-preview.js';
import type { TokenRateIndicatorState } from '../analytics/use-token-rate';
import type { WorkingTimeIndicatorState } from '../analytics/use-working-time';
import type {
  CanonicalSessionActivitySummary,
  SessionCostIndicatorState,
} from '../session-tabs/token-usage';
import { SessionCostTooltip } from '../analytics/session-cost-tooltip';
import { ComposerSettingsMenu } from '../settings/settings-menu';
import { SubagentProviderMenu } from './subagent-provider-menu';
import { getAutonomousModeForSession, setAutonomousModeForSession } from '../shell/chat-prefs';
import { CompactionButton } from './compaction-button';
import { formatCompactTokens } from '../lib/formatting/format-tokens';
import { ComposerToolbarOverflow, type ComposerToolbarItem } from './toolbar-overflow';

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

/** The session-cost chip renders a bare em dash — never a fabricated zero —
 *  when no priced usage is known ("unavailable", not "$0.00"). Such a bare chip
 *  says nothing in-row, so it yields to the overflow panel before every other
 *  indicator; the chip itself is never discarded and keeps its tooltip there. */
const UNKNOWN_SESSION_COST_LABEL = /^—/u;

function isUnknownSessionCost(sessionCostIndicator: SessionCostIndicatorState): boolean {
  return UNKNOWN_SESSION_COST_LABEL.test(sessionCostIndicator.label);
}

interface ComposerToolbarStatus {
  text: string;
  tone: string;
  title: string;
}

interface ComposerToolbarProps {
  sessionPath: string | null;
  canCompact: boolean;
  /** False while transport/backend lifecycle work makes mutations unsafe. */
  commandsAvailable?: boolean;
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  pruningCatalog: PruningCatalog;
  pruningResult: PruningResult | null;
  pruningRefreshPending?: boolean;
  busy?: boolean;
  onSetPruningRefreshPending?: (pending: boolean) => void;
  toolResultPruningSettings: ToolResultPruningSettings;
  sessionTitlesSettings: SessionTitlesSettings;
  providerGateStats: ProviderGateStats;
  providerManagement?: ProviderSetupPreviewProps;
  privacyMode?: boolean;
  browserServer?: BrowserServerViewState;
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
  mcpServers: McpServerInfo[];
  mcpServersStatus?: 'loading' | 'error' | 'ok';
  mcpPendingApply: boolean;
  mcpSessionServers: McpServerInfo[];
  mcpSessionPendingApply: boolean;
  onMcpListRequested: () => void;
  onMcpSetServerEnabled: (name: string, enabled: boolean) => void;
  onMcpSetServerEnabledForSession: (name: string, enabled: boolean) => void;
  onSetPrivacyMode?: (enabled: boolean) => void;
  onSetBrowserServerLanEnabled?: (enabled: boolean) => void;
  onSetBrowserServerEnabled?: (enabled: boolean) => void;
  onSetSystemPromptToggles: (disabledEntries: string[]) => void;
  onSetPruningSettings: (settings: Partial<PruningSettings>) => void;
  onSetToolResultPruningSettings: (settings: Partial<ToolResultPruningSettings>) => void;
  onSetSessionTitlesSettings: (settings: Partial<SessionTitlesSettings>) => void;
  availableExtensions: ExtensionInfo[];
  availableModels: ModelInfo[];
  availableModelsStatus?: 'provisional' | 'loading' | 'authoritative' | 'error';
  /** Invoked when the user clicks the models-unavailable retry chip (a terminal
   *  catalog hydration failure). Absent keeps the chip non-interactive. */
  onRetryModelCatalog?: () => void;
  systemPrompts: SystemPromptEntry[];
  selectedModel: string;
  selectedProvider?: string;
  selectedLevel: ThinkingLevel;
  supportsReasoning: boolean;
  contextIndicator: { label: string | null; ariaLabel: string; severity: string | null } | null;
  contextBreakdown: ContextWindowBreakdown | null;
  sessionCostIndicator: SessionCostIndicatorState | null;
  /** Canonical root-session activity/facet summary for the active session;
   *  null when absent (legacy authority) — renders nothing. */
  canonicalActivitySummary?: CanonicalSessionActivitySummary | null;
  tokenRateIndicator: TokenRateIndicatorState;
  workingTimeIndicator: WorkingTimeIndicatorState;
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
  canCompact,
  commandsAvailable = true,
  prefs,
  pruningSettings,
  pruningCatalog,
  pruningResult,
  pruningRefreshPending = false,
  busy = false,
  onSetPruningRefreshPending,
  toolResultPruningSettings,
  sessionTitlesSettings,
  providerGateStats,
  providerManagement,
  privacyMode = false,
  browserServer,
  onSetPrefs,
  mcpServers,
  mcpServersStatus,
  mcpPendingApply,
  mcpSessionServers,
  mcpSessionPendingApply,
  onMcpListRequested,
  onMcpSetServerEnabled,
  onMcpSetServerEnabledForSession,
  onSetPrivacyMode,
  onSetBrowserServerLanEnabled,
  onSetBrowserServerEnabled,
  onSetSystemPromptToggles,
  onSetPruningSettings,
  onSetToolResultPruningSettings,
  onSetSessionTitlesSettings,
  availableExtensions,
  availableModels,
  availableModelsStatus,
  onRetryModelCatalog,
  systemPrompts,
  selectedModel,
  selectedProvider,
  selectedLevel,
  supportsReasoning,
  contextIndicator,
  contextBreakdown,
  sessionCostIndicator,
  canonicalActivitySummary,
  workingTimeIndicator,
  runStatus,
  compacting,
  lastCompaction,
  onModelChange,
  onCompact,
}: ComposerToolbarProps) {
  const removedProviderIds = providerManagement?.view.removedProviderIds ?? [];
  const selectedProviderRemoved = !!selectedProvider && removedProviderIds.includes(selectedProvider);
  const filteredModels = useMemo(
    () => availableModels.filter(
      (m) => !removedProviderIds.includes(m.provider) && (prefs.providerToggles[m.provider] !== false
        || (m.id === selectedModel && (!selectedProvider || m.provider === selectedProvider))),
    ),
    [availableModels, prefs.providerToggles, removedProviderIds, selectedModel, selectedProvider],
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
  const selectedModelProvider = selectedProvider ?? selectedModelEntry?.model.provider;
  const selectedProviderDisabled = selectedModelProvider
    ? prefs.providerToggles[selectedModelProvider] === false
    : false;
  // Retain display metadata, never catalog choices: discovery may temporarily
  // have no entries, but must not replace a known concise label with a raw id.
  const previousModelLabel = useRef<{ sessionPath: string | null; id: string; provider: string; label: string } | null>(null);
  const selectedModelIdentityProvider = selectedProvider ?? selectedModelEntry?.model.provider;
  if (selectedModelEntry && selectedModelIdentityProvider) {
    previousModelLabel.current = {
      sessionPath,
      id: selectedModel,
      provider: selectedModelIdentityProvider,
      label: selectedModelEntry.selectedLabel,
    };
  } else if (previousModelLabel.current?.sessionPath !== sessionPath
    || previousModelLabel.current?.id !== selectedModel
    || !previousModelLabel.current?.provider
    || (selectedProvider && previousModelLabel.current.provider !== selectedProvider)) {
    previousModelLabel.current = null;
  }
  const selectedModelBaseLabel = selectedModelEntry?.selectedLabel
    ?? previousModelLabel.current?.label ?? (selectedModel || fallbackModelLabel);
  const selectedModelLabel = selectedProviderRemoved
    ? `${selectedModelBaseLabel} · Unavailable (removed provider)`
    : selectedProviderDisabled
      ? `${selectedModelBaseLabel} (disabled)`
      : selectedModelBaseLabel;
  const selectedModelIdentity = selectedModelEntry
    ? formatModelSpec(selectedModelEntry.model)
    : selectedProvider
      ? formatModelSpec({ provider: selectedProvider, id: selectedModel })
      : selectedModel || selectedModelBaseLabel;
  const selectedModelTooltip = [
    selectedModelIdentity,
    selectedModelBaseLabel && selectedModelBaseLabel !== selectedModelIdentity ? selectedModelBaseLabel : null,
    selectedProviderRemoved ? 'Selected provider was removed — select another model' : null,
    selectedProviderDisabled ? 'Selected provider is disabled — select another model' : null,
  ].filter((line): line is string => !!line).join('\n');
  const selectedThinkingLevels = getModelThinkingLevels(selectedModelEntry?.model);
  const selectedThinkingOptions = THINKING_LEVEL_OPTIONS.filter((option) =>
    selectedThinkingLevels.includes(option.value));
  const autonomousMode = getAutonomousModeForSession(prefs, sessionPath);
  const autonomousModeLabel = autonomousMode
    ? 'Autonomous mode on — ask_user is unavailable'
    : 'Enable autonomous mode — run without the ask_user tool';
  const refreshDisabled = !commandsAvailable || !sessionPath || isPendingTabPath(sessionPath)
    || pruningSettings.mode === 'off' || pruningSettings.mainAgentEnabled === false
    || prefs.extensionToggles['skill-pruner'] === false || !onSetPruningRefreshPending;
  const refreshTooltip = 'Re-evaluate tools and skills for your next message'
    + (pruningRefreshPending
      ? '. Refresh pending for your next idle, nonempty send; click to cancel. Queued messages and empty continuation do not consume it.'
      : busy
        ? '. You can arm it while busy; it waits for your next idle, nonempty send, not a queued message or empty continuation.'
        : '. Applies to your next idle, nonempty send, not an empty continuation.');
  const pinnedControls = (
    <>
      <ComposerSettingsMenu commandsAvailable={commandsAvailable} prefs={prefs} mcpServers={mcpServers} mcpServersStatus={mcpServersStatus} mcpPendingApply={mcpPendingApply} pruningSettings={pruningSettings} pruningCatalog={pruningCatalog} pruningResult={pruningResult} toolResultPruningSettings={toolResultPruningSettings} sessionTitlesSettings={sessionTitlesSettings} availableExtensions={availableExtensions} availableModels={availableModels} providerGateStats={providerGateStats} providerManagement={providerManagement} activeContextWindow={selectedModelEntry?.model.contextWindow} activeModel={{ provider: selectedProvider, id: selectedModel }} selectedModel={selectedModel} selectedProvider={selectedProvider} selectedLevel={selectedLevel} chatModelEntries={modelEntries} onModelChange={onModelChange} onSetPrefs={onSetPrefs} onMcpListRequested={onMcpListRequested} onMcpSetServerEnabled={onMcpSetServerEnabled} onSetPruningSettings={onSetPruningSettings} onSetSessionTitlesSettings={onSetSessionTitlesSettings} onSetToolResultPruningSettings={onSetToolResultPruningSettings} />
      {filteredModels.length > 0 ? (
        <ModelPicker
          label={selectedModelLabel}
          value={selectedProvider ? formatModelSpec({ provider: selectedProvider, id: selectedModel }) : selectedModel}
          ariaLabel="Model"
          title={selectedModelTooltip}
          disabled={!commandsAvailable}
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
      ) : availableModelsStatus === 'error' ? (
        <ToolbarActionChip
          tone="warning"
          label={selectedModelLabel || 'Models unavailable — Retry'}
          ariaLabel="Retry loading the model catalog"
          title="Loading the model catalog failed. Keep the last loaded choices visible; click to retry."
          onClick={onRetryModelCatalog}
        />
      ) : (
        <ToolbarChip
          label={selectedModelLabel || (availableModelsStatus === 'authoritative' ? 'No models available' : 'Loading models…')}
          tooltip={availableModelsStatus === 'authoritative' ? 'No models available' : 'Loading models…'}
          ariaLabel={availableModelsStatus === 'authoritative' ? 'No models available' : 'Loading models…'}
        />
      )}
      {supportsReasoning && selectedThinkingOptions.length > 0 && (
        <ChoicePicker
          value={selectedLevel}
          label={THINKING_LEVEL_LABELS[selectedLevel]}
          ariaLabel="Reasoning level"
          title="Reasoning effort"
          options={selectedThinkingOptions}
          disabled={!commandsAvailable}
          onChange={(level) => onModelChange(selectedModel, selectedProvider, level)}
        />
      )}
    </>
  );

  const toolbarItems: ComposerToolbarItem[] = [
    {
      key: 'subagent-providers',
      kind: 'control',
      shortLabel: 'Subagents',
      content: (
        <SubagentProviderMenu
          sessionPath={sessionPath}
          prefs={prefs}
          removedProviderIds={providerManagement?.view.removedProviderIds}
          availableModels={availableModels}
          onSetPrefs={onSetPrefs}
        />
      ),
    },
    {
      key: 'system-prompts',
      kind: 'control',
      shortLabel: 'Prompts',
      content: <SystemPromptToggleMenu sessionPath={sessionPath} prompts={systemPrompts} onSetToggles={onSetSystemPromptToggles} />,
    },
    {
      key: 'mcp',
      kind: 'control',
      shortLabel: 'MCP',
      content: <McpToggleMenu prefs={prefs} mcpServers={mcpSessionServers} mcpServersStatus={mcpServersStatus} mcpPendingApply={mcpSessionPendingApply} onMcpListRequested={onMcpListRequested} onMcpSetServerEnabledForSession={onMcpSetServerEnabledForSession} />,
    },
    {
      key: 'compact-context',
      kind: 'control',
      shortLabel: 'Compact',
      content: (
        <CompactionButton
          availability={!sessionPath ? 'no-session' : compacting ? 'compacting' : !canCompact ? 'busy' : 'available'}
          onCompact={onCompact}
        />
      ),
    },
    {
      key: 'autonomous-mode',
      kind: 'control',
      shortLabel: 'Autonomous',
      content: (
        <button
          type="button"
          class={`system-prompt-toggle-trigger autonomous-mode-trigger${autonomousMode ? ' active' : ''}`}
          aria-label={autonomousModeLabel}
          aria-pressed={autonomousMode}
          title={autonomousModeLabel}
          onClick={() => onSetPrefs(setAutonomousModeForSession(prefs, sessionPath ?? undefined, !autonomousMode))}
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
      ),
    },
    {
      key: 'privacy-mode',
      kind: 'control',
      shortLabel: 'Privacy',
      content: (
        <button
          type="button"
          class={`system-prompt-toggle-trigger privacy-mode-trigger${privacyMode ? ' active' : ''}`}
          aria-label={privacyMode ? 'Privacy mode on: data deleted on session close' : 'Enable privacy mode: delete data on session close'}
          aria-pressed={privacyMode}
          title="Privacy mode: data deleted on session close"
          disabled={!sessionPath || isPendingTabPath(sessionPath)}
          onClick={() => onSetPrivacyMode?.(!privacyMode)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 1.8 13 4v3.7c0 3.2-2.1 5.5-5 6.5-2.9-1-5-3.3-5-6.5V4l5-2.2Z" />
            {privacyMode ? <path d="m5.2 8 1.8 1.8 3.8-4" /> : <path d="M5.5 8h5" />}
          </svg>
        </button>
      ),
    },
    {
      key: 'browser-network',
      kind: 'control',
      shortLabel: 'Browser',
      content: (
        <BrowserServerMenu
          browserServer={browserServer}
          commandsAvailable={commandsAvailable}
          onSetLanEnabled={onSetBrowserServerLanEnabled ?? (() => undefined)}
          onSetServerEnabled={onSetBrowserServerEnabled}
        />
      ),
    },
    {
      key: 'pruning-refresh',
      kind: 'control',
      shortLabel: 'Refresh',
      content: (
        <button
          type="button"
          class={`system-prompt-toggle-trigger pruning-refresh-trigger${pruningRefreshPending ? ' active' : ''}`}
          aria-label="Refresh capabilities"
          aria-pressed={pruningRefreshPending}
          title={refreshTooltip}
          disabled={refreshDisabled}
          onClick={() => { if (!refreshDisabled) onSetPruningRefreshPending?.(!pruningRefreshPending); }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M13 5.5A5.3 5.3 0 0 0 3.1 4M3 1.5V4h2.5M3 10.5A5.3 5.3 0 0 0 12.9 12M13 14.5V12h-2.5" />
          </svg>
          {pruningRefreshPending && <span class="pruning-refresh-pending" aria-hidden="true" />}
        </button>
      ),
    },
    ...(sessionCostIndicator && !prefs.hideSessionCost ? [{
      key: 'session-cost',
      kind: 'indicator' as const,
      shortLabel: 'Cost',
      // A bare em-dash chip has nothing to show in-row: move it behind the
      // trigger ahead of every other item, keeping its tooltip in the panel.
      ...(isUnknownSessionCost(sessionCostIndicator) ? { removalPriority: 0 as const } : {}),
      content: (
        <ToolbarIndicatorChip
          kind="cost"
          ariaLabel={sessionCostIndicator.ariaLabel}
          tooltip={sessionCostIndicator.tooltip}
          tooltipNode={
            <SessionCostTooltip
              indicator={sessionCostIndicator}
              canonicalActivity={canonicalActivitySummary ?? null}
            />
          }
          richRole="region"
          label={sessionCostIndicator.label}
          freezeWhileVisible
        />
      ),
    }] : []),

    ...(workingTimeIndicator.label ? [{
      key: 'working-time',
      kind: 'indicator' as const,
      content: (
        <ToolbarIndicatorChip
          kind="time"
          ariaLabel={workingTimeIndicator.ariaLabel}
          tooltip={workingTimeIndicator.tooltip}
          tooltipNode={workingTimeIndicator.tooltipNode}
          label={workingTimeIndicator.label}
          freezeWhileVisible
        />
      ),
    }] : []),
    ...(runStatus && !prefs.hideRunStatus ? [{
      key: 'run-status',
      kind: 'indicator' as const,
      content: <ToolbarRunStatusChip tone={runStatus.tone} tooltip={runStatus.title} label={runStatus.text} />,
    }] : []),
    ...(compacting && !prefs.hideRunStatus ? [{
      key: 'compacting',
      kind: 'indicator' as const,
      content: (
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
      ),
    }] : []),
    ...(lastCompaction && !prefs.hideRunStatus ? [{
      key: 'last-compaction',
      kind: 'indicator' as const,
      content: (
        <ToolbarChip
          tone="success"
          role="status"
          ariaLive="polite"
          ariaLabel={compactionChipAriaLabel(lastCompaction)}
          tooltip={compactionChipTooltip(lastCompaction)}
          label={compactionChipLabel(lastCompaction)}
        />
      ),
    }] : []),
    ...(contextIndicator?.label && contextBreakdown && !prefs.hideContextIndicator ? [{
      key: 'context-window',
      kind: 'indicator' as const,
      content: (
        <ToolbarIndicatorChip
          kind="context"
          severity={contextIndicator.severity}
          ariaLabel={contextIndicator.ariaLabel}
          tooltipNode={<ContextWindowBreakdownChart breakdown={contextBreakdown} />}
          label={contextIndicator.label}
          freezeWhileVisible
        />
      ),
    }] : []),
  ];

  return (
    <ComposerToolbarOverflow
      pinnedControls={pinnedControls}
      items={toolbarItems}
      commandsAvailable={commandsAvailable}
    />
  );
});
