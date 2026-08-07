import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { buildBlindedEvidence, readSessionIdentity } from './src/evidence.js';
import { compileReviewDraft, isSessionReviewDraft } from './src/draft.js';
import { hashCanonicalJson } from './src/hash.js';
import { validateRuntimeProvenance } from './src/runtime-provenance.js';
import { sessionReviewSchema } from './src/types.js';
import type { EvidenceManifest, ReviewClosureTarget, SessionReviewDraft, SessionReviewParams, SessionReviewV2 } from './src/types.js';
import { enqueueClosure, readOpenTabs, readReviewStore, recordReviewOnce } from './src/store.js';
import { validateSessionReviewV2 } from './src/validation.js';

function isDisabledByToggle(): boolean {
  const raw = process.env['PIE_EXTENSION_TOGGLES_JSON'];
  if (!raw) return false;
  try { return (JSON.parse(raw) as Record<string, unknown>)['session-reviewer'] === false; }
  catch { return false; }
}
function ok(text: string, details?: unknown) {
  return { content: [{ type: 'text' as const, text }], details, isError: false as const };
}
function err(message: string, details?: unknown) {
  return { content: [{ type: 'text' as const, text: `session_review error: ${message}` }], details: details ?? { error: message }, isError: true as const };
}
function truncate(value: string, length: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= length ? oneLine : `${oneLine.slice(0, length)}…`;
}

interface ToolExecuteCtx { sessionManager: { getSessionFile(): string | undefined } }
interface ListedSession {
  sessionId: string;
  sessionPath: string;
  name: string;
  pinned: boolean;
  isRunning: boolean;
  isSelf: boolean;
  identityFallback: boolean;
  reviewStatus: 'unrated' | 'reviewed';
  reviewId?: string;
  reviewEligible: boolean;
  closureEligible: boolean;
}
interface OrchestratorSnapshot {
  orchestratorPath: string;
  targetsByPath: Map<string, ListedSession>;
  targetsById: Map<string, ListedSession>;
  evidenceBySessionId: Map<string, EvidenceManifest[]>;
}
const orchestratorSnapshots = new Map<string, OrchestratorSnapshot>();
function orchestratorPath(ctx: ToolExecuteCtx): string | undefined { return ctx?.sessionManager?.getSessionFile(); }
function snapshotFor(ctx: ToolExecuteCtx): OrchestratorSnapshot | undefined {
  const current = orchestratorPath(ctx);
  return current ? orchestratorSnapshots.get(current) : undefined;
}
function eligibleTarget(snapshot: OrchestratorSnapshot, sessionPath?: string, sessionId?: string): ListedSession | undefined {
  const target = sessionPath ? snapshot.targetsByPath.get(sessionPath) : sessionId ? snapshot.targetsById.get(sessionId) : undefined;
  if (!target || (sessionId && target.sessionId !== sessionId) || target.isSelf || target.isRunning) return undefined;
  const current = readOpenTabs().find((tab) => tab.path === target.sessionPath);
  if (!current || current.isRunning) return undefined;
  return target;
}
/** Closure eligibility is broader than review eligibility: an already-reviewed
 *  running session is closeable as a durable tab hide, while evidence and
 *  review recording remain forbidden for running targets. Self is always
 *  excluded; the persisted canonical review match is checked by the caller. */
function closureEligibleTarget(snapshot: OrchestratorSnapshot, sessionPath?: string, sessionId?: string): ListedSession | undefined {
  const target = sessionPath ? snapshot.targetsByPath.get(sessionPath) : sessionId ? snapshot.targetsById.get(sessionId) : undefined;
  if (!target || (sessionId && target.sessionId !== sessionId) || target.isSelf) return undefined;
  return target;
}

function listSessions(ctx: ToolExecuteCtx, selectedOnly: boolean): ListedSession[] {
  const snapshot = readReviewStore();
  const selfPath = ctx?.sessionManager?.getSessionFile();
  const selfId = selfPath ? readSessionIdentity(selfPath).sessionId : undefined;
  return readOpenTabs()
    .filter((tab) => !selectedOnly || tab.pinned)
    .map((tab) => {
      const identity = readSessionIdentity(tab.path);
      const existingReview = snapshot.canonicalBySessionId.get(identity.sessionId);
      const reviewStatus: ListedSession['reviewStatus'] = existingReview ? 'reviewed' : 'unrated';
      const isSelf = !!selfId && identity.sessionId === selfId;
      const alreadyRated = reviewStatus !== 'unrated';
      return {
        sessionId: identity.sessionId,
        sessionPath: tab.path,
        name: tab.name || '(unnamed)',
        pinned: !!tab.pinned,
        isRunning: !!tab.isRunning,
        isSelf,
        identityFallback: identity.identityFallback,
        reviewStatus,
        ...(existingReview ? { reviewId: existingReview.reviewId } : {}),
        reviewEligible: !isSelf && !tab.isRunning && !alreadyRated,
        closureEligible: !isSelf && !!existingReview,
      };
    });
}
const MAX_REVIEW_FILE_BYTES = 1024 * 1024;
const MAX_REVIEW_BATCH_FILE_BYTES = 8 * 1024 * 1024;
function parseReviewJson(raw: string, source: string, exposeParserMessage = true): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = exposeParserMessage ? `: ${(error as Error).message}` : '.';
    throw new Error(`${source} must contain valid review JSON${detail}`);
  }
}
function safeTemporaryReviewPath(reviewPath: string): string {
  if (!path.isAbsolute(reviewPath)) throw new Error('reviewPath must be absolute.');
  const realTempRoot = fs.realpathSync(os.tmpdir());
  const realReviewPath = fs.realpathSync(reviewPath);
  const relative = path.relative(realTempRoot, realReviewPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('reviewPath must be inside the OS temporary directory.');
  if (fs.lstatSync(reviewPath).isSymbolicLink()) throw new Error('reviewPath must not be a symbolic link.');
  return realReviewPath;
}
function readTemporaryJson(reviewPath: string, maxBytes: number, source: string): unknown {
  const safePath = safeTemporaryReviewPath(reviewPath);
  if (!fs.statSync(safePath).isFile()) throw new Error(`${source} must identify a regular file.`);
  const bytes = fs.readFileSync(safePath);
  if (bytes.byteLength > maxBytes) throw new Error(`${source} exceeds the ${maxBytes}-byte limit.`);
  return parseReviewJson(bytes.toString('utf8'), source, false);
}
function reviewInput(review: unknown, reviewPath: string | undefined): unknown {
  if (review !== undefined && reviewPath !== undefined) throw new Error('provide either review or reviewPath, not both.');
  if (reviewPath !== undefined) return readTemporaryJson(reviewPath, MAX_REVIEW_FILE_BYTES, 'reviewPath');
  return typeof review === 'string' ? parseReviewJson(review, 'review') : review;
}
function reviewBatchInput(reviews: unknown, reviewsPath: string | undefined): unknown[] {
  if (reviews !== undefined && reviewsPath !== undefined) throw new Error('provide either reviews or reviewsPath, not both.');
  const value = reviewsPath === undefined ? reviews : readTemporaryJson(reviewsPath, MAX_REVIEW_BATCH_FILE_BYTES, 'reviewsPath');
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('recordReviews requires 1 to 100 reviews.');
  return value;
}
function normalizeFrozenLedgerHashes(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const review = structuredClone(value) as Record<string, unknown>;
  if (!Array.isArray(review.frozenLedger)) return review;
  const frozenLedgerSha256 = hashCanonicalJson(review.frozenLedger);
  review.frozenLedgerSha256 = frozenLedgerSha256;
  const consolidation = review.consolidation as Record<string, unknown> | undefined;
  if (consolidation && typeof consolidation === 'object' && !Array.isArray(consolidation) && Array.isArray(consolidation.frozenLedger)) consolidation.frozenLedgerSha256 = frozenLedgerSha256;
  const provenance = review.provenance as Record<string, unknown> | undefined;
  const pipeline = provenance?.pipeline as Record<string, unknown> | undefined;
  if (pipeline && typeof pipeline === 'object' && !Array.isArray(pipeline)) pipeline.frozenLedgerSha256 = frozenLedgerSha256;
  return review;
}
function parseReviewParam(review: unknown, reviewPath: string | undefined, scope: OrchestratorSnapshot): SessionReviewV2 {
  const raw = reviewInput(review, reviewPath);
  if (isSessionReviewDraft(raw)) {
    const target = scope.targetsById.get(raw.sessionId);
    const issued = scope.evidenceBySessionId.get(raw.sessionId) ?? [];
    const evidenceManifest = raw.provenance.evidenceManifest ?? (issued.length === 1 ? issued[0] : undefined);
    if (!evidenceManifest) throw new Error(`review draft ${raw.sessionId} must include the issued evidence manifest when multiple or no bundles exist`);
    const draft = {
      ...raw,
      provenance: { ...raw.provenance, evidenceManifest },
      sessionPathAtReview: raw.sessionPathAtReview || target?.sessionPath,
      identityFallback: raw.identityFallback ?? target?.identityFallback,
    } as SessionReviewDraft;
    const orchestratorIdentity = readSessionIdentity(scope.orchestratorPath).sessionId;
    return normalizeFrozenLedgerHashes(compileReviewDraft(draft, { orchestratorSessionId: orchestratorIdentity })) as SessionReviewV2;
  }
  return normalizeFrozenLedgerHashes(raw) as SessionReviewV2;
}

function renderList(items: ListedSession[], selectedOnly: boolean): string {
  if (!items.length) return selectedOnly ? 'No pinned sessions are selected.' : 'No open sessions are currently pushed from the host (PIE_OPEN_TABS empty/unset).';
  const rows = items.map((item) => {
    const flags = [item.isSelf ? 'self' : '', item.pinned ? 'pinned' : '', item.isRunning ? 'running' : '', item.identityFallback ? 'path-id-fallback' : ''].filter(Boolean).join(',');
    return `  ${item.reviewEligible ? '○ review' : '✓ skip'}  ${item.reviewStatus.padEnd(17)} ${truncate(item.name, 30)}${flags ? ` (${flags})` : ''}\n    id=${item.sessionId}${item.reviewId ? ` reviewId=${item.reviewId}` : ''}\n    path=${item.sessionPath}`;
  });
  return `${selectedOnly ? 'Selected' : 'Open'} sessions (${items.length}):\n${rows.join('\n')}`;
}

function validateReviewTarget(review: SessionReviewV2, scope: OrchestratorSnapshot): ListedSession {
  const target = eligibleTarget(scope, review.sessionPathAtReview, review.sessionId);
  if (!target || !target.reviewEligible) throw new Error('Review target is not an eligible unrated selected/open snapshot member.');
  const identity = readSessionIdentity(review.sessionPathAtReview);
  if (identity.sessionId !== review.sessionId || identity.identityFallback !== !!review.identityFallback) {
    throw new Error('review session identity does not match the session JSONL header/path fallback.');
  }
  const snapshots = scope.evidenceBySessionId.get(review.sessionId) ?? [];
  if (!snapshots.some((manifest) => isDeepStrictEqual(manifest, review.provenance.evidenceManifest))) {
    throw new Error('review evidenceManifest was not issued by getEvidence in this reviewer session; fetch evidence before recording.');
  }
  validateRuntimeProvenance(review, scope.orchestratorPath);
  return target;
}

function prepareReview(input: unknown, reviewPath: string | undefined, scope: OrchestratorSnapshot): SessionReviewV2 {
  return validateSessionReviewV2(parseReviewParam(input, reviewPath, scope));
}

function compactRecordResult(review: SessionReviewV2, result: Awaited<ReturnType<typeof recordReviewOnce>>) {
  return {
    sessionId: review.sessionId,
    reviewId: result.written ? review.reviewId : result.reviewId,
    written: result.written,
    file: result.file,
  };
}

function batchResponse(label: string, results: Array<Record<string, unknown> & { error?: string }>) {
  const failures = results.filter((result) => result.error);
  const text = `${label}: ${results.length - failures.length} succeeded, ${failures.length} failed.`;
  return {
    content: [{ type: 'text' as const, text }],
    details: { results },
    isError: failures.length > 0,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'session_review',
    label: 'Session review',
    description: 'Session evaluation: list open/pinned sessions, fetch blinded evidence, compile and persist canonical reviews, and enqueue explicit closure actions.',
    promptSnippet: 'List, inspect, and review open app sessions.',
    promptGuidelines: [
      'List before getEvidence. Review only selected targets, exclude (self), and do not re-rate already-reviewed sessions. Prefer compact drafts or a temporary JSON file; use recordReviews and closeReviewedBatch for independent batches. Persistence never closes a target; use closeReviewed after recording and closeSelf as the final action.',
    ],
    parameters: sessionReviewSchema,

    async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolExecuteCtx) {
      if (isDisabledByToggle()) return err('The session-reviewer extension is disabled. Enable it in Settings → Extensions.');
      const p = params as SessionReviewParams;

      if (p.action === 'listOpen' || p.action === 'listSelected') {
        const current = orchestratorPath(ctx);
        if (!current) return err('Could not determine the current reviewer session for target scoping.');
        const sessions = listSessions(ctx, p.action === 'listSelected');
        orchestratorSnapshots.set(current, {
          orchestratorPath: current,
          targetsByPath: new Map(sessions.map((session) => [session.sessionPath, session])),
          targetsById: new Map(sessions.map((session) => [session.sessionId, session])),
          evidenceBySessionId: new Map(),
        });
        return ok(renderList(sessions, p.action === 'listSelected'), { sessions });
      }

      if (p.action === 'getEvidence') {
        if (!p.sessionPath) return err('getEvidence requires sessionPath (from listOpen/listSelected).');
        const scope = snapshotFor(ctx);
        if (!scope) return err('List targets in this reviewer session before fetching evidence.');
        const target = eligibleTarget(scope, p.sessionPath);
        if (!target) return err('Evidence target is not an eligible selected/open snapshot member (self and running sessions are excluded).');
        if (!target.reviewEligible) return err('Evidence is only fetched for unrated review targets; already-reviewed sessions are closure-only.');
        try {
          const bundle = buildBlindedEvidence(target.sessionPath, typeof p.maxTurns === 'number' ? p.maxTurns : 40, p.artifacts ?? []);
          if (bundle.sessionId !== target.sessionId || bundle.identityFallback !== target.identityFallback) return err('Target identity changed after the list snapshot; list targets again.');
          const prior = scope.evidenceBySessionId.get(bundle.sessionId) ?? [];
          prior.push(bundle.manifest);
          scope.evidenceBySessionId.set(bundle.sessionId, prior.slice(-5));
          return ok(JSON.stringify(bundle, null, 2), {
            sessionId: bundle.sessionId,
            sessionPath: bundle.sessionPath,
            identityFallback: bundle.identityFallback,
            manifest: bundle.manifest,
          });
        } catch (error) { return err((error as Error).message); }
      }

      if (p.action === 'recordReview') {
        if (p.review === undefined && p.reviewPath === undefined) return err('recordReview requires review or reviewPath.');
        const scope = snapshotFor(ctx);
        if (!scope) return err('List targets in this reviewer session before recording.');
        try {
          const review = prepareReview(p.review, p.reviewPath, scope);
          validateReviewTarget(review, scope);
          const result = await recordReviewOnce(review);
          if (!result.written) {
            return ok(`Session ${review.sessionId} already has canonical production review ${result.reviewId}; no duplicate was written.`, result);
          }
          return ok(`Recorded ${review.kind} review ${review.reviewId} for session ${review.sessionId}.\nStored in ${result.file}. No closure action was written.`, result);
        } catch (error) { return err((error as Error).message); }
      }

      if (p.action === 'recordReviews') {
        const scope = snapshotFor(ctx);
        if (!scope) return err('List targets in this reviewer session before recording.');
        try {
          const inputs = reviewBatchInput(p.reviews, p.reviewsPath);
          const results = await Promise.all(inputs.map(async (input, index) => {
            try {
              const review = prepareReview(input, undefined, scope);
              validateReviewTarget(review, scope);
              const result = await recordReviewOnce(review);
              return { index, ...compactRecordResult(review, result) };
            } catch (error) {
              return { index, error: (error as Error).message };
            }
          }));
          return batchResponse('Recorded review batch', results);
        } catch (error) { return err((error as Error).message); }
      }

      if (p.action === 'closeReviewed') {
        if (!p.sessionId || !p.reviewId) return err('closeReviewed requires sessionId and reviewId from list/recordReview.');
        const scope = snapshotFor(ctx);
        if (!scope) return err('List targets in this reviewer session before closing.');
        const target = closureEligibleTarget(scope, p.sessionPath, p.sessionId);
        if (!target) return err('Closure target is not an eligible selected/open snapshot member (self is excluded; running already-reviewed sessions are closeable as a tab hide).');
        const snapshot = readReviewStore();
        const review = snapshot.canonicalBySessionId.get(p.sessionId);
        if (!review || review.reviewId !== p.reviewId) return err('closeReviewed requires a matching persisted canonical production review.');
        if (p.sessionPath) {
          const identity = readSessionIdentity(p.sessionPath);
          if (identity.sessionId !== p.sessionId) return err('closeReviewed sessionPath does not match sessionId.');
        }
        try {
          const result = await enqueueClosure({ kind: 'closeReviewed', targetSessionId: p.sessionId, targetSessionPath: target.sessionPath, reviewId: p.reviewId });
          return ok(`${result.existing ? 'Reused' : 'Enqueued'} closeReviewed action ${result.action.actionId} (${result.action.status}).\nOutbox: ${result.file}. reviews.jsonl was not modified.`, result);
        } catch (error) { return err((error as Error).message); }
      }

      if (p.action === 'closeReviewedBatch') {
        if (!p.closures?.length) return err('closeReviewedBatch requires at least one closure target.');
        const scope = snapshotFor(ctx);
        if (!scope) return err('List targets in this reviewer session before closing.');
        const snapshot = readReviewStore();
        const results = await Promise.all(p.closures.map(async (closure: ReviewClosureTarget, index) => {
          try {
            const target = closureEligibleTarget(scope, closure.sessionPath, closure.sessionId);
            if (!target) throw new Error('Closure target is not an eligible selected/open snapshot member (self is excluded).');
            const review = snapshot.canonicalBySessionId.get(closure.sessionId);
            if (!review || review.reviewId !== closure.reviewId) throw new Error('closure requires a matching persisted canonical review.');
            if (closure.sessionPath) {
              const identity = readSessionIdentity(closure.sessionPath);
              if (identity.sessionId !== closure.sessionId) throw new Error('closure sessionPath does not match sessionId.');
            }
            const result = await enqueueClosure({ kind: 'closeReviewed', targetSessionId: closure.sessionId, targetSessionPath: target.sessionPath, reviewId: closure.reviewId });
            return { index, sessionId: closure.sessionId, reviewId: closure.reviewId, actionId: result.action.actionId, status: result.action.status, existing: result.existing };
          } catch (error) {
            return { index, sessionId: closure.sessionId, reviewId: closure.reviewId, error: (error as Error).message };
          }
        }));
        return batchResponse('Requested closure batch', results);
      }

      if (p.action === 'closeSelf') {
        const sessionPath = orchestratorPath(ctx);
        if (!sessionPath) return err('closeSelf could not determine the current reviewer session.');
        if (!snapshotFor(ctx)) return err('List targets in this reviewer session before closing self.');
        const identity = readSessionIdentity(sessionPath);
        try {
          const result = await enqueueClosure({ kind: 'closeSelf', targetSessionId: identity.sessionId, targetSessionPath: sessionPath });
          return ok(`${result.existing ? 'Reused' : 'Enqueued'} closeSelf action ${result.action.actionId} (${result.action.status}). No review was written. End the turn now.`, result);
        } catch (error) { return err((error as Error).message); }
      }

      return err(`unknown action: ${String(p.action)}`);
    },
  });
}
