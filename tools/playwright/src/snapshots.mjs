import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Keep in sync with src/types.ts (plain-JS sidecar module).
const MAX_OBSERVATION_BYTES = 16 * 1024;
const MAX_OBSERVATION_LINES = 250;
const MAX_OBSERVATION_LINE_CHARS = 400;
const MAX_SNAPSHOT_ARTIFACT_BYTES = 8 * 1024 * 1024;
const DEFAULT_DEPTH = 25;

export function extractRefs(text) {
  const refs = new Set();
  for (const match of String(text).matchAll(/\[ref=([^\]\s]+)\]/g)) refs.add(match[1]);
  return refs;
}

function byteLength(text) { return Buffer.byteLength(text, 'utf8'); }
function lineCount(text) { return text.length === 0 ? 0 : text.split('\n').length; }
function fitsObservation(text) { return byteLength(text) <= MAX_OBSERVATION_BYTES && lineCount(text) <= MAX_OBSERVATION_LINES; }

function truncateLine(line) {
  if (line.length <= MAX_OBSERVATION_LINE_CHARS) return { line, truncated: false };
  const refMatch = /\[ref=[^\]\s]+\]/.exec(line);
  const suffix = ' … [line truncated]';
  const refToken = refMatch ? ` ${refMatch[0]}` : '';
  const budget = Math.max(0, MAX_OBSERVATION_LINE_CHARS - Buffer.byteLength(suffix) - refToken.length);
  let cut = line.slice(0, budget);
  const alreadyKept = refMatch !== null && cut.includes(refMatch[0]);
  return { line: `${cut}${suffix}${alreadyKept ? '' : refToken}`, truncated: true };
}

function boundPathologicalLines(text) {
  const lines = text.split('\n');
  let truncatedLines = 0;
  const bounded = lines.map((line) => {
    const result = truncateLine(line);
    if (result.truncated) truncatedLines += 1;
    return result.line;
  });
  let omittedLines = 0;
  let final = bounded;
  if (bounded.length > MAX_OBSERVATION_LINES) {
    omittedLines = bounded.length - MAX_OBSERVATION_LINES;
    final = bounded.slice(0, MAX_OBSERVATION_LINES);
  }
  return { text: final.join('\n'), truncatedLines, omittedLines };
}

async function capture(root, depth, signal) {
  const options = { mode: 'ai' };
  if (depth !== undefined) options.depth = depth;
  if (signal !== undefined) options.signal = signal;
  return await root.ariaSnapshot(options);
}

function coded(code, message, retryable = false, extra = {}) {
  return Object.assign(new Error(message), { code, retryable, ...extra });
}

async function saveFullArtifact(artifactDir, counter, full, beginArtifactReservation) {
  const bytes = byteLength(full);
  if (bytes > MAX_SNAPSHOT_ARTIFACT_BYTES) {
    throw coded(
      'ARTIFACT_TOO_LARGE',
      `Full accessibility snapshot is ${bytes} bytes, exceeding the ${MAX_SNAPSHOT_ARTIFACT_BYTES}-byte artifact cap; it was not saved. Narrow the observation target or depth.`,
      false,
    );
  }
  const directory = path.join(artifactDir, 'snapshots');
  await mkdir(directory, { recursive: true });
  const artifactPath = path.join(directory, `${String(counter).padStart(4, '0')}-${randomUUID()}.yaml`);
  const reservation = beginArtifactReservation?.('A complete accessibility snapshot') ?? { add() {}, commit() {}, release() {} };
  try {
    reservation.add(bytes);
    await writeFile(artifactPath, full);
    reservation.commit();
    return { artifactPath, bytes };
  } catch (error) {
    reservation.release();
    await unlink(artifactPath).catch(() => {});
    throw error;
  }
}

function depthLadder(requested) {
  const ladder = [];
  let current = requested ?? DEFAULT_DEPTH;
  while (current > 1) { ladder.push(current); current = Math.max(1, Math.floor(current / 2)); }
  ladder.push(1);
  return [...new Set(ladder)];
}

/**
 * Captures a bounded AI accessibility snapshot. Bounding order:
 *  1. capture the complete unrestricted snapshot; if nothing needs reducing, use it;
 *  2. when reduction is needed, save the complete snapshot as a session artifact;
 *  3. re-capture at the requested/default depth, halving until it fits;
 *  4. bound pathological long lines (preserving ref + prefix) and the line budget;
 *  5. return an explicit reduction record so the caller can add fidelity markers.
 *
 * Returns { text, refs, reduction? }. Throws ARTIFACT_TOO_LARGE when even the
 * complete artifact cannot be saved.
 */
export async function captureBoundedSnapshot({ root, depth, mode, artifactDir, artifactCounter, beginArtifactReservation, signal }) {
  const requestedDepth = depth ?? (mode === 'full' ? 50 : undefined);
  const full = await capture(root, undefined, signal);

  const boundedFull = boundPathologicalLines(full);
  if (requestedDepth === undefined && fitsObservation(full) && boundedFull.truncatedLines === 0 && boundedFull.omittedLines === 0) {
    return { text: full, refs: extractRefs(full) };
  }
  const ladder = requestedDepth === undefined ? depthLadder(undefined) : depthLadder(requestedDepth);

  let artifact;
  const persistArtifact = async () => {
    if (!artifact) artifact = await saveFullArtifact(artifactDir, artifactCounter(), full, beginArtifactReservation);
    return artifact;
  };

  // An explicit depth request that already fits is a user-requested view, not a
  // reduction: no artifact is needed.
  let last = full;
  for (const candidate of ladder) {
    const text = await capture(root, candidate, signal);
    last = text;
    if (fitsObservation(text)) {
      const reduced = boundPathologicalLines(text);
      const requestedViewFitsExactly = requestedDepth !== undefined
        && candidate === requestedDepth
        && reduced.truncatedLines === 0
        && reduced.omittedLines === 0;
      if (requestedViewFitsExactly) return { text, refs: extractRefs(text) };
      const saved = await persistArtifact();
      const reasonParts = candidate === requestedDepth
        ? [`requested depth ${candidate} required line bounding`]
        : [`depth reduced to ${candidate}${requestedDepth === undefined ? ` (default ladder, artifact required by size ${byteLength(full)} bytes)` : ` from requested ${requestedDepth}`}`];
      if (reduced.truncatedLines > 0) reasonParts.push(`${reduced.truncatedLines} overlong lines truncated`);
      return {
        text: reduced.text, refs: extractRefs(reduced.text),
        reduction: { reason: reasonParts.join('; '), fullSnapshotPath: saved.artifactPath, depthUsed: candidate, truncatedLines: reduced.truncatedLines || undefined },
      };
    }
  }

  const saved = await persistArtifact();
  const reduced = boundPathologicalLines(last);
  const reason = [
    `snapshot still oversized at depth 1; applied line bounds${reduced.truncatedLines > 0 ? ` (${reduced.truncatedLines} lines truncated)` : ''}${reduced.omittedLines > 0 ? ` (${reduced.omittedLines} lines omitted)` : ''}; complete snapshot saved to artifact`,
  ].join('');
  return {
    text: reduced.text, refs: extractRefs(reduced.text),
    reduction: { reason, fullSnapshotPath: saved.artifactPath, depthUsed: 1, truncatedLines: reduced.truncatedLines || undefined, omittedLines: reduced.omittedLines || undefined },
  };
}
