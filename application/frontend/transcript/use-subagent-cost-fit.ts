import { useLayoutEffect, useRef, useState } from 'preact/hooks';

/** Reserve a little breathing room; optional cost must not force a wrap or
 * squeeze the existing header metadata. */
export function subagentCostFits(available: number, required: number): boolean {
  return available > 0 && required + 12 <= available;
}

export function useSubagentCostFit(revision: unknown) {
  const contentRef = useRef<HTMLDivElement>(null);
  const costRef = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const content = contentRef.current;
    const cost = costRef.current;
    if (!content || !cost) return;
    const measure = () => {
      const available = content.getBoundingClientRect().width;
      // No layout in SSR/DOM-only tests. The browser measures before paint.
      if (available <= 0) return;
      const children = Array.from(content.children) as HTMLElement[];
      const widths = children.map((child) => Math.max(child.scrollWidth, child.getBoundingClientRect().width));
      const gap = parseFloat(getComputedStyle(content).columnGap) || 0;
      setFits(subagentCostFits(available, widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, children.length - 1)));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(content);
    for (const child of Array.from(content.children)) observer?.observe(child);
    let active = true;
    void document.fonts?.ready.then(() => { if (active) measure(); });
    return () => { active = false; observer?.disconnect(); };
  }, [revision]);
  return { contentRef, costRef, fits };
}
