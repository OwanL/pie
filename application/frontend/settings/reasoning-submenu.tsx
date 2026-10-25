/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { useId, useLayoutEffect, useState } from 'preact/hooks';
import type { ModelInfo, ThinkingLevel } from '../../lib/protocol/index.js';
import { getModelThinkingLevels, type ModelPickerEntry } from '../composer/model-list';

const LEVELS: ThinkingLevel[] = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'off'];
export function reasoningLevels(model: ModelInfo): ThinkingLevel[] {
  const supported = getModelThinkingLevels(model);
  return LEVELS.filter(level => supported.includes(level));
}

interface ReasoningSubmenuProps {
  menuRef: { current: HTMLDivElement | null };
  entry: ModelPickerEntry;
  anchor: () => HTMLDivElement | null;
  root: HTMLDivElement | null;
  selected?: ThinkingLevel;
  focus: boolean;
  onBack: () => void;
  onTab: (backwards: boolean) => void;
  onSelect: (level: ThinkingLevel) => void;
}

export function ReasoningSubmenu({
  menuRef: ref,
  entry,
  anchor,
  root,
  selected,
  focus,
  onBack,
  onTab,
  onSelect,
}: ReasoningSubmenuProps) {
  const levels = reasoningLevels(entry.model);
  const id = useId();
  const [active, setActive] = useState(0);
  useLayoutEffect(() => {
    setActive(Math.max(0, levels.indexOf(selected!)));
  }, [entry.model, selected]);
  useLayoutEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus, entry.model]);
  useLayoutEffect(() => {
    const position = () => {
      const menu = ref.current;
      const rowElement = anchor();
      if (!menu || !rowElement || !root) return;
      menu.style.setProperty('--reasoning-max-height', `${window.innerHeight - 22}px`);
      const row = rowElement.getBoundingClientRect();
      const bounds = root.getBoundingClientRect();
      const width = Math.min(132, window.innerWidth - 24);
      const height = Math.min(levels.length * 28 + 6, window.innerHeight - 16);
      const right = bounds.right + width + 6 <= window.innerWidth - 8;
      const left = bounds.left - width - 6 >= 8;
      const x = right ? bounds.right + 5 : left ? bounds.left - width - 5 : bounds.right - width - 12;
      const y = Math.max(8, Math.min(row.top, window.innerHeight - height - 8));
      Object.assign(menu.style, { left: `${Math.max(8, x)}px`, top: `${y}px`, width: `${width}px`, maxHeight: `${window.innerHeight - 16}px` });
      menu.dataset.side = right ? 'right' : left ? 'left' : 'inset';
      menu.style.setProperty('--reasoning-pointer-y', `${Math.max(6, Math.min(height - 10, row.top + row.height / 2 - y))}px`);
      menu.style.visibility = row.bottom < bounds.top || row.top > bounds.bottom ? 'hidden' : 'visible';
    };
    position();
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    const observer = new ResizeObserver(position);
    if (root) observer.observe(root);
    const rowElement = anchor();
    if (rowElement) observer.observe(rowElement);
    return () => {
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      observer.disconnect();
    };
  }, [anchor, root, entry.model]);
  useLayoutEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onBack();
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [onBack]);
  return (
    <div
      ref={ref}
      data-model-reasoning-submenu
      class="picker-popover model-picker-reasoning-menu"
      role="listbox"
      aria-label={`Reasoning for ${entry.label}`}
      aria-activedescendant={`${id}-${levels[active]}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        const key = event.key;
        if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'Enter', ' ', 'Tab'].includes(key)) {
          event.preventDefault();
        }
        switch (key) {
          case 'ArrowDown': setActive(i => Math.min(levels.length - 1, i + 1)); break;
          case 'ArrowUp': setActive(i => Math.max(0, i - 1)); break;
          case 'Home': setActive(0); break;
          case 'End': setActive(levels.length - 1); break;
          case 'ArrowLeft': onBack(); break;
          case 'Tab': onTab(event.shiftKey); break;
          case 'Enter':
          case ' ':
            if (levels[active]) onSelect(levels[active]);
            break;
        }
      }}
    >
      <div class="model-picker-reasoning-options">
        {levels.map((level, index) => (
          <button
            key={level}
            id={`${id}-${level}`}
            type="button"
            role="option"
            aria-selected={selected === level}
            tabIndex={-1}
            class={`choice-picker-option${active === index ? ' active' : ''}${selected === level ? ' selected' : ''}`}
            onMouseEnter={() => setActive(index)}
            onClick={() => onSelect(level)}
          >
            <span class="choice-picker-check">{selected === level ? '✓' : ''}</span>
            <span class="choice-picker-label">{level}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
