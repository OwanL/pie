import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { deriveSessionNameFromText, NEW_SESSION_NAME } from '../shared/session-name';
import { parseJsonOrThrow, toErrorMessage } from '../shared/error-message';
import type {
  ModelInfo,
  SessionSummary,
  ThinkingLevel,
} from '../shared/protocol';
import { normalizeThinkingLevel, resolveModelInputKinds } from './message-inputs';
import type { SdkCatalogModel, SdkModelRegistry, SdkModule, SdkSessionInfo } from './sdk';
import type { SessionContext } from './server-types';
import { findSubagentProfile, loadSubagentProfiles } from './subagent-profiles';
import { summarizeSession, type SessionEntryLike } from './transcript';
import { mergeReviewIntoSummary, mergeReviewsIntoSummaries, readReviews } from './session-review-store';
import { backendTrace } from './log';
import {
  backendSessionFingerprintsEqual,
  backendSessionPathKey,
  statBackendSessionFile,
  type BackendSessionFileFingerprint,
} from './session-directory';

function textFromSessionMessageContent(content: unknown): string {
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

const SESSION_METADATA_CHECKPOINT_VERSION = 1;
const SESSION_METADATA_READ_CHUNK_BYTES = 256 * 1024;
const SESSION_METADATA_WITNESS_BYTES = 4 * 1024;
const SESSION_METADATA_YIELD_LINES = 256;

interface SessionMetadataAccumulator {
  headerSeen: boolean;
  invalidRoot: boolean;
  cwd: string;
  headerTimestamp?: string;
  sessionId?: string;
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
  version: 1;
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
    modifiedAt: new Date(modifiedMs).toISOString(),
    messageCount: accumulator.messageCount,
    ...(accumulator.sessionId ? { sessionId: accumulator.sessionId } : {}),
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

export async function deriveNameFromFile(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = parseJsonOrThrow<SessionEntryLike>(line, `session metadata line ${i + 1}`);
        if (entry.type === 'message' && entry.message?.role === 'user') {
          const derived = deriveSessionNameFromText(
            textFromSessionMessageContent(entry.message.content),
          );
          if (!derived.isPlaceholder) {
            return derived.name;
          }
        }
      } catch (error) {
        backendTrace('sessionMetadata', 'deriveName.lineParseFailed', { level: 'warn', error: toErrorMessage(error), line: i + 1 });
      }
    }
  } catch (error) {
    backendTrace('sessionMetadata', 'deriveName.readFailed', { level: 'warn', error: toErrorMessage(error), filePath });
  }
  return NEW_SESSION_NAME;
}

async function deriveSessionInfoName(session: SdkSessionInfo): Promise<string> {
  const firstMessage = session.firstMessage?.trim();
  if (firstMessage === '(no messages)') return NEW_SESSION_NAME;
  if (firstMessage) return deriveSessionNameFromText(firstMessage).name;
  return await deriveNameFromFile(session.path);
}

export async function discoverSessionSummaries(
  sdk: SdkModule,
  sessionDir?: string,
): Promise<SessionSummary[]> {
  let configuredDirs: string[] = [];
  if (sessionDir) {
    configuredDirs = [sessionDir];
    try {
      const entries = await fs.readdir(sessionDir, { withFileTypes: true });
      configuredDirs.push(...entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(sessionDir, entry.name)));
    } catch {
      // A missing/unreadable configured directory still lists its top-level
      // path via listAll(sessionDir) below; canonical-only sources no longer
      // fall back to the SDK default while a root is configured.
    }
  }
  // Canonical-only listing: with a configured session directory, read it
  // (plus its per-cwd subdirectories) exclusively — the installer's verified
  // migration moved legacy sessions into the canonical store, and `npm run
  // doctor` surfaces any newly stranded legacy sessions rather than scanning
  // the legacy root forever. With nothing configured, the embedded SDK keeps
  // its own default via the bare listAll().
  const sources = await Promise.all(
    configuredDirs.length > 0
      ? configuredDirs.map((dir) => sdk.SessionManager.listAll(dir))
      : [sdk.SessionManager.listAll()],
  );
  const byPath = new Map<string, SdkSessionInfo>();
  for (const session of sources.flat()) {
    const key = backendSessionPathKey(session.path);
    if (!byPath.has(key)) byPath.set(key, session);
  }
  const sessions = [...byPath.values()];
  const summaries = await Promise.all(
    sessions.map(async (session) => {
      const summary = summarizeSession(session);
      if (summary.name === NEW_SESSION_NAME && session.path) {
        const derived = await deriveSessionInfoName(session);
        if (derived !== NEW_SESSION_NAME) {
          summary.name = derived;
          summary.isPlaceholder = false;
        } else {
          summary.isPlaceholder = true;
        }
      }
      return summary;
    }),
  );
  return summaries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

export function applySessionReviews(summaries: readonly SessionSummary[]): SessionSummary[] {
  return mergeReviewsIntoSummaries(summaries, readReviews());
}

export async function listSessions(
  sdk: SdkModule,
  sessionDir?: string,
): Promise<SessionSummary[]> {
  return applySessionReviews(await discoverSessionSummaries(sdk, sessionDir));
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
      if (!derived.isPlaceholder) {
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
  const summary: SessionSummary = {
    path: context.sessionPath,
    cwd: context.session.sessionManager.getCwd() ?? startupCwd,
    name,
    isPlaceholder,
    modifiedAt: new Date().toISOString(),
    messageCount,
    modelId: context.session.model?.id,
    provider: resolveActiveModel(context).provider,
    thinkingLevel: normalizeThinkingLevel(context.session.thinkingLevel),
  };
  return mergeReviewIntoSummary(summary, readReviews());
}

export interface ActiveModelInfo {
  /** Resolved provider name (e.g. 'umans', 'anthropic'), when the active model is found in the registry. */
  provider?: string;
  /** Active model id, when a model is selected for the session. */
  modelId?: string;
  /** Human-readable model name from the registry, when available. */
  modelName?: string;
}

/**
 * Resolve the session's active model and its provider from the model registry.
 *
 * `context.session.model` carries the selected provider when available; the
 * registry supplies its display name and provides a legacy fallback for older
 * id-only sessions. Returns an empty object when no model is selected yet or
 * the registry is unavailable — callers should render a neutral "not resolved"
 * state rather than guessing a provider.
 */
export function resolveActiveModel(context: SessionContext): ActiveModelInfo {
  const modelId = context.session.model?.id;
  if (!modelId) {
    return {};
  }

  try {
    const available = context.runtime.services?.modelRegistry?.getAvailable() ?? [];
    // The session model carries its selected provider. Prefer that exact pair:
    // model IDs such as GPT-5.6 are available through both Copilot and Codex,
    // so an id-only registry lookup can attribute a Codex turn to Copilot.
    const selectedProvider = context.session.model?.provider;
    const match = selectedProvider
      ? available.find((model) => model.id === modelId && model.provider === selectedProvider)
      : available.find((model) => model.id === modelId);
    // A provider recorded on the session remains authoritative even if the
    // currently available registry no longer contains that model.
    return match
      ? { modelId, provider: selectedProvider ?? match.provider, modelName: match.name }
      : selectedProvider ? { modelId, provider: selectedProvider } : { modelId };
  } catch (error) {
    backendTrace('sessionMetadata', 'resolveActiveModel.failed', { level: 'debug', error: toErrorMessage(error), modelId });
    return { modelId };
  }
}

const MODEL_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

/** Mirror Pi's model-level reasoning contract for the webview catalog. Standard
 * levels through `high` (including `off`) exist unless explicitly mapped to
 * null; extended `xhigh`/`max` exist only when the model maps them. */
export function resolveModelThinkingLevels(model: Record<string, unknown>): ThinkingLevel[] {
  if (model.reasoning !== true) return ['off'];
  const rawMap = model.thinkingLevelMap;
  const map = rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)
    ? rawMap as Record<string, unknown>
    : undefined;
  return MODEL_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

export type ModelCatalogLoadResult =
  | { ok: true; models: ModelInfo[] }
  | { ok: false; models: []; error: string };

export function projectRegistryModels(
  models: SdkCatalogModel[],
  agentDir?: string,
): ModelInfo[] {
  const profiles = agentDir ? loadSubagentProfiles(agentDir) : new Map();
  return models.map((model) => {
    const info: ModelInfo = {
      id: model.id,
      name: model.name,
      provider: model.provider,
      reasoning: model.reasoning,
      thinkingLevels: resolveModelThinkingLevels(model as unknown as Record<string, unknown>),
      inputKinds: resolveModelInputKinds(model as unknown as Record<string, unknown>),
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    };
    const profile = findSubagentProfile(profiles, model.provider, model.id);
    if (profile) info.subagent = profile;
    return info;
  });
}

/** Load configured models without conflating a valid empty catalog with an I/O
 * or parse failure. When the runtime-free coordinator registry is supplied it
 * resolves built-in models plus `modelOverrides`, matching hot worker catalog
 * semantics without creating an AgentSession. Callers that publish catalog
 * authority must inspect `ok`. */
export async function loadConfiguredModels(
  agentDir: string,
  modelRegistry?: SdkModelRegistry,
): Promise<ModelCatalogLoadResult> {
  try {
    if (modelRegistry) {
      modelRegistry.refresh?.();
      const registryError = modelRegistry.getError?.();
      if (registryError) return { ok: false, models: [], error: registryError };
      return { ok: true, models: projectRegistryModels(modelRegistry.getAvailable(), agentDir) };
    }
    const raw = await fs.readFile(path.join(agentDir, 'models.json'), 'utf8');
    const parsed = parseJsonOrThrow<{ providers?: Record<string, { models?: Array<Record<string, unknown>> }> }>(raw, 'models.json');
    const profiles = loadSubagentProfiles(agentDir);
    const result: ModelInfo[] = [];
    for (const [provider, config] of Object.entries(parsed.providers ?? {})) {
      for (const model of config.models ?? []) {
        if (typeof model.id !== 'string' || typeof model.name !== 'string') continue;
        const info: ModelInfo = {
          id: model.id,
          name: model.name,
          provider,
          reasoning: model.reasoning === true,
          thinkingLevels: resolveModelThinkingLevels(model),
          inputKinds: resolveModelInputKinds(model),
          ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
          ...(typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {}),
        };
        const profile = findSubagentProfile(profiles, provider, model.id);
        if (profile) info.subagent = profile;
        result.push(info);
      }
    }
    return { ok: true, models: result };
  } catch (error) {
    const message = toErrorMessage(error);
    backendTrace('sessionMetadata', 'listConfiguredModels.failed', { level: 'debug', error: message });
    return { ok: false, models: [], error: message };
  }
}

/** Compatibility projection for callers where an empty fallback is explicitly
 * acceptable. Authority-publishing paths use `loadConfiguredModels` instead. */
export async function listConfiguredModels(agentDir: string): Promise<ModelInfo[]> {
  return (await loadConfiguredModels(agentDir)).models;
}

export function loadAvailableModels(context?: SessionContext, agentDir?: string): ModelCatalogLoadResult {
  if (!context) {
    return { ok: true, models: [] };
  }

  try {
    const models = context.runtime.services?.modelRegistry?.getAvailable() ?? [];
    return { ok: true, models: projectRegistryModels(models, agentDir) };
  } catch (error) {
    const message = toErrorMessage(error);
    backendTrace('sessionMetadata', 'listAvailableModels.failed', { level: 'debug', error: message });
    return { ok: false, models: [], error: message };
  }
}

export function listAvailableModels(context?: SessionContext, agentDir?: string): ModelInfo[] {
  return loadAvailableModels(context, agentDir).models;
}
