import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { deriveFileChangesFromSessionEntries, readSessionCwd } from '../../session-changes/src/session-jsonl.js';
import type { BlindedEvidenceBundle, EvidenceArtifactExcerpt, EvidenceArtifactInput, EvidenceArtifactManifest } from './types.js';
import { parseSessionTranscriptBytes, renderTranscriptDetailed } from './transcript.js';

const MAX_ARTIFACTS = 20;
const MAX_DERIVED_CHANGED_FILES = 12;
const MAX_ARTIFACT_EXCERPT_BYTES = 8 * 1024;
const MAX_ARTIFACT_EXCERPTS_BYTES = 32 * 1024;
const MAX_GIT_DIFF_BYTES = 1024 * 1024;

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
export function hashJson(value: unknown): string { return sha256(JSON.stringify(value)); }

/** V1-compatible normalized path hash (§14.5). */
export function normalizedPathHash(sessionPath: string): string {
  let normalized = sessionPath.trim().replace(/\\/g, '/');
  const unc = normalized.startsWith('//');
  normalized = normalized.replace(/\/+/g, '/');
  if (unc) normalized = `//${normalized.replace(/^\/+/, '')}`;
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//')) normalized = normalized.toLowerCase();
  return sha256(Buffer.from(normalized, 'utf8')).slice(0, 16);
}

export interface SessionIdentity { sessionId: string; identityFallback: boolean }
export function readSessionIdentityFromBytes(sessionPath: string, raw: Buffer | string): SessionIdentity {
  const content = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  const first = content.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (first) {
    try {
      const header = JSON.parse(first) as { type?: unknown; id?: unknown };
      if (header.type === 'session' && typeof header.id === 'string' && header.id.trim()) return { sessionId: header.id.trim(), identityFallback: false };
    } catch { /* path fallback */ }
  }
  return { sessionId: normalizedPathHash(sessionPath), identityFallback: true };
}
/** Reads only the first snapshot; later headers never repair a bad first line. */
export function readSessionIdentity(sessionPath: string): SessionIdentity {
  try { return readSessionIdentityFromBytes(sessionPath, fs.readFileSync(sessionPath)); }
  catch { return { sessionId: normalizedPathHash(sessionPath), identityFallback: true }; }
}

const AUTHOR_IDENTITY_KEYS = new Set(['model', 'modelId', 'provider', 'family', 'thinkingLevel']);
function authorIdentityValues(raw: Buffer): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (AUTHOR_IDENTITY_KEYS.has(key) && typeof child === 'string' && child) found.add(child);
      else visit(child);
    }
  };
  for (const line of raw.toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { visit(JSON.parse(line)); } catch { /* malformed transcript line */ }
  }
  return [...found].sort((a, b) => b.length - a.length);
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function redactAuthorIdentity(rendered: string, values: string[]): { text: string; redacted: string[] } {
  let text = rendered;
  const redacted: string[] = [];
  for (const value of values) {
    const pattern = new RegExp(escapeRegExp(value), 'gi');
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    text = text.replace(pattern, '[REDACTED_AUTHOR_IDENTITY]');
    redacted.push(value);
  }
  return { text, redacted };
}

function sameStat(a: fs.Stats, b: fs.Stats): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}
function parsedEntries(raw: Buffer): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const line of raw.toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) entries.push(value as Record<string, unknown>);
    } catch { /* malformed transcript line */ }
  }
  return entries;
}
function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value) <= maxBytes) return { text: value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { text: value.slice(0, low), truncated: true };
}
function finalGitDiff(cwd: string, absolutePath: string): Buffer | undefined {
  const result = spawnSync('git', [
    '--no-pager', '--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=1', '--', absolutePath,
  ], {
    cwd,
    encoding: 'buffer',
    maxBuffer: MAX_GIT_DIFF_BYTES,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.status === 0 && result.stdout?.byteLength ? result.stdout : undefined;
}
interface ArtifactSnapshot { path: string; kind: EvidenceArtifactManifest['kind']; bytes: Buffer }
function automaticArtifactSnapshots(raw: Buffer, limitations: string[]): { cwd?: string; snapshots: ArtifactSnapshot[] } {
  const entries = parsedEntries(raw);
  const cwd = readSessionCwd(entries);
  if (!cwd) {
    limitations.push('Session cwd was unavailable; changed-file and final-diff evidence could not be derived automatically.');
    return { snapshots: [] };
  }
  let changes;
  try { changes = deriveFileChangesFromSessionEntries(entries); }
  catch {
    limitations.push('Changed-file evidence could not be derived from the captured session transcript.');
    return { cwd, snapshots: [] };
  }
  if (changes.length > MAX_DERIVED_CHANGED_FILES) limitations.push(`Automatic artifact capture omitted ${changes.length - MAX_DERIVED_CHANGED_FILES} changed file(s) beyond its ${MAX_DERIVED_CHANGED_FILES}-file limit.`);
  const snapshots: ArtifactSnapshot[] = [];
  for (const change of changes.slice(0, MAX_DERIVED_CHANGED_FILES)) {
    const absolutePath = path.isAbsolute(change.path) ? path.resolve(change.path) : path.resolve(cwd, change.path);
    if (change.kind !== 'created') {
      const diff = finalGitDiff(cwd, absolutePath);
      if (diff) snapshots.push({ path: absolutePath, kind: 'diff', bytes: diff });
      else limitations.push(`Final git diff was unavailable or empty for changed file: ${absolutePath}`);
    }
    if (change.kind !== 'deleted') {
      try {
        snapshots.push({ path: absolutePath, kind: change.kind === 'created' ? 'untracked' : 'file', bytes: fs.readFileSync(absolutePath) });
      } catch { limitations.push(`Changed file unavailable at snapshot: ${absolutePath}`); }
    }
  }
  return { cwd, snapshots };
}
function evidenceArtifact(snapshot: ArtifactSnapshot, identityValues: string[], remainingBytes: number): EvidenceArtifactExcerpt | undefined {
  if (remainingBytes <= 0) return undefined;
  const binary = snapshot.bytes.subarray(0, Math.min(snapshot.bytes.byteLength, 4096)).includes(0);
  const source = binary ? '[binary artifact content omitted]' : snapshot.bytes.subarray(0, MAX_ARTIFACT_EXCERPT_BYTES).toString('utf8');
  const redacted = redactAuthorIdentity(source, identityValues).text;
  const bounded = truncateUtf8(redacted, Math.min(MAX_ARTIFACT_EXCERPT_BYTES, remainingBytes));
  const excerptBytes = Buffer.byteLength(bounded.text);
  return {
    path: snapshot.path,
    sha256: sha256(snapshot.bytes),
    bytes: snapshot.bytes.byteLength,
    kind: snapshot.kind,
    excerptSha256: sha256(bounded.text),
    excerptBytes,
    excerptTruncated: binary || bounded.truncated || snapshot.bytes.byteLength > Buffer.byteLength(source),
    excerpt: bounded.text,
  };
}

export function buildBlindedEvidence(sessionPath: string, maxTurns = 40, artifactInputs: EvidenceArtifactInput[] = []): BlindedEvidenceBundle {
  let descriptor: number | undefined;
  let raw: Buffer;
  let before: fs.Stats;
  let after: fs.Stats;
  try {
    descriptor = fs.openSync(sessionPath, 'r');
    before = fs.fstatSync(descriptor);
    raw = fs.readFileSync(descriptor);
    after = fs.fstatSync(descriptor);
  } catch (error) {
    throw new Error(`Could not read session file ${sessionPath}: ${(error as Error).message}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }

  const identity = readSessionIdentityFromBytes(sessionPath, raw!);
  const parsed = parseSessionTranscriptBytes(sessionPath, raw!, maxTurns);
  const rendered = renderTranscriptDetailed(parsed);
  const identityValues = authorIdentityValues(raw!);
  const redaction = redactAuthorIdentity(rendered.text, identityValues);
  const limitations = [...parsed.truncationReasons];
  if (rendered.limitation) limitations.push(rendered.limitation);
  if (!sameStat(before!, after!)) limitations.push('Session JSONL changed while its byte snapshot was being read; the hash and rendering both use the captured bytes.');

  const automatic = automaticArtifactSnapshots(raw!, limitations);
  const snapshots: ArtifactSnapshot[] = [];
  for (const input of artifactInputs.slice(0, MAX_ARTIFACTS)) {
    const resolved = path.isAbsolute(input.path) ? path.resolve(input.path) : path.resolve(automatic.cwd ?? process.cwd(), input.path);
    try { snapshots.push({ path: resolved, kind: input.kind, bytes: fs.readFileSync(resolved) }); }
    catch { limitations.push(`Artifact unavailable at snapshot: ${input.path}`); }
  }
  if (artifactInputs.length > MAX_ARTIFACTS) limitations.push(`Artifact input omitted ${artifactInputs.length - MAX_ARTIFACTS} item(s) beyond its ${MAX_ARTIFACTS}-item limit.`);
  const seen = new Set(snapshots.map((item) => `${item.kind}\0${item.path}`));
  for (const snapshot of automatic.snapshots) {
    const key = `${snapshot.kind}\0${snapshot.path}`;
    if (!seen.has(key)) { snapshots.push(snapshot); seen.add(key); }
  }
  if (!snapshots.length) limitations.push('No changed files or supplied artifacts were available for excerpt capture.');

  const artifacts: EvidenceArtifactExcerpt[] = [];
  let remainingBytes = MAX_ARTIFACT_EXCERPTS_BYTES;
  for (const snapshot of snapshots.slice(0, MAX_ARTIFACTS)) {
    const artifact = evidenceArtifact(snapshot, identityValues, remainingBytes);
    if (!artifact) break;
    artifacts.push(artifact);
    remainingBytes -= artifact.excerptBytes;
    if (artifact.excerptTruncated) limitations.push(`Artifact excerpt was truncated: ${snapshot.path} (${snapshot.kind}).`);
  }
  if (snapshots.length > artifacts.length) limitations.push(`Artifact evidence omitted ${snapshots.length - artifacts.length} item(s) beyond output count/byte limits.`);

  const manifestArtifacts = artifacts.map(({ excerpt: _excerpt, ...manifest }) => manifest);
  const blinding = {
    stripped: ['modelId', 'provider', 'thinkingLevel', 'family', 'reputation', 'settingsVersion', 'model_change'],
    redactedTurnFields: ['message.model', 'message.provider', 'entry.modelId', 'rendered author identity values', 'artifact excerpts'],
    notes: [
      'Raw JSONL and full artifact bytes are hashed but not included. Structured model-change and host/settings entries are omitted by transcript rendering.',
      `Detected ${identityValues.length} author identity value(s) and redacted any occurrence in rendered transcript or artifact excerpts.`,
      `Artifact excerpts are capped at ${MAX_ARTIFACT_EXCERPT_BYTES} bytes each and ${MAX_ARTIFACT_EXCERPTS_BYTES} bytes total.`,
    ],
  };
  const manifest = {
    rawJsonlSha256: sha256(raw!),
    rawJsonlBytes: raw!.byteLength,
    rawJsonlMtime: before!.mtime.toISOString(),
    transcriptExcerptSha256: sha256(redaction.text),
    artifacts: manifestArtifacts,
    limitations,
    blinding,
  };
  return {
    sessionId: identity.sessionId,
    sessionPath,
    identityFallback: identity.identityFallback,
    transcriptExcerpt: redaction.text,
    artifacts,
    limitations,
    manifest,
  };
}
