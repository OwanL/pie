export const ADMISSION_FALLBACK_CUSTOM_TYPE = 'pie.session-title-admission-fallback';

interface TitleManager {
  getEntries(): readonly unknown[];
  appendCustomEntry?: (customType: string, data: unknown) => unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Markers refer to an entry identity, never merely to its text. */
export function getAdmissionFallbackTitle(manager: TitleManager): string | undefined {
  let latest: Record<string, unknown> | undefined;
  let fallback: string | undefined;
  for (const value of manager.getEntries()) {
    const entry = record(value);
    if (entry?.type === 'session_info') {
      latest = entry;
      fallback = undefined;
    } else if (entry?.type === 'custom' && entry.customType === ADMISSION_FALLBACK_CUSTOM_TYPE) {
      const data = record(entry.data);
      if (latest && typeof latest.id === 'string' && latest.id
        && typeof latest.name === 'string' && latest.name.trim()
        && data?.version === 1 && data.titleEntryId === latest.id && data.name === latest.name) {
        fallback = latest.name;
      }
    }
  }
  return fallback;
}

export function appendAdmissionFallbackMarker(manager: TitleManager): void {
  const latest = [...manager.getEntries()].reverse().map(record).find((entry) => entry?.type === 'session_info');
  if (typeof manager.appendCustomEntry !== 'function' || !latest
    || typeof latest.id !== 'string' || !latest.id
    || typeof latest.name !== 'string' || !latest.name.trim()) {
    throw new Error('Admission fallback requires a durable title entry and custom-entry writer.');
  }
  manager.appendCustomEntry(ADMISSION_FALLBACK_CUSTOM_TYPE, {
    version: 1, titleEntryId: latest.id, name: latest.name,
  });
}
