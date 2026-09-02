export const PLAYWRIGHT_PROTOCOL_VERSION = 1 as const;
export const MAX_JSONL_BYTES = 1024 * 1024;

// Model-facing observation limits, kept below pi's generic 50 KiB / 2000-line
// tool-output ceiling so URL/title/events and fidelity markers also fit.
export const MAX_OBSERVATION_BYTES = 32 * 1024;
export const MAX_OBSERVATION_LINES = 250;
export const MAX_OBSERVATION_LINE_CHARS = 400;

// Input bounds (character counts; the UTF-8 wire record is capped separately by
// MAX_JSONL_BYTES).
export const MAX_ID_CHARS = 128;
export const MAX_URL_CHARS = 8 * 1024;
export const MAX_SELECTOR_CHARS = 16 * 1024;
export const MAX_TEXT_CHARS = 64 * 1024;
export const MAX_CODE_CHARS = 64 * 1024;
export const MAX_KEY_CHARS = 128;
export const MAX_SELECT_VALUES = 100;
export const MAX_SELECT_VALUE_CHARS = 4 * 1024;
export const MAX_UPLOAD_PATHS = 20;
export const MAX_PATH_CHARS = 4 * 1024;

export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 45_000;
export const DEFAULT_RUN_CODE_TIMEOUT_MS = 60_000;

export const MIN_OBSERVATION_DEPTH = 1;
export const MAX_OBSERVATION_DEPTH = 50;
export const DEFAULT_OBSERVATION_DEPTH = 25;

export const MAX_EVENT_LIMIT = 200;
export const DEFAULT_EVENT_LIMIT = 25;

export const VIEWPORT_LIMITS = { minWidth: 320, maxWidth: 1920, minHeight: 200, maxHeight: 1080 } as const;
export const DISPLAY_IMAGE_MAX_LONG_EDGE = 1_600;

// Fail-closed artifact caps.
export const MAX_SNAPSHOT_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_DOWNLOAD_ARTIFACT_BYTES = 128 * 1024 * 1024;
export const MAX_STORAGE_STATE_BYTES = 8 * 1024 * 1024;
export const MAX_RUN_CODE_RESULT_BYTES = 8 * 1024 * 1024;
export const MAX_SESSION_ARTIFACT_BYTES = 512 * 1024 * 1024;

export type ObservationMode = 'auto' | 'full' | 'none';
export type CloseScope = 'session' | 'runtime';

export interface ViewportSize { width: number; height: number }

export interface TargetRef { ref: string; revision: number }
export interface TargetSelector { selector: string }
export type ElementTarget = TargetRef | TargetSelector;

export interface WaitCondition {
  timeMs?: number;
  url?: string;
  text?: string;
  selector?: string;
}

export type PlaywrightInput =
  | { kind: 'navigate'; url: string }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'reload' }
  | { kind: 'click'; target: ElementTarget }
  | { kind: 'double_click'; target: ElementTarget }
  | { kind: 'fill'; target: ElementTarget; value: string }
  | { kind: 'type'; target: ElementTarget; text: string }
  | { kind: 'press'; key: string; target?: ElementTarget }
  | { kind: 'select'; target: ElementTarget; values: string[] }
  | { kind: 'check'; target: ElementTarget }
  | { kind: 'uncheck'; target: ElementTarget }
  | { kind: 'hover'; target: ElementTarget }
  | { kind: 'focus'; target: ElementTarget }
  | { kind: 'upload'; target: ElementTarget; paths: string[] }
  | { kind: 'wait'; condition: WaitCondition }
  | { kind: 'tab_open'; url?: string }
  | { kind: 'tab_select'; pageId: string }
  | { kind: 'tab_close'; pageId?: string };

export interface ObservationSettings {
  mode?: ObservationMode;
  depth?: number;
  target?: ElementTarget;
  screenshot?: boolean;
  consoleLimit?: number;
  pageErrorLimit?: number;
  requestLimit?: number;
  downloadLimit?: number;
  includeTabs?: boolean;
}

export interface DialogPolicy { action: 'accept' | 'dismiss'; promptText?: string }

export interface OpenParams {
  action: 'open';
  sessionId?: string;
  url?: string;
  viewport?: ViewportSize;
  storageStatePath?: string;
  actionTimeoutMs?: number;
  navigationTimeoutMs?: number;
  observation?: ObservationSettings;
}
export interface ObserveParams { action: 'observe'; sessionId: string; pageId?: string; observation?: ObservationSettings }
export interface ActParams {
  action: 'act'; sessionId: string; pageId?: string; input: PlaywrightInput;
  timeoutMs?: number; dialog?: DialogPolicy; observation?: ObservationSettings;
}
export interface RunCodeParams {
  action: 'run_code'; sessionId: string; pageId?: string; code: string;
  timeout?: number; observation?: ObservationSettings;
}
export interface CloseParams {
  action: 'close'; scope: CloseScope; sessionId?: string; exportStorageState?: boolean;
}
export type PlaywrightParams = OpenParams | ObserveParams | ActParams | RunCodeParams | CloseParams;

/** Params as they appear on the wire: runtime-internal fields merged in by the extension. */
export interface WiredOpenParams extends OpenParams { sessionId: string; artifactDir: string }

export interface ConsoleEntry { seq: number; type: string; text: string }
export interface PageErrorEntry { seq: number; message: string }
export interface FailedRequestEntry { seq: number; method: string; url: string; failure: string }
export interface DownloadEntry {
  seq: number; suggestedFilename: string; url: string;
  state: 'saving' | 'saved' | 'failed' | 'too_large';
  path?: string; bytes?: number; error?: string;
}
export interface TabSummary { pageId: string; url: string; title: string; active: boolean }
export interface DialogRecord {
  result: 'accepted' | 'dismissed' | 'auto-dismissed';
  type: string; message: string; defaultValue?: string;
}

export interface SnapshotReduction {
  reason: string;
  fullSnapshotPath: string;
  depthUsed?: number;
  truncatedLines?: number;
  omittedLines?: number;
}

export interface EventBundle {
  console: ConsoleEntry[];
  pageErrors: PageErrorEntry[];
  failedRequests: FailedRequestEntry[];
  downloads: DownloadEntry[];
  dropped: { console: number; pageErrors: number; failedRequests: number; downloads: number };
}

export interface ObservationResult {
  pageId: string; url: string; title: string;
  /** Present only when a fresh snapshot established the current ref set. */
  revision?: number;
  snapshot?: string;
  reduction?: SnapshotReduction;
  refsInvalidated?: boolean;
  events: EventBundle;
  tabs?: TabSummary[];
  tabsDropped?: number;
}

export interface ScreenshotResult {
  fullImagePath: string; displayImagePath: string;
  imageWidth: number; imageHeight: number;
  sourceWidth: number; sourceHeight: number;
}

export interface RunCodeResultSummary {
  text: string; bytes: number; truncated: boolean; artifactPath?: string;
}
export interface RunCodeHelperArtifact { artifactId: string; path: string; bytes: number }

export interface RuntimeResponse {
  sessionId?: string;
  headless?: boolean;
  isolated?: boolean;
  actionKind?: string;
  observation?: ObservationResult;
  dialogs?: DialogRecord[];
  dialogsDropped?: number;
  screenshot?: ScreenshotResult;
  runCode?: RunCodeResultSummary;
  helperArtifacts?: RunCodeHelperArtifact[];
  storageStatePath?: string;
  closed?: { scope: CloseScope; sessionIds: string[]; omittedSessionIds?: number };
}

export interface RuntimeErrorShape { code: string; message: string; retryable?: boolean }

export const REF_ACTION_KINDS = new Set([
  'click', 'double_click', 'fill', 'type', 'select', 'check', 'uncheck', 'hover', 'focus', 'upload',
]);
export const STATE_CHANGING_KINDS = new Set([
  'navigate', 'back', 'forward', 'reload',
  'click', 'double_click', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'focus', 'upload',
  'wait', 'tab_open', 'tab_select', 'tab_close',
]);
export const NAVIGATION_KINDS = new Set(['navigate', 'back', 'forward', 'reload']);
