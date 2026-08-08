/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { JSX } from 'preact';
import { formatModelSpec, type ModelPickerEntry } from '../composer/model-list';
import { focusAdjacentControl, useAnchoredOverlay } from './anchored-overlay';
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
  /** Disable the trigger and prevent the dropdown from opening. */
  disabled?: boolean;
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
  compact?: boolean,
) {
  useAnchoredOverlay({
    open,
    triggerRef,
    overlayRef: listRef,
    preferredDirection: dropdownDirection,
    preferredWidth: compact ? 360 : 420,
    minHeight: 140,
    maxHeight: 400,
  });
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
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
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
  triggerRef: { current: HTMLButtonElement | null },
) {
  return useCallback(
    (e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
      const action = resolveListKeyAction(e.key);
      if (!action) return;
      // Tab must close even when the current search has no results; otherwise
      // focus leaves while the portaled dropdown remains visibly stranded.
      if (action === 'close') {
        e.preventDefault();
        setOpen(false);
        focusAdjacentControl(triggerRef.current, e.shiftKey);
        return;
      }
      if (entries.length === 0) return;
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
          if (entry) handleSelect(formatModelSpec(entry.model));
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
  compact,
}: {
  value: string;
  entries: ModelPickerEntry[];
  onChange: (modelId: string) => void;
  dropdownDirection: 'up' | 'down';
  compact?: boolean;
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
    (e) => formatModelSpec(e.model) === value || e.model.id === value,
  );

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      `${e.label} ${e.model.name} ${e.model.id} ${e.model.provider}`.toLowerCase().includes(q),
    );
  }, [entries, query]);

  useFocusOnOpen(open, selectedIndex, setActiveIndex, inputRef, setQuery);
  useClickOutside(open, setOpen, triggerRef, listRef);
  useDropdownPosition(open, dropdownDirection, listRef, triggerRef, compact);
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
  const onListKeyDown = useListKeyDown(filteredEntries, activeIndex, handleSelect, setOpen, setActiveIndex, triggerRef);
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
  disabled?: boolean;
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
  disabled,
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
        disabled={disabled}
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
  onClick: () => void;
}

function ModelPickerRow({
  entry,
  isSelected,
  isActive,
  optionId,
  setItemRef,
  onMouseEnter,
  onMouseDown,
  onClick,
}: ModelPickerRowProps) {
  return (
    <div
      key={formatModelSpec(entry.model)}
      id={optionId}
      ref={setItemRef}
      class={getRowClass(isSelected, isActive, entry.ineligible)}
      role="option"
      aria-selected={isSelected}
      title={entry.title}
      onMouseEnter={onMouseEnter}
      onMouseDown={onMouseDown}
      onClick={onClick}
    >
      <span class="model-picker-col model-picker-col-name">
        <span class="model-picker-selection" aria-hidden="true">{isSelected ? '✓' : ''}</span>
        <span class="model-picker-name">{entry.label}</span>
      </span>
      <span class="model-picker-col model-picker-col-price">
        {entry.tokenInPrice || '—'}
      </span>
      <span class="model-picker-col model-picker-col-price">
        {entry.tokenOutPrice || '—'}
      </span>
      <span class="model-picker-col model-picker-col-images" aria-label={entry.supportsImages ? 'Supports images' : 'Text only'}>
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
        <svg class="model-picker-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" />
        </svg>
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
      </div>
      <div class="model-picker-header" aria-hidden="true">
        <span class="model-picker-col model-picker-col-name">Model</span>
        <span class="model-picker-col model-picker-col-price">In</span>
        <span class="model-picker-col model-picker-col-price">Out</span>
        <span class="model-picker-col model-picker-col-images">Img</span>
      </div>
      <div id={listId} class="model-picker-rows" role="listbox" aria-label={ariaLabel}>
        {entries.length === 0 ? (
          <div class="model-picker-empty">{`No models match "${query}"`}</div>
        ) : (
          entries.map((entry, i) => {
            const isSelected = formatModelSpec(entry.model) === value || entry.model.id === value;
            const isActive = i === activeIndex;
            const optionId = `${idBase}-option-${entry.model.provider}-${entry.model.id}`;
            return (
              <ModelPickerRow
                key={formatModelSpec(entry.model)}
                entry={entry}
                isSelected={isSelected}
                isActive={isActive}
                optionId={optionId}
                setItemRef={(el) => { itemRefs.current[i] = el; }}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => {
                  // Keep the combobox focused until click commits the option.
                  e.preventDefault();
                }}
                onClick={() => handleSelect(formatModelSpec(entry.model))}
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
  disabled,
  dropdownDirection = 'up',
}: ModelPickerProps) {
  const state = useModelPicker({ value, entries, onChange, dropdownDirection, compact });

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
        disabled={disabled}
        onClick={() => {
          if (!disabled) state.setOpen((o) => !o);
        }}
        onKeyDown={state.onTriggerKeyDown}
      />
      {dropdown && (usePortal ? createPortal(dropdown, document.body) : dropdown)}
    </div>
  );
}
