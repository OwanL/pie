import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { buildBlindedEvidence, readSessionIdentity } from './src/evidence.js';
import { compileReviewDraft, isSessionReviewDraft } from './src/draft.js';
import { hashCanonicalJson, sha256 } from './src/hash.js';
import { compileRecoveredReview, getReviewRecoveryStatus, recoveredEvidenceManifests } from './src/recovery.js';
import { validateRuntimeProvenance } from './src/runtime-provenance.js';
import { sessionReviewSchema } from './src/types.js';
import type { EvidenceManifest, OpenTabSummary, ReviewClosureTarget, SessionReviewDraft, SessionReviewParams, SessionReviewV2 } from './src/types.js';
import { enqueueClosure, enqueueClosureBatch, readClosureActions, readOpenTabRegistry, readReviewStore, recordReviewOnce } from './src/store.js';
import type { OpenTabRegistry } from './src/store.js';
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
  orchestratorSessionId: string;
  selection: 'open' | 'selected';
  registryRevision?: number;
  branchAnchor: BranchAnchor;
  targetsByPath: Map<string, ListedSession>;
  targetsById: Map<string, ListedSession>;
  evidenceBySessionId: Map<string, EvidenceManifest[]>;
}
interface BranchAnchor {
  prefixBytes: number;
  tailOffset: number;
  tailSha256: string;
  observedBytes: number;
  laterUserTurnObserved: boolean;
}
const BRANCH_ANCHOR_BYTES = 8 * 1024;
const orchestratorSnapshots = new Map<string, OrchestratorSnapshot>();
function orchestratorPath(ctx: ToolExecuteCtx): string | undefined { return ctx?.sessionManager?.getSessionFile(); }

/** Bind target authority to the append-only branch that issued
 * listOpen/listSelected. Tool traffic, history compaction, and later user turns
 * may append after this prefix without losing an in-flight batch. Edit/resend
 * or branch rewrites invalidate every action. A later user turn is tracked
 * separately because closeSelf alone requires a fresh explicit listSelected. */
function captureBranchAnchor(sessionPath: string): BranchAnchor {
  const descriptor = fs.openSync(sessionPath, 'r');
  try {
    const prefixBytes = fs.fstatSync(descriptor).size;
    const tailOffset = Math.max(0, prefixBytes - BRANCH_ANCHOR_BYTES);
    const tail = Buffer.alloc(prefixBytes - tailOffset);
    const bytesRead = tail.byteLength ? fs.readSync(descriptor, tail, 0, tail.byteLength, tailOffset) : 0;
    if (bytesRead !== tail.byteLength) throw new Error('Could not capture the reviewer branch authority anchor.');
    return {
      prefixBytes,
      tailOffset,
      tailSha256: sha256(tail),
      observedBytes: prefixBytes,
      laterUserTurnObserved: false,
    };
  } finally { fs.closeSync(descriptor); }
}
function branchAnchorIsCurrent(sessionPath: string, anchor: BranchAnchor): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(sessionPath, 'r');
    const currentBytes = fs.fstatSync(descriptor).size;
    if (currentBytes < anchor.prefixBytes || currentBytes < anchor.observedBytes) return false;
    const length = anchor.prefixBytes - anchor.tailOffset;
    const tail = Buffer.alloc(length);
    const bytesRead = length ? fs.readSync(descriptor, tail, 0, length, anchor.tailOffset) : 0;
    if (bytesRead !== length || sha256(tail) !== anchor.tailSha256) return false;

    // Inspect only bytes appended since the previous check. Ordinary user
    // steering does not invalidate the original, live-revalidated target set;
    // otherwise a harmless follow-up would strand an in-flight review. Keep
    // the turn boundary for closeSelf, whose explicit permission must be fresh.
    // An incomplete final JSONL line stays pending for the next check.
    const appendedLength = currentBytes - anchor.observedBytes;
    if (!appendedLength) return true;
    const appended = Buffer.alloc(appendedLength);
    if (fs.readSync(descriptor, appended, 0, appendedLength, anchor.observedBytes) !== appendedLength) return false;
    const lastNewline = appended.lastIndexOf(0x0a);
    if (lastNewline < 0) return true;
    for (const line of appended.subarray(0, lastNewline + 1).toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { type?: unknown; message?: { role?: unknown } };
        if (entry.type === 'message' && entry.message?.role === 'user') anchor.laterUserTurnObserved = true;
      } catch {
        // A complete malformed transcript entry makes the current branch
        // unknowable. Never carry review or closure authority across it.
        return false;
      }
    }
    anchor.observedBytes += lastNewline + 1;
    return true;
  } catch { return false; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function snapshotFor(
  ctx: ToolExecuteCtx,
  options: { requireFreshUserTurn?: boolean } = {},
): OrchestratorSnapshot | undefined {
  const current = orchestratorPath(ctx);
  if (!current) return undefined;
  const snapshot = orchestratorSnapshots.get(current);
  if (!snapshot) return undefined;
  if (!branchAnchorIsCurrent(current, snapshot.branchAnchor)) {
    orchestratorSnapshots.delete(current);
    return undefined;
  }
  if (options.requireFreshUserTurn && snapshot.branchAnchor.laterUserTurnObserved) return undefined;
  const currentRevision = readOpenTabRegistry().revision;
  if (snapshot.registryRevision !== undefined
    && (currentRevision === undefined || currentRevision < snapshot.registryRevision)) {
    return undefined;
  }
  return snapshot;
}

function listedSession(tab: OpenTabSummary, selfId: string | undefined, reviews: Map<string, SessionReviewV2>): ListedSession {
  const identity = readSessionIdentity(tab.path);
  const existingReview = reviews.get(identity.sessionId);
  const reviewStatus: ListedSession['reviewStatus'] = existingReview ? 'reviewed' : 'unrated';
  const isSelf = !!selfId && identity.sessionId === selfId;
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
    reviewEligible: !isSelf && !tab.isRunning && !existingReview,
    closureEligible: !isSelf && !!existingReview,
  };
}

/** Resolve an originally-authorized target from the current live registry.
 * The stored list controls scope only; membership, selection, identity,
 * running state, and review state all come from the current registry/store. */
function currentSnapshotTarget(
  snapshot: OrchestratorSnapshot,
  sessionPath?: string,
  sessionId?: string,
  options: { allowSelf?: boolean; allowRunning?: boolean } = {},
  live?: { registry: OpenTabRegistry; reviews: ReturnType<typeof readReviewStore>['canonicalBySessionId'] },
): ListedSession | undefined {
  const listed = sessionPath ? snapshot.targetsByPath.get(sessionPath) : sessionId ? snapshot.targetsById.get(sessionId) : undefined;
  if (!listed || (sessionId && listed.sessionId !== sessionId)) return undefined;
  const registry = live?.registry ?? readOpenTabRegistry();
  if (snapshot.registryRevision !== undefined
    && (registry.revision === undefined || registry.revision < snapshot.registryRevision)) return undefined;
  const tab = registry.tabs.find((candidate) => candidate.path === listed.sessionPath);
  if (!tab || (snapshot.selection === 'selected' && !tab.pinned)) return undefined;
  const current = listedSession(tab, snapshot.orchestratorSessionId, live?.reviews ?? readReviewStore().canonicalBySessionId);
  if (current.sessionId !== listed.sessionId || current.identityFallback !== listed.identityFallback) return undefined;
  if (!options.allowSelf && current.isSelf) return undefined;
  if (!options.allowRunning && current.isRunning) return undefined;
  return current;
}
function eligibleTarget(snapshot: OrchestratorSnapshot, sessionPath?: string, sessionId?: string): ListedSession | undefined {
  return currentSnapshotTarget(snapshot, sessionPath, sessionId);
}
/** Closure eligibility is broader than review eligibility: an already-reviewed
 *  running session is closeable as a durable tab hide, while evidence and
 *  review recording remain forbidden for running targets. Self is always
 *  excluded; the persisted canonical review match is checked by the caller. */
function closureEligibleTarget(
  snapshot: OrchestratorSnapshot,
  sessionPath?: string,
  sessionId?: string,
  live?: { registry: OpenTabRegistry; reviews: ReturnType<typeof readReviewStore>['canonicalBySessionId'] },
): ListedSession | undefined {
  return currentSnapshotTarget(snapshot, sessionPath, sessionId, { allowRunning: true }, live);
}

function latestRecoveryCheckpoint(snapshot: OrchestratorSnapshot, sessionId: string) {
  const manifests = snapshot.evidenceBySessionId.get(sessionId) ?? [];
  const latestManifest = manifests[manifests.length - 1];
  if (!latestManifest) return undefined;
  return getReviewRecoveryStatus(snapshot.orchestratorPath, sessionId, latestManifest).checkpoint;
}

/** Return the unfinished target whose evidence has been issued in this
 * orchestrator. Evidence is the workflow boundary: allowing another target
 * before the current one is recorded and closed recreates the history/context
 * explosion that recovery is intended to prevent. */
function activeReviewTargets(snapshot: OrchestratorSnapshot): ListedSession[] {
  const reviews = readReviewStore().canonicalBySessionId;
  const closures = readClosureActions();
  return [...snapshot.evidenceBySessionId.keys()].flatMap((sessionId) => {
    const target = currentSnapshotTarget(snapshot, undefined, sessionId, { allowRunning: true });
    if (!target) return [];
    const review = reviews.get(sessionId);
    if (review && closures.some((action) =>
      action.kind === 'closeReviewed'
      && action.targetSessionId === sessionId
      && action.reviewId === review.reviewId
      && (action.status === 'pending' || action.status === 'retrying'))
    ) return [];
    try {
      // An exhausted role remains unreviewed and recordRecoveredReview still
      // rejects it, but it must not monopolize the batch forever. Recovery is
      // durable, so a later status call can still report the blocked target.
      if (latestRecoveryCheckpoint(snapshot, sessionId)?.state === 'blocked') return [];
    } catch {
      // Unknown recovery state fails closed and keeps the target active.
    }
    return [target];
  });
}

function reviewTurnError(snapshot: OrchestratorSnapshot, sessionId: string): string | undefined {
  // Normally the evidence boundary admits one unfinished target. Recovery can
  // reveal several at once when a bug fix makes formerly blocked durable roles
  // valid again. Serialize those targets in evidence-issuance order instead of
  // making each one reject the others and deadlocking the batch.
  const blocker = activeReviewTargets(snapshot)[0];
  if (!blocker || blocker.sessionId === sessionId) return undefined;
  return `Target ${blocker.sessionId} (${truncate(blocker.name, 40)}) is still the active review target. Record its review and request closeReviewed before starting another target.`;
}

function listSessions(selfId: string, selectedOnly: boolean, registry: OpenTabRegistry): ListedSession[] {
  const reviews = readReviewStore().canonicalBySessionId;
  return registry.tabs
    .filter((tab) => !selectedOnly || tab.pinned)
    .map((tab) => listedSession(tab, selfId, reviews));
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
    return normalizeFrozenLedgerHashes(compileReviewDraft(draft, { orchestratorSessionId: scope.orchestratorSessionId })) as SessionReviewV2;
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
  // Membership and idle state are live requirements. A production review may
  // already exist by the time an idempotent retry arrives, and calibration
  // records intentionally coexist with production, so review uniqueness stays
  // the store's lock-time responsibility.
  if (!target) throw new Error('Review target is not an eligible selected/open snapshot member.');
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
      'List once before review work. Review only those selected targets, exclude (self), and do not re-rate already-reviewed sessions. Ordinary user follow-ups and closure of earlier targets do not invalidate the batch; every target is still revalidated against live membership and identity. Relist after an edit/resend/branch rewrite or extension restart, and to add newly selected targets. The tool permits one active evidence target: finish, record, and request closeReviewed before another; a checkpoint-blocked target remains unreviewed but no longer blocks later targets. Treat getReviewStatus.checkpoint as authoritative: launch exactly its entries with the tool-free session-evaluator, issued bucket/workflowRef/taskInstructions, and never exceed its one-retry budget. Never call closeSelf automatically. Only call it with confirmSelf:true after a same-turn listSelected when the user explicitly asked to hide/close this pinned evaluator session; closeSelf never interrupts running work.'
    ],
    parameters: sessionReviewSchema,

    async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolExecuteCtx) {
      if (isDisabledByToggle()) return err('The session-reviewer extension is disabled. Enable it in Settings → Extensions.');
      const p = params as SessionReviewParams;

      if (p.action === 'listOpen' || p.action === 'listSelected') {
        const current = orchestratorPath(ctx);
        if (!current) return err('Could not determine the current reviewer session for target scoping.');
        try {
          const selectedOnly = p.action === 'listSelected';
          const registry = readOpenTabRegistry();
          const orchestratorSessionId = readSessionIdentity(current).sessionId;
          const sessions = listSessions(orchestratorSessionId, selectedOnly, registry);
          orchestratorSnapshots.set(current, {
            orchestratorPath: current,
            orchestratorSessionId,
            selection: selectedOnly ? 'selected' : 'open',
            ...(registry.revision !== undefined ? { registryRevision: registry.revision } : {}),
            branchAnchor: captureBranchAnchor(current),
            targetsByPath: new Map(sessions.map((session) => [session.sessionPath, session])),
            targetsById: new Map(sessions.map((session) => [session.sessionId, session])),
            // Tool-result details are durable in the orchestrator JSONL even when
            // history compaction removes their text from the model context. Rehydrate
            // issued manifests so backend/session restart is also resumable.
            evidenceBySessionId: recoveredEvidenceManifests(current),
          });
          return ok(renderList(sessions, selectedOnly), { sessions, registryRevision: registry.revision ?? null });
        } catch (error) { return err((error as Error).message); }
      }

      if (p.action === 'getEvidence') {
        if (!p.sessionPath) return err('getEvidence requires sessionPath (from listOpen/listSelected).');
        const scope = snapshotFor(ctx);
        if (!scope) return err('List targets in this reviewer session before fetching evidence.');
        const target = eligibleTarget(scope, p.sessionPath);
        if (!target) return err('Evidence target is not an eligible selected/open snapshot member (self and running sessions are excluded).');
        if (!target.reviewEligible) return err('Evidence is only fetched for unrated review targets; already-reviewed sessions are closure-only.');
        const turnError = reviewTurnError(scope, target.sessionId);
        if (turnError) return err(turnError);
        try {
          const bundle = buildBlindedEvidence(target.sessionPath, typeof p.maxTurns === 'number' ? p.maxTurns : 40, p.artifacts ?? []);
          if (bundle.sessionId !== target.sessionId || bundle.identityFallback !== target.identityFallback) return err('Target identity changed after the list snapshot; list targets again.');
          const prior = scope.evidenceBySessionId.get(bundle.sessionId) ?? [];
          const latestManifest = prior[prior.length - 1];
          const checkpoint = latestManifest ? latestRecoveryCheckpoint(scope, target.sessionId) : undefined;
          const evidenceOptionsChanged = latestManifest
            && hashCanonicalJson(latestManifest) !== hashCanonicalJson(bundle.manifest);
          const roleWorkStarted = checkpoint
            && Object.values(checkpoint.attemptsByRole).some((attempts) => attempts > 0);
          if (latestManifest
            && latestManifest.rawJsonlSha256 === bundle.manifest.rawJsonlSha256
            && evidenceOptionsChanged
            && roleWorkStarted) {
            return err('Reviewer role work already started for this unchanged target session. Re-fetch the identical bundle if context was lost, or continue the batch if its checkpoint is blocked; do not reset the retry budget by changing evidence options.');
          }
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

      if (p.action === 'getReviewStatus') {
        if (!p.sessionId) return err('getReviewStatus requires sessionId from listOpen/listSelected.');
        const scope = snapshotFor(ctx);
        if (!scope) return err('List targets in this reviewer session before recovering review work.');
        const target = eligibleTarget(scope, p.sessionPath, p.sessionId);
        if (!target || !target.reviewEligible) return err('Review status target is not an eligible unrated selected/open snapshot member.');
        const turnError = reviewTurnError(scope, target.sessionId);
        if (turnError) return err(turnError);
        const issued = scope.evidenceBySessionId.get(target.sessionId) ?? [];
        const evidenceManifest = issued[issued.length - 1];
        if (!evidenceManifest) return err('Fetch evidence for this target before requesting review status.');
        try {
          const status = getReviewRecoveryStatus(scope.orchestratorPath, target.sessionId, evidenceManifest);
          return ok(JSON.stringify(status), status);
        } catch (error) { return err((error as Error).message); }
      }

      if (p.action === 'recordRecoveredReview') {
        if (!p.sessionId) return err('recordRecoveredReview requires sessionId from listOpen/listSelected.');
        const scope = snapshotFor(ctx);
        if (!scope) return err('List targets in this reviewer session before recording.');
        const target = eligibleTarget(scope, p.sessionPath, p.sessionId);
        if (!target) return err('Recovered review target is not an eligible selected/open snapshot member.');
        const turnError = reviewTurnError(scope, target.sessionId);
        if (turnError) return err(turnError);
        const issued = scope.evidenceBySessionId.get(target.sessionId) ?? [];
        const evidenceManifest = issued[issued.length - 1];
        if (!evidenceManifest) return err('Fetch evidence for this target before recording; no issued manifest is recoverable.');
        try {
          const recovery = getReviewRecoveryStatus(scope.orchestratorPath, target.sessionId, evidenceManifest);
          if (recovery.checkpoint.state === 'blocked') {
            const failures = recovery.checkpoint.blockedRoles.map(({ role, error }) => `${role}: ${error}`).join('; ');
            return err(`Recovered review pipeline is blocked after its retry budget: ${failures}`, recovery);
          }
          if (recovery.checkpoint.state !== 'ready-to-record') {
            return err(`Recovered review pipeline is not ready to record; next action is ${recovery.checkpoint.nextAction}.`, recovery);
          }
          const review = validateSessionReviewV2(compileRecoveredReview({
            orchestratorPath: scope.orchestratorPath,
            orchestratorSessionId: scope.orchestratorSessionId,
            sessionId: target.sessionId,
            sessionPathAtReview: target.sessionPath,
            identityFallback: target.identityFallback,
            evidenceManifest,
          }));
          validateReviewTarget(review, scope);
          const result = await recordReviewOnce(review);
          if (!result.written) return ok(`Session ${review.sessionId} already has canonical production review ${result.reviewId}; no duplicate was written.`, result);
          return ok(`Recovered and recorded ${review.kind} review ${review.reviewId} for session ${review.sessionId}.\nStored in ${result.file}. No closure action was written.`, result);
        } catch (error) { return err((error as Error).message); }
      }

      if (p.action === 'recordReview') {
        if (p.review === undefined && p.reviewPath === undefined) return err('recordReview requires review or reviewPath.');
        const scope = snapshotFor(ctx);
        if (!scope) return err('List targets in this reviewer session before recording.');
        try {
          const review = prepareReview(p.review, p.reviewPath, scope);
          const turnError = reviewTurnError(scope, review.sessionId);
          if (turnError) throw new Error(turnError);
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
          const prepared = inputs.map((input, index) => ({ index, review: prepareReview(input, undefined, scope) }));
          const sessionIds = new Set(prepared.map(({ review }) => review.sessionId));
          if (sessionIds.size !== 1) throw new Error('recordReviews accepts only one active target at a time; record and close each target before continuing.');
          const [sessionId] = sessionIds;
          const turnError = reviewTurnError(scope, sessionId!);
          if (turnError) throw new Error(turnError);
          for (const { review } of prepared) validateReviewTarget(review, scope);
          const results = await Promise.all(prepared.map(async ({ review, index }) => {
            try {
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
          const disposition = target.isRunning ? 'hide-running' : 'close-tab';
          const effect = target.isRunning
            ? 'The target is currently running, so this is a tab hide/unpin request only; it does not interrupt the agent or its subagents.'
            : 'The host will remove this target from the open/pinned tab lists.';
          return ok(`${result.existing ? 'Reused' : 'Enqueued'} closeReviewed action ${result.action.actionId} (${result.action.status}).\n${effect} Normal session persistence or privacy cleanup still follows the host close path.\nOutbox: ${result.file}. reviews.jsonl was not modified.`, { ...result, disposition });
        } catch (error) { return err((error as Error).message); }
      }

      if (p.action === 'closeReviewedBatch') {
        if (!p.closures?.length) return err('closeReviewedBatch requires at least one closure target.');
        const scope = snapshotFor(ctx);
        if (!scope) return err('List targets in this reviewer session before closing.');
        const snapshot = readReviewStore();
        const live = { registry: readOpenTabRegistry(), reviews: snapshot.canonicalBySessionId };
        const results: Array<Record<string, unknown> & { error?: string }> = new Array(p.closures.length);
        const valid: Array<{ index: number; closure: ReviewClosureTarget; target: ListedSession }> = [];
        p.closures.forEach((closure: ReviewClosureTarget, index) => {
          try {
            const target = closureEligibleTarget(scope, closure.sessionPath, closure.sessionId, live);
            if (!target) throw new Error('Closure target is not an eligible selected/open snapshot member (self is excluded).');
            const review = snapshot.canonicalBySessionId.get(closure.sessionId);
            if (!review || review.reviewId !== closure.reviewId) throw new Error('closure requires a matching persisted canonical review.');
            if (closure.sessionPath) {
              const identity = readSessionIdentity(closure.sessionPath);
              if (identity.sessionId !== closure.sessionId) throw new Error('closure sessionPath does not match sessionId.');
            }
            valid.push({ index, closure, target });
          } catch (error) {
            results[index] = { index, sessionId: closure.sessionId, reviewId: closure.reviewId, error: (error as Error).message };
          }
        });
        if (valid.length > 0) {
          try {
            const enqueued = await enqueueClosureBatch(valid.map(({ closure, target }) => ({
              kind: 'closeReviewed', targetSessionId: closure.sessionId, targetSessionPath: target.sessionPath, reviewId: closure.reviewId,
            })));
            enqueued.forEach((result, validIndex) => {
              const { index, closure, target } = valid[validIndex]!;
              results[index] = 'error' in result
                ? { index, sessionId: closure.sessionId, reviewId: closure.reviewId, error: result.error }
                : { index, sessionId: closure.sessionId, reviewId: closure.reviewId, actionId: result.action.actionId, status: result.action.status, existing: result.existing, disposition: target.isRunning ? 'hide-running' : 'close-tab' };
            });
          } catch (error) {
            for (const { index, closure } of valid) {
              results[index] = { index, sessionId: closure.sessionId, reviewId: closure.reviewId, error: (error as Error).message };
            }
          }
        }
        return batchResponse('Requested closure batch', results);
      }

      if (p.action === 'closeSelf') {
        if (p.confirmSelf !== true) return err('closeSelf is disabled by default. It requires confirmSelf:true and an explicit user request to close this evaluator session.');
        const sessionPath = orchestratorPath(ctx);
        if (!sessionPath) return err('closeSelf could not determine the current reviewer session.');
        const scope = snapshotFor(ctx, { requireFreshUserTurn: true });
        if (!scope || scope.selection !== 'selected') return err('Call listSelected in the current user turn before closing self; listOpen and earlier-turn snapshots do not authorize closeSelf.');
        const target = currentSnapshotTarget(scope, sessionPath, scope.orchestratorSessionId, { allowSelf: true, allowRunning: true });
        if (!target?.isSelf || !target.pinned) return err('closeSelf requires this evaluator to be an explicitly listed, currently pinned session. Relist with listSelected after tab or branch changes.');
        try {
          const result = await enqueueClosure({ kind: 'closeSelf', targetSessionId: scope.orchestratorSessionId, targetSessionPath: sessionPath });
          const disposition = target.isRunning ? 'hide-running' : 'close-tab';
          const effect = target.isRunning
            ? 'This evaluator is running, so the action only hides/unpins its tab; it does not interrupt this turn or any subagents.'
            : 'This removes the evaluator tab from the open/pinned tab lists.';
          return ok(`${result.existing ? 'Reused' : 'Enqueued'} closeSelf action ${result.action.actionId} (${result.action.status}). ${effect} Normal session persistence or privacy cleanup still follows the host close path. No review was written. End the turn now.`, { ...result, disposition });
        } catch (error) { return err((error as Error).message); }
      }

      return err(`unknown action: ${String(p.action)}`);
    },
  });
}
