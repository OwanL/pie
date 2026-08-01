import * as path from 'node:path';

import type { RunCheckpoint } from '../run-analytics';
import { atomicWriteText } from '../../shared/atomic-write';
import type { CheckpointSlot } from '../shared/checkpoint-slots';

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
