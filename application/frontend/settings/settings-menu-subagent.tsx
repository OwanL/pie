/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';
import { useMemo, useState, useEffect, useRef } from 'preact/hooks';
import type { ChatPrefs, ModelInfo, ProviderGateStats, SubagentBucketAssignment, ThinkingLevel } from '../../lib/protocol/index.js';
import {
  MAX_SUBAGENT_MAX_INFLIGHT,
  MIN_SUBAGENT_MAX_INFLIGHT,
  concurrencySourceLabel,
} from '../../../lib/concurrency-config.js';
import { THINKING_LEVEL_OPTIONS } from '../composer/thinking-level-options.js';
import {
  getSubagentBucketProviders,
  isSubagentProviderEnabled,
  setBucketAssignments,
  setNestedAllowedBucket,
  setSubagentBucketCanSpawn,
  setSubagentDropTools,
  setSubagentProviderDefaultEnabled,
  toggleChatPref,
} from '../shell/chat-prefs';
import {
  filterEnabledProviders,
  formatModelSpec,
  getModelThinkingLevels,
  isModelSelectedBySpec,
  orderModelsForPicker,
  parseModelSpec,
} from '../composer/model-list';
import { PickerTag } from '../lib/components/PickerTag';
import { ModelPicker } from './model-picker';
import { ThinkingSelect } from './thinking-select';
import { ChipEditor } from './chip-editor';
import { SettingCheckbox } from './setting-checkbox';
import { SettingsHelp } from './settings-help';
import { SliderRow } from './slider-row';
import type { OnSetPrefs } from './settings-menu-types';

type BucketKey = 'small' | 'medium' | 'frontier';

interface BucketDef {
  key: BucketKey;
  label: string;
  hint: string;
}

/** The three model buckets, in display order. Hints mirror the schema guidance
 *  the LLM sees for the `bucket` parameter. */
export const BUCKET_DEFS: readonly BucketDef[] = [
  { key: 'small', label: 'Small', hint: 'Low-cost busywork' },
  { key: 'medium', label: 'Medium', hint: 'Balanced main development' },
  { key: 'frontier', label: 'Frontier', hint: 'Most capable for hardest problems' },
];

/** Nested-bucket allowlist toggles, highest tier first (the one users most often
 *  want to disallow for nested sub-agents shown on top). */
export const NESTED_TOGGLE_DEFS: readonly { key: BucketKey; label: string }[] = [
  { key: 'frontier', label: 'Frontier' },
  { key: 'medium', label: 'Medium' },
  { key: 'small', label: 'Small' },
];

export const SUBAGENT_MODEL_SETTING_LABELS = [
  'Small bucket models',
  'Medium bucket models',
  'Frontier bucket models',
] as const;

export const SUBAGENT_BEHAVIOR_SETTING_LABELS = [
  'Always use parent model',
  'Route around busy providers',
  'Fallback on provider failure',
  'Default providers',
  'Drop tools for subagents',
  'Allow Frontier',
  'Allow Medium',
  'Allow Small',
  'Allow Frontier subagents to delegate',
  'Allow Medium subagents to delegate',
  'Allow Small subagents to delegate',
  'Nesting levels',
  'Tree session budget',
  'Max active trees',
] as const;

interface BucketModelsEditorProps {
  label: string;
  hint: string;
  selected: SubagentBucketAssignment[];
  removedProviderIds?: readonly string[];
  availableModels: ModelInfo[];
  modelEntries: ReturnType<typeof orderModelsForPicker>;
  onChange: (assignments: SubagentBucketAssignment[]) => void;
}

/** Editor for one bucket's explicit model/reasoning assignments. Adding a
 * model is a single inline flow: pick a model from the searchable picker,
 * choose a reasoning level from the exposed pill buttons (pre-selected to a
 * sensible default), and confirm with one click or the Enter key. */
function BucketModelsEditor({ label, hint, selected, availableModels, modelEntries, removedProviderIds = [], onChange }: BucketModelsEditorProps) {
  const [pendingModel, setPendingModel] = useState('');
  const [pendingThinkingLevel, setPendingThinkingLevel] = useState<ThinkingLevel | ''>('');
  const addRowRef = useRef<HTMLDivElement>(null);
  const pickerWrapRef = useRef<HTMLDivElement>(null);
  const selectedModels = selected.map((entry) => entry.model);
  const labelFor = (spec: string): string => {
    const parsed = parseModelSpec(spec);
    if (parsed.provider && removedProviderIds.includes(parsed.provider)) return `${spec} · Unavailable (removed provider)`;
    const match = availableModels.find((model) =>
      model.id === parsed.id && (!parsed.provider || model.provider === parsed.provider));
    return match ? `${match.provider} · ${match.name}` : spec;
  };
  const isSelected = (model: ModelInfo): boolean =>
    isModelSelectedBySpec(model, selectedModels, availableModels);
  const availableOptions = useMemo(
    () => modelEntries.filter((entry) => !removedProviderIds.includes(entry.model.provider) && !isSelected(entry.model)),
    [availableModels, modelEntries, removedProviderIds, selectedModels.join('\u0000')],
  );
  // Resolve against the current addable picker entries, not the full catalog
  // used for persisted chip labels. This also shares the picker's legacy-id
  // duplicate semantics through availableOptions/isSelected.
  const pendingModelInfo = availableOptions.find((entry) =>
    formatModelSpec(entry.model) === pendingModel)?.model;
  const pendingEligible = !!pendingModelInfo;
  const pendingSupportedLevels = getModelThinkingLevels(pendingModelInfo);
  const pendingSupportedLevelsKey = pendingSupportedLevels.join('\u0000');
  const canAdd = pendingEligible && !!pendingThinkingLevel && pendingSupportedLevels.includes(pendingThinkingLevel);

  // Pick a sensible default reasoning level for the newly selected model so
  // the user can add it in one click. Prefer medium for reasoning models,
  // then low, then the first supported level; non-reasoning models fall back
  // to off.
  useEffect(() => {
    if (!pendingModel || !pendingEligible) {
      setPendingModel('');
      setPendingThinkingLevel('');
      return;
    }
    const defaults: ThinkingLevel[] = ['medium', 'low', 'high', 'xhigh', 'max', 'minimal', 'off'];
    const defaultLevel = defaults.find((level) => pendingSupportedLevels.includes(level))
      ?? pendingSupportedLevels[0]
      ?? 'off';
    // Capability refreshes repair only unsupported levels; unrelated prop
    // renders must not overwrite a supported, intentional user choice.
    setPendingThinkingLevel((current) =>
      current && pendingSupportedLevels.includes(current) ? current : defaultLevel);
  }, [pendingModel, pendingEligible, pendingSupportedLevelsKey]);

  // Focus management: move focus into the add row when it appears with a
  // selected reasoning level, and back to the picker trigger when a pending
  // add is cancelled or completed so keyboard users stay in context. The
  // previous-value guard prevents stealing focus on initial mount.
  const prevPendingModel = useRef(pendingModel);
  useEffect(() => {
    if (!pendingModel) {
      if (prevPendingModel.current) {
        const trigger = pickerWrapRef.current?.querySelector('[aria-haspopup="listbox"]') as HTMLButtonElement | null;
        if (trigger && !trigger.disabled) trigger.focus();
      }
      prevPendingModel.current = '';
      return;
    }
    prevPendingModel.current = pendingModel;
    if (!pendingThinkingLevel) return;
    const addBtn = addRowRef.current?.querySelector('.toolbar-settings-bucket-add-btn') as HTMLButtonElement | null;
    if (addBtn && !addBtn.disabled) {
      addBtn.focus();
    } else {
      const firstPill = addRowRef.current?.querySelector('.toolbar-settings-bucket-level') as HTMLButtonElement | null;
      firstPill?.focus();
    }
  }, [pendingModel, pendingThinkingLevel]);

  const addAssignment = () => {
    // Revalidate synchronously too: a confirmation can arrive after new props
    // render but before the pending-state reconciliation effect runs.
    if (!canAdd || !pendingThinkingLevel) return;
    onChange([...selected, { model: pendingModel, thinkingLevel: pendingThinkingLevel }]);
    setPendingModel('');
    setPendingThinkingLevel('');
  };
  const cancelAdd = () => {
    setPendingModel('');
    setPendingThinkingLevel('');
  };
  const removeModel = (spec: string) => onChange(selected.filter((entry) => entry.model !== spec));
  const updateThinkingLevel = (spec: string, thinkingLevel: ThinkingLevel) =>
    onChange(selected.map((entry) => entry.model === spec ? { ...entry, thinkingLevel } : entry));

  const handleKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    // Only treat Enter as "confirm add" when the event target is the add row
    // itself or another non-interactive descendant. Buttons, selects and inputs
    // have their own default Enter/Space behavior (Add, Cancel, reasoning pills)
    // and must not be hijacked by the wrapper handler.
    if (e.key === 'Enter' && pendingModel && pendingThinkingLevel) {
      const target = e.target as HTMLElement;
      const interactive = target.closest('button, select, input, textarea');
      if (interactive) return;
      e.preventDefault();
      addAssignment();
    } else if (e.key === 'Escape' && pendingModel) {
      e.preventDefault();
      e.stopPropagation();
      cancelAdd();
    }
  };

  return (
    <div class="toolbar-settings-keep-picker" onKeyDown={handleKeyDown}>
      <div class="toolbar-settings-keep-picker-label">
        {label}
        <SettingsHelp label={`${label} bucket models`}>
          {hint}{selected.length === 0 && <> Empty buckets use the parent model and its reasoning level.</>}
        </SettingsHelp>
      </div>
      {selected.length > 0 && (
        <div class="toolbar-settings-keep-chips">
          {selected.map((entry) => {
            const parsed = parseModelSpec(entry.model);
            const model = availableModels.find((candidate) =>
              candidate.id === parsed.id && (!parsed.provider || candidate.provider === parsed.provider));
            return (
              <div class="toolbar-settings-bucket-assignment" key={entry.model}>
                <PickerTag
                  value={entry.model}
                  label={labelFor(entry.model)}
                  removeLabel={`Remove ${labelFor(entry.model)} from ${label}`}
                  onRemove={() => removeModel(entry.model)}
                />
                {!(parsed.provider && removedProviderIds.includes(parsed.provider)) && <ThinkingSelect
                  value={entry.thinkingLevel}
                  model={model ?? null}
                  ariaLabel={`Reasoning for ${labelFor(entry.model)} in ${label}`}
                  onChange={(value) => {
                    if (value !== '' && value !== 'inherit') {
                      updateThinkingLevel(entry.model, value);
                    }
                  }}
                />}
              </div>
            );
          })}
        </div>
      )}
      {selected.length === 0 && (
        <div class="toolbar-settings-bucket-inherit">Uses parent model</div>
      )}
      <div class="toolbar-settings-keep-picker-wrap" ref={pickerWrapRef}>
        {!pendingModel && (
          <ModelPicker
            compact
            dropdownDirection="down"
            value=""
            label={availableOptions.length === 0 ? 'No models available' : 'Add model…'}
            ariaLabel={`Choose model for ${label} bucket`}
            title={`Choose model for ${label} bucket`}
            entries={availableOptions}
            disabled={availableOptions.length === 0}
            onChange={(spec) => {
              setPendingModel(spec);
            }}
          />
        )}
        {pendingModel && (
          <div ref={addRowRef} class="toolbar-settings-bucket-add-row" role="group" aria-label={`Add ${labelFor(pendingModel)} to ${label}`}>
            <span class="toolbar-settings-bucket-add-model">{labelFor(pendingModel)}</span>
            <div class="toolbar-settings-bucket-levels" role="radiogroup" aria-label="Reasoning level">
              {pendingSupportedLevels.map((level) => {
                const option = THINKING_LEVEL_OPTIONS.find((o) => o.value === level)!;
                const active = pendingThinkingLevel === level;
                return (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    class={`toolbar-settings-bucket-level${active ? ' selected' : ''}`}
                    onClick={() => setPendingThinkingLevel(level)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              class="toolbar-settings-bucket-add-btn"
              disabled={!canAdd}
              onClick={addAssignment}
            >
              <svg width="12" height="12" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="6.5" y1="2.5" x2="6.5" y2="10.5" />
                <line x1="2.5" y1="6.5" x2="10.5" y2="6.5" />
              </svg>
              <span>Add</span>
            </button>
            <button
              type="button"
              class="toolbar-settings-bucket-cancel-btn"
              aria-label="Cancel adding model"
              onClick={cancelAdd}
            >
              <svg width="12" height="12" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="3" y1="3" x2="10" y2="10" />
                <line x1="10" y1="3" x2="3" y2="10" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface DropToolsEditorProps {
  selected: string[];
  onChange: (tools: string[]) => void;
}

/** Free-text chip editor for the list of tool names always dropped from
 *  subagent sessions. Tool names aren't enumerated in the webview, so the
 *  user types them (e.g. `ask_user`) and presses Enter to add; chips are
 *  removable. Built on the shared {@link ChipEditor} foundation with a
 *  free-text Enter-to-add slot; reuses the keep-picker chip styling for
 *  visual consistency. */
function DropToolsEditor({ selected, onChange }: DropToolsEditorProps) {
  const [draft, setDraft] = useState('');
  const addTool = () => {
    const name = draft.trim();
    setDraft('');
    if (!name || selected.includes(name)) return;
    onChange([...selected, name]);
  };
  const removeTool = (name: string) => onChange(selected.filter((t) => t !== name));
  return (
    <ChipEditor
      label="Drop tools for subagents"
      hint={<>Remove these tools from every subagent, including explicit <code>tools:</code> lists and unrestricted agents. Example: <code>ask_user</code> prevents mid-delegation prompts.</>}
      selected={selected}
      onRemove={removeTool}
      removeLabel={(name) => `Stop dropping ${name}`}
      addControl={
        <input
          type="text"
          class="toolbar-settings-keep-select"
          value={draft}
          placeholder="Add tool name…"
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addTool();
            }
          }}
          aria-label="Add a tool name to drop for subagents"
        />
      }
    />
  );
}

interface SubagentSettingsProps {
  removedProviderIds?: readonly string[];
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  availableModels: ModelInfo[];
  providerGateStats?: ProviderGateStats;
}

interface SubagentModelAssignmentsProps extends SubagentSettingsProps {
  /** Optional test/integration override. Production derives purpose-specific
   * subagent entries rather than reusing generic settings-picker rows. */
  modelEntries?: ReturnType<typeof orderModelsForPicker>;
}

/** Models-tab editors for the subagent model buckets. */
export function SubagentModelAssignments({ prefs, onSetPrefs, availableModels, modelEntries, removedProviderIds = [] }: SubagentModelAssignmentsProps) {
  const bucketModelEntries = useMemo(
    () => modelEntries ?? orderModelsForPicker(
      filterEnabledProviders(availableModels, prefs.providerToggles),
    ),
    [availableModels, modelEntries, prefs.providerToggles],
  );
  return (
    <div class="toolbar-settings-ext-settings">
      <h3 class="toolbar-settings-assignment-title">Subagent model buckets
        <SettingsHelp label="Subagent model buckets">
          Each bucket holds provider-qualified models eligible for that tier. When a subagent requests a bucket, one model is picked from a balanced random cycle. Empty buckets fall back to the parent's active model.
        </SettingsHelp>
      </h3>
      {BUCKET_DEFS.map((def) => (
        <BucketModelsEditor
          key={def.key}
          label={def.label}
          hint={def.hint}
          selected={prefs.subagentBuckets[def.key] ?? []}
          removedProviderIds={removedProviderIds}
          availableModels={availableModels}
          modelEntries={bucketModelEntries}
          onChange={(assignments) => onSetPrefs(setBucketAssignments(prefs, def.key, assignments))}
        />
      ))}
    </div>
  );
}

/** Subagents-tab behavior, routing, nesting, and throughput controls. */
export function SubagentSection({ prefs, onSetPrefs, availableModels, providerGateStats, removedProviderIds = [] }: SubagentSettingsProps) {
  const subagentProviders = useMemo(
    () => getSubagentBucketProviders(prefs, availableModels, undefined, removedProviderIds),
    [availableModels, removedProviderIds, prefs.subagentBuckets, prefs.subagentProviderDefaults],
  );
  const runtimeConcurrency = providerGateStats?.subagentConcurrency;
  const appliedRuntimeStatus = runtimeConcurrency?.effective
    ? `Applied: ${runtimeConcurrency.effective.value} · ${concurrencySourceLabel(runtimeConcurrency.effective.source)}`
    : runtimeConcurrency?.workerCount === 0
      ? 'Applied: awaiting workers'
      : runtimeConcurrency && runtimeConcurrency.pendingWorkers > 0
        ? `Applied: awaiting sync (${runtimeConcurrency.pendingWorkers} pending)`
        : 'Applied: unavailable';
  const pendingRuntimeStatus = runtimeConcurrency?.effective && runtimeConcurrency.pendingWorkers > 0
    ? ` · ${runtimeConcurrency.pendingWorkers} worker${runtimeConcurrency.pendingWorkers === 1 ? '' : 's'} pending sync`
    : '';

  return (
    <div class="toolbar-settings-ext-settings">
      <section class="toolbar-settings-content-group" role="group" aria-label="Model selection & routing">
        <h3 class="toolbar-settings-content-group-title">Model selection &amp; routing</h3>
      <SettingCheckbox
        label="Always use parent model"
        checked={prefs.subagentAlwaysParentModel}
        onChange={() => onSetPrefs(toggleChatPref(prefs, 'subagentAlwaysParentModel'))}
      />

      <SettingCheckbox
        label="Route around busy providers"
        checked={prefs.subagentRouteAroundSaturatedProviders}
        hint="Prefer a requested-bucket model with an immediate ProviderGate slot; if none is available, use normal selection and queue. Always use parent model takes precedence."
        onChange={() => onSetPrefs(toggleChatPref(prefs, 'subagentRouteAroundSaturatedProviders'))}
      />

      <SettingCheckbox
        label="Fallback on provider failure"
        checked={prefs.subagentFallbackOnProviderFailure}
        hint="After provider retries fail (timeout, connection error, rate limit, or server error), retry another model in the same bucket only before visible output or tool execution. Work is never replayed."
        onChange={() => onSetPrefs(toggleChatPref(prefs, 'subagentFallbackOnProviderFailure'))}
      />

      <div class="toolbar-settings-ui-group-label">
        Default providers
        <SettingsHelp label="Default providers">
          Initial provider selection for each chat; per-chat changes override it. Configured providers stay visible when the live model list is stale. Add models to the buckets in Models to configure provider defaults.
        </SettingsHelp>
      </div>
      {subagentProviders.length === 0 && (
        <div class="toolbar-settings-item-hint">No providers configured</div>
      )}
      {subagentProviders.map((provider) => {
        const enabled = isSubagentProviderEnabled(prefs, provider);
        return (
          <SettingCheckbox
            key={provider}
            label={provider}
            checked={enabled}
            onChange={() => onSetPrefs(setSubagentProviderDefaultEnabled(prefs, provider, !enabled))}
          />
        );
      })}

      </section>

      <section class="toolbar-settings-content-group" role="group" aria-label="Tools">
        <h3 class="toolbar-settings-content-group-title">Tools</h3>
      <DropToolsEditor
        selected={prefs.subagentDropTools ?? []}
        onChange={(tools) => onSetPrefs(setSubagentDropTools(prefs, tools))}
      />

      </section>

      <section class="toolbar-settings-content-group" role="group" aria-label="Delegation">
        <h3 class="toolbar-settings-content-group-title">Delegation</h3>
      <h4 class="toolbar-settings-ui-group-label">
        Nested bucket allowlist
        <SettingsHelp label="Nested bucket allowlist">
          Controls which tiers nested subagents (depth ≥ 1) may use; disallowed requests downgrade to the highest allowed tier at or below the request. The root agent is never restricted.
        </SettingsHelp>
      </h4>
      {NESTED_TOGGLE_DEFS.map((def) => {
        const enabled = prefs.subagentNestedAllowedBuckets[def.key] ?? true;
        return (
          <SettingCheckbox
            key={def.key}
            label={`Allow ${def.label}`}
            checked={enabled}
            onChange={() => onSetPrefs(setNestedAllowedBucket(prefs, def.key, !enabled))}
          />
        );
      })}

      <h4 class="toolbar-settings-ui-group-label">
        Delegation by bucket
        <SettingsHelp label="Delegation by bucket">
          Controls which effective subagent tiers may spawn further subagents; disabled tiers become leaves and subagent-tool calls return an error. The root agent is never restricted.
        </SettingsHelp>
      </h4>
      {NESTED_TOGGLE_DEFS.map((def) => {
        const enabled = prefs.subagentBucketCanSpawn[def.key] ?? true;
        return (
          <SettingCheckbox
            key={def.key}
            label={`Allow ${def.label} subagents to delegate`}
            checked={enabled}
            onChange={() => onSetPrefs(setSubagentBucketCanSpawn(prefs, def.key, !enabled))}
          />
        );
      })}

      </section>

      <section class="toolbar-settings-content-group" role="group" aria-label="Limits">
        <h3 class="toolbar-settings-content-group-title">Limits</h3>
      <SliderRow
        label="Nesting levels"
        value={prefs.subagentMaxDepth}
        min={0}
        max={8}
        step={1}
        formatValue={(v) => (v === 0 ? 'Off' : String(v))}
        ariaLabel="Subagent nesting levels"
        hint="Maximum delegation depth (main → L1 → …); 0 disables subagents. Deeper trees can increase cost."
        onChange={(subagentMaxDepth) => onSetPrefs({ subagentMaxDepth })}
      />
      <SliderRow
        label="Tree session budget"
        value={prefs.subagentMaxTreeSessions}
        min={5}
        max={200}
        step={5}
        ariaLabel="Max subagent sessions across the nested tree"
        hint="Total sessions spawned across one nested tree. Caps the cost of deeper delegation."
        onChange={(subagentMaxTreeSessions) => onSetPrefs({ subagentMaxTreeSessions })}
      />

      <div class="toolbar-settings-ui-group-label">
        Throughput
        <SettingsHelp label="Throughput">
          Sibling subagent calls run concurrently; the cap protects providers from bursts.<br />
          Preference: {prefs.subagentMaxInflight} · {concurrencySourceLabel(prefs.subagentMaxInflightSource)}<br />
          {runtimeConcurrency ? (
            <>
              Runtime configured: {runtimeConcurrency.configured.value} · {concurrencySourceLabel(runtimeConcurrency.configured.source)}<br />
              {appliedRuntimeStatus}{pendingRuntimeStatus}<br />
              Worker-process scope · {runtimeConcurrency.workerCount} worker{runtimeConcurrency.workerCount === 1 ? '' : 's'}; the cap is shared by sessions in that process, not across all sessions or processes.
            </>
          ) : (
            <>Runtime configured/applied: unavailable<br />Worker-process scope · runtime status unavailable</>
          )}
        </SettingsHelp>
      </div>
      <SliderRow
        label="Max active trees"
        value={prefs.subagentMaxInflight}
        min={MIN_SUBAGENT_MAX_INFLIGHT}
        max={MAX_SUBAGENT_MAX_INFLIGHT}
        step={1}
        ariaLabel="Max concurrent root subagent trees"
        hint="Maximum independent root trees per worker process, shared by its sessions—not across all sessions or processes. Extra sibling calls wait; descendants borrow their root's permit to avoid deadlock."
        onChange={(subagentMaxInflight) => onSetPrefs({ subagentMaxInflight })}
      />
      <div class="toolbar-settings-runtime-status">
        {runtimeConcurrency ? `${appliedRuntimeStatus}${pendingRuntimeStatus}` : 'Runtime unavailable'}
      </div>
      </section>
    </div>
  );
}
