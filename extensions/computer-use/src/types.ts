export const COMPUTER_PROTOCOL_VERSION = 1 as const;
export const MAX_JSONL_BYTES = 1024 * 1024;
export const MAX_OBSERVATION_ELEMENTS = 250;
export const MAX_OBSERVATION_BYTES = 32 * 1024;
export const MAX_SEQUENCE_ACTIONS = 10_000;
export const MAX_SEQUENCE_MS = 10 * 60 * 1000;

export type MouseButton = 'left' | 'middle' | 'right';
export type CoordinateScope = 'target' | 'desktop';

export interface CoordinateTarget {
  x: number;
  y: number;
  scope?: CoordinateScope;
}
export interface ReferenceTarget { ref: string }
export type PointTarget = CoordinateTarget | ReferenceTarget;

export type ComputerAction =
  | { kind: 'move'; target: PointTarget; durationMs?: number }
  | { kind: 'mouse_down'; button: MouseButton }
  | { kind: 'mouse_up'; button: MouseButton }
  | { kind: 'click' | 'double_click' | 'right_click'; target: PointTarget; button?: MouseButton }
  | { kind: 'drag'; from?: PointTarget; to?: PointTarget; path?: PointTarget[]; durationMs?: number; button?: MouseButton }
  | { kind: 'scroll'; target?: PointTarget; deltaX?: number; deltaY?: number }
  | { kind: 'key_down' | 'key_up' | 'press'; key: string }
  | { kind: 'hotkey'; keys: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'wait'; durationMs: number }
  | { kind: 'focus' }
  | { kind: 'release_all' };

export interface SequenceStep { atMs: number; action: ComputerAction }
export interface ComputerSequence { version: 1; actions: SequenceStep[] }

export type OpenSelector =
  | { kind: 'desktop' | 'foreground' }
  | { kind: 'pid'; pid: number }
  | { kind: 'title'; title: string }
  | { kind: 'window_id'; windowId: number; pid?: number }
  | { kind: 'process'; process: string; launch?: boolean; args?: string[] }
  | { kind: 'path'; path: string; args?: string[] };

export interface OpenParams { action: 'open'; selector: OpenSelector; sessionId?: string }
export interface ObserveParams {
  action: 'observe'; sessionId: string; targetId?: string;
  state?: boolean; screenshot?: boolean; tree?: boolean;
}
export interface ActParams { action: 'act'; sessionId: string; targetId?: string; revision?: number; input: ComputerAction }
export interface RunSequenceParams {
  action: 'run_sequence'; sessionId: string; targetId?: string; revision?: number;
  sequence?: ComputerSequence; sequencePath?: string; preserveHeld?: boolean;
}
export interface CloseParams { action: 'close'; sessionId: string; closeApplication?: boolean }
export type ComputerParams = OpenParams | ObserveParams | ActParams | RunSequenceParams | CloseParams;

export interface HeldState { keys: string[]; buttons: MouseButton[] }
export interface SessionHeldState { sessionId: string; held: HeldState }
export interface DesktopCursor { x: number; y: number }
export interface Geometry {
  bounds: { x: number; y: number; width: number; height: number };
  screenshot?: { width: number; height: number };
  coordinateSpace: 'screenshot-relative';
}
export interface ComputerTarget {
  id: string; kind: 'desktop' | 'window'; pid?: number; windowId?: number;
  title?: string; process?: string; geometry?: Geometry;
}

export interface RuntimeErrorShape {
  code: string; message: string; retryable?: boolean;
  held?: HeldState; heldBySession?: SessionHeldState[];
}
export interface RuntimeResponse {
  sessionId?: string; targetId?: string; target?: ComputerTarget;
  revision?: number; elements?: unknown[]; tree?: string; truncated?: boolean;
  accessibilityAvailable?: boolean; degraded?: { reason: string; fallback?: string };
  fullImagePath?: string; displayImagePath?: string; imageWidth?: number; imageHeight?: number; fullImageWidth?: number; fullImageHeight?: number;
  sequencePath?: string; tracePath?: string; held?: HeldState; heldBySession?: SessionHeldState[]; cursor?: DesktopCursor;
  capabilities?: Record<string, boolean>; state?: Record<string, unknown>;
  closedApplication?: boolean;
}
