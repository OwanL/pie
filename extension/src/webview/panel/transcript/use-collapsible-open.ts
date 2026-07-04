import { useEffect, useMemo, useState } from 'preact/hooks';

import { syncCollapsibleOpenState } from '../collapsible-state';

const collapsibleOpenByKey = new Map<string, boolean>();
const collapsibleDefaultByKey = new Map<string, boolean>();

/** Clear the module-level collapsible cache. Called on host-instance change
 *  (backend restart) to prevent stale open/closed state from a previous backend
 *  instance. NOT called on session switch — keys are globally-unique
 *  message/tool ids, so open/closed state is preserved across tab switches. */
export function clearCollapsibleCache(): void {
  collapsibleOpenByKey.clear();
  collapsibleDefaultByKey.clear();
}

export function useCollapsibleOpen(storageKey: string, defaultOpen: boolean) {
  const resolvedStorageKey = useMemo(() => storageKey || '__anonymous__', [storageKey]);
  const [open, setOpen] = useState<boolean>(() => {
    if (collapsibleOpenByKey.has(resolvedStorageKey)) {
      return collapsibleOpenByKey.get(resolvedStorageKey)!;
    }
    collapsibleDefaultByKey.set(resolvedStorageKey, defaultOpen);
    return defaultOpen;
  });

  useEffect(() => {
    const previousDefaultOpen = collapsibleDefaultByKey.get(resolvedStorageKey) ?? defaultOpen;
    const currentOpen = collapsibleOpenByKey.get(resolvedStorageKey) ?? open;
    const nextOpen = syncCollapsibleOpenState(currentOpen, previousDefaultOpen, defaultOpen);
    collapsibleDefaultByKey.set(resolvedStorageKey, defaultOpen);
    collapsibleOpenByKey.set(resolvedStorageKey, nextOpen);
    setOpen(nextOpen);
  }, [resolvedStorageKey, defaultOpen]);

  useEffect(() => {
    collapsibleOpenByKey.set(resolvedStorageKey, open);
  }, [resolvedStorageKey, open]);

  return [open, setOpen] as const;
}
