import { isDeepStrictEqual } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { buildBlindedEvidence, readSessionIdentity } from './src/evidence.js';
import { validateRuntimeProvenance } from './src/runtime-provenance.js';
import { sessionReviewSchema } from './src/types.js';
import type { EvidenceManifest, SessionReviewParams } from './src/types.js';
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
  reviewStatus: 'unrated' | 'reviewed-v2' | 'reviewed-legacy' | 'legacy-unresolved';
  reviewId?: string;
  legacyReview?: { rating: number; completion: string; reason: string; evaluatedAt: string; identityFallback: boolean };
  ratingQueueEligible: boolean;
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
/** Closure eligibility is broader than rating eligibility: an already-reviewed
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
      const v2 = snapshot.canonicalBySessionId.get(identity.sessionId);
      const legacy = snapshot.reservedLegacyBySessionId.get(identity.sessionId);
      const unresolved = snapshot.unresolvedLegacy.find((record) => record.sessionPath === tab.path);
      const legacyRecord = legacy ?? unresolved;
      const reviewStatus: ListedSession['reviewStatus'] = v2 ? 'reviewed-v2' : legacy ? 'reviewed-legacy' : unresolved ? 'legacy-unresolved' : 'unrated';
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
        ...(v2 ? { reviewId: v2.reviewId } : {}),
        ...(legacyRecord ? { legacyReview: { rating: legacyRecord.rating, completion: legacyRecord.completion, reason: legacyRecord.reason, evaluatedAt: legacyRecord.evaluatedAt, identityFallback: !!unresolved } } : {}),
        ratingQueueEligible: !isSelf && !tab.isRunning && !alreadyRated,
        closureEligible: !isSelf && !!v2,
      };
    });
}
function renderList(items: ListedSession[], selectedOnly: boolean): string {
  if (!items.length) return selectedOnly ? 'No pinned sessions are selected.' : 'No open sessions are currently pushed from the host (PIE_OPEN_TABS empty/unset).';
  const rows = items.map((item) => {
    const flags = [item.isSelf ? 'self' : '', item.pinned ? 'pinned' : '', item.isRunning ? 'running' : '', item.identityFallback ? 'path-id-fallback' : ''].filter(Boolean).join(',');
    return `  ${item.ratingQueueEligible ? '○ rate' : '✓ skip'}  ${item.reviewStatus.padEnd(17)} ${truncate(item.name, 30)}${flags ? ` (${flags})` : ''}\n    id=${item.sessionId}${item.reviewId ? ` reviewId=${item.reviewId}` : ''}\n    path=${item.sessionPath}`;
  });
  return `${selectedOnly ? 'Selected' : 'Open'} sessions (${items.length}):\n${rows.join('\n')}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'session_review',
    label: 'Session review',
    description: 'V2 session review: list open/pinned sessions, fetch blinded evidence, persist one validated canonical ledger review, and enqueue explicit closure actions.',
    promptSnippet: 'List, inspect, and review open app sessions.',
    promptGuidelines: [
      'List before getEvidence. Review only selected targets, exclude (self), and do not re-rate already-reviewed sessions. recordReview never closes a tab; use closeReviewed after persistence and closeSelf as the final action.',
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
        if (!target.ratingQueueEligible) return err('Evidence is only fetched for unrated rating targets; already-reviewed sessions are closure-only.');
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
        if (!p.review) return err('recordReview requires a complete review object.');
        const scope = snapshotFor(ctx);
        if (!scope) return err('List targets in this reviewer session before recording.');
        try {
          const review = validateSessionReviewV2(p.review);
          const target = eligibleTarget(scope, review.sessionPathAtReview, review.sessionId);
          if (!target || !target.ratingQueueEligible) return err('Review target is not an eligible unrated selected/open snapshot member.');
          const identity = readSessionIdentity(review.sessionPathAtReview);
          if (identity.sessionId !== review.sessionId || identity.identityFallback !== !!review.identityFallback) {
            return err('review session identity does not match the session JSONL header/path fallback.');
          }
          const snapshots = scope.evidenceBySessionId.get(review.sessionId) ?? [];
          if (!snapshots.some((manifest) => isDeepStrictEqual(manifest, review.provenance.evidenceManifest))) {
            return err('review evidenceManifest was not issued by getEvidence in this reviewer session; fetch evidence before recording.');
          }
          validateRuntimeProvenance(review, scope.orchestratorPath);
          const result = await recordReviewOnce(review);
          if (!result.written) {
            if (result.legacy) return err('session is reserved by a legacy V1 review and must not be re-rated; reconcile/import it explicitly.', result);
            return ok(`Session ${review.sessionId} already has canonical production review ${result.reviewId}; no duplicate was written.`, result);
          }
          return ok(`Recorded ${review.kind} V2 review ${review.reviewId} for session ${review.sessionId}.\nStored in ${result.file}. No closure action was written.`, result);
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

      if (p.action === 'closeSelf') {
        const sessionPath = orchestratorPath(ctx);
        if (!sessionPath) return err('closeSelf could not determine the current reviewer session.');
        if (!snapshotFor(ctx)) return err('List targets in this reviewer session before closing self.');
        const identity = readSessionIdentity(sessionPath);
        try {
          const result = await enqueueClosure({ kind: 'closeSelf', targetSessionId: identity.sessionId, targetSessionPath: sessionPath });
          return ok(`${result.existing ? 'Reused' : 'Enqueued'} closeSelf action ${result.action.actionId} (${result.action.status}). No review/rating was written. End the turn now.`, result);
        } catch (error) { return err((error as Error).message); }
      }

      return err(`unknown action: ${String(p.action)}`);
    },
  });
}
