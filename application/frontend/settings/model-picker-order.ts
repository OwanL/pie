import { formatModelSpec, type ModelPickerEntry } from '../composer/model-list';

export type ModelSortKey = 'name' | 'provider' | 'input' | 'output' | 'images';
export interface ModelSort { key: ModelSortKey; descending: boolean }

export function sortModelPickerEntries(entries: readonly ModelPickerEntry[], favorites: readonly string[], sort: ModelSort): ModelPickerEntry[] {
  const compareText = (a: string, b: string) => a.localeCompare(b);
  const name = (entry: ModelPickerEntry) => entry.selectedLabel.replace(/^⚠\s*/, '');
  const tie = (a: ModelPickerEntry, b: ModelPickerEntry) =>
    compareText(name(a), name(b)) || compareText(a.model.provider, b.model.provider) || compareText(a.model.id, b.model.id);
  return [...entries].sort((a, b) => {
    const group = Number(favorites.includes(formatModelSpec(b.model))) - Number(favorites.includes(formatModelSpec(a.model)));
    if (group) return group;
    let order = 0;
    if (sort.key === 'input' || sort.key === 'output') {
      const av = a.model.subagent?.pricing?.[sort.key];
      const bv = b.model.subagent?.pricing?.[sort.key];
      const missingA = av == null || !Number.isFinite(av);
      const missingB = bv == null || !Number.isFinite(bv);
      if (missingA !== missingB) return missingA ? 1 : -1;
      if (!missingA && !missingB) order = av! - bv!;
    } else if (sort.key === 'images') order = Number(a.supportsImages) - Number(b.supportsImages);
    else if (sort.key === 'provider') order = compareText(a.model.provider, b.model.provider);
    else order = compareText(name(a), name(b));
    return (sort.descending ? -order : order) || tie(a, b);
  });
}
