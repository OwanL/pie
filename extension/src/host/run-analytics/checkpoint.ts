import * as path from 'node:path';

import { parseCheckpoint, readOptionalText } from '../shared/checkpoint-io';
import { resolveCheckpointSlot, type ResolvedCheckpoint } from '../shared/checkpoint-slots';

/**
 * Read the A/B checkpoint slot files for a run-analytics storage directory and
 * resolve which slot is active. Returns the parsed checkpoint (or null when no
 * slot is readable) alongside the active slot identifier.
 */
export async function readCheckpointSlots(storageDir: string): Promise<ResolvedCheckpoint> {
  const genPath = path.join(storageDir, 'open-runs.gen');
  const slotAPath = path.join(storageDir, 'open-runs.a.json');
  const slotBPath = path.join(storageDir, 'open-runs.b.json');

  const [genValue, slotA, slotB] = await Promise.all([
    readOptionalText(genPath),
    readOptionalText(slotAPath),
    readOptionalText(slotBPath),
  ]);

  const checkpointA = slotA ? parseCheckpoint(slotA) : null;
  const checkpointB = slotB ? parseCheckpoint(slotB) : null;
  return resolveCheckpointSlot(genValue, checkpointA, checkpointB);
}
