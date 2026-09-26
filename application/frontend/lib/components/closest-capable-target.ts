export interface ClosestCapableEventTarget {
  closest: (selector: string) => unknown;
  parentElement?: ClosestCapableEventTarget | null;
}

export interface MaybeClosestCapableEventTarget {
  closest?: (selector: string) => unknown;
  parentElement?: MaybeClosestCapableEventTarget | null;
}

export function resolveClosestCapableTarget(target: EventTarget | null): ClosestCapableEventTarget | null {
  if (!target || typeof target !== 'object') {
    return null;
  }

  const candidate = target as MaybeClosestCapableEventTarget;
  if (typeof candidate.closest === 'function') {
    return candidate as ClosestCapableEventTarget;
  }

  if (candidate.parentElement && typeof candidate.parentElement.closest === 'function') {
    return candidate.parentElement as ClosestCapableEventTarget;
  }

  return null;
}