/** @jsxRuntime automatic */
/** @jsxImportSource preact */

interface PickerTagProps {
  /** Stable identifier used as the React key by callers. */
  value: string;
  /** Visible chip text. */
  label: string;
  /** Accessible label for the remove button. */
  removeLabel: string;
  /** Called when the user clicks the remove button. */
  onRemove: () => void;
}

/** A removable chip rendered inside a keep-picker chip list. */
export function PickerTag({ label, removeLabel, onRemove }: PickerTagProps) {
  return (
    <span class="toolbar-settings-keep-chip">
      <span>{label}</span>
      <button
        type="button"
        class="toolbar-settings-keep-chip-remove"
        aria-label={removeLabel}
        onClick={onRemove}
      >
        <svg width="12" height="12" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="3" y1="3" x2="10" y2="10" />
          <line x1="10" y1="3" x2="3" y2="10" />
        </svg>
      </button>
    </span>
  );
}
