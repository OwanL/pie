/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';
import { useMemo, useState, useEffect, useRef } from 'preact/hooks';
import type { ChatPrefs, ModelInfo, SubagentBucketAssignment, ThinkingLevel } from '../../../shared/protocol';
import { THINKING_LEVEL_OPTIONS } from '../../../shared/thinking-level.js';
import {
  getSubagentBucketProviders,
  isSubagentProviderEnabled,
  setBucketAssignments,
  setNestedAllowedBucket,
  setSubagentBucketCanSpawn,
  setSubagentDropTools,
  setSubagentProviderDefaultEnabled,
  toggleChatPref,
} from '../chat-prefs';
import {
  filterEnabledProviders,
  getModelThinkingLevels,
  isModelSelectedBySpec,
  orderModelsForPicker,
  parseModelSpec,
} from './model-list';
import { PickerTag } from '../components/PickerTag';
import { ModelPicker } from '../components/model-picker';
import { ThinkingSelect } from '../components/thinking-select';
import { ChipEditor } from '../components/chip-editor';
import { SettingCheckbox } from '../components/setting-checkbox';
import { SliderRow } from '../components/slider-row';
import { UiGroupLabel } from './ui-appearance-settings';
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
  availableModels: ModelInfo[];
  modelEntries: ReturnType<typeof orderModelsForPicker>;
  onChange: (assignments: SubagentBucketAssignment[]) => void;
}

/** Editor for one bucket's explicit model/reasoning assignments. Adding a
 * model is a single inline flow: pick a model from the searchable picker,
 * choose a reasoning level from the exposed pill buttons (pre-selected to a
 * sensible default), and confirm with one click or the Enter key. */
function BucketModelsEditor({ label, hint, selected, availableModels, modelEntries, onChange }: BucketModelsEditorProps) {
  const [pendingModel, setPendingModel] = useState('');
  const [pendingThinkingLevel, setPendingThinkingLevel] = useState<ThinkingLevel | ''>('');
  const addRowRef = useRef<HTMLDivElement>(null);
  const pickerWrapRef = useRef<HTMLDivElement>(null);
  const selectedModels = selected.map((entry) => entry.model);
  const labelFor = (spec: string): string => {
    const parsed = parseModelSpec(spec);
    const match = availableModels.find((model) =>
      model.id === parsed.id && (!parsed.provider || model.provider === parsed.provider));
    return match ? `${match.provider} · ${match.name}` : spec;
  };
  const isSelected = (model: ModelInfo): boolean =>
    isModelSelectedBySpec(model, selectedModels, availableModels);
  const availableOptions = useMemo(
    () => modelEntries.filter((entry) => !isSelected(entry.model)),
    [availableModels, modelEntries, selectedModels.join('\u0000')],
  );
  const pendingParsed = parseModelSpec(pendingModel);
  const pendingModelInfo = availableModels.find((model) =>
    model.id === pendingParsed.id && (!pendingParsed.provider || model.provider === pendingParsed.provider));
  const pendingSupportedLevels = getModelThinkingLevels(pendingModelInfo);

  // Pick a sensible default reasoning level for the newly selected model so
  // the user can add it in one click. Prefer medium for reasoning models,
  // then low, then the first supported level; non-reasoning models fall back
  // to off.
  useEffect(() => {
    if (!pendingModel) {
      setPendingThinkingLevel('');
      return;
    }
    const defaults: ThinkingLevel[] = ['medium', 'low', 'high', 'xhigh', 'max', 'minimal', 'off'];
    const defaultLevel = defaults.find((level) => pendingSupportedLevels.includes(level))
      ?? pendingSupportedLevels[0]
      ?? 'off';
    setPendingThinkingLevel(defaultLevel);
  }, [pendingModel]);

  // Focus management: move focus into the add row when it appears with a
  // selected reasoning level, and back to the picker trigger when a pending
  // add is cancelled or completed so keyboard users stay in context. The
  // previous-value guard prevents stealing focus on initial mount.
  const prevPendingModel = useRef(pendingModel);
  useEffect(() => {
    if (!pendingModel) {
      if (prevPendingModel.current) {
        const trigger = pickerWrapRef.current?.querySelector('[aria-haspopup="listbox"]') as HTMLButtonElement | null;
        trigger?.focus();
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
    if (!pendingModel || !pendingThinkingLevel || selectedModels.includes(pendingModel)) return;
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
      <div class="toolbar-settings-keep-picker-label">{label}</div>
      <div class="toolbar-settings-item-hint">{hint}</div>
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
                <ThinkingSelect
                  value={entry.thinkingLevel}
                  model={model ?? null}
                  ariaLabel={`Reasoning for ${labelFor(entry.model)} in ${label}`}
                  onChange={(value) => {
                    if (value !== '' && value !== 'inherit') {
                      updateThinkingLevel(entry.model, value);
                    }
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
      {selected.length === 0 && (
        <div class="toolbar-settings-bucket-warning" role="note">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 1.6 L10.7 10.1 H1.3 Z" />
            <line x1="6" y1="4.9" x2="6" y2="7.1" />
            <circle cx="6" cy="8.6" r="0.55" fill="currentColor" stroke="none" />
          </svg>
          <span>No assignments — inherits the parent model and reasoning</span>
        </div>
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
              disabled={!pendingThinkingLevel}
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
      hint={
        <>
          Tool names listed here are removed from every subagent's tool set — e.g. <code>ask_user</code> to stop subagents prompting the user mid-delegation. Applies to both agents with an explicit <code>tools:</code> list and unrestricted agents.
        </>
      }
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
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  availableModels: ModelInfo[];
}

interface SubagentModelAssignmentsProps extends SubagentSettingsProps {
  /** Optional test/integration override. Production derives purpose-specific
   * subagent entries rather than reusing generic settings-picker rows. */
  modelEntries?: ReturnType<typeof orderModelsForPicker>;
}

/** Models-tab editors for the subagent model buckets. */
export function SubagentModelAssignments({ prefs, onSetPrefs, availableModels, modelEntries }: SubagentModelAssignmentsProps) {
  const bucketModelEntries = useMemo(
    () => modelEntries ?? orderModelsForPicker(
      filterEnabledProviders(availableModels, prefs.providerToggles),
    ),
    [availableModels, modelEntries, prefs.providerToggles],
  );
  return (
    <div class="toolbar-settings-ext-settings">
      <div class="toolbar-settings-item-hint">
        Each bucket holds provider-qualified models eligible for that tier. When a subagent requests a bucket, one model is picked from a balanced random cycle. Empty buckets fall back to the parent's active model.
      </div>
      {BUCKET_DEFS.map((def) => (
        <BucketModelsEditor
          key={def.key}
          label={def.label}
          hint={def.hint}
          selected={prefs.subagentBuckets[def.key] ?? []}
          availableModels={availableModels}
          modelEntries={bucketModelEntries}
          onChange={(assignments) => onSetPrefs(setBucketAssignments(prefs, def.key, assignments))}
        />
      ))}
    </div>
  );
}

/** Subagents-tab behavior, routing, nesting, and throughput controls. */
export function SubagentSection({ prefs, onSetPrefs, availableModels }: SubagentSettingsProps) {
  const subagentProviders = useMemo(
    () => getSubagentBucketProviders(prefs, availableModels),
    [availableModels, prefs.subagentBuckets, prefs.subagentProviderDefaults],
  );
  const defaultEnabledCount = subagentProviders.filter(
    (provider) => isSubagentProviderEnabled(prefs, provider),
  ).length;

  return (
    <div class="toolbar-settings-ext-settings">
      <SettingCheckbox
        label="Always use parent model"
        checked={prefs.subagentAlwaysParentModel}
        onChange={() => onSetPrefs(toggleChatPref(prefs, 'subagentAlwaysParentModel'))}
      />

      <SettingCheckbox
        label="Route around busy providers"
        checked={prefs.subagentRouteAroundSaturatedProviders}
        onChange={() => onSetPrefs(toggleChatPref(prefs, 'subagentRouteAroundSaturatedProviders'))}
      />
      <div class="toolbar-settings-item-hint">
        Prefer another enabled model/provider in the requested bucket when its ProviderGate has an immediate slot. If capacity is unavailable or every candidate is busy, keep normal selection and queue. “Always use parent model” takes precedence.
      </div>

      <SettingCheckbox
        label="Fallback on provider failure"
        checked={prefs.subagentFallbackOnProviderFailure}
        onChange={() => onSetPrefs(toggleChatPref(prefs, 'subagentFallbackOnProviderFailure'))}
      />
      <div class="toolbar-settings-item-hint">
        Retry on another model in the same bucket when a provider fails after exhausting its own retries (for example a timeout, connection error, rate limit, or server error). Failover only happens before visible output or tool execution, so work is not replayed unsafely.
      </div>

      <UiGroupLabel label="Default providers" />
      <div class="toolbar-settings-item-hint">
        Sets the initial selection in each chat's subagent provider selector. Per-chat changes override these defaults. Configured providers stay visible if a session's live model list is temporarily stale.
      </div>
      {subagentProviders.length === 0 && (
        <div class="toolbar-settings-item-hint">Add models to the buckets in Models to configure provider defaults.</div>
      )}
      {subagentProviders.map((provider) => {
        const enabled = isSubagentProviderEnabled(prefs, provider);
        const lastEnabled = enabled && defaultEnabledCount === 1;
        return (
          <SettingCheckbox
            key={provider}
            label={provider}
            checked={enabled}
            disabled={lastEnabled}
            title={lastEnabled ? 'At least one subagent provider must remain enabled by default' : undefined}
            onChange={() => onSetPrefs(setSubagentProviderDefaultEnabled(prefs, provider, !enabled))}
          />
        );
      })}

      <UiGroupLabel label="Dropped tools" />
      <DropToolsEditor
        selected={prefs.subagentDropTools ?? []}
        onChange={(tools) => onSetPrefs(setSubagentDropTools(prefs, tools))}
      />

      <UiGroupLabel label="Nested bucket allowlist" />
      <div class="toolbar-settings-item-hint">
        Which model tiers nested sub-agents (depth ≥ 1) may use. A requested tier that isn't allowed is downgraded to the highest allowed tier at or below it — for example, a disallowed Frontier request runs on Medium (or Small if only that tier is allowed). The root agent is never restricted.
      </div>
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

      <UiGroupLabel label="Delegation by bucket" />
      <div class="toolbar-settings-item-hint">
        Choose which effective subagent tiers may create further subagents. Disabled tiers become leaves and receive an error if they call the subagent tool. The root agent is never restricted.
      </div>
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

      <UiGroupLabel label="Nesting" />
      <SliderRow
        label="Nesting levels"
        value={prefs.subagentMaxDepth}
        min={0}
        max={8}
        step={1}
        formatValue={(v) => (v === 0 ? 'Off' : String(v))}
        ariaLabel="Subagent nesting levels"
        hint="How many levels subagents may delegate to further subagents (main → L1 → L2 → ...). 0 turns subagents off entirely. Higher values allow more nesting at higher cost."
        onChange={(subagentMaxDepth) => onSetPrefs({ subagentMaxDepth })}
      />
      <SliderRow
        label="Tree session budget"
        value={prefs.subagentMaxTreeSessions}
        min={5}
        max={200}
        step={5}
        ariaLabel="Max subagent sessions across the nested tree"
        hint="Cap on total subagent sessions spawned across an entire nested tree, so increased nesting can't run away on cost."
        onChange={(subagentMaxTreeSessions) => onSetPrefs({ subagentMaxTreeSessions })}
      />

      <UiGroupLabel label="Throughput" />
      <div class="toolbar-settings-item-hint">
        Native sibling subagent calls run concurrently. This cap protects providers from bursts; 0 is not allowed.
      </div>
      <SliderRow
        label="Max active trees"
        value={prefs.subagentMaxInflight}
        min={1}
        max={16}
        step={1}
        ariaLabel="Max concurrent root subagent trees"
        hint="Global concurrency cap on independent root subagent trees across all sessions. Sibling calls have no per-turn count cap; calls beyond this limit wait for a permit. Nested descendants borrow their root's permit, so recursive delegation cannot deadlock the throttle."
        onChange={(subagentMaxInflight) => onSetPrefs({ subagentMaxInflight })}
      />
    </div>
  );
}
