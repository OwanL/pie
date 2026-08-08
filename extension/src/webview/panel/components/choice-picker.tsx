/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { createPortal } from 'preact/compat';
import type { JSX } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

import { CollapsibleChevron } from './chevron';
import { Tooltip } from './tooltip';
import { focusAdjacentControl, useAnchoredOverlay } from './anchored-overlay';

export interface ChoicePickerOption<T extends string> {
  value: T;
  label: string;
}

interface ChoicePickerProps<T extends string> {
  value: T;
  label: string;
  ariaLabel: string;
  title: string;
  options: readonly ChoicePickerOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

/** Compact toolbar listbox used where a native select would break panel theming. */
export function ChoicePicker<T extends string>({
  value,
  label,
  ariaLabel,
  title,
  options,
  onChange,
  disabled,
}: ChoicePickerProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  useAnchoredOverlay({
    open,
    triggerRef,
    overlayRef: menuRef,
    preferredDirection: 'up',
    preferredWidth: 176,
    maxHeight: 240,
  });

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
    const frame = window.requestAnimationFrame(() => menuRef.current?.focus());
    const pointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', pointer);
    document.addEventListener('keydown', keyboard);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', pointer);
      document.removeEventListener('keydown', keyboard);
    };
  }, [open, selectedIndex]);

  const select = (option: ChoicePickerOption<T>) => {
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (options.length === 0) return;
    let next = activeIndex;
    if (event.key === 'ArrowDown') next = Math.min(options.length - 1, activeIndex + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, activeIndex - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) select(option);
      return;
    } else if (event.key === 'Tab') {
      event.preventDefault();
      setOpen(false);
      focusAdjacentControl(triggerRef.current, event.shiftKey);
      return;
    } else {
      return;
    }
    event.preventDefault();
    setActiveIndex(next);
    menuRef.current?.querySelector<HTMLElement>(`[data-choice-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const dropdown = open ? (
    <div
      ref={menuRef}
      class="choice-picker-dropdown picker-popover"
      role="listbox"
      aria-label={ariaLabel}
      aria-activedescendant={`${id}-option-${activeIndex}`}
      tabIndex={-1}
      onKeyDown={onMenuKeyDown}
    >
      <div class="picker-popover-heading">{title}</div>
      <div class="choice-picker-options">
        {options.map((option, index) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              id={`${id}-option-${index}`}
              type="button"
              data-choice-index={index}
              class={`choice-picker-option${selected ? ' selected' : ''}${activeIndex === index ? ' active' : ''}`}
              role="option"
              aria-selected={selected}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(option)}
            >
              <span class="choice-picker-check" aria-hidden="true">{selected ? '✓' : ''}</span>
              <span class="choice-picker-label">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  ) : null;

  return (
    <div class="choice-picker">
      <Tooltip content={open ? null : title} placement="top">
        <button
          ref={triggerRef}
          type="button"
          class={`panel-chip panel-chip-toolbar choice-picker-trigger${open ? ' open' : ''}`}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => !disabled && setOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              if (!disabled) setOpen(true);
            }
          }}
        >
          <span class="choice-picker-trigger-label">{label}</span>
          <CollapsibleChevron open={open} size={10} />
        </button>
      </Tooltip>
      {dropdown && (typeof document === 'undefined' ? dropdown : createPortal(dropdown, document.body))}
    </div>
  );
}
