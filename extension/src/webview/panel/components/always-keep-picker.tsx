/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useMemo, useState } from 'preact/hooks';
import { PickerTag } from './PickerTag';

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

export function AlwaysKeepPicker({ label, selected, catalog, category, onChange }: AlwaysKeepPickerProps) {
  const availableOptions = useMemo(() => filterKeepCatalog(catalog, selected), [catalog, selected]);

  // Optimistic names just added but not yet reflected in the host-persisted
  // `selected` prop. `selected` only updates after a host round-trip, so
  // without this gate the user can re-select an item (the <select> resets to
  // "" while availableOptions still lists it) before the host state arrives,
  // firing a duplicate setPruningSettings.
  const [pending, setPending] = useState<string[]>([]);

  // Release optimistic entries once the host-persisted `selected` catches up.
  useEffect(() => {
    if (pending.length === 0) return;
    const remaining = pending.filter((name) => !selected.includes(name));
    if (remaining.length !== pending.length) {
      setPending(remaining);
    }
  }, [selected, pending]);

  const addName = (rawName: string) => {
    const name = rawName.trim();
    if (!name) return;
    if (selected.includes(name) || pending.includes(name)) return;
    setPending((current) => [...current, name]);
    onChange([...selected, name]);
    // Safety net: if the host round-trip never arrives, release the lock so
    // the item becomes selectable again.
    window.setTimeout(() => {
      setPending((current) => current.filter((entry) => entry !== name));
    }, 2000);
  };

  const removeName = (name: string) => {
    onChange(selected.filter((n) => n !== name));
  };

  return (
    <div class="toolbar-settings-keep-picker">
      <div class="toolbar-settings-keep-picker-label">{label}</div>
      {selected.length > 0 && (
        <div class="toolbar-settings-keep-chips">
          {selected.map((name) => (
            <PickerTag
              key={name}
              value={name}
              label={name}
              removeLabel={`Remove ${name}`}
              onRemove={() => removeName(name)}
            />
          ))}
        </div>
      )}
      <div class="toolbar-settings-keep-picker-wrap">
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
      </div>
    </div>
  );
}
