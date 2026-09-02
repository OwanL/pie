/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';
import { PickerTag } from './PickerTag';

export interface ChipEditorProps {
  label: string;
  hint?: ComponentChildren;
  selected: readonly string[];
  /** Called with the chip name when its remove button is clicked. */
  onRemove: (name: string) => void;
  /** Visible chip text (defaults to the name). */
  chipLabel?: (name: string) => string;
  /** Accessible remove-button label (defaults to `Remove ${name}`). */
  removeLabel?: (name: string) => string;
  /** Add-control slot rendered inside `.toolbar-settings-keep-picker-wrap` —
   *  a catalog select, a free-text input, or any other affordance. */
  addControl?: ComponentChildren;
}

/** Shared foundation for the keep-picker chip editors: the
 *  `.toolbar-settings-keep-picker` wrapper, a label, an optional hint, the
 *  removable PickerTag chip list for `selected` names, and a caller-provided
 *  add control. Callers own the add flow (catalog filtering, duplicate
 *  guards, draft input state) via the `addControl` slot. */
export function ChipEditor({
  label,
  hint,
  selected,
  onRemove,
  chipLabel,
  removeLabel,
  addControl,
}: ChipEditorProps) {
  return (
    <div class="toolbar-settings-keep-picker">
      <div class="toolbar-settings-keep-picker-label">{label}</div>
      {hint && <div class="toolbar-settings-item-hint">{hint}</div>}
      {selected.length > 0 && (
        <div class="toolbar-settings-keep-chips">
          {selected.map((name) => (
            <PickerTag
              key={name}
              value={name}
              label={chipLabel ? chipLabel(name) : name}
              removeLabel={removeLabel ? removeLabel(name) : `Remove ${name}`}
              onRemove={() => onRemove(name)}
            />
          ))}
        </div>
      )}
      {addControl && (
        <div class="toolbar-settings-keep-picker-wrap">{addControl}</div>
      )}
    </div>
  );
}