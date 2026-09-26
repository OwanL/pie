import * as crypto from 'node:crypto';

import type { ComposerInput } from '../../../harness/agent-processes/lib/rpc/composer-input.js';
import type { RunSnapshot } from '../run-analytics/types.js';

/** Stable workspace directory key used by the legacy analytics store. */
export function workspaceHash(workspaceId: string): string {
  return crypto.createHash('sha256').update(workspaceId).digest('hex').slice(0, 16);
}

/** Capture privacy-safe input-kind and attachment-size facts for a run. */
export function summarizeInputs(run: RunSnapshot, inputs: ComposerInput[]): void {
  const kindsUsed = new Set<ComposerInput['kind']>(run.inputKindsUsed);

  for (const input of inputs) {
    kindsUsed.add(input.kind);
    switch (input.kind) {
      case 'filesystemPathRef':
        run.filesystemPathRefCount += 1;
        break;
      case 'imageBlob':
        run.imageInputCount += 1;
        run.imageInputBytes += input.sizeBytes;
        break;
      case 'fileBlob':
        run.unsupportedInputCount += 1;
        break;
    }
  }

  run.inputKindsUsed = [...kindsUsed];
}

/** Append values while preserving first-seen order and uniqueness. */
export function appendUnique<TValue>(values: TValue[], nextValues: TValue[]): TValue[] {
  return [...new Set([...values, ...nextValues])];
}
