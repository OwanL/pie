/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren, JSX } from 'preact';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { useAnchoredOverlay } from '../components/anchored-overlay';
import { allocateComposerModelWidthBudget, allocateComposerOverflow } from './toolbar-overflow-allocation';

export interface ComposerToolbarItem {
  key: string;
  kind: 'control' | 'indicator';
  content: ComponentChildren;
}

interface ComposerToolbarOverflowProps {
  pinnedControls: ComponentChildren;
  items: readonly ComposerToolbarItem[];
  commandsAvailable: boolean;
}

interface Allocation {
  /** Null means the initial, unmeasured layout keeps every item in the row. */
  visibleItemKeys: readonly string[] | null;
}

const INITIAL_ALLOCATION: Allocation = { visibleItemKeys: null };
const OVERFLOW_TRIGGER_WIDTH = 26;
const FALLBACK_CONTROL_GAP = 2;
const FALLBACK_SECTION_GAP = 4;

function readWidth(element: HTMLElement | null | undefined): number {
  if (!element) return 0;
  const rectWidth = element.getBoundingClientRect().width;
  return rectWidth > 0 ? rectWidth : element.clientWidth;
}

function readGap(element: HTMLElement | null, property: 'columnGap' | 'gap', fallback: number): number {
  if (!element || typeof window.getComputedStyle !== 'function') return fallback;
  const value = Number.parseFloat(window.getComputedStyle(element)[property]);
  return Number.isFinite(value) ? value : fallback;
}

function isOverflowPortalTarget(target: EventTarget | null, popover: HTMLElement | null): boolean {
  if (!(target instanceof Node)) return false;
  if (popover?.contains(target)) return true;
  const element = target instanceof Element ? target : target.parentElement;
  if (!element) return false;
  // BrowserServerMenu portals its dialog to document.body. Treat only this
  // overflow-owned nested layer as inside while its trigger is open.
  if (popover?.querySelector('.browser-server-trigger[aria-expanded="true"]')
    && element.closest('.browser-server-popover')) return true;
  // Tooltip hosts also live under document.body. Tooltip stamps the host with
  // the id of its owning overflow panel; unrelated tooltips remain outside.
  const tooltip = element.closest<HTMLElement>('.pie-tooltip-host');
  return !!popover?.dataset.composerToolbarOverflowOwner
    && tooltip?.dataset.composerToolbarOverflowOwner === popover.dataset.composerToolbarOverflowOwner;
}

function hasOpenNestedLayer(popover: HTMLElement | null): boolean {
  return !!popover?.querySelector('[aria-expanded="true"]');
}

/** Responsive composer row. Each toolbar component is rendered once, either in
 * its original row position or in the anchored overflow panel. */
export function ComposerToolbarOverflow({ pinnedControls, items, commandsAvailable }: ComposerToolbarOverflowProps) {
  const [allocation, setAllocation] = useState<Allocation>(INITIAL_ALLOCATION);
  const [open, setOpen] = useState(false);
  const [contentGeneration, setContentGeneration] = useState(0);
  const ownerId = useId();
  const controlsRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef<HTMLFieldSetElement>(null);
  const indicatorsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const itemElementsRef = useRef(new Map<string, HTMLElement>());
  const itemWidthsRef = useRef(new Map<string, number>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const measureAndAllocate = useCallback(() => {
    const controls = controlsRef.current;
    const root = controls?.parentElement;
    const pinned = pinnedRef.current;
    const actions = root?.querySelector<HTMLElement>(':scope > .composer-actions');
    const availableWidth = readWidth(root);
    if (!controls || !root || !pinned || availableWidth <= 0) return;

    // The model picker cap is applied after allocation. Temporarily remove it
    // while measuring so both the pinned group and model reserve their natural,
    // deliberately capped-at-180px widths instead of whatever a narrow flex row
    // happened to leave them.
    const modelPicker = pinned.querySelector<HTMLElement>('.model-picker');
    const appliedModelWidth = pinned.style.getPropertyValue('--composer-model-picker-max-width');
    pinned.style.removeProperty('--composer-model-picker-max-width');
    const pinnedNaturalWidth = readWidth(pinned);
    const modelNaturalWidth = readWidth(modelPicker);
    if (appliedModelWidth) pinned.style.setProperty('--composer-model-picker-max-width', appliedModelWidth);

    const itemWidths = itemsRef.current.map((item) => {
      const element = itemElementsRef.current.get(item.key);
      const measured = readWidth(element);
      if (element) itemWidthsRef.current.set(item.key, measured);
      return {
        key: item.key,
        kind: item.kind,
        width: element ? measured : itemWidthsRef.current.get(item.key) || 0,
      };
    });
    const sectionGap = readGap(root, 'columnGap', FALLBACK_SECTION_GAP);
    const controlGap = readGap(controls, 'columnGap', FALLBACK_CONTROL_GAP);
    const visibleItemKeys = allocateComposerOverflow({
      availableWidth,
      pinnedWidth: pinnedNaturalWidth,
      actionsWidth: readWidth(actions),
      items: itemWidths,
      controlGap,
      indicatorGap: readGap(indicatorsRef.current, 'columnGap', FALLBACK_CONTROL_GAP),
      sectionGap,
      overflowTriggerWidth: OVERFLOW_TRIGGER_WIDTH,
    });
    if (modelPicker) {
      const modelWidthBudget = allocateComposerModelWidthBudget({
        availableWidth,
        pinnedNaturalWidth,
        modelNaturalWidth,
        actionsWidth: readWidth(actions),
        sectionGap,
        controlGap,
        overflowTriggerWidth: OVERFLOW_TRIGGER_WIDTH,
        hasOverflow: visibleItemKeys.length < itemWidths.length,
      });
      const widthValue = `${Math.round(modelWidthBudget * 100) / 100}px`;
      if (pinned.style.getPropertyValue('--composer-model-picker-max-width') !== widthValue) {
        pinned.style.setProperty('--composer-model-picker-max-width', widthValue);
      }
    } else {
      pinned.style.removeProperty('--composer-model-picker-max-width');
    }
    setAllocation((previous) => (
      previous.visibleItemKeys?.length === visibleItemKeys.length
        && previous.visibleItemKeys.every((key, index) => key === visibleItemKeys[index])
        ? previous
        : { visibleItemKeys }
    ));
  }, []);

  const itemRef = useCallback((key: string) => {
    let attachedElement: HTMLElement | null = null;
    return (element: HTMLElement | null) => {
      if (attachedElement && attachedElement !== element) {
        observerRef.current?.unobserve(attachedElement);
        if (itemElementsRef.current.get(key) === attachedElement) itemElementsRef.current.delete(key);
      }
      attachedElement = element;
      if (!element) return;
      itemElementsRef.current.set(key, element);
      const width = readWidth(element);
      if (width > 0) itemWidthsRef.current.set(key, width);
      observerRef.current?.observe(element);
    };
  }, []);
  const refCallbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const getItemRef = (key: string, location: 'row' | 'popover') => {
    const refKey = `${key}:${location}`;
    let callback = refCallbacks.current.get(refKey);
    if (!callback) {
      callback = itemRef(key);
      refCallbacks.current.set(refKey, callback);
    }
    return callback;
  };

  // Measure once after every committed layout (items can move between row and
  // popover) and observe real widths thereafter. This captures container,
  // font, model-label, and live-indicator changes without viewport guesses.
  useEffect(() => {
    const measureFonts = () => measureAndAllocate();
    window.addEventListener('resize', measureFonts);
    const fonts = document.fonts;
    fonts?.addEventListener?.('loadingdone', measureFonts);
    void fonts?.ready?.then(measureFonts);
    return () => {
      window.removeEventListener('resize', measureFonts);
      fonts?.removeEventListener?.('loadingdone', measureFonts);
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [measureAndAllocate]);

  useLayoutEffect(() => {
    measureAndAllocate();
    if (!observerRef.current && typeof ResizeObserver !== 'undefined') {
      observerRef.current = new ResizeObserver(measureAndAllocate);
    }
    const observer = observerRef.current;
    const controls = controlsRef.current;
    const root = controls?.parentElement;
    const actions = root?.querySelector<HTMLElement>(':scope > .composer-actions');
    for (const element of [root, controls, pinnedRef.current, indicatorsRef.current, actions]) {
      if (element) observer?.observe(element);
    }
    for (const element of itemElementsRef.current.values()) observer?.observe(element);
  });

  useLayoutEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (isOverflowPortalTarget(event.target, popoverRef.current)
        || triggerRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (isOverflowPortalTarget(event.target, popoverRef.current)
        || triggerRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Existing child menus own the first Escape. Their document listener will
      // close the nested layer; the next Escape dismisses this overflow panel.
      if (hasOpenNestedLayer(popoverRef.current)) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const visibleItemKeys = allocation.visibleItemKeys === null
    ? null
    : new Set(allocation.visibleItemKeys);
  const isVisible = (item: ComposerToolbarItem) => visibleItemKeys === null || visibleItemKeys.has(item.key);
  const controlItems = items.filter((item) => item.kind === 'control');
  const indicatorItems = items.filter((item) => item.kind === 'indicator');
  const visibleControls = controlItems.filter(isVisible);
  const visibleIndicators = indicatorItems.filter(isVisible);
  const hiddenItems = items.filter((item) => !isVisible(item));
  const hiddenKeySignature = hiddenItems.map((item) => item.key).join('\u0000');
  const previousHiddenKeySignature = useRef(hiddenKeySignature);

  // If a resize moves a component out of the open popover, close the parent
  // layer as its child remounts. Child-owned portals then clean up normally.
  useLayoutEffect(() => {
    if (previousHiddenKeySignature.current !== hiddenKeySignature) {
      previousHiddenKeySignature.current = hiddenKeySignature;
      if (open) close();
    }
  }, [hiddenKeySignature, open]);

  useLayoutEffect(() => {
    if (popoverRef.current) popoverRef.current.inert = !open;
  }, [open, hiddenKeySignature]);

  useAnchoredOverlay({
    open: open && hiddenItems.length > 0,
    triggerRef,
    overlayRef: popoverRef,
    preferredDirection: 'up',
    preferredWidth: 260,
    minHeight: 80,
    maxHeight: 420,
  });

  function close(restoreFocus = false): void {
    setOpen(false);
    setContentGeneration((generation) => generation + 1);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function renderItem(item: ComposerToolbarItem, inPopover = false): JSX.Element {
    const common = {
      key: inPopover ? `${item.key}-${contentGeneration}` : item.key,
      ref: getItemRef(item.key, inPopover ? 'popover' : 'row'),
      class: `composer-toolbar-item composer-toolbar-${item.kind}-item`,
      'data-toolbar-item': item.key,
      'data-toolbar-item-kind': item.kind,
    };
    if (item.kind === 'control') {
      return (
        <fieldset
          {...common}
          disabled={!commandsAvailable}
          aria-disabled={!commandsAvailable}
        >
          {item.content}
        </fieldset>
      );
    }
    return <div {...common}>{item.content}</div>;
  }

  const openMenu = () => {
    if (hiddenItems.length === 0) return;
    setOpen(true);
  };

  return (
    <>
      <div ref={controlsRef} class="composer-controls">
        <fieldset ref={pinnedRef} class="composer-pinned-controls" disabled={!commandsAvailable} aria-disabled={!commandsAvailable}>
          {pinnedControls}
        </fieldset>
        {visibleControls.map((item) => renderItem(item))}
        {hiddenItems.length > 0 && (
          <button
            ref={triggerRef}
            type="button"
            class={`system-prompt-toggle-trigger composer-overflow-trigger${open ? ' open' : ''}`}
            aria-label="More composer options"
            aria-haspopup="dialog"
            aria-expanded={open}
            title="More composer options"
            onClick={() => open ? close() : openMenu()}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openMenu();
              }
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <circle cx="3" cy="8" r="1.2" />
              <circle cx="8" cy="8" r="1.2" />
              <circle cx="13" cy="8" r="1.2" />
            </svg>
          </button>
        )}
        {hiddenItems.length > 0 && (
          <div
            ref={popoverRef}
            class="picker-popover composer-toolbar-overflow-popover"
            role="dialog"
            aria-label="Additional composer options"
            aria-hidden={!open}
            data-composer-toolbar-overflow-owner={ownerId}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Tab' && event.shiftKey && event.target === event.currentTarget) {
                event.preventDefault();
                triggerRef.current?.focus();
              }
            }}
          >
            {hiddenItems.map((item) => renderItem(item, true))}
          </div>
        )}
      </div>
      {visibleIndicators.length > 0 && (
        <div ref={indicatorsRef} class="composer-indicators">
          {visibleIndicators.map((item) => renderItem(item))}
        </div>
      )}
    </>
  );
}
