import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';

import { deriveSessionNameFromText, NEW_SESSION_NAME } from './session-name';
import type { SessionSummary } from '../../agent-processes/lib/rpc/session-events.js';
import { normalizeThinkingLevel } from '../../model-providers/catalog/thinking-level.js';
import type { SessionContext } from '../../agent-processes/coordinator/server-types.js';
import { resolveActiveModel } from '../../model-providers/catalog/model-catalog';
import {
  AGENT_CREATED_SESSION_CUSTOM_TYPE,
  isAgentCreatedSession,
} from './session-provenance';
import {
  backendSessionFingerprintsEqual,
  statBackendSessionFile,
  type BackendSessionFileFingerprint,
} from '../catalog/session-directory';

export function textFromSessionMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join(' ');
  }

  return '';
}

// v2 replaces heuristic names with replaceable first-prompt snippets.
const SESSION_METADATA_CHECKPOINT_VERSION = 2;
const SESSION_METADATA_READ_CHUNK_BYTES = 256 * 1024;
const SESSION_METADATA_WITNESS_BYTES = 4 * 1024;
const SESSION_METADATA_YIELD_LINES = 256;

interface SessionMetadataAccumulator {
  headerSeen: boolean;
  invalidRoot: boolean;
  cwd: string;
  headerTimestamp?: string;
  sessionId?: string;
  agentCreated: boolean;
  explicitName: string | null;
  derivedName: string;
  derivedIsPlaceholder: boolean;
  sawFirstUserText: boolean;
  messageCount: number;
  lastActivityMs?: number;
}

/** Durable append checkpoint stored beside a session's catalog projection.
 * Bounded head/tail witnesses guard the ordinary SDK append path before a
 * growing file resumes at `parsedBytes`. They are not a hash of the whole old
 * prefix: a same-inode interior rewrite followed by an append falls back to a
 * full scan only when one of those sampled boundaries changes. */
export interface SessionMetadataCheckpoint {
  version: 2;
  parsedBytes: number;
  endedWithNewline: boolean;
  firstWitnessHash: string;
  tailWitnessStart: number;
  tailWitnessHash: string;
  accumulator: SessionMetadataAccumulator;
}

export interface IndexedSessionMetadata {
  fingerprint: BackendSessionFileFingerprint;
  summary: SessionSummary;
  checkpoint: SessionMetadataCheckpoint;
}

export type SessionMetadataReadResult =
  | { status: 'ok'; metadata: IndexedSessionMetadata; resumedAppend: boolean }
  | { status: 'invalid' }
  | { status: 'retry' };

function emptyMetadataAccumulator(): SessionMetadataAccumulator {
  return {
    headerSeen: false,
    invalidRoot: false,
    cwd: '',
    agentCreated: false,
    explicitName: null,
    derivedName: NEW_SESSION_NAME,
    derivedIsPlaceholder: true,
    sawFirstUserText: false,
    messageCount: 0,
  };
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function applyMetadataLine(line: Buffer, accumulator: SessionMetadataAccumulator): void {
  const text = line.toString('utf8').trim();
  if (!text) return;
  let entry: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    entry = parsed as Record<string, unknown>;
  } catch {
    // Match Pi's tolerant catalog reader: malformed individual rows do not
    // make the whole session disappear.
    return;
  }

  if (!accumulator.headerSeen) {
    if (entry.type !== 'session') {
      accumulator.invalidRoot = true;
      return;
    }
    accumulator.headerSeen = true;
    accumulator.cwd = typeof entry.cwd === 'string' ? entry.cwd : '';
    if (typeof entry.timestamp === 'string') accumulator.headerTimestamp = entry.timestamp;
    if (typeof entry.id === 'string' && entry.id.trim()) accumulator.sessionId = entry.id.trim();
    return;
  }
  if (accumulator.invalidRoot) return;

  if (entry.type === 'custom' && entry.customType === AGENT_CREATED_SESSION_CUSTOM_TYPE) {
    const data = entry.data;
    if (accumulator.sessionId && data && typeof data === 'object' && !Array.isArray(data)
      && (data as Record<string, unknown>).version === 1
      && (data as Record<string, unknown>).sessionId === accumulator.sessionId) {
      accumulator.agentCreated = true;
    }
    return;
  }

  if (entry.type === 'session_info') {
    accumulator.explicitName = typeof entry.name === 'string' && entry.name.trim()
      ? entry.name.trim()
      : null;
    return;
  }
  if (entry.type !== 'message') return;
  accumulator.messageCount += 1;

  const message = entry.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const sessionMessage = message as Record<string, unknown>;
  if (sessionMessage.role !== 'user' && sessionMessage.role !== 'assistant') return;
  const messageTime = isFiniteTimestamp(sessionMessage.timestamp)
    ? sessionMessage.timestamp
    : typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  if (Number.isFinite(messageTime) && messageTime > 0) {
    accumulator.lastActivityMs = Math.max(accumulator.lastActivityMs ?? 0, messageTime);
  }

  if (sessionMessage.role === 'user' && !accumulator.sawFirstUserText) {
    const userText = textFromSessionMessageContent(sessionMessage.content);
    if (userText) {
      accumulator.sawFirstUserText = true;
      const derived = deriveSessionNameFromText(userText);
      accumulator.derivedName = derived.name;
      accumulator.derivedIsPlaceholder = derived.isPlaceholder;
    }
  }
}

async function yieldMetadataReader(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function hashFileRange(
  handle: fs.FileHandle,
  start: number,
  length: number,
): Promise<string> {
  const buffer = Buffer.allocUnsafe(Math.max(0, length));
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, start + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return createHash('sha256').update(buffer.subarray(0, offset)).digest('hex');
}

async function contentWitnesses(
  handle: fs.FileHandle,
  sizeBytes: number,
): Promise<Pick<SessionMetadataCheckpoint, 'firstWitnessHash' | 'tailWitnessStart' | 'tailWitnessHash'>> {
  const firstLength = Math.min(SESSION_METADATA_WITNESS_BYTES, sizeBytes);
  const tailWitnessStart = Math.max(0, sizeBytes - SESSION_METADATA_WITNESS_BYTES);
  return {
    firstWitnessHash: await hashFileRange(handle, 0, firstLength),
    tailWitnessStart,
    tailWitnessHash: await hashFileRange(handle, tailWitnessStart, sizeBytes - tailWitnessStart),
  };
}

async function canResumeMetadataAppend(
  handle: fs.FileHandle,
  current: BackendSessionFileFingerprint,
  previous: IndexedSessionMetadata,
): Promise<boolean> {
  const old = previous.fingerprint;
  const checkpoint = previous.checkpoint;
  if (checkpoint.version !== SESSION_METADATA_CHECKPOINT_VERSION
    || !checkpoint.endedWithNewline
    || checkpoint.parsedBytes !== old.sizeBytes
    || current.sizeBytes <= old.sizeBytes
    || current.device !== old.device
    || current.inode !== old.inode) {
    return false;
  }
  const firstLength = Math.min(SESSION_METADATA_WITNESS_BYTES, old.sizeBytes);
  const firstHash = await hashFileRange(handle, 0, firstLength);
  if (firstHash !== checkpoint.firstWitnessHash) return false;
  const oldTailHash = await hashFileRange(
    handle,
    checkpoint.tailWitnessStart,
    old.sizeBytes - checkpoint.tailWitnessStart,
  );
  return oldTailHash === checkpoint.tailWitnessHash;
}

function buildIndexedSummary(
  file: BackendSessionFileFingerprint,
  accumulator: SessionMetadataAccumulator,
): SessionSummary {
  const headerTime = accumulator.headerTimestamp ? Date.parse(accumulator.headerTimestamp) : NaN;
  const statTime = Number(BigInt(file.modifiedNs) / 1_000_000n);
  const modifiedMs = accumulator.lastActivityMs
    ?? (Number.isFinite(headerTime) ? headerTime : statTime);
  const explicitName = accumulator.explicitName;
  return {
    path: file.path,
    cwd: accumulator.cwd,
    name: explicitName ?? accumulator.derivedName,
    isPlaceholder: explicitName === null ? accumulator.derivedIsPlaceholder : false,
    isAssignedTitle: explicitName !== null,
    modifiedAt: new Date(modifiedMs).toISOString(),
    messageCount: accumulator.messageCount,
    ...(accumulator.sessionId ? { sessionId: accumulator.sessionId } : {}),
    ...(accumulator.headerTimestamp ? { headerTimestamp: accumulator.headerTimestamp } : {}),
    ...(accumulator.agentCreated ? { agentCreated: true } : {}),
  };
}

/** Read exactly one session projection. An ordinary append whose bounded
 * witnesses still match resumes from the old EOF; other detected mutations
 * reparse only this file. The function yields regularly so a first-time index
 * build cannot monopolize backend RPCs. */
export async function readIndexedSessionMetadata(
  file: BackendSessionFileFingerprint,
  previous?: IndexedSessionMetadata,
): Promise<SessionMetadataReadResult> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file.path, 'r');
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { status: 'retry' } : Promise.reject(error);
  }

  try {
    const resumedAppend = previous ? await canResumeMetadataAppend(handle, file, previous) : false;
    const accumulator = resumedAppend
      ? { ...previous!.checkpoint.accumulator }
      : emptyMetadataAccumulator();
    const start = resumedAppend ? previous!.checkpoint.parsedBytes : 0;
    const targetSize = file.sizeBytes;
    let position = start;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let processedLines = 0;
    let endedWithNewline = start > 0 ? previous!.checkpoint.endedWithNewline : false;

    while (position < targetSize) {
      const readLength = Math.min(SESSION_METADATA_READ_CHUNK_BYTES, targetSize - position);
      const chunk = Buffer.allocUnsafe(readLength);
      const { bytesRead } = await handle.read(chunk, 0, readLength, position);
      if (bytesRead === 0) return { status: 'retry' };
      position += bytesRead;
      const bytes = chunk.subarray(0, bytesRead);
      let lineStart = 0;
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== 0x0a) continue;
        const segment = bytes.subarray(lineStart, index);
        const line = pendingBytes === 0
          ? segment
          : Buffer.concat([...pending, segment], pendingBytes + segment.length);
        pending = [];
        pendingBytes = 0;
        applyMetadataLine(line, accumulator);
        processedLines += 1;
        endedWithNewline = true;
        lineStart = index + 1;
        if (accumulator.invalidRoot) return { status: 'invalid' };
        if (processedLines % SESSION_METADATA_YIELD_LINES === 0) await yieldMetadataReader();
      }
      if (lineStart < bytes.length) {
        const segment = bytes.subarray(lineStart);
        pending.push(segment);
        pendingBytes += segment.length;
        endedWithNewline = false;
      }
    }
    if (pendingBytes > 0) {
      applyMetadataLine(Buffer.concat(pending, pendingBytes), accumulator);
      endedWithNewline = false;
    }
    if (!accumulator.headerSeen || accumulator.invalidRoot) return { status: 'invalid' };

    const after = await statBackendSessionFile(file.path);
    if (!after || !backendSessionFingerprintsEqual(file, after)) return { status: 'retry' };
    const witnesses = await contentWitnesses(handle, targetSize);
    // Witness reads are part of the checkpoint. Re-stat afterwards so an
    // append/rewrite between the first stat and those reads cannot pair new
    // witnesses with an old fingerprint.
    const witnessed = await statBackendSessionFile(file.path);
    if (!witnessed || !backendSessionFingerprintsEqual(after, witnessed)) return { status: 'retry' };
    const checkpoint: SessionMetadataCheckpoint = {
      version: SESSION_METADATA_CHECKPOINT_VERSION,
      parsedBytes: targetSize,
      endedWithNewline,
      ...witnesses,
      accumulator,
    };
    return {
      status: 'ok',
      resumedAppend,
      metadata: {
        fingerprint: witnessed,
        summary: buildIndexedSummary(witnessed, accumulator),
        checkpoint,
      },
    };
  } finally {
    await handle.close();
  }
}

export function deriveSessionName(context: SessionContext): { name: string; isPlaceholder: boolean } {
  const sdkName = context.session.sessionName || context.session.sessionManager.getSessionName();
  if (sdkName) {
    return { name: sdkName, isPlaceholder: false };
  }

  const entries = context.session.sessionManager.getBranch() ?? [];
  for (const entry of entries) {
    if (entry.type === 'message' && entry.message?.role === 'user') {
      const derived = deriveSessionNameFromText(
        textFromSessionMessageContent(entry.message.content),
      );
      if (derived.name !== NEW_SESSION_NAME) {
        return derived;
      }
    }
  }

  return { name: NEW_SESSION_NAME, isPlaceholder: true };
}

export function buildCurrentSummary(
  context: SessionContext,
  startupCwd: string,
): SessionSummary {
  const messageCount = context.session.messages.length ?? 0;
  const { name, isPlaceholder } = deriveSessionName(context);
  const sessionId = context.session.sessionManager.getSessionId?.()?.trim();
  // Reuse the durable SDK header rather than any mutable summary field when the
  // title authority needs the durable creation timestamp.
  const header = context.session.sessionManager.getHeader?.() as { timestamp?: unknown } | null | undefined;
  const headerTimestamp = typeof header?.timestamp === 'string' ? header.timestamp : undefined;
  const summary: SessionSummary = {
    path: context.sessionPath,
    cwd: context.session.sessionManager.getCwd() ?? startupCwd,
    name,
    isPlaceholder,
    isAssignedTitle: Boolean(context.session.sessionName?.trim()
      || context.session.sessionManager.getSessionName()?.trim()),
    modifiedAt: new Date().toISOString(),
    messageCount,
    modelId: context.session.model?.id,
    provider: resolveActiveModel(context).provider,
    thinkingLevel: normalizeThinkingLevel(context.session.thinkingLevel),
    ...(sessionId ? { sessionId } : {}),
    ...(headerTimestamp ? { headerTimestamp } : {}),
    ...(isAgentCreatedSession(context.session.sessionManager) ? { agentCreated: true } : {}),
  };
  return summary;
}
