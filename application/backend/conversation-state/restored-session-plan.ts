import { isPendingTabPath } from '../../../lib/session-path.js';
import { readStoredOpenTabPath } from '../../frontend/session-tabs/tab-behavior';

export interface RestoredSessionPlan {
  startupPath: string | null;
  preloadPaths: string[];
}

export interface FilteredRestoredTabs {
  rawTabs: unknown[];
  openTabPaths: string[];
  droppedPaths: string[];
}

export function filterRestorableStoredTabs(
  rawTabs: readonly unknown[],
  exists: (sessionPath: string) => boolean,
): FilteredRestoredTabs {
  const seenPaths = new Set<string>();
  const openTabPaths: string[] = [];
  const droppedPaths: string[] = [];
  const filteredRawTabs: unknown[] = [];

  for (const value of rawTabs) {
    const sessionPath = readStoredOpenTabPath(value);
    if (!sessionPath || isPendingTabPath(sessionPath) || seenPaths.has(sessionPath)) {
      continue;
    }

    seenPaths.add(sessionPath);
    if (!exists(sessionPath)) {
      droppedPaths.push(sessionPath);
      continue;
    }

    openTabPaths.push(sessionPath);
    filteredRawTabs.push(value);
  }

  return {
    rawTabs: filteredRawTabs,
    openTabPaths,
    droppedPaths,
  };
}

export function buildRestoredSessionPlan(
  openTabPaths: readonly string[],
  preferredPath: string | null | undefined,
): RestoredSessionPlan {
  const startupPath = preferredPath && openTabPaths.includes(preferredPath)
    ? preferredPath
    : openTabPaths[0] ?? null;

  return {
    startupPath,
    preloadPaths: startupPath
      ? openTabPaths.filter((sessionPath) => sessionPath !== startupPath)
      : [],
  };
}
