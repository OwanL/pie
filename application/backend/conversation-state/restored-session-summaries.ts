import type { SessionSummary } from '../../lib/protocol/index.js';
import { isPendingTabPath } from '../../../lib/session-path.js';

export function buildRestoredSessionSummaries(
  rawTabs: readonly unknown[],
  restoredTabs: readonly string[],
  workspaceCwd: string,
  modifiedAt: string,
): SessionSummary[] {
  const restoredNames = new Map<string, string>();

  for (const value of rawTabs) {
    if (value === null || typeof value !== 'object') {
      continue;
    }

    const obj = value as Record<string, unknown>;
    const sessionPath = typeof obj['path'] === 'string' ? obj['path'] : null;
    const name = typeof obj['name'] === 'string' ? obj['name'].trim() : '';
    if (sessionPath && name) {
      restoredNames.set(sessionPath, name);
    }
  }

  return restoredTabs
    .filter((sessionPath) => !isPendingTabPath(sessionPath))
    .map((sessionPath) => {
      const restoredName = restoredNames.get(sessionPath);
      const name = restoredName ?? 'Loading...';
      return {
        path: sessionPath,
        name,
        isPlaceholder: !restoredName || name === 'New Session',
        cwd: workspaceCwd,
        modifiedAt,
        messageCount: 0,
      };
    });
}