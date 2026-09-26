import * as path from 'node:path';

import type {
  RunCheckpoint,
} from '../run-analytics/types.js';
import { atomicWriteText } from '../../../lib/temporary-files/atomic-write';
import type { CheckpointSlot } from '../checkpoint-slots';

export async function writeCheckpointToDisk(
  storageDir: string,
  activeSlot: CheckpointSlot,
  checkpoint: RunCheckpoint,
): Promise<CheckpointSlot> {
  const nextSlot: CheckpointSlot = activeSlot === 'a' ? 'b' : 'a';
  const slotPath = path.join(storageDir, `open-runs.${nextSlot}.json`);
  const genPath = path.join(storageDir, 'open-runs.gen');

  await atomicWriteText(slotPath, JSON.stringify(checkpoint, null, 2));
  await atomicWriteText(genPath, nextSlot);
  return nextSlot;
}
