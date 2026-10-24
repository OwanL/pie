export interface ComposerOverflowItemWidth {
  key: string;
  kind: 'control' | 'indicator' | 'global';
  /** Always belongs to More, regardless of available width. */
  overflowOnly?: boolean;
  width: number;
  /**
   * Explicit removal priority. Lower values move the item behind the trigger
   * earlier, ahead of every built-in control and indicator order. Bare
   * indicators with nothing informative to show in-row (an unavailable session
   * cost renders a bare em dash, never a fabricated zero) use this so they join
   * the overflow panel first, while chips with real values keep their built-in
   * indicator priority.
   */
  removalPriority?: number;
}

export interface ComposerToolbarAllocationInput {
  /** Width of the composer bottom bar, including its outer gaps. */
  availableWidth: number;
  /** Intrinsic, uncompressed width of the always-visible Model/Reasoning group. */
  pinnedNaturalWidth: number;
  /**
   * Natural, uncompressed width of the model picker inside the pinned group;
   * 0 when the row has no model picker. A positive width enables the compact
   * model stage: the label yields width down to
   * {@link COMPOSER_MODEL_COMPACT_MIN_WIDTH} to keep secondary items visible,
   * and yields further only once no secondary item remains.
   */
  modelNaturalWidth: number;
  actionsWidth: number;
  /** Items in their presentation order; removal priority is resolved separately. */
  items: readonly ComposerOverflowItemWidth[];
  controlGap: number;
  indicatorGap: number;
  sectionGap: number;
  overflowTriggerWidth: number;
}

export interface ComposerToolbarAllocation {
  /** Keys of items that stay in the row, in presentation order. */
  visibleItemKeys: readonly string[];
  /** max-width budget for the pinned model picker. */
  modelWidthBudget: number;
}

/** Narrowest width the selected-model label may compact to while any secondary
 *  item can still be hidden instead of the space being taken from the label.
 *  Roughly ten characters stay readable below the never-below-180px natural
 *  cap; once no secondary item remains, the model may yield further (or fully)
 *  because hiding everything else cannot be traded for label room. */
export const COMPOSER_MODEL_COMPACT_MIN_WIDTH = 96;

const INDICATOR_REMOVAL_PRIORITY: Readonly<Record<string, number>> = {
  // Run and compaction status are transient; let these yield before duration,
  // cost, and context indicators.
  'run-status': 0,
  compacting: 0,
  'last-compaction': 0,
  'working-time': 2,
  'session-cost': 3,
  'context-window': 4,
};

/** Allocate the row's items and the model label budget in one calculation.
 *  Narrowing yields in this order: overridden items (e.g. a bare unknown cost
 *  dash), secondary controls, transient/low-priority indicators — while the
 *  model label compacts at most down to {@link COMPOSER_MODEL_COMPACT_MIN_WIDTH}.
 *  Only when no secondary item remains, or the row is narrower than the pinned
 *  group itself, may the label yield below that bound. Retained indicators are
 *  part of the same required-width arithmetic as the model budget, so a mixed
 *  state can never promise the model more room than the row actually has. */
export function allocateComposerToolbar({
  availableWidth,
  pinnedNaturalWidth,
  modelNaturalWidth,
  actionsWidth,
  items,
  controlGap,
  indicatorGap,
  sectionGap,
  overflowTriggerWidth,
}: ComposerToolbarAllocationInput): ComposerToolbarAllocation {
  const normalizedItems = items.map((item) => ({ ...item, width: Math.max(0, item.width) }));
  const modelCap = Math.max(0, modelNaturalWidth);
  const modelReserve = modelCap > 0 ? Math.min(COMPOSER_MODEL_COMPACT_MIN_WIDTH, modelCap) : 0;

  const requiredWidth = (visibleKeys: ReadonlySet<string>, modelBudget: number): number => {
    const visibleControls = normalizedItems.filter((item) => item.kind === 'control' && visibleKeys.has(item.key));
    const visibleIndicators = normalizedItems.filter((item) => item.kind === 'indicator' && visibleKeys.has(item.key));
    const visibleGlobals = normalizedItems.filter((item) => item.kind === 'global' && visibleKeys.has(item.key));
    const hasIndicators = visibleIndicators.length > 0;
    const hasOverflow = visibleKeys.size < normalizedItems.length;

    let width = Math.max(0, pinnedNaturalWidth - modelNaturalWidth)
      + Math.max(0, modelBudget)
      + Math.max(0, actionsWidth)
      + Math.max(0, sectionGap) * (1 + Number(hasIndicators) + Number(visibleGlobals.length > 0));
    for (const [index, item] of visibleGlobals.entries()) {
      width += (index === 0 ? 0 : Math.max(0, indicatorGap)) + item.width;
    }
    for (const item of visibleControls) width += Math.max(0, controlGap) + item.width;
    if (hasOverflow) width += Math.max(0, controlGap) + Math.max(0, overflowTriggerWidth);
    for (const [index, item] of visibleIndicators.entries()) {
      width += (index === 0 ? 0 : Math.max(0, indicatorGap)) + item.width;
    }
    return width;
  };

  /** Model width left once every other part of a candidate layout is accounted
   *  for, including the retained indicators. */
  const budgetFor = (visibleKeys: ReadonlySet<string>): number =>
    Math.max(0, Math.min(modelCap, availableWidth - requiredWidth(visibleKeys, 0)));

  /** Fit rule shared by the retained-item decision and the model budget: while
   *  any secondary item remains, the label is held at or above its compact
   *  reserve; an empty row may still squeeze it below that reserve. Item-only
   *  callers (no model picker) reserve nothing, and their required-width
   *  arithmetic matches the historical item allocator exactly. */
  const fits = (visibleKeys: ReadonlySet<string>): boolean =>
    requiredWidth(visibleKeys, visibleKeys.size > 0 ? modelReserve : 0) <= availableWidth;

  const visibleInPresentationOrder = (keys: ReadonlySet<string>): readonly string[] => normalizedItems
    .filter((item) => keys.has(item.key))
    .map((item) => item.key);

  const visibleKeys = new Set(normalizedItems.filter((item) => !item.overflowOnly).map((item) => item.key));
  if (fits(visibleKeys)) {
    return { visibleItemKeys: visibleInPresentationOrder(visibleKeys), modelWidthBudget: budgetFor(visibleKeys) };
  }

  const overriddenItems = normalizedItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.overflowOnly && item.removalPriority !== undefined)
    .sort((a, b) => (a.item.removalPriority ?? 0) - (b.item.removalPriority ?? 0) || b.index - a.index)
    .map(({ item }) => item);
  const isOverridden = (item: (typeof normalizedItems)[number]): boolean => item.removalPriority !== undefined;
  // The former leading-prefix allocator removed controls from the end of their
  // row sequence. Preserve that direction within secondary controls.
  const controlsToRemove = normalizedItems
    .filter((item) => item.kind === 'control' && !item.overflowOnly && !isOverridden(item))
    .reverse();
  const indicatorsToRemove = normalizedItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.kind === 'indicator' && !item.overflowOnly && !isOverridden(item))
    .sort((a, b) => (INDICATOR_REMOVAL_PRIORITY[a.item.key] ?? 0)
      - (INDICATOR_REMOVAL_PRIORITY[b.item.key] ?? 0) || b.index - a.index)
    .map(({ item }) => item);

  const globalsToRemove = normalizedItems.filter((item) => item.kind === 'global' && !item.overflowOnly && !isOverridden(item));
  for (const item of [...overriddenItems, ...controlsToRemove, ...globalsToRemove, ...indicatorsToRemove]) {
    visibleKeys.delete(item.key);
    if (fits(visibleKeys)) {
      return { visibleItemKeys: visibleInPresentationOrder(visibleKeys), modelWidthBudget: budgetFor(visibleKeys) };
    }
  }
  // Pinned controls and Send/Stop are mandatory even in a pathological row
  // narrower than their combined minimum. Keep the overflow affordance and the
  // surviving width rather than silently dropping eligible items.
  return { visibleItemKeys: [], modelWidthBudget: budgetFor(visibleKeys) };
}

/** Item-only allocation without the compact-model stage: the pinned width is
 *  taken as measured and items are yielded per the built-in removal order. */
export function allocateComposerOverflow(
  input: Omit<ComposerToolbarAllocationInput, 'modelNaturalWidth'>,
): string[] {
  return [...allocateComposerToolbar({ ...input, modelNaturalWidth: 0 }).visibleItemKeys];
}