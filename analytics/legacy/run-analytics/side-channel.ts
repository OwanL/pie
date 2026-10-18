/** Privacy scrubbing for preserved global analytics side-channel logs. */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import { atomicWriteText } from '../../../lib/temporary-files/atomic-write';

/**
 * Derive the global log root from a workspace-specific run store directory.
 * Run stores live at `<configRoot>/data/outcomes/<hash>`, so walking up two
 * levels yields the data root. If the path does not follow that convention,
 * fall back to the supplied directory.
 */
export function inferGlobalLogRoot(storageDir: string): string {
  const normalized = path.normalize(storageDir);
  const parent = path.dirname(normalized);            // outcomes
  const grandparent = path.dirname(parent);          // data
  const configRoot = path.dirname(grandparent);       // repository / global config root
  if (path.basename(parent) === 'outcomes' && path.basename(grandparent) === 'data') {
    return configRoot;
  }
  return normalized;
}

/** Scrub global analytics side-channel logs for one private session. The
 * records are global files, so deleting only the workspace run snapshot is not
 * sufficient. Malformed lines are preserved conservatively. */
export async function forgetGlobalSideChannels(
  configRoot: string,
  sessionPath: string,
  sessionId?: string,
): Promise<void> {
  const ids = new Set([sessionId, sessionPath].filter((value): value is string => !!value));
  for (const fileName of ['pruning.jsonl', 'tool-result-pruning.jsonl', 'warm-bash.jsonl']) {
    for (const suffix of ['', '.1', '.2']) {
      const filePath = path.join(configRoot, 'data', `${fileName}${suffix}`);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const kept: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: Record<string, unknown> | undefined;
        try {
          const value = JSON.parse(trimmed);
          if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
        } catch {
          kept.push(line);
          continue;
        }
        const belongsToSession = parsed && (
          (typeof parsed.sessionId === 'string' && ids.has(parsed.sessionId))
          || (typeof parsed.rootSessionId === 'string' && ids.has(parsed.rootSessionId))
          || (typeof parsed.sessionPath === 'string' && parsed.sessionPath === sessionPath)
        );
        if (!belongsToSession) kept.push(line);
      }
      const next = kept.length > 0 ? `${kept.join('\n')}\n` : '';
      if (next !== raw) await atomicWriteText(filePath, next);
    }
  }
}

/** Scrub global side-channel logs for a subject using any run-store roots that
 * share the data root. This operation is independent of run-analytics storage
 * authority; canonical close uses only its resolved run-store location and
 * never starts or writes the legacy analytics store. */
export async function forgetGlobalSideChannelsForStorageDirs(
  storageDirs: readonly string[],
  sessionPath: string,
  sessionId?: string,
): Promise<void> {
  const roots = [...new Set(storageDirs.map(inferGlobalLogRoot))];
  for (const root of roots) {
    await forgetGlobalSideChannels(root, sessionPath, sessionId);
  }
}
