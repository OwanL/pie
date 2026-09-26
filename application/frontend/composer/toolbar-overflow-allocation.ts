export interface ComposerOverflowItemWidth {
  key: string;
  kind: 'control' | 'indicator';
  width: number;
}

export interface ComposerOverflowAllocationInput {
  /** Width of the composer bottom bar, including its outer gaps. */
  availableWidth: number;
  /** Intrinsic, uncompressed width of the always-visible Settings/Model/Reasoning group. */
  pinnedWidth: number;
  actionsWidth: number;
  /** Items in their presentation order; removal priority is resolved separately. */
  items: readonly ComposerOverflowItemWidth[];
  controlGap: number;
  indicatorGap: number;
  sectionGap: number;
  overflowTriggerWidth: number;
}

export interface ComposerModelWidthBudgetInput {
  availableWidth: number;
  pinnedNaturalWidth: number;
  modelNaturalWidth: number;
  actionsWidth: number;
  sectionGap: number;
  controlGap: number;
  overflowTriggerWidth: number;
  hasOverflow: boolean;
}

/** Keep the model at its natural capped width while secondary items can still
 * fit. Only after they have all moved behind the overflow trigger may the model
 * label yield the width needed by Settings, Reasoning, actions, and the trigger. */
export function allocateComposerModelWidthBudget({
  availableWidth,
  pinnedNaturalWidth,
  modelNaturalWidth,
  actionsWidth,
  sectionGap,
  controlGap,
  overflowTriggerWidth,
  hasOverflow,
}: ComposerModelWidthBudgetInput): number {
  if (!hasOverflow || modelNaturalWidth <= 0) return Math.max(0, modelNaturalWidth);
  const nonModelPinnedWidth = Math.max(0, pinnedNaturalWidth - modelNaturalWidth);
  const remainingWidth = availableWidth
    - nonModelPinnedWidth
    - Math.max(0, actionsWidth)
    - Math.max(0, sectionGap)
    - Math.max(0, controlGap)
    - Math.max(0, overflowTriggerWidth);
  return Math.max(0, Math.min(modelNaturalWidth, remainingWidth));
}

const INDICATOR_REMOVAL_PRIORITY: Readonly<Record<string, number>> = {
  // Run and compaction status are transient; let these yield before the
  // requested speed, duration, cost, and context indicators.
  'run-status': 0,
  compacting: 0,
  'last-compaction': 0,
  'token-rate': 1,
  'working-time': 2,
  'session-cost': 3,
  'context-window': 4,
};

/** Allocate visible items by removing secondary controls first, then indicators
 * by semantic priority. The input and returned keys stay in presentation order;
 * the removal order is deliberately independent of that order. */
export function allocateComposerOverflow({
  availableWidth,
  pinnedWidth,
  actionsWidth,
  items,
  controlGap,
  indicatorGap,
  sectionGap,
  overflowTriggerWidth,
}: ComposerOverflowAllocationInput): string[] {
  const normalizedItems = items.map((item) => ({ ...item, width: Math.max(0, item.width) }));
  const visibleKeys = new Set(normalizedItems.map((item) => item.key));
  const fixedWidth = Math.max(0, pinnedWidth) + Math.max(0, actionsWidth);

  const requiredWidth = (): number => {
    const visibleControls = normalizedItems.filter((item) => item.kind === 'control' && visibleKeys.has(item.key));
    const visibleIndicators = normalizedItems.filter((item) => item.kind === 'indicator' && visibleKeys.has(item.key));
    const hasIndicators = visibleIndicators.length > 0;
    const hasOverflow = visibleKeys.size < normalizedItems.length;

    let width = fixedWidth + (hasIndicators ? sectionGap * 2 : sectionGap);
    for (const item of visibleControls) width += controlGap + item.width;
    if (hasOverflow) width += controlGap + overflowTriggerWidth;
    for (const [index, item] of visibleIndicators.entries()) {
      width += (index === 0 ? 0 : indicatorGap) + item.width;
    }
    return width;
  };
  const visibleInPresentationOrder = () => normalizedItems
    .filter((item) => visibleKeys.has(item.key))
    .map((item) => item.key);

  if (requiredWidth() <= availableWidth) return visibleInPresentationOrder();

  // The former leading-prefix allocator removed controls from the end of their
  // row sequence. Preserve that direction within secondary controls.
  const controlsToRemove = normalizedItems
    .filter((item) => item.kind === 'control')
    .reverse();
  const indicatorsToRemove = normalizedItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.kind === 'indicator')
    .sort((a, b) => (INDICATOR_REMOVAL_PRIORITY[a.item.key] ?? 0)
      - (INDICATOR_REMOVAL_PRIORITY[b.item.key] ?? 0) || b.index - a.index)
    .map(({ item }) => item);

  for (const item of [...controlsToRemove, ...indicatorsToRemove]) {
    visibleKeys.delete(item.key);
    if (requiredWidth() <= availableWidth) return visibleInPresentationOrder();
  }
  // Pinned controls and Send/Stop are mandatory even in a pathological row
  // narrower than their combined minimum. Keep the overflow affordance rather
  // than silently dropping eligible items.
  return [];
}
