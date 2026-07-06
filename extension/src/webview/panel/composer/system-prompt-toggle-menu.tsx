/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import type { SystemPromptEntry } from '../../../shared/protocol';
import { CollapsibleChevron } from '../components/chevron';
import { cx } from '../utils/cx';

interface SystemPromptToggleMenuProps {
  /** Full system-prompt entry list for the active session (each carries an
   *  `id` and a `disabled` flag). The backend is the source of truth — the
   *  webview renders this list verbatim and sends toggle changes back via
   *  `onSetToggles`. */
  prompts: SystemPromptEntry[];
  /** Apply the complete disabled-entry set (entry ids toggled OFF). An empty
   *  array re-enables everything. */
  onSetToggles: (disabledEntries: string[]) => void;
}

/** A toolbar menu for toggling individual system-prompt entries on/off.
 *
 *  Placed immediately to the right of the model / reasoning pickers. Each entry
 *  is a checkbox row: checked = enabled (sent to the model + shown in the
 *  transcript), unchecked = disabled (stripped from the prompt + hidden). The
 *  backend owns the toggle state and re-emits `session.opened` to update this
 *  list, so the component is fully controlled by `prompts`. */
export function SystemPromptToggleMenu({ prompts, onSetToggles }: SystemPromptToggleMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Only entries with a stable `id` that are `toggleable` appear as checkboxes.
  // Display-only entries (`toggleable === false`, e.g. the provider card) are
  // excluded: pi cannot strip them from the sent prompt, so a toggle would be
  // misleading. Legacy/mock entries without an `id` are always-on and hidden.
  const entries = useMemo(
    () => prompts.filter((p) => p.id && p.toggleable !== false),
    [prompts],
  );
  const disabledIds = useMemo(
    () => new Set(entries.filter((p) => p.disabled).map((p) => p.id!)),
    [entries],
  );
  const disabledCount = disabledIds.size;

  // Hide the trigger entirely when there is nothing to toggle (e.g. a
  // not-yet-resolved session with only the provider card).
  if (entries.length === 0) return null;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideMenu = menuRef.current?.contains(target);
      const insideTrigger = triggerRef.current?.contains(target);
      if (!insideMenu && !insideTrigger) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const toggle = (entry: SystemPromptEntry) => {
    const id = entry.id;
    if (!id) return;
    const next = new Set(disabledIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSetToggles([...next]);
  };

  const onTriggerKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div class="system-prompt-toggle-menu">
      <button
        ref={triggerRef}
        type="button"
        class={cx('system-prompt-toggle-trigger', open && 'open', disabledCount > 0 && 'has-disabled')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Toggle system prompts"
        title="Toggle system prompts on/off"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2" y="3" width="12" height="3.5" rx="1" />
          <rect x="2" y="9.5" width="12" height="3.5" rx="1" />
          <circle cx="5.5" cy="4.75" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="10" cy="11.25" r="1.1" fill="currentColor" stroke="none" />
        </svg>
        {disabledCount > 0 && (
          <span class="system-prompt-toggle-badge" aria-label={`${disabledCount} disabled`}>{disabledCount}</span>
        )}
        <CollapsibleChevron open={open} size={10} class="system-prompt-toggle-caret" />
      </button>

      {open && (
        <div ref={menuRef} class="system-prompt-toggle-dropdown" role="dialog" aria-label="System prompt toggles">
          <div class="system-prompt-toggle-header">
            <span class="toolbar-settings-title">System prompts</span>
            {disabledCount > 0 && (
              <button
                type="button"
                class="system-prompt-toggle-reset"
                onClick={() => onSetToggles([])}
                title="Re-enable all system prompts"
              >
                Reset
              </button>
            )}
          </div>
          <div class="system-prompt-toggle-body">
            {entries.map((entry) => {
              const enabled = !entry.disabled;
              return (
                <button
                  key={entry.id}
                  type="button"
                  class={cx('toolbar-settings-item', enabled && 'checked')}
                  role="checkbox"
                  aria-checked={enabled}
                  title={entry.tooltip ?? entry.title}
                  onClick={() => toggle(entry)}
                >
                  <span class="toolbar-settings-item-check" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={enabled ? '' : 'opacity:0'}>
                      <polyline points="2.5,6.5 5,9 10.5,3.5" />
                    </svg>
                  </span>
                  <span class="toolbar-settings-item-label">
                    <span class="system-prompt-toggle-entry-title">{entry.title}</span>
                    {entry.summary && (
                      <span class="system-prompt-toggle-entry-summary">{entry.summary}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
