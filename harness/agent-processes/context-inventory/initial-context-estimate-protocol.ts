import type { SdkPatchIdentity } from '../lib/sdk-integration/sdk-patch-barrier.js';

export const INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION = 1 as const;

export interface InitialContextEstimateWorkerInitialization {
  protocolVersion: typeof INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION;
  kind: 'initialize';
  sdkPath: string;
  sdkPatchIdentity: SdkPatchIdentity;
  parentPid: number;
}

export interface InitialContextEstimateWorkerReady {
  protocolVersion: typeof INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION;
  kind: 'ready';
  timings?: { sdkImportDurationMs?: number };
}
