/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { JSX } from 'preact';
import type { ModelPickerEntry } from '../composer/model-list';
import { CollapsibleChevron } from './chevron';
import { Tooltip } from './tooltip';

interface ModelPickerProps {
  /** Current selected model spec: either `id` or `provider/id` (when the caller can disambiguate duplicates). */
  value: string;
  /** Label shown on the closed trigger. */
  label: string;
  /** Accessible label for the control. */
  ariaLabel: string;
  /** Tooltip / title for the trigger. */
  title: string;
  /** Picker entries to display. */
  entries: ModelPickerEntry[];
  /** Called when the user selects a model; receives `provider/id` so callers can route unambiguously even when the same id exists under multiple providers. */
  onChange: (modelSpec: string) => void;
  /** Optional compact width for use inside settings rows. */
  compact?: boolean;
  /** Which direction the dropdown opens. Default 'up'. */
  dropdownDirection?: 'up' | 'down';
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function getTriggerClass(compact?: boolean): string {
  return compact
    ? 'model-picker-trigger model-picker-trigger-compact'
    : 'model-picker-trigger';
}

function getWrapperClass(compact?: boolean): string {
  return ['model-picker', compact && 'model-picker-compact'].filter(Boolean).join(' ');
}

function getDropdownClass(direction: 'up' | 'down', compact?: boolean): string {
  return [
    'model-picker-dropdown',
    direction === 'down' && 'model-picker-dropdown-down',
    compact && 'model-picker-dropdown-compact',
  ].filter(Boolean).join(' ');
}

function getRowClass(isSelected: boolean, isActive: boolean, ineligible?: boolean): string {
  return [
    'model-picker-row',
    isSelected && 'model-picker-row-selected',
    isActive && 'model-picker-row-active',
    ineligible && 'model-picker-row-ineligible',
  ].filter(Boolean).join(' ');
}

type ListKeyAction = 'next' | 'prev' | 'first' | 'last' | 'select' | 'close';

function resolveListKeyAction(key: string): ListKeyAction | null {
  switch (key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'prev';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case 'Enter':
      return 'select';
    case 'Tab':
      return 'close';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Sub-hooks
// ---------------------------------------------------------------------------

function useFocusOnOpen(
  open: boolean,
  selectedIndex: number,
  setActiveIndex: (index: number) => void,
  inputRef: { current: HTMLInputElement | null },
  setQuery: (value: string) => void,
) {
  useEffect(() => {
    if (!open) return;
    // Start each open with a fresh filter and the current selection highlighted,
    // so Enter on an untouched dropdown re-selects the active model (no-op).
    setQuery('');
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [open]);
}

function useClickOutside(
  open: boolean,
  setOpen: (value: boolean) => void,
  triggerRef: { current: HTMLButtonElement | null },
  listRef: { current: HTMLDivElement | null },
) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const target = e.target as Node;
      const outside =
        listRef.current &&
        !listRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target);
      if (outside) {
        setOpen(false);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
}

function useDropdownPosition(
  open: boolean,
  dropdownDirection: 'up' | 'down',
  listRef: { current: HTMLDivElement | null },
  triggerRef: { current: HTMLButtonElement | null },
) {
  useLayoutEffect(() => {
    if (!open) return;
    const dropdown = listRef.current;
    const trigger = triggerRef.current;
    if (!dropdown || !trigger) return;

    const gap = 4; // matches the previous calc(100% + 4px) offset
    const margin = 8; // viewport edge padding

    const position = () => {
      const rect = trigger.getBoundingClientRect();
      // Horizontal: align the dropdown's left edge to the trigger, then clamp
      // inward so a wide list never overflows the viewport's right edge (the
      // common case inside the narrow settings menu).
      let left = rect.left;
      const maxLeft = window.innerWidth - dropdown.offsetWidth - margin;
      if (left > maxLeft) left = Math.max(margin, maxLeft);
      dropdown.style.left = `${left}px`;

      if (dropdownDirection === 'down') {
        const top = rect.bottom + gap;
        dropdown.style.top = `${top}px`;
        dropdown.style.bottom = '';
        // Cap height to the space below the trigger so the list scrolls
        // instead of running off the viewport bottom.
        const available = window.innerHeight - top - margin;
        dropdown.style.maxHeight = `${Math.min(420, Math.max(120, available))}px`;
      } else {
        // Up: anchor the dropdown's bottom edge `gap` above the trigger.
        dropdown.style.bottom = `${window.innerHeight - rect.top + gap}px`;
        dropdown.style.top = '';
        // No inline maxHeight for 'up' — the CSS max-height: 420px cap wins,
        // matching prior behavior (the trigger sits low in the panel, so there
        // is ordinarily ample room above it).
      }
    };

    position();
    // Re-measure once the entrance animation settles, in case async content
    // (font loads, row hydration) changed the dropdown's width after layout.
    const t = window.setTimeout(position, 320);
    // The portal no longer tracks the trigger automatically, so follow the
    // viewport on resize and any ancestor scroll (capture phase catches
    // scrolls in nested scroll containers like the settings menu body).
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, dropdownDirection]);
}

function useScrollActiveItem(
  open: boolean,
  activeIndex: number,
  itemRefs: { current: (HTMLDivElement | null)[] },
) {
  useEffect(() => {
    if (!open) return;
    if (activeIndex < 0) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);
}

function useHandleSelect(
  onChange: (modelId: string) => void,
  setOpen: (value: boolean) => void,
  triggerRef: { current: HTMLButtonElement | null },
) {
  return useCallback(
    (modelId: string) => {
      onChange(modelId);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange],
  );
}

function useTriggerKeyDown(setOpen: (value: boolean) => void) {
  return useCallback(
    (e: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
    },
    [],
  );
}

function useListKeyDown(
  entries: ModelPickerEntry[],
  activeIndex: number,
  handleSelect: (modelId: string) => void,
  setOpen: (value: boolean) => void,
  setActiveIndex: (updater: (prev: number) => number) => void,
) {
  return useCallback(
    (e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
      if (entries.length === 0) return;
      const action = resolveListKeyAction(e.key);
      if (!action) return;
      if (action === 'close') {
        setOpen(false);
        return;
      }
      e.preventDefault();
      switch (action) {
        case 'next':
          setActiveIndex((i) => Math.min(entries.length - 1, i + 1));
          break;
        case 'prev':
          setActiveIndex((i) => Math.max(0, i - 1));
          break;
        case 'first':
          setActiveIndex(() => 0);
          break;
        case 'last':
          setActiveIndex(() => entries.length - 1);
          break;
        case 'select': {
          const entry = entries[activeIndex];
          if (entry) handleSelect(`${entry.model.provider}/${entry.model.id}`);
          break;
        }
      }
    },
    [entries, activeIndex, handleSelect],
  );
}

function useModelPicker({
  value,
  entries,
  onChange,
  dropdownDirection,
}: {
  value: string;
  entries: ModelPickerEntry[];
  onChange: (modelId: string) => void;
  dropdownDirection: 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const idBase = useId();
  const listId = `${idBase}-list`;
  // Match the selected row by `provider/id` when `value` carries a provider
  // prefix (lets callers disambiguate duplicate ids across providers), falling
  // back to a bare-id match.
  const selectedIndex = entries.findIndex(
    (e) => `${e.model.provider}/${e.model.id}` === value || e.model.id === value,
  );

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      `${e.label} ${e.model.id} ${e.model.provider}`.toLowerCase().includes(q),
    );
  }, [entries, query]);

  useFocusOnOpen(open, selectedIndex, setActiveIndex, inputRef, setQuery);
  useClickOutside(open, setOpen, triggerRef, listRef);
  useDropdownPosition(open, dropdownDirection, listRef, triggerRef);
  useScrollActiveItem(open, activeIndex, itemRefs);

  // Keep activeIndex within the filtered list if the underlying entries change
  // while the dropdown is open (e.g. a provider toggle). Never reduces a valid
  // index, so it can't clobber the selectedIndex set on open.
  useEffect(() => {
    if (activeIndex >= 0 && activeIndex >= filteredEntries.length) {
      setActiveIndex(Math.max(0, filteredEntries.length - 1));
    }
  }, [filteredEntries.length]);

  const handleSelect = useHandleSelect(onChange, setOpen, triggerRef);
  const onTriggerKeyDown = useTriggerKeyDown(setOpen);
  const onListKeyDown = useListKeyDown(filteredEntries, activeIndex, handleSelect, setOpen, setActiveIndex);
  const onSearchInput = useCallback((e: JSX.TargetedEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
    setActiveIndex(0);
  }, []);

  const activeDescendant =
    activeIndex >= 0 ? `${idBase}-option-${filteredEntries[activeIndex]?.model.provider}-${filteredEntries[activeIndex]?.model.id}` : undefined;

  return {
    open,
    setOpen,
    activeIndex,
    setActiveIndex,
    triggerRef,
    listRef,
    inputRef,
    itemRefs,
    idBase,
    listId,
    selectedIndex,
    handleSelect,
    onTriggerKeyDown,
    onListKeyDown,
    onSearchInput,
    query,
    filteredEntries,
    activeDescendant,
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ModelPickerTriggerProps {
  triggerRef: { current: HTMLButtonElement | null };
  className: string;
  ariaLabel: string;
  title: string;
  label: string;
  open: boolean;
  onClick: () => void;
  onKeyDown: (e: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => void;
}

function ModelPickerTrigger({
  triggerRef,
  className,
  ariaLabel,
  title,
  label,
  open,
  onClick,
  onKeyDown,
}: ModelPickerTriggerProps) {
  // Wrap the trigger in the custom Tooltip (placement 'top') so its tooltip
  // opens upward like the rest of the model-picker row. Suppress the tooltip
  // content while the dropdown is open so it doesn't collide with the
  // (upward-opening) dropdown list.
  return (
    <Tooltip content={open ? null : title} placement="top">
      <button
        ref={triggerRef}
        type="button"
        class={className}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <span class="model-picker-trigger-label">{label}</span>
        <CollapsibleChevron open={open} />
      </button>
    </Tooltip>
  );
}

interface ModelPickerRowProps {
  entry: ModelPickerEntry;
  isSelected: boolean;
  isActive: boolean;
  optionId: string;
  setItemRef: (el: HTMLDivElement | null) => void;
  onMouseEnter: () => void;
  onMouseDown: (e: JSX.TargetedMouseEvent<HTMLDivElement>) => void;
}

function ModelPickerRow({
  entry,
  isSelected,
  isActive,
  optionId,
  setItemRef,
  onMouseEnter,
  onMouseDown,
}: ModelPickerRowProps) {
  return (
    <div
      key={`${entry.model.provider}/${entry.model.id}`}
      id={optionId}
      ref={setItemRef}
      class={getRowClass(isSelected, isActive, entry.ineligible)}
      role="option"
      aria-selected={isSelected}
      title={entry.title}
      onMouseEnter={onMouseEnter}
      onMouseDown={onMouseDown}
    >
      <span class="model-picker-col model-picker-col-name">
        {entry.label}
      </span>
      <span class="model-picker-col model-picker-col-price">
        {entry.tokenInPrice || '—'}
      </span>
      <span class="model-picker-col model-picker-col-price">
        {entry.tokenOutPrice || '—'}
      </span>
      <span class="model-picker-col model-picker-col-images">
        {entry.supportsImages ? '✓' : '—'}
      </span>
    </div>
  );
}

interface ModelPickerDropdownProps {
  listRef: { current: HTMLDivElement | null };
  listId: string;
  dropdownDirection: 'up' | 'down';
  compact?: boolean;
  ariaLabel: string;
  activeDescendant: string | undefined;
  onKeyDown: (e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => void;
  entries: ModelPickerEntry[];
  value: string;
  activeIndex: number;
  idBase: string;
  handleSelect: (modelId: string) => void;
  setActiveIndex: (index: number) => void;
  itemRefs: { current: (HTMLDivElement | null)[] };
  query: string;
  onSearchInput: (e: JSX.TargetedEvent<HTMLInputElement>) => void;
  inputRef: { current: HTMLInputElement | null };
}

function ModelPickerDropdown({
  listRef,
  listId,
  dropdownDirection,
  compact,
  ariaLabel,
  activeDescendant,
  onKeyDown,
  entries,
  value,
  activeIndex,
  idBase,
  handleSelect,
  setActiveIndex,
  itemRefs,
  query,
  onSearchInput,
  inputRef,
}: ModelPickerDropdownProps) {
  return (
    <div ref={listRef} class={getDropdownClass(dropdownDirection, compact)}>
      <div class="model-picker-searchbar">
        <input
          ref={inputRef}
          class="model-picker-search"
          type="text"
          placeholder="Search models…"
          value={query}
          aria-label={ariaLabel}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={true}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeDescendant}
          autocomplete="off"
          spellcheck={false}
          onInput={onSearchInput}
          onKeyDown={onKeyDown}
        />
        <div class="model-picker-header" aria-hidden="true">
          <span class="model-picker-col model-picker-col-name">Model</span>
          <span class="model-picker-col model-picker-col-price">In</span>
          <span class="model-picker-col model-picker-col-price">Out</span>
          <span class="model-picker-col model-picker-col-images">Img</span>
        </div>
      </div>
      <div id={listId} class="model-picker-rows" role="listbox" aria-label={ariaLabel}>
        {entries.length === 0 ? (
          <div class="model-picker-empty">{`No models match "${query}"`}</div>
        ) : (
          entries.map((entry, i) => {
            const isSelected = `${entry.model.provider}/${entry.model.id}` === value || entry.model.id === value;
            const isActive = i === activeIndex;
            const optionId = `${idBase}-option-${entry.model.provider}-${entry.model.id}`;
            return (
              <ModelPickerRow
                key={`${entry.model.provider}/${entry.model.id}`}
                entry={entry}
                isSelected={isSelected}
                isActive={isActive}
                optionId={optionId}
                setItemRef={(el) => { itemRefs.current[i] = el; }}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => {
                  // prevent focus loss so the item is clicked properly
                  e.preventDefault();
                  handleSelect(`${entry.model.provider}/${entry.model.id}`);
                }}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ModelPicker({
  value,
  label,
  ariaLabel,
  title,
  entries,
  onChange,
  compact,
  dropdownDirection = 'up',
}: ModelPickerProps) {
  const state = useModelPicker({ value, entries, onChange, dropdownDirection });

  const triggerClass = getTriggerClass(compact);
  const wrapperClass = getWrapperClass(compact);
  // Portal the dropdown to document.body so its (wide) list escapes any
  // clipping scroll container it happens to be rendered inside — notably the
  // settings menu, whose scrollable body would otherwise clip it on the x-axis.
  const usePortal = typeof document !== 'undefined';

  const dropdown = state.open && (
    <ModelPickerDropdown
      listRef={state.listRef}
      listId={state.listId}
      dropdownDirection={dropdownDirection}
      compact={compact}
      ariaLabel={ariaLabel}
      activeDescendant={state.activeDescendant}
      onKeyDown={state.onListKeyDown}
      entries={state.filteredEntries}
      value={value}
      activeIndex={state.activeIndex}
      idBase={state.idBase}
      handleSelect={state.handleSelect}
      setActiveIndex={state.setActiveIndex}
      itemRefs={state.itemRefs}
      query={state.query}
      onSearchInput={state.onSearchInput}
      inputRef={state.inputRef}
    />
  );

  return (
    <div class={wrapperClass}>
      <ModelPickerTrigger
        triggerRef={state.triggerRef}
        className={triggerClass}
        ariaLabel={ariaLabel}
        title={title}
        label={label}
        open={state.open}
        onClick={() => state.setOpen((o) => !o)}
        onKeyDown={state.onTriggerKeyDown}
      />
      {dropdown && (usePortal ? createPortal(dropdown, document.body) : dropdown)}
    </div>
  );
}
