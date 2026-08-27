import * as fs from 'node:fs';

import type {
  DetailResult,
  LazyDetailRef,
  ModelInfo,
  ModelSettings,
  SessionOpenedPayload,
  TranscriptMode,
  TranscriptPageDirection,
  TranscriptPagePayload,
} from '../shared/protocol';
import type { SessionSnapshotTransport } from '../shared/transcript-window';
import type { SdkPatchIdentity } from './sdk-patch-barrier';

export const COLD_BROWSE_HELPER_PROTOCOL_VERSION = 1 as const;
export const COLD_BROWSE_HELPER_MAX_FRAME_BYTES = 32 * 1024 * 1024;

export interface ColdBrowseHelperFence {
  readonly coordinatorGeneration: number;
  readonly sessionPath: string;
  readonly sessionPathKey: string;
  readonly ownershipRevision: number;
  readonly fingerprint: string;
}

export interface ColdBrowseHelperOpenOptions {
  readonly modelSettings: ModelSettings;
  readonly availableModels?: ModelInfo[];
  readonly selectionToken?: string;
  readonly operationId?: string;
  readonly operationAttempt?: number;
  readonly transcript?: TranscriptMode;
  readonly transport?: SessionSnapshotTransport;
  readonly systemPromptDisabledEntries?: readonly string[];
}

export interface ColdBrowseHelperPageOptions {
  readonly transport: SessionSnapshotTransport;
  readonly requiredMessageId?: string;
}

export type ColdBrowseHelperOperation =
  | {
      readonly operation: 'open';
      readonly fence: ColdBrowseHelperFence;
      readonly options: ColdBrowseHelperOpenOptions;
    }
  | {
      readonly operation: 'page';
      readonly fence: ColdBrowseHelperFence;
      readonly direction: TranscriptPageDirection;
      readonly loadedStart?: number;
      readonly loadedEnd?: number;
      readonly options: ColdBrowseHelperPageOptions;
    }
  | {
      readonly operation: 'detail';
      readonly fence: ColdBrowseHelperFence;
      readonly ref: LazyDetailRef;
    }
  | {
      readonly operation: 'invalidate';
      readonly sessionPathKey: string;
    };

export interface ColdBrowseHelperInitializeFrame {
  readonly protocolVersion: typeof COLD_BROWSE_HELPER_PROTOCOL_VERSION;
  readonly kind: 'initialize';
  readonly sdkPath: string;
  readonly sdkPatchIdentity: SdkPatchIdentity;
  readonly startupCwd: string;
  readonly parentPid: number;
  readonly maxSourceBytes?: number;
  readonly maxEntries?: number;
}

export interface ColdBrowseHelperRequestFrame {
  readonly protocolVersion: typeof COLD_BROWSE_HELPER_PROTOCOL_VERSION;
  readonly kind: 'request';
  readonly requestId: string;
  readonly payload: ColdBrowseHelperOperation;
}

export interface ColdBrowseHelperShutdownFrame {
  readonly protocolVersion: typeof COLD_BROWSE_HELPER_PROTOCOL_VERSION;
  readonly kind: 'shutdown';
}

export type ColdBrowseHelperInputFrame =
  | ColdBrowseHelperInitializeFrame
  | ColdBrowseHelperRequestFrame
  | ColdBrowseHelperShutdownFrame;

export interface ColdBrowseHelperReadyFrame {
  readonly protocolVersion: typeof COLD_BROWSE_HELPER_PROTOCOL_VERSION;
  readonly kind: 'ready';
}

export interface ColdBrowseHelperSuccessFrame {
  readonly protocolVersion: typeof COLD_BROWSE_HELPER_PROTOCOL_VERSION;
  readonly kind: 'response';
  readonly requestId: string;
  readonly ok: true;
  readonly fingerprint?: string;
  readonly result: SessionOpenedPayload | TranscriptPagePayload | DetailResult | { invalidated: true };
}

export interface ColdBrowseHelperErrorFrame {
  readonly protocolVersion: typeof COLD_BROWSE_HELPER_PROTOCOL_VERSION;
  readonly kind: 'response';
  readonly requestId: string;
  readonly ok: false;
  /** Present when the failed operation was fenced to one durable file image. */
  readonly fingerprint?: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly data?: unknown;
  };
}

export interface ColdBrowseHelperShutdownCompleteFrame {
  readonly protocolVersion: typeof COLD_BROWSE_HELPER_PROTOCOL_VERSION;
  readonly kind: 'shutdown-complete';
}

export type ColdBrowseHelperOutputFrame =
  | ColdBrowseHelperReadyFrame
  | ColdBrowseHelperSuccessFrame
  | ColdBrowseHelperErrorFrame
  | ColdBrowseHelperShutdownCompleteFrame;

/** Exact durable identity shared by coordinator and browse helper. */
export function readColdBrowseFingerprintSync(sessionPath: string): string {
  try {
    const stat = fs.statSync(sessionPath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

export function coldBrowseSourceBytes(fingerprint: string): number | undefined {
  const rawSize = fingerprint.split(':').at(-3);
  if (!rawSize || !/^\d+$/u.test(rawSize)) return undefined;
  const value = Number(rawSize);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
