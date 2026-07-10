import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { RunCheckpoint } from '../run-analytics';
import type { CheckpointSlot } from '../shared/checkpoint-slots';

function tempPathIn(dir: string, name: string): string {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(dir, `.${name}.${suffix}.tmp`);
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = tempPathIn(dir, path.basename(filePath));
  try {
    await fs.writeFile(tmpPath, data, 'utf8');
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

export async function writeCheckpointToDisk(
  storageDir: string,
  activeSlot: CheckpointSlot,
  checkpoint: RunCheckpoint,
): Promise<CheckpointSlot> {
  const nextSlot: CheckpointSlot = activeSlot === 'a' ? 'b' : 'a';
  const slotPath = path.join(storageDir, `open-runs.${nextSlot}.json`);
  const genPath = path.join(storageDir, 'open-runs.gen');

  await atomicWrite(slotPath, JSON.stringify(checkpoint, null, 2));
  await atomicWrite(genPath, nextSlot);
  return nextSlot;
}
