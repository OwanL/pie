/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import type { SystemPromptEntry } from '../../../shared/protocol';
import { useAnchoredOverlay } from '../components/anchored-overlay';
import { Tooltip } from '../components/tooltip';
import { cx } from '../utils/cx';

interface SystemPromptToggleMenuProps {
  /** Full system-prompt entry list for the active session (each carries an
   *  `id` and a `disabled` flag). The backend is the source of truth — the
   *  webview renders this list and sends toggle changes back via
   *  `onSetToggles`, applying them optimistically until the backend's
   *  re-emitted `session.opened` confirms them. */
  prompts: SystemPromptEntry[];
  /** Apply the complete disabled-entry set (entry ids toggled OFF). An empty
   *  array re-enables everything. */
  onSetToggles: (disabledEntries: string[]) => void;
}

/** A toggleable entry narrowed so its `id` is a required string. */
type ToggleableEntry = SystemPromptEntry & { id: string };

/** A toolbar menu for toggling individual system-prompt entries on/off.
 *
 *  Placed immediately to the right of the model / reasoning pickers. Each entry
 *  is a checkbox row: checked = enabled (sent to the model + shown in the
 *  transcript), unchecked = disabled (stripped from the prompt + hidden).
 *
 *  The backend owns the toggle set and re-emits `session.opened` to update
 *  this list — but that round-trip is asynchronous. To stay robust under rapid
 *  interaction (the previous version computed each toggle's "next" set from a
 *  not-yet-updated `prompts` and silently dropped the prior toggle, and the
 *  checkbox lagged a full round-trip behind the click), the component keeps a
 *  local `pending` overlay of per-entry intents:
 *    - the *effective* disabled set is the remote set (`prompts`) with pending
 *      overrides applied on top;
 *    - `toggle`/`reset` update `pending` optimistically AND post the full
 *      effective set, so successive clicks accumulate locally instead of
 *      racing the stale prop;
 *    - a reconcile effect acks pending intents the backend has confirmed (or
 *      prunes ones whose entry vanished), so the overlay never masks later
 *      backend-driven changes or grows without bound. */
export function SystemPromptToggleMenu({ prompts, onSetToggles }: SystemPromptToggleMenuProps) {
  const [open, setOpen] = useState(false);
  /** Local per-entry intent overlay, keyed by entry id: `true` = disabled,
   *  `false` = enabled. Cleared as the backend confirms each intent. */
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useAnchoredOverlay({
    open,
    triggerRef,
    overlayRef: menuRef,
    preferredDirection: 'up',
    preferredWidth: 320,
    minHeight: 120,
    maxHeight: 380,
  });

  // Only entries with a stable `id` that are `toggleable` appear as checkboxes.
  // Display-only entries (`toggleable === false`, e.g. the provider card) are
  // excluded: pi cannot strip them from the sent prompt, so a toggle would be
  // misleading. Legacy/mock entries without an `id` are always-on and hidden.
  const entries = useMemo(
    () => prompts.filter(
      (p): p is ToggleableEntry => !!p.id && p.toggleable !== false,
    ),
    [prompts],
  );

  // The backend-controlled disabled set (the truth that survives a reopen).
  const remoteDisabledIds = useMemo(
    () => new Set(entries.filter((e) => e.disabled).map((e) => e.id)),
    [entries],
  );

  // Effective disabled set = remote truth overlaid with local pending intents.
  // Pending overrides let a click take effect instantly (checkbox + badge) and
  // lets rapid successive toggles accumulate against the effective set instead
  // of a stale remote prop — which previously caused lost updates.
  const disabledIds = useMemo(() => {
    const set = new Set<string>(remoteDisabledIds);
    for (const [id, intent] of Object.entries(pending)) {
      if (intent) set.add(id);
      else set.delete(id);
    }
    return set;
  }, [remoteDisabledIds, pending]);

  // Reconcile pending intents against incoming remote state: ack entries the
  // backend has confirmed (remote state matches intent) and prune entries that
  // no longer exist (e.g. a context file removed from the project). Keeping
  // `pending` tight prevents it from masking later backend-driven changes or
  // growing without bound. The effect fires only when remote state changes
  // (the sole condition under which an ack can occur), so a local `toggle`
  // does not trigger an extra reconcile pass; the functional `setPending` reads
  // fresh state and the `prev`-guard avoids re-render loops when nothing
  // reconciles.
  useEffect(() => {
    if (Object.keys(pending).length === 0) return;
    setPending((prev) => {
      const present = new Set(entries.map((e) => e.id));
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, intent] of Object.entries(prev)) {
        // Drop entries whose id has vanished, or whose intent the backend now
        // confirms — both free the overlay to track fresh remote state.
        if (!present.has(id) || remoteDisabledIds.has(id) === intent) {
          changed = true;
          continue;
        }
        next[id] = intent;
      }
      return changed ? next : prev;
    });
  }, [entries, remoteDisabledIds]);

  // Outside-click + Escape handling, wired only while the dropdown is open.
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

  const disabledCount = disabledIds.size;

  // Hide the trigger entirely when there is nothing to toggle (e.g. a
  // not-yet-resolved session with only the provider card). Declared after every
  // hook so the hook count is stable across the 0 ⇄ N transition.
  if (entries.length === 0) return null;

  const toggle = (entry: ToggleableEntry) => {
    const willDisable = !disabledIds.has(entry.id);
    // Build the next full set from the *effective* (pending-aware) set so a
    // rapid second toggle carries the first along instead of clobbering it.
    const next = new Set(disabledIds);
    if (willDisable) next.add(entry.id);
    else next.delete(entry.id);
    setPending((prev) => ({ ...prev, [entry.id]: willDisable }));
    onSetToggles([...next]);
  };

  const resetAll = () => {
    if (disabledCount === 0) return;
    // Mark every currently-effective disabled entry as pending-enabled so the
    // UI clears instantly; the backend's empty-set re-emit later confirms it.
    setPending((prev) => {
      const next = { ...prev };
      for (const id of disabledIds) next[id] = false;
      return next;
    });
    onSetToggles([]);
  };

  const onTriggerKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div class="system-prompt-toggle-menu">
      <Tooltip content={open ? null : 'Toggle system prompts on/off'} placement="top">
        <button
          ref={triggerRef}
          type="button"
          class={cx('system-prompt-toggle-trigger', open && 'open', disabledCount > 0 && 'has-disabled')}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Toggle system prompts"
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
        </button>
      </Tooltip>

      {open && (
        <div ref={menuRef} class="system-prompt-toggle-dropdown" role="dialog" aria-label="System prompt toggles">
          <div class="system-prompt-toggle-header">
            <span class="system-prompt-toggle-title">System prompts</span>
            {disabledCount > 0 && (
              <button
                type="button"
                class="system-prompt-toggle-reset"
                onClick={resetAll}
                title="Re-enable all system prompts"
              >
                Reset
              </button>
            )}
          </div>
          <div class="system-prompt-toggle-body">
            {entries.map((entry) => {
              // Reflect the effective (pending-aware) state so the checkbox
              // responds to the click immediately, before the round-trip.
              const enabled = !disabledIds.has(entry.id);
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
