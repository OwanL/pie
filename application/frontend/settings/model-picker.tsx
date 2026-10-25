/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { RemovedProvidersContext } from './removed-providers';
import { createPortal } from 'preact/compat';
import type { JSX } from 'preact';
import type { ThinkingLevel } from '../../lib/protocol/index.js';
import { ReasoningSubmenu, reasoningLevels } from './reasoning-submenu';
import { formatModelSpec, type ModelPickerEntry } from '../composer/model-list';
import { focusAdjacentControl, useAnchoredOverlay } from '../lib/components/anchored-overlay';
import { CollapsibleChevron } from '../lib/components/chevron';
import { Tooltip } from '../lib/components/tooltip';

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
  /** Composer-only combined selection; other callers retain standalone behavior. */
  reasoning?: { value: ThinkingLevel; onChange: (spec: string, level: ThinkingLevel) => void };
  /** Disable the trigger and prevent the dropdown from opening. */
  disabled?: boolean;
  /** Existing description ID to reference from the closed trigger. */
  ariaDescribedBy?: string;
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
  resetNavigation: () => void,
) {
  useEffect(() => {
    if (!open) return;
    // Start each open with a fresh filter and, when the current model is in
    // the list, that row highlighted. When it is missing, highlight nothing:
    // the first entry must never be pre-highlighted, because Enter could then
    // silently commit a model the user never chose. A keyboard commit always
    // requires an explicit action first (navigation or a typed filter).
    setQuery('');
    resetNavigation();
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : -1);
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
  submenuRef: { current: HTMLDivElement | null },
) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const target = e.target as Node;
      const outside =
        listRef.current &&
        !listRef.current.contains(target) &&
        !submenuRef.current?.contains(target) &&
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
  onChange: (modelId: string) => void | boolean,
  setOpen: (value: boolean) => void,
  triggerRef: { current: HTMLButtonElement | null },
) {
  return useCallback(
    (modelId: string) => {
      if (onChange(modelId) === false) return;
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
  /** True once the user explicitly moved the highlight (arrows/Home/End or
   *  pointer hover). Enter may also commit a typed-filter match. */
  explicitHighlightRef: { current: boolean },
  query: string,
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
          explicitHighlightRef.current = true;
          setActiveIndex((i) => Math.min(entries.length - 1, i + 1));
          break;
        case 'prev':
          explicitHighlightRef.current = true;
          setActiveIndex((i) => Math.max(0, i - 1));
          break;
        case 'first':
          explicitHighlightRef.current = true;
          setActiveIndex(() => 0);
          break;
        case 'last':
          explicitHighlightRef.current = true;
          setActiveIndex(() => entries.length - 1);
          break;
        case 'select': {
          // Enter must be an explicit model choice: either the user moved the
          // highlight (keys or pointer) or typed a filter query. Enter on an
          // untouched dropdown — including one whose current model is missing
          // from the list — must never silently commit an entry.
          if (!explicitHighlightRef.current && query.trim() === '') break;
          const entry = entries[activeIndex];
          if (entry) handleSelect(formatModelSpec(entry.model));
          break;
        }
      }
    },
    [entries, activeIndex, handleSelect, setActiveIndex, explicitHighlightRef, query],
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
  onChange: (modelId: string) => void | boolean;
  dropdownDirection: 'up' | 'down';
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeSpec, setActiveSpec] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // An explicit user action that moves the highlight (arrow keys, Home/End,
  // pointer hover). Enter commits only after one of these, or after the user
  // typed a filter query. Reset on every open.
  const explicitHighlightRef = useRef(false);
  const resetNavigation = useCallback(() => {
    explicitHighlightRef.current = false;
  }, []);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
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

  // Resolve the highlight during render, before Enter or ARIA can observe a
  // catalog refresh. A removed candidate leaves no implicit replacement.
  const activeIndex = filteredEntries.findIndex((entry) => formatModelSpec(entry.model) === activeSpec);
  const setActiveIndex = useCallback((next: number | ((previous: number) => number)) => {
    setActiveSpec((previous) => {
      const previousIndex = filteredEntries.findIndex((entry) => formatModelSpec(entry.model) === previous);
      const index = typeof next === 'function' ? next(previousIndex) : next;
      const entry = filteredEntries[index];
      return entry ? formatModelSpec(entry.model) : null;
    });
  }, [filteredEntries]);
  useLayoutEffect(() => {
    if (activeIndex < 0) setActiveSpec(null);
  }, [activeIndex, activeSpec]);

  useFocusOnOpen(open, selectedIndex, (index) => {
    setActiveSpec(entries[index] ? formatModelSpec(entries[index].model) : null);
  }, inputRef, setQuery, resetNavigation);
  useClickOutside(open, setOpen, triggerRef, listRef, submenuRef);
  useDropdownPosition(open, dropdownDirection, listRef, triggerRef, compact);
  useScrollActiveItem(open, activeIndex, itemRefs);

  const handleSelect = useHandleSelect(onChange, setOpen, triggerRef);
  const onTriggerKeyDown = useTriggerKeyDown(setOpen);
  const onListKeyDown = useListKeyDown(filteredEntries, activeIndex, handleSelect, setOpen, setActiveIndex, triggerRef, explicitHighlightRef, query);
  const onSearchInput = useCallback((e: JSX.TargetedEvent<HTMLInputElement>) => {
    const nextQuery = e.currentTarget.value;
    setQuery(nextQuery);
    // Typeahead: the first filtered match becomes the commit candidate. This
    // is itself an explicit user action (a typed query), so Enter may commit
    // it even without arrow-key navigation.
    const q = nextQuery.trim().toLowerCase();
    const first = entries.find((entry) =>
      `${entry.label} ${entry.model.name} ${entry.model.id} ${entry.model.provider}`.toLowerCase().includes(q),
    );
    setActiveSpec(first ? formatModelSpec(first.model) : null);
  }, [entries]);
  // Pointer hover is an explicit pointing action; hovering a row then pressing
  // Enter commits the hovered row, mirroring focus-follows-mouse.
  const onRowPointerEnter = useCallback((index: number) => {
    explicitHighlightRef.current = true;
    setActiveIndex(index);
  }, [setActiveIndex]);

  const activeDescendant =
    activeIndex >= 0 ? `${idBase}-option-${filteredEntries[activeIndex]?.model.provider}-${filteredEntries[activeIndex]?.model.id}` : undefined;

  return {
    open,
    setOpen,
    activeIndex,
    setActiveIndex,
    triggerRef,
    listRef,
    submenuRef,
    inputRef,
    itemRefs,
    idBase,
    listId,
    selectedIndex,
    handleSelect,
    onTriggerKeyDown,
    onListKeyDown,
    onSearchInput,
    onRowPointerEnter,
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
  reasoning?: ThinkingLevel;
  open: boolean;
  disabled?: boolean;
  ariaDescribedBy?: string;
  onClick: () => void;
  onKeyDown: (e: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => void;
}

function ModelPickerTrigger({
  triggerRef,
  className,
  ariaLabel,
  title,
  label,
  reasoning,
  open,
  disabled,
  ariaDescribedBy,
  onClick,
  onKeyDown,
}: ModelPickerTriggerProps) {
  // Wrap the trigger in the custom Tooltip (placement 'top') so its tooltip
  // opens upward like the rest of the model-picker row. Suppress the tooltip
  // content while the dropdown is open so it doesn't collide with the
  // (upward-opening) dropdown list.
  return (
    <Tooltip content={open ? null : reasoning ? `${title}\nReasoning: ${reasoning}` : title} placement="top">
      <button
        ref={triggerRef}
        type="button"
        class={className}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-description={reasoning ? `Reasoning: ${reasoning}` : undefined}
        disabled={disabled}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <span class="model-picker-trigger-label">{label}</span>
        {reasoning && <sup class="model-picker-reasoning-suffix">{reasoning}</sup>}
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
  nested?: boolean;
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
  nested,
}: ModelPickerRowProps) {
  return (
    <div
      key={formatModelSpec(entry.model)}
      id={optionId}
      ref={setItemRef}
      class={getRowClass(isSelected, isActive, entry.ineligible)}
      role="option"
      aria-selected={isSelected}
      aria-haspopup={nested ? 'listbox' : undefined}
      aria-label={`${entry.label}, ${entry.model.provider}/${entry.model.id}, input price ${entry.tokenInPrice ? `${entry.tokenInPrice} per million tokens` : 'unavailable'}, output price ${entry.tokenOutPrice ? `${entry.tokenOutPrice} per million tokens` : 'unavailable'}, ${entry.supportsImages ? 'supports images' : 'text only'}`}
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
      {nested && <span class="model-picker-nested-chevron" aria-hidden="true">›</span>}
    </div>
  );
}

interface ModelPickerDropdownProps {
  listRef: { current: HTMLDivElement | null };
  listId: string;
  dropdownDirection: 'up' | 'down';
  compact?: boolean;
  combined?: boolean;
  ariaLabel: string;
  activeDescendant: string | undefined;
  onKeyDown: (e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => void;
  entries: ModelPickerEntry[];
  value: string;
  activeIndex: number;
  idBase: string;
  handleSelect: (modelId: string) => void;
  /** Explicit pointer highlight; also marks the highlight as user-chosen so
   *  Enter can commit the hovered row. */
  onRowPointerEnter: (index: number) => void;
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
  combined,
  ariaLabel,
  activeDescendant,
  onKeyDown,
  entries,
  value,
  activeIndex,
  idBase,
  handleSelect,
  onRowPointerEnter,
  itemRefs,
  query,
  onSearchInput,
  inputRef,
}: ModelPickerDropdownProps) {
  return (
    <div ref={listRef} class={`${getDropdownClass(dropdownDirection, compact)}${combined ? ' model-picker-combined' : ''}`}>
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
        <span class="model-picker-col model-picker-col-price" title="Input price per million tokens">In</span>
        <span class="model-picker-col model-picker-col-price" title="Output price per million tokens">Out</span>
        <span class="model-picker-col model-picker-col-images" title="Image input capability">Img</span>
      </div>
      <div id={listId} class="model-picker-rows" role="listbox" aria-label={ariaLabel}>
        {entries.length === 0 ? (
          <div class="model-picker-empty">{query.trim() ? `No models match "${query}"` : 'No models available'}</div>
        ) : (
          entries.map((entry, i) => {
            const isSelected = formatModelSpec(entry.model) === value || entry.model.id === value;
            const isActive = i === activeIndex;
            const optionId = `${idBase}-option-${entry.model.provider}-${entry.model.id}`;
            return (
              <ModelPickerRow
                key={formatModelSpec(entry.model)}
                entry={entry}
                nested={combined && reasoningLevels(entry.model).length > 1}
                isSelected={isSelected}
                isActive={isActive}
                optionId={optionId}
                setItemRef={(el) => { itemRefs.current[i] = el; }}
                onMouseEnter={() => onRowPointerEnter(i)}
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
  label: currentLabel,
  ariaLabel,
  title,
  entries: catalogEntries,
  onChange,
  compact,
  reasoning,
  disabled,
  ariaDescribedBy,
  dropdownDirection = 'up',
}: ModelPickerProps) {
  const removedProviderIds = useContext(RemovedProvidersContext);
  const entries = useMemo(() => catalogEntries.filter(entry => !removedProviderIds.includes(entry.model.provider)), [catalogEntries, removedProviderIds]);
  const provider = value.includes('/') ? value.slice(0, value.indexOf('/')) : '';
  const label = removedProviderIds.includes(provider) ? `${value} · Unavailable (removed provider)` : currentLabel;
  const [nestedSpec, setNestedSpec] = useState<string | null>(null);
  const [nestedFocus, setNestedFocus] = useState(false);
  const selectedEntry = entries.find(entry => formatModelSpec(entry.model) === value || entry.model.id === value);
  const displayedReasoning = reasoning && selectedEntry && reasoningLevels(selectedEntry.model).some(level => level !== 'off')
    ? reasoning.value : undefined;
  const orderedEntries = useMemo(() => {
    if (!reasoning || !selectedEntry) return entries;
    return [selectedEntry, ...entries.filter(entry => entry !== selectedEntry)];
  }, [entries, selectedEntry, !!reasoning]);
  const selectModel = (spec: string) => {
    const entry = entries.find(entry => formatModelSpec(entry.model) === spec);
    if (reasoning && entry) {
      const levels = reasoningLevels(entry.model);
      if (levels.length > 1) { setNestedSpec(spec); setNestedFocus(true); return false; }
      reasoning.onChange(spec, levels[0] ?? 'off');
    } else onChange(spec);
  };
  const state = useModelPicker({ value, entries: orderedEntries, onChange: selectModel, dropdownDirection, compact });
  const nestedIndex = state.filteredEntries.findIndex(entry => formatModelSpec(entry.model) === nestedSpec);
  const nestedCandidate = nestedIndex >= 0 ? state.filteredEntries[nestedIndex] : undefined;
  const nestedEntry = reasoning && nestedCandidate && reasoningLevels(nestedCandidate.model).length > 1
    ? nestedCandidate : undefined;
  const openNested = (spec: string, focus: boolean) => {
    const entry = entries.find(entry => formatModelSpec(entry.model) === spec);
    setNestedSpec(entry && reasoningLevels(entry.model).length > 1 ? spec : null);
    setNestedFocus(focus);
  };
  const choose = (spec: string) => {
    const entry = entries.find(entry => formatModelSpec(entry.model) === spec);
    if (reasoning && entry && reasoningLevels(entry.model).length > 1) openNested(spec, true);
    else state.handleSelect(spec);
  };
  useLayoutEffect(() => {
    if (!state.open || !nestedEntry) {
      setNestedSpec(null);
      if (state.open && !disabled && nestedSpec && nestedFocus) state.inputRef.current?.focus();
    }
  }, [state.open, nestedEntry, nestedSpec, nestedFocus, disabled]);

  useLayoutEffect(() => {
    if (disabled) state.setOpen(false);
  }, [disabled, state.setOpen]);

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
      combined={!!reasoning}
      ariaLabel={ariaLabel}
      activeDescendant={state.activeDescendant}
      onKeyDown={(event) => {
        if (reasoning && event.key === 'ArrowRight' && state.activeIndex >= 0) {
          event.preventDefault();
          openNested(formatModelSpec(state.filteredEntries[state.activeIndex].model), true);
        } else if (reasoning && event.key === 'Enter') {
          // Let the existing explicit-highlight guard decide whether Enter is safe.
          state.onListKeyDown(event);
        } else {
          if (event.key !== 'Escape') setNestedSpec(null);
          state.onListKeyDown(event);
        }
      }}
      entries={state.filteredEntries}
      value={value}
      activeIndex={state.activeIndex}
      idBase={state.idBase}
      handleSelect={choose}
      onRowPointerEnter={(index) => {
        state.onRowPointerEnter(index);
        if (reasoning) openNested(formatModelSpec(state.filteredEntries[index].model), false);
      }}
      itemRefs={state.itemRefs}
      query={state.query}
      onSearchInput={(event) => { setNestedSpec(null); state.onSearchInput(event); }}
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
        reasoning={displayedReasoning}
        open={state.open}
        disabled={disabled}
        ariaDescribedBy={ariaDescribedBy}
        onClick={() => {
          if (!disabled) state.setOpen((o) => !o);
        }}
        onKeyDown={state.onTriggerKeyDown}
      />
      {dropdown && (usePortal ? createPortal(dropdown, document.body) : dropdown)}
      {state.open && !disabled && reasoning && nestedEntry && createPortal(
        <ReasoningSubmenu
          menuRef={state.submenuRef}
          entry={nestedEntry}
          anchor={() => state.itemRefs.current[nestedIndex]}
          root={state.listRef.current}
          selected={formatModelSpec(nestedEntry.model) === value ? reasoning.value : undefined}
          focus={nestedFocus}
          onBack={() => { setNestedSpec(null); state.inputRef.current?.focus(); }}
          onTab={(backwards) => { state.setOpen(false); focusAdjacentControl(state.triggerRef.current, backwards); }}
          onSelect={(level) => {
            reasoning.onChange(formatModelSpec(nestedEntry.model), level);
            state.setOpen(false);
            state.triggerRef.current?.focus();
          }}
        />, document.body,
      )}
    </div>
  );
}
