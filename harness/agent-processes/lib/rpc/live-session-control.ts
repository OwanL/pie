import { BackendError } from '../../coordinator/server-io.js';

/**
 * Shared contract for the narrow host-owned live membership/list projection
 * bridge (agent session-control refinement §§1–2).
 *
 * The host is the only authority for live membership: its `openTabPaths` (minus
 * pending placeholder paths) plus its non-terminal host-owned close operations
 * decide which sessions are admitted live targets and which are closing
 * reservations. The host projects that state — plus compact existing
 * activity/request-timing/usage projections — to the coordinator through the
 * typed `session.liveMembership` RPC at startup restoration and after every
 * reducer transition, strictly ordered before later host mutations on the same
 * FIFO transport. The coordinator stores the latest snapshot in memory only;
 * this is never a second durable session list. Closed sessions are excluded by
 * definition (their tab was removed and their close operation terminalized or
 * never started) and must not be revived through any addressable flow.
 */

export const HOST_LIVE_MEMBERSHIP_METHOD = 'session.liveMembership';

export const MAX_LIVE_MEMBERSHIP_SESSIONS = 256;
export const MAX_LIVE_MEMBERSHIP_CLOSING = 256;

const PATH_MAX_BYTES = 16 * 1024;
const SESSION_ID_MAX_BYTES = 512;
const LABEL_MAX_BYTES = 1024;
const TITLE_MAX_BYTES = 512;

/** Coarse host-projected activity, distinct from the coordinator's own hot
 *  route state. `running` covers any billable execution (turn, tools,
 *  subagents, compaction, retry); `waiting-user-input` is an ask_user/inline
 *  UI request pending on the session. */
export type LiveSessionActivity = 'idle' | 'running' | 'waiting-user-input';

export interface LiveSessionUsageProjection {
  /** Cumulative session working time reconstructed from the host billable
   *  invocation ledger (existing authority; tab age is never working time).
   *  Absent means the session ledger exposes no measurable durations. */
  workingTimeMs?: number;
  /** Cumulative cost with provenance; provider-reported before calculated. */
  costUsd?: number;
  costProvenance?: 'reported' | 'estimated';
  /** Explicit incompleteness markers projected from the existing usage
   *  snapshot; the coordinator must not present them as fresh/complete. */
  unpricedInvocations?: number;
  incompleteInvocations?: number;
  freshness?: 'fresh' | 'stale' | 'unknown';
}

/** One host-admitted live session. `title` is reserved for the assigned-title
 *  owner (LiveSessionTitles); until that module supplies it, `name` is the
 *  provisional display label and is not an assigned title target. */
export interface LiveSessionMembershipEntry {
  path: string;
  name?: string;
  /** Assigned unique tool title, supplied by the host title owner. */
  title?: string;
  sessionId?: string;
  cwd?: string;
  agentCreated?: boolean;
  /** A running session whose tab was intentionally hidden (still in use). */
  hidden?: boolean;
  modelId?: string;
  provider?: string;
  thinkingLevel?: string;
  activity: LiveSessionActivity;
  /** Active tool executions; includes subagent launches. */
  runningTools?: number;
  /** Active subagent launches; overlaps `runningTools` and exposes no details. */
  runningSubagents?: number;
  /** Epoch ms of the current request's start (waits included). Absent when idle. */
  requestStartedAt?: number;
  usage?: LiveSessionUsageSnapshot;
}

export interface LiveSessionUsageSnapshot {
  workingTimeMs?: number;
  costUsd?: number;
  costProvenance?: 'reported' | 'estimated';
  unpricedInvocations?: number;
  incompleteInvocations?: number;
  freshness?: 'fresh' | 'stale' | 'unknown';
}

/** One host-owned non-terminal close operation. Closing reservations are
 *  addressability reservations, not admitted live targets. */
export interface LiveSessionClosingEntry {
  path: string;
  operationId: string;
  privacyMode?: boolean;
  source?: 'agent' | 'host';
}

export interface HostLiveMembershipSnapshotParams {
  /** Monotonic host bridge revision. A snapshot must never regress. */
  revision: number;
  /** Epoch ms when the host reduced this snapshot. */
  timestamp: number;
  sessions: readonly LiveSessionMembershipEntry[];
  closing: readonly LiveSessionClosingEntry[];
}

export interface HostLiveMembershipResult {
  ok: true;
  appliedRevision: number;
}

function fail(method: string, detail: string): never {
  throw new BackendError('INVALID_PARAMS', `Invalid params for ${method}: ${detail}`);
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateMembershipEntry(raw: unknown, index: number): LiveSessionMembershipEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}] must be an object`);
  }
  const entry = raw as Record<string, unknown>;
  if (!isBoundedString(entry['path'], PATH_MAX_BYTES)) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].path must be a bounded string`);
  }
  if (entry['name'] !== undefined && !isBoundedString(entry['name'], LABEL_MAX_BYTES)) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].name must be a bounded string`);
  }
  if (entry['title'] !== undefined && !isBoundedString(entry['title'], TITLE_MAX_BYTES)) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].title must be a bounded string`);
  }
  if (entry['sessionId'] !== undefined && !isBoundedString(entry['sessionId'], SESSION_ID_MAX_BYTES)) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].sessionId must be a bounded string`);
  }
  if (entry['cwd'] !== undefined && !isBoundedString(entry['cwd'], PATH_MAX_BYTES)) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].cwd must be a bounded string`);
  }
  const activity = entry['activity'];
  if (activity !== 'idle' && activity !== 'running' && activity !== 'waiting-user-input') {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].activity must be idle, running, or waiting-user-input`);
  }
  if (entry['runningTools'] !== undefined && !isNonNegativeSafeInteger(entry['runningTools'])) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].runningTools must be a non-negative integer`);
  }
  if (entry['runningSubagents'] !== undefined && !isNonNegativeSafeInteger(entry['runningSubagents'])) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].runningSubagents must be a non-negative integer`);
  }
  if (entry['requestStartedAt'] !== undefined && !isNonNegativeFiniteNumber(entry['requestStartedAt'])) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].requestStartedAt must be a non-negative finite number`);
  }
  for (const optionalString of ['modelId', 'provider', 'thinkingLevel'] as const) {
    if (entry[optionalString] !== undefined && !isBoundedString(entry[optionalString], SESSION_ID_MAX_BYTES)) {
      fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].${optionalString} must be a bounded string`);
    }
  }
  let usage: LiveSessionUsageSnapshot | undefined;
  if (entry['usage'] !== undefined) {
    if (!entry['usage'] || typeof entry['usage'] !== 'object' || Array.isArray(entry['usage'])) {
      fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].usage must be an object`);
    }
    const rawUsage = entry['usage'] as Record<string, unknown>;
    if (rawUsage['workingTimeMs'] !== undefined && !isNonNegativeFiniteNumber(rawUsage['workingTimeMs'])) {
      fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].usage.workingTimeMs must be a non-negative finite number`);
    }
    if (rawUsage['costUsd'] !== undefined && !isNonNegativeFiniteNumber(rawUsage['costUsd'])) {
      fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].usage.costUsd must be a non-negative finite number`);
    }
    if (rawUsage['costProvenance'] !== undefined
      && rawUsage['costProvenance'] !== 'reported' && rawUsage['costProvenance'] !== 'estimated') {
      fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].usage.costProvenance must be reported or estimated`);
    }
    if (rawUsage['unpricedInvocations'] !== undefined && !isNonNegativeSafeInteger(rawUsage['unpricedInvocations'])) {
      fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].usage.unpricedInvocations must be a non-negative integer`);
    }
    if (rawUsage['incompleteInvocations'] !== undefined && !isNonNegativeSafeInteger(rawUsage['incompleteInvocations'])) {
      fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].usage.incompleteInvocations must be a non-negative integer`);
    }
    if (rawUsage['freshness'] !== undefined
      && rawUsage['freshness'] !== 'fresh' && rawUsage['freshness'] !== 'stale' && rawUsage['freshness'] !== 'unknown') {
      fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions[${index}].usage.freshness must be fresh, stale, or unknown`);
    }
    usage = {
      ...(rawUsage['workingTimeMs'] !== undefined ? { workingTimeMs: rawUsage['workingTimeMs'] as number } : {}),
      ...(rawUsage['costUsd'] !== undefined ? { costUsd: rawUsage['costUsd'] as number } : {}),
      ...(rawUsage['costProvenance'] !== undefined
        ? { costProvenance: rawUsage['costProvenance'] as 'reported' | 'estimated' } : {}),
      ...(rawUsage['unpricedInvocations'] !== undefined
        ? { unpricedInvocations: rawUsage['unpricedInvocations'] as number } : {}),
      ...(rawUsage['incompleteInvocations'] !== undefined
        ? { incompleteInvocations: rawUsage['incompleteInvocations'] as number } : {}),
      ...(rawUsage['freshness'] !== undefined
        ? { freshness: rawUsage['freshness'] as 'fresh' | 'stale' | 'unknown' } : {}),
    };
  }
  return {
    path: entry['path'] as string,
    ...(entry['name'] !== undefined ? { name: entry['name'] as string } : {}),
    ...(entry['title'] !== undefined ? { title: entry['title'] as string } : {}),
    ...(entry['sessionId'] !== undefined ? { sessionId: entry['sessionId'] as string } : {}),
    ...(entry['cwd'] !== undefined ? { cwd: entry['cwd'] as string } : {}),
    ...(entry['agentCreated'] === true ? { agentCreated: true } : {}),
    ...(entry['hidden'] === true ? { hidden: true } : {}),
    ...(entry['modelId'] !== undefined ? { modelId: entry['modelId'] as string } : {}),
    ...(entry['provider'] !== undefined ? { provider: entry['provider'] as string } : {}),
    ...(entry['thinkingLevel'] !== undefined ? { thinkingLevel: entry['thinkingLevel'] as string } : {}),
    activity: activity as LiveSessionActivity,
    ...(entry['runningTools'] !== undefined ? { runningTools: entry['runningTools'] as number } : {}),
    ...(entry['runningSubagents'] !== undefined ? { runningSubagents: entry['runningSubagents'] as number } : {}),
    ...(entry['requestStartedAt'] !== undefined ? { requestStartedAt: entry['requestStartedAt'] as number } : {}),
    ...(usage ? { usage } : {}),
  };
}

function validateClosingEntry(raw: unknown, index: number): LiveSessionClosingEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `closing[${index}] must be an object`);
  }
  const entry = raw as Record<string, unknown>;
  if (!isBoundedString(entry['path'], PATH_MAX_BYTES)) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `closing[${index}].path must be a bounded string`);
  }
  if (!isBoundedString(entry['operationId'], SESSION_ID_MAX_BYTES)) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `closing[${index}].operationId must be a bounded string`);
  }
  const source = entry['source'];
  if (source !== undefined && source !== 'agent' && source !== 'host') {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `closing[${index}].source must be agent or host`);
  }
  return {
    path: entry['path'] as string,
    operationId: entry['operationId'] as string,
    ...(entry['privacyMode'] === true ? { privacyMode: true } : {}),
    ...(source !== undefined ? { source: source as 'agent' | 'host' } : {}),
  };
}

/** Validate one ordered host→coordinator live membership snapshot. */
export function validateHostLiveMembership(params: unknown): HostLiveMembershipSnapshotParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, 'expected an object');
  }
  const snapshot = params as Record<string, unknown>;
  if (!isNonNegativeSafeInteger(snapshot['revision']) || (snapshot['revision'] as number) < 1) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, 'revision must be a positive integer');
  }
  if (!isNonNegativeFiniteNumber(snapshot['timestamp'])) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, 'timestamp must be a non-negative finite number');
  }
  if (!Array.isArray(snapshot['sessions']) || snapshot['sessions'].length > MAX_LIVE_MEMBERSHIP_SESSIONS) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `sessions must be an array of at most ${MAX_LIVE_MEMBERSHIP_SESSIONS} entries`);
  }
  if (!Array.isArray(snapshot['closing']) || snapshot['closing'].length > MAX_LIVE_MEMBERSHIP_CLOSING) {
    fail(HOST_LIVE_MEMBERSHIP_METHOD, `closing must be an array of at most ${MAX_LIVE_MEMBERSHIP_CLOSING} entries`);
  }
  return {
    revision: snapshot['revision'] as number,
    timestamp: snapshot['timestamp'] as number,
    sessions: (snapshot['sessions'] as unknown[]).map((entry, index) => validateMembershipEntry(entry, index)),
    closing: (snapshot['closing'] as unknown[]).map((entry, index) => validateClosingEntry(entry, index)),
  };
}