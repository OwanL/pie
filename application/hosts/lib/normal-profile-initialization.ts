import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResolvedAgentDir } from './agent-dir-resolution';

/** Called only by admitted host startup, with its original path selection.
 * Existing files (including malformed settings) are entirely user-owned. */
export function initializeNormalProfile(selection: ResolvedAgentDir): void {
  if (selection.source !== 'normal') return;
  fs.mkdirSync(selection.agentDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(selection.agentDir, 'settings.json'), '{}', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
