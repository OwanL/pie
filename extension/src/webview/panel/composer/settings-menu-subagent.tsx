/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ChatPrefs, ModelInfo } from '../../../shared/protocol';
import { setBucketModels, setNestedAllowedBucket, setSubagentDropTools, toggleChatPref } from '../chat-prefs';
import { orderModelsForPicker } from './model-list';
import { PickerTag } from '../components/PickerTag';
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
const BUCKET_DEFS: readonly BucketDef[] = [
  { key: 'small', label: 'Small', hint: 'Haiku-class busywork' },
  { key: 'medium', label: 'Medium', hint: 'Sonnet-class main development' },
  { key: 'frontier', label: 'Frontier', hint: 'Opus-class hardest problems' },
];

/** Nested-bucket allowlist toggles, highest tier first (the one users most often
 *  want to disallow for nested sub-agents shown on top). */
const NESTED_TOGGLE_DEFS: readonly { key: BucketKey; label: string }[] = [
  { key: 'frontier', label: 'Frontier (Opus)' },
  { key: 'medium', label: 'Medium (Sonnet)' },
  { key: 'small', label: 'Small (Haiku)' },
];

interface BucketModelsEditorProps {
  label: string;
  hint: string;
  selected: string[];
  availableModels: ModelInfo[];
  modelEntries: ReturnType<typeof orderModelsForPicker>;
  onChange: (models: string[]) => void;
}

/**
 * Editor for a single bucket's model list. Selected models render as removable
 * chips (labelled with the model's display name); an "Add model…" select lists
 * every available model not already in the bucket. Reuses the AlwaysKeepPicker
 * styling (chips + select) for visual consistency, and its optimistic-pending
 * gate so a slow host round-trip can't double-add an item.
 *
 * A model id that is no longer in the registry (e.g. its provider was toggled
 * off) still renders as a chip labelled with the raw id, so the user can see and
 * remove stale entries — selection-time filtering in the subagent extension
 * drops unavailable models from the pool anyway.
 */
function BucketModelsEditor({ label, hint, selected, availableModels, modelEntries, onChange }: BucketModelsEditorProps) {
  const labelFor = (id: string): string => availableModels.find((m) => m.id === id)?.name ?? id;

  const availableOptions = useMemo(
    () => modelEntries.filter((entry) => !selected.includes(entry.model.id)),
    [modelEntries, selected],
  );

  // Optimistic names just added but not yet reflected in the host-persisted
  // `selected` prop (mirrors AlwaysKeepPicker). Without this gate the user can
  // re-select an item before the host state arrives, firing a duplicate update.
  const [pending, setPending] = useState<string[]>([]);
  useEffect(() => {
    if (pending.length === 0) return;
    const remaining = pending.filter((id) => !selected.includes(id));
    if (remaining.length !== pending.length) setPending(remaining);
  }, [selected, pending]);

  const addModel = (id: string) => {
    if (!id || selected.includes(id) || pending.includes(id)) return;
    setPending((cur) => [...cur, id]);
    onChange([...selected, id]);
    window.setTimeout(() => setPending((cur) => cur.filter((x) => x !== id)), 2000);
  };
  const removeModel = (id: string) => onChange(selected.filter((x) => x !== id));

  return (
    <div class="toolbar-settings-keep-picker">
      <div class="toolbar-settings-keep-picker-label">{label}</div>
      <div class="toolbar-settings-item-hint">{hint}</div>
      {selected.length > 0 && (
        <div class="toolbar-settings-keep-chips">
          {selected.map((id) => (
            <PickerTag
              key={id}
              value={id}
              label={labelFor(id)}
              removeLabel={`Remove ${labelFor(id)} from ${label}`}
              onRemove={() => removeModel(id)}
            />
          ))}
        </div>
      )}
      {selected.length === 0 && (
        <div class="toolbar-settings-bucket-warning" role="note">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 1.6 L10.7 10.1 H1.3 Z" />
            <line x1="6" y1="4.9" x2="6" y2="7.1" />
            <circle cx="6" cy="8.6" r="0.55" fill="currentColor" stroke="none" />
          </svg>
          <span>No models — falls back to the parent model</span>
        </div>
      )}
      <div class="toolbar-settings-keep-picker-wrap">
        <select
          class="toolbar-settings-select toolbar-settings-keep-select"
          value=""
          aria-label={`Add model to ${label} bucket`}
          disabled={availableOptions.length === 0}
          onChange={(e) => {
            const id = (e.target as HTMLSelectElement).value;
            if (id) {
              addModel(id);
              (e.target as HTMLSelectElement).value = '';
            }
          }}
        >
          <option value="">
            {availableOptions.length === 0 ? 'No models available' : 'Add model…'}
          </option>
          {availableOptions.map((entry) => (
            <option key={entry.model.id} value={entry.model.id}>{entry.label}</option>
          ))}
        </select>
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
 *  removable. Reuses the keep-picker chip styling for visual consistency. */
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
    <div class="toolbar-settings-keep-picker">
      <div class="toolbar-settings-keep-picker-label">Drop tools for subagents</div>
      <div class="toolbar-settings-item-hint">
        Tool names listed here are removed from every subagent's tool set — e.g. <code>ask_user</code> to stop subagents prompting the user mid-delegation. Applies to both agents with an explicit <code>tools:</code> list and unrestricted agents.
      </div>
      {selected.length > 0 && (
        <div class="toolbar-settings-keep-chips">
          {selected.map((name) => (
            <PickerTag
              key={name}
              value={name}
              label={name}
              removeLabel={`Stop dropping ${name}`}
              onRemove={() => removeTool(name)}
            />
          ))}
        </div>
      )}
      <div class="toolbar-settings-keep-picker-wrap">
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
      </div>
    </div>
  );
}

interface SubagentSettingsProps {
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  availableModels: ModelInfo[];
  modelEntries: ReturnType<typeof orderModelsForPicker>;
}

/**
 * Inline subagent settings, rendered inside the Extensions tab when the
 * subagent extension row is expanded. Holds the always-parent-model toggle, the
 * user-configurable model buckets, the nested-bucket allowlist, and the
 * nesting/throughput limits. Reuses the same inline-settings container styling
 * as the skill-pruner expansion.
 */
export function SubagentSection({ prefs, onSetPrefs, availableModels, modelEntries }: SubagentSettingsProps) {
  return (
    <div class="toolbar-settings-ext-settings">
      <button
        class={`toolbar-settings-item${prefs.subagentAlwaysParentModel ? ' checked' : ''}`}
        type="button"
        role="checkbox"
        aria-checked={prefs.subagentAlwaysParentModel}
        onClick={() => onSetPrefs(toggleChatPref(prefs, 'subagentAlwaysParentModel'))}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={prefs.subagentAlwaysParentModel ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">Always use parent model</span>
      </button>

      <UiGroupLabel label="Dropped tools" />
      <DropToolsEditor
        selected={prefs.subagentDropTools ?? []}
        onChange={(tools) => onSetPrefs(setSubagentDropTools(prefs, tools))}
      />

      <UiGroupLabel label="Model buckets" />
      <div class="toolbar-settings-item-hint">
        Each bucket holds model ids you want eligible for that tier. When a subagent requests a bucket, one model is picked at random from its list. Empty buckets fall back to the parent's active model.
      </div>
      {BUCKET_DEFS.map((def) => (
        <BucketModelsEditor
          key={def.key}
          label={def.label}
          hint={def.hint}
          selected={prefs.subagentBuckets[def.key] ?? []}
          availableModels={availableModels}
          modelEntries={modelEntries}
          onChange={(models) => onSetPrefs(setBucketModels(prefs, def.key, models))}
        />
      ))}

      <UiGroupLabel label="Nested bucket allowlist" />
      <div class="toolbar-settings-item-hint">
        Which model tiers nested sub-agents (depth ≥ 1) may use. A requested tier that isn't allowed is downgraded to the highest allowed tier at or below it — e.g. disallow Frontier and an Opus request runs on Sonnet (or Haiku if only that's allowed). The root agent is never restricted.
      </div>
      {NESTED_TOGGLE_DEFS.map((def) => {
        const enabled = prefs.subagentNestedAllowedBuckets[def.key] ?? true;
        return (
          <button
            key={def.key}
            class={`toolbar-settings-item${enabled ? ' checked' : ''}`}
            type="button"
            role="checkbox"
            aria-checked={enabled}
            onClick={() => onSetPrefs(setNestedAllowedBucket(prefs, def.key, !enabled))}
          >
            <span class="toolbar-settings-item-check" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={enabled ? '' : 'opacity:0'}>
                <polyline points="2.5,6.5 5,9 10.5,3.5" />
              </svg>
            </span>
            <span class="toolbar-settings-item-label">Allow {def.label}</span>
          </button>
        );
      })}

      <UiGroupLabel label="Preview" />
      <div class="toolbar-settings-ui-control">
        <div class="toolbar-settings-ui-control-head">
          <span class="toolbar-settings-ui-control-label">Collapsed preview rows</span>
          <span class="toolbar-settings-ui-control-value">{prefs.subagentPreviewLines}</span>
        </div>
        <input
          type="range"
          class="toolbar-settings-slider toolbar-settings-ui-slider"
          min="1"
          max="12"
          step="1"
          value={prefs.subagentPreviewLines}
          onInput={(e) => onSetPrefs({ subagentPreviewLines: Number((e.target as HTMLInputElement).value) })}
          aria-label="Collapsed subagent preview rows"
        />
        <div class="toolbar-settings-item-hint">Rows reserved for live streaming output on collapsed subagent cards. When the child has no visible stream yet, the rows show pending….</div>
      </div>

      <UiGroupLabel label="Nesting" />
      <div class="toolbar-settings-ui-control">
        <div class="toolbar-settings-ui-control-head">
          <span class="toolbar-settings-ui-control-label">Nesting levels</span>
          <span class="toolbar-settings-ui-control-value">{prefs.subagentMaxDepth === 0 ? 'Off' : prefs.subagentMaxDepth}</span>
        </div>
        <input
          type="range"
          class="toolbar-settings-slider toolbar-settings-ui-slider"
          min="0"
          max="8"
          step="1"
          value={prefs.subagentMaxDepth}
          onInput={(e) => onSetPrefs({ subagentMaxDepth: Number((e.target as HTMLInputElement).value) })}
          aria-label="Subagent nesting levels"
        />
        <div class="toolbar-settings-item-hint">How many levels subagents may delegate to further subagents (main → L1 → L2 → ...). 0 turns subagents off entirely. Higher values allow more nesting at higher cost.</div>
      </div>
      <div class="toolbar-settings-ui-control">
        <div class="toolbar-settings-ui-control-head">
          <span class="toolbar-settings-ui-control-label">Tree session budget</span>
          <span class="toolbar-settings-ui-control-value">{prefs.subagentMaxTreeSessions}</span>
        </div>
        <input
          type="range"
          class="toolbar-settings-slider toolbar-settings-ui-slider"
          min="5"
          max="200"
          step="5"
          value={prefs.subagentMaxTreeSessions}
          onInput={(e) => onSetPrefs({ subagentMaxTreeSessions: Number((e.target as HTMLInputElement).value) })}
          aria-label="Max subagent sessions across the nested tree"
        />
        <div class="toolbar-settings-item-hint">Cap on total subagent sessions spawned across an entire nested tree, so increased nesting can't run away on cost.</div>
      </div>

      <UiGroupLabel label="Throughput" />
      <div class="toolbar-settings-item-hint">
        These caps throttle subagent fan-out to protect providers from bursts. Lower values reduce concurrency; 0 is not allowed.
      </div>
      <div class="toolbar-settings-ui-control">
        <div class="toolbar-settings-ui-control-head">
          <span class="toolbar-settings-ui-control-label">Max active trees</span>
          <span class="toolbar-settings-ui-control-value">{prefs.subagentMaxInflight}</span>
        </div>
        <input
          type="range"
          class="toolbar-settings-slider toolbar-settings-ui-slider"
          min="1"
          max="16"
          step="1"
          value={prefs.subagentMaxInflight}
          onInput={(e) => onSetPrefs({ subagentMaxInflight: Number((e.target as HTMLInputElement).value) })}
          aria-label="Max concurrent root subagent trees"
        />
        <div class="toolbar-settings-item-hint">Global cap on independent root subagent trees across all sessions. Nested descendants borrow their root's permit, so this throttle cannot deadlock recursive delegation.</div>
      </div>
      <div class="toolbar-settings-ui-control">
        <div class="toolbar-settings-ui-control-head">
          <span class="toolbar-settings-ui-control-label">Max concurrency</span>
          <span class="toolbar-settings-ui-control-value">{prefs.subagentMaxConcurrency}</span>
        </div>
        <input
          type="range"
          class="toolbar-settings-slider toolbar-settings-ui-slider"
          min="1"
          max="16"
          step="1"
          value={prefs.subagentMaxConcurrency}
          onInput={(e) => onSetPrefs({ subagentMaxConcurrency: Number((e.target as HTMLInputElement).value) })}
          aria-label="Max concurrency within one parallel subagent call"
        />
        <div class="toolbar-settings-item-hint">How many tasks inside one parallel subagent call may run at the same time.</div>
      </div>
      <div class="toolbar-settings-ui-control">
        <div class="toolbar-settings-ui-control-head">
          <span class="toolbar-settings-ui-control-label">Max parallel tasks</span>
          <span class="toolbar-settings-ui-control-value">{prefs.subagentMaxParallelTasks}</span>
        </div>
        <input
          type="range"
          class="toolbar-settings-slider toolbar-settings-ui-slider"
          min="1"
          max="16"
          step="1"
          value={prefs.subagentMaxParallelTasks}
          onInput={(e) => onSetPrefs({ subagentMaxParallelTasks: Number((e.target as HTMLInputElement).value) })}
          aria-label="Max parallel tasks per subagent call"
        />
        <div class="toolbar-settings-item-hint">Maximum number of tasks allowed in a single parallel subagent call.</div>
      </div>
    </div>
  );
}
