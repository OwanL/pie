import type { SdkRuntimeSelection } from '../lib/sdk-integration/sdk-runtime-selection.js';

export const INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION = 2 as const;

export interface InitialContextEstimateWorkerInitialization {
  protocolVersion: typeof INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION;
  kind: 'initialize';
  sdkPath: string;
  sdkRuntime: SdkRuntimeSelection;
  parentPid: number;
}

export interface InitialContextEstimateWorkerReady {
  protocolVersion: typeof INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION;
  kind: 'ready';
  timings?: { sdkImportDurationMs?: number };
}
