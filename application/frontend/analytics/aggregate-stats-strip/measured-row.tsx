/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import type { JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Tooltip } from '../../lib/components/tooltip';
import { cx } from '../../lib/components/cx';
import { allocateAggregateStrip } from './allocation';

export interface StripItem {
  key: string;
  body: JSX.Element;
  tooltip: JSX.Element;
  label: string;
  className?: string;
  onClick?: (event: MouseEvent) => void;
}

/** Intrinsic, inert copies never mount tooltips, ids, or interactive controls. */
export function MeasuredRow({ items }: { items: StripItem[] }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const update = () => {
      const width = row.getBoundingClientRect().width;
      const widths = Array.from(measure.children, (el) => el.getBoundingClientRect().width);
      // Detached/hidden panels retain their last valid allocation.
      if (width <= 0 || widths.some((w) => w <= 0)) return;
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const next = allocateAggregateStrip(width, widths, gap);
      setCount((previous) => previous === next ? previous : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(row);
    for (const el of measure.children) observer.observe(el);
    return () => observer.disconnect();
  });
  return <>
    <div ref={rowRef} class="aggregate-strip-metrics">
      {items.slice(0, count).map((item) => <div key={item.key} class="aggregate-strip-item" data-stat={item.key}>
        <Tooltip contentNode={item.tooltip} placement="top" freezeWhileVisible richRole="region" returnFocusOnEscape>
          {item.onClick
            ? <button type="button" class={cx('aggregate-strip-seg', item.className)} aria-label={item.label} onClick={item.onClick}>{item.body}</button>
            : <span class={cx('aggregate-strip-seg', item.className)} tabIndex={0} aria-label={item.label}>{item.body}</span>}
        </Tooltip>
      </div>)}
    </div>
    <div ref={measureRef} class="aggregate-strip-measurements" aria-hidden="true" inert>
      {items.map((item) => <div key={item.key} class="aggregate-strip-item" data-measure-stat={item.key}>
        <span class={cx('aggregate-strip-seg', item.className)}>{item.body}</span>
      </div>)}
    </div>
  </>;
}
