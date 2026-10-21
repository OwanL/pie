/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useMemo } from 'preact/hooks';
import { ChipEditor } from './chip-editor';
import { useIntendedSelection } from './optimistic-selection';

/**
 * Filter a keep catalog by hiding already-selected names.
 *
 * Co-located with {@link AlwaysKeepPicker} (its only consumer) so the picker is
 * self-contained in `components/` — no `components/ -> composer/` back-dependency
 * on `settings-menu-helpers`. Previously lived in `composer/settings-menu-helpers.ts`.
 */
export function filterKeepCatalog(catalog: string[], selected: string[]): string[] {
  const selectedSet = new Set(selected);
  return catalog.filter((name) => !selectedSet.has(name));
}

interface AlwaysKeepPickerProps {
  label: string;
  selected: string[];
  catalog: string[];
  category: 'skill' | 'tool';
  onChange: (next: string[]) => void;
}

/** Chip picker backed by a fixed catalog (the never-pruned skills/tools in the
 *  skill-pruner settings). Adds happen through an enum <select> offering every
 *  not-yet-selected name, so users can't introduce unknown names. Built on the
 *  shared {@link ChipEditor} foundation; the catalog select is the add slot.
 *  Duplicate selection is guarded both by that filtering (the option
 *  disappears from the catalog immediately) and by an optimistic intent check
 *  before editing (see {@link useIntendedSelection}). */
export function AlwaysKeepPicker({ label, selected, catalog, category, onChange }: AlwaysKeepPickerProps) {
  // Optimistic intended selection. `selected` only updates after the host
  // round-trip, so edits must accumulate from the local intent instead: a
  // rapid add → add → remove burst computed against the stale host prop would
  // drop every earlier intent. The chip list and addable catalog reflect the
  // intent while delayed echoes converge; an echo matching no local edit is
  // authoritative host truth (external change or rejected commit) and
  // projects it.
  const selection = useIntendedSelection(selected, onChange);
  const display = selection.value;
  const availableOptions = useMemo(() => filterKeepCatalog(catalog, display), [catalog, display]);

  const addName = (rawName: string) => {
    const name = rawName.trim();
    if (!name || display.includes(name)) return;
    selection.update([...display, name]);
  };

  const removeName = (name: string) => {
    selection.update(display.filter((n) => n !== name));
  };

  const addControl = (
    <select
      class="toolbar-settings-select toolbar-settings-keep-select"
      value=""
      aria-label={label}
      disabled={availableOptions.length === 0}
      onChange={(e) => {
        const name = (e.target as HTMLSelectElement).value;
        if (name) {
          addName(name);
          (e.target as HTMLSelectElement).value = '';
        }
      }}
    >
      <option value="">
        {availableOptions.length === 0
          ? `No ${category}s available`
          : `Select ${category} to omit from pruning...`}
      </option>
      {availableOptions.map((name) => (
        <option key={name} value={name}>{name}</option>
      ))}
    </select>
  );

  return (
    <ChipEditor
      label={label}
      selected={display}
      onRemove={removeName}
      addControl={addControl}
    />
  );
}