import * as fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { materialDisagreementFields } from './disagreement.js';
import { compileReviewDraft } from './draft.js';
import { hashCanonicalJson } from './hash.js';
import {
  validateClassifiedCriteria, validateCriterionDefinitions, validateReviewConfidence,
  validateReviewEvidenceVector, validateReviewHumanQuestionCandidate, validateReviewProcessVector,
  validateSessionReviewV2,
} from './validation.js';
import type {
  AskUserReviewInput, ClassifiedCriterion, ConsolidationDraft, CriterionDefinition,
  EvidenceManifest, ReviewHumanCheck, ReviewerAdjudicationDraft, ReviewerAssessment,
  ReviewerAssessmentDraft, ReviewerProposalDraft, ReviewerRuntime, ReviewWorkflowRole,
  SessionReviewDraft, SessionReviewV2,
} from './types.js';

interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; line: number }
interface ParsedEntry { entry: Record<string, unknown>; line: number }
interface ToolResult { toolCallId: string; toolName: string; details?: unknown; contentText: string; timestamp?: unknown; line: number }
interface TranscriptIndex {
  calls: Map<string, ToolCall>;
  results: Map<string, ToolResult>;
  evidenceBySessionId: Map<string, EvidenceManifest[]>;
}
interface RuntimeResult extends Record<string, unknown> { parentToolCallId?: string }
interface RecoveredRole<T = unknown> {
  role: ReviewWorkflowRole;
  workflowRef: string;
  call: ToolCall;
  result: ToolResult;
  runtime: RuntimeResult;
  payload: T;
}

const roles: readonly ReviewWorkflowRole[] = [
  'proposal-small', 'proposal-medium', 'consolidation',
  'classification-small', 'classification-medium', 'adjudication',
];
const expectedBucketByRole: Record<ReviewWorkflowRole, 'small' | 'medium'> = {
  'proposal-small': 'small',
  'proposal-medium': 'medium',
  consolidation: 'medium',
  'classification-small': 'small',
  'classification-medium': 'medium',
  adjudication: 'medium',
};

export function reviewWorkflowRef(sessionId: string, role: ReviewWorkflowRole, evidenceKey: string): string {
  return `session-review-v1/${sessionId}/${evidenceKey}/${role}`;
}

export function reviewEvidenceKey(manifest: EvidenceManifest): string {
  return hashCanonicalJson(manifest);
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is Record<string, unknown> => !!part && typeof part === 'object' && !Array.isArray(part))
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
}

function activeBranchEntries(raw: string): ParsedEntry[] {
  const parsed: ParsedEntry[] = [];
  for (const [offset, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { parsed.push({ entry: JSON.parse(line) as Record<string, unknown>, line: offset + 1 }); } catch { /* ignore malformed lines */ }
  }
  const sessionEntries = parsed.filter(({ entry }) => entry.type !== 'session');
  if (sessionEntries.length === 0 || !sessionEntries.every(({ entry }) =>
    typeof entry.id === 'string' && (entry.parentId === null || typeof entry.parentId === 'string'))) {
    // Legacy v1 and focused fixtures are append-only without tree metadata.
    return parsed;
  }
  const byId = new Map(sessionEntries.map((item) => [item.entry.id as string, item]));
  const activeIds = new Set<string>();
  let current: ParsedEntry | undefined = sessionEntries[sessionEntries.length - 1];
  while (current) {
    const id = current.entry.id as string;
    if (activeIds.has(id)) return parsed;
    activeIds.add(id);
    if (current.entry.parentId === null) break;
    current = byId.get(current.entry.parentId as string);
    if (!current) return parsed;
  }
  return parsed.filter(({ entry }) => entry.type === 'session' || activeIds.has(entry.id as string));
}

function indexReviewOrchestrator(sessionPath: string): TranscriptIndex {
  const calls = new Map<string, ToolCall>();
  const results = new Map<string, ToolResult>();
  const evidenceBySessionId = new Map<string, EvidenceManifest[]>();
  const raw = fs.readFileSync(sessionPath, 'utf8');
  for (const { entry, line } of activeBranchEntries(raw)) {
    if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue;
    const message = entry.message as Record<string, unknown>;
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (part.type !== 'toolCall' || typeof part.id !== 'string' || typeof part.name !== 'string') continue;
        const args = part.arguments && typeof part.arguments === 'object' && !Array.isArray(part.arguments)
          ? part.arguments as Record<string, unknown>
          : {};
        calls.set(part.id, { id: part.id, name: part.name, arguments: args, line });
      }
      continue;
    }
    if (message.role !== 'toolResult' || typeof message.toolCallId !== 'string' || typeof message.toolName !== 'string') continue;
    const result: ToolResult = {
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      details: message.details,
      contentText: textFromContent(message.content),
      timestamp: message.timestamp ?? entry.timestamp,
      line,
    };
    results.set(result.toolCallId, result);
    if (result.toolName === 'session_review' && result.details && typeof result.details === 'object' && !Array.isArray(result.details)) {
      const details = result.details as Record<string, unknown>;
      if (typeof details.sessionId === 'string' && details.manifest && typeof details.manifest === 'object' && !Array.isArray(details.manifest)) {
        const prior = evidenceBySessionId.get(details.sessionId) ?? [];
        prior.push(details.manifest as unknown as EvidenceManifest);
        evidenceBySessionId.set(details.sessionId, prior.slice(-5));
      }
    }
  }
  return { calls, results, evidenceBySessionId };
}

export function recoveredEvidenceManifests(sessionPath: string): Map<string, EvidenceManifest[]> {
  return indexReviewOrchestrator(sessionPath).evidenceBySessionId;
}

function runtimeResult(result: ToolResult, toolCallId: string): RuntimeResult {
  const details = result.details as Record<string, unknown> | undefined;
  const candidates = Array.isArray(details?.results)
    ? details.results.filter((value): value is RuntimeResult => !!value && typeof value === 'object' && !Array.isArray(value))
    : [];
  const exact = candidates.filter((candidate) => candidate.parentToolCallId === toolCallId);
  const matches = exact.length ? exact : candidates.length === 1 ? candidates : [];
  if (matches.length !== 1) throw new Error(`subagent call ${toolCallId} does not expose one authoritative runtime result`);
  const runtime = matches[0]!;
  if (runtime.exitCode !== undefined && runtime.exitCode !== 0) throw new Error(`subagent call ${toolCallId} did not complete successfully`);
  return runtime;
}

function parseJsonOutput(value: unknown, fallback: string): unknown {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback.trim();
  if (!raw) throw new Error('reviewer returned no final JSON output');
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  try { return JSON.parse(fenced ? fenced[1]! : raw) as unknown; }
  catch (error) { throw new Error(`reviewer output is not valid JSON: ${(error as Error).message}`); }
}

function latestRole(index: TranscriptIndex, sessionId: string, role: ReviewWorkflowRole, evidenceKey: string): RecoveredRole {
  const workflowRef = reviewWorkflowRef(sessionId, role, evidenceKey);
  const candidates = [...index.calls.values()]
    .filter((call) => call.name === 'subagent' && call.arguments.workflowRef === workflowRef)
    .sort((a, b) => b.line - a.line);
  const call = candidates[0];
  if (!call) throw new Error(`missing ${role} subagent call (${workflowRef})`);
  if (call.arguments.agent !== 'reviewer') throw new Error(`${role} must use the reviewer agent`);
  if (call.arguments.bucket !== expectedBucketByRole[role]) {
    throw new Error(`${role} must request the ${expectedBucketByRole[role]} bucket`);
  }
  const result = index.results.get(call.id);
  if (!result || result.toolName !== 'subagent') throw new Error(`${role} subagent call ${call.id} has no completed result`);
  const runtime = runtimeResult(result, call.id);
  const payload = parseJsonOutput(runtime.finalOutput, result.contentText);
  return { role, workflowRef, call, result, runtime, payload };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function reviewerRuntime(role: ReviewWorkflowRole, recovered: RecoveredRole): Omit<ReviewerRuntime, 'rubricVersion'> {
  const actual = recovered.runtime;
  const requestedBucket = actual.requestedBucket ?? recovered.call.arguments.bucket;
  if (requestedBucket !== 'small' && requestedBucket !== 'medium') throw new Error(`${role} requestedBucket must be small or medium`);
  if (requestedBucket !== expectedBucketByRole[role]) throw new Error(`${role} requestedBucket must be ${expectedBucketByRole[role]}`);
  const bucket = actual.bucket;
  if (bucket !== 'small' && bucket !== 'medium' && bucket !== 'frontier') throw new Error(`${role} effective bucket is missing or invalid`);
  const modelId = typeof actual.model === 'string' && actual.model ? actual.model
    : typeof actual.selectedModel === 'string' && actual.selectedModel ? actual.selectedModel : undefined;
  return {
    reviewerId: `${role}:${recovered.call.id}`,
    toolCallId: recovered.call.id,
    requestedBucket,
    bucket,
    bucketDowngraded: actual.bucketDowngraded === true,
    modelId: string(modelId, `${role}.model`),
    provider: string(actual.provider, `${role}.provider`),
    family: string(actual.family, `${role}.family`),
    thinkingLevel: typeof actual.thinkingLevel === 'string' ? actual.thinkingLevel : null,
    promptHash: string(actual.promptHash, `${role}.promptHash`),
  };
}

function proposalDraft(recovered: RecoveredRole): ReviewerProposalDraft {
  const payload = object(recovered.payload, recovered.role);
  if (payload.candidateHumanQuestion !== undefined) validateReviewHumanQuestionCandidate(payload.candidateHumanQuestion, `${recovered.role}.candidateHumanQuestion`);
  return {
    ...reviewerRuntime(recovered.role, recovered),
    criteria: validateCriterionDefinitions(payload.criteria, `${recovered.role}.criteria`),
    ...(payload.candidateHumanQuestion === undefined ? {} : { candidateHumanQuestion: payload.candidateHumanQuestion as ReviewerProposalDraft['candidateHumanQuestion'] }),
  };
}

interface ConsolidationPayload {
  frozenLedger: CriterionDefinition[];
  selectedHumanQuestion?: ConsolidationDraft['selectedHumanQuestion'];
  dedupNotes: string[];
}
function consolidationPayload(recovered: RecoveredRole): ConsolidationPayload {
  const payload = object(recovered.payload, 'consolidation');
  const dedupNotes = payload.dedupNotes === undefined ? [] : array(payload.dedupNotes, 'consolidation.dedupNotes');
  if (!dedupNotes.every((note) => typeof note === 'string')) throw new Error('consolidation.dedupNotes must contain only strings');
  if (payload.selectedHumanQuestion !== undefined) validateReviewHumanQuestionCandidate(payload.selectedHumanQuestion, 'consolidation.selectedHumanQuestion');
  return {
    frozenLedger: validateCriterionDefinitions(payload.frozenLedger, 'consolidation.frozenLedger'),
    ...(payload.selectedHumanQuestion === undefined ? {} : { selectedHumanQuestion: payload.selectedHumanQuestion as ConsolidationDraft['selectedHumanQuestion'] }),
    dedupNotes: dedupNotes as string[],
  };
}

function classificationDraft(recovered: RecoveredRole, frozenLedger: CriterionDefinition[]): ReviewerAssessmentDraft {
  const root = object(recovered.payload, recovered.role);
  const payload = root.classifications === undefined ? root : object(root.classifications, `${recovered.role}.classifications`);
  const rawCriteria = array(payload.criteria, `${recovered.role}.criteria`).map((value, index) => object(value, `${recovered.role}.criteria[${index}]`));
  const definitions = new Map(frozenLedger.map((criterion) => [criterion.criterionId, criterion]));
  const criteria = rawCriteria.map((item, index) => {
    const criterionId = string(item.criterionId, `${recovered.role}.criteria[${index}].criterionId`);
    const definition = definitions.get(criterionId);
    if (!definition) throw new Error(`${recovered.role} classified unknown criterion ${criterionId}`);
    return {
      ...definition,
      status: item.status,
      reason: item.reason,
      evidenceRefs: item.evidenceRefs,
    } as ClassifiedCriterion;
  });
  const process = object(payload.process, `${recovered.role}.process`);
  const evidence = object(payload.evidence, `${recovered.role}.evidence`);
  validateClassifiedCriteria(criteria, frozenLedger, `${recovered.role}.criteria`);
  validateReviewProcessVector(process, `${recovered.role}.process`);
  validateReviewEvidenceVector(evidence, `${recovered.role}.evidence`);
  validateReviewConfidence(payload.confidence, `${recovered.role}.confidence`);
  return {
    ...reviewerRuntime(recovered.role, recovered),
    classifications: {
      criteria,
      process: process as unknown as ReviewerAssessmentDraft['classifications']['process'],
      evidence: evidence as unknown as ReviewerAssessmentDraft['classifications']['evidence'],
      confidence: payload.confidence as ReviewerAssessmentDraft['classifications']['confidence'],
    },
  };
}

const adjudicationValuesByField: Record<string, ReadonlySet<string>> = {
  'evidence.requirements': new Set(['clear', 'partly_clear', 'unclear']),
  'evidence.artifacts': new Set(['direct', 'partial', 'none', 'not_applicable']),
  'evidence.execution': new Set(['direct', 'partial', 'reported_only', 'none', 'not_applicable']),
  'evidence.human': new Set(['not_needed', 'supports', 'contradicts', 'inconclusive', 'unanswered', 'unavailable']),
  'process.requirementDiscipline': new Set(['proportionate', 'underclarified', 'overclarified', 'not_assessable']),
  'process.verificationDiscipline': new Set(['proportionate', 'underverified', 'oververified', 'not_applicable', 'not_assessable']),
  'process.scopeControl': new Set(['controlled', 'minor_avoidable_drift', 'material_scope_drift', 'not_assessable']),
  'process.recovery': new Set(['effective', 'partly_effective', 'ineffective', 'not_needed', 'not_assessable']),
  'process.finalClaimAccuracy': new Set(['accurate', 'overclaimed', 'underclaimed', 'unclear', 'no_final_claim']),
};
const criterionStatusValues = new Set(['met', 'partly_met', 'unmet', 'blocked', 'not_assessable', 'superseded']);
const criterionReasonValues = new Set(['none', 'omitted', 'attempt_failed', 'incorrect_result', 'regression', 'external_blocker', 'user_dependency', 'human_evidence_missing', 'insufficient_artifact_evidence', 'unknown']);

function validateAdjudicationValue(field: string, value: string): void {
  const allowed = field.endsWith('.status') && field.startsWith('criterion:')
    ? criterionStatusValues
    : field.endsWith('.reason') && field.startsWith('criterion:')
      ? criterionReasonValues
      : adjudicationValuesByField[field];
  if (!allowed?.has(value)) throw new Error(`adjudication value ${JSON.stringify(value)} is invalid for ${field}`);
}

function adjudicationDraft(recovered: RecoveredRole, expectedFields?: string[]): ReviewerAdjudicationDraft {
  const payload = object(recovered.payload, 'adjudication');
  const resolvedFields = array(payload.resolvedFields, 'adjudication.resolvedFields').map((rawValue, index) => {
    const item = object(rawValue, `adjudication.resolvedFields[${index}]`);
    const evidenceRefs = array(item.evidenceRefs, `adjudication.resolvedFields[${index}].evidenceRefs`);
    if (!evidenceRefs.every((ref) => typeof ref === 'string')) throw new Error(`adjudication.resolvedFields[${index}].evidenceRefs must contain only strings`);
    const field = string(item.field, `adjudication.resolvedFields[${index}].field`);
    const resolvedValue = string(item.value, `adjudication.resolvedFields[${index}].value`);
    validateAdjudicationValue(field, resolvedValue);
    return {
      field,
      value: resolvedValue,
      rationale: string(item.rationale, `adjudication.resolvedFields[${index}].rationale`),
      evidenceRefs: evidenceRefs as string[],
    };
  });
  const fields = resolvedFields.map((item) => item.field);
  if (new Set(fields).size !== fields.length) throw new Error('adjudication.resolvedFields contains duplicate fields');
  if (expectedFields && (fields.length !== expectedFields.length || fields.some((field) => !expectedFields.includes(field)))) {
    throw new Error(`adjudication.resolvedFields must exactly match: ${expectedFields.join(', ')}`);
  }
  return { ...reviewerRuntime(recovered.role, recovered), resolvedFields };
}

function isoTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function recoverHumanCheck(
  index: TranscriptIndex,
  sessionId: string,
  selected: ConsolidationDraft['selectedHumanQuestion'],
  afterLine: number,
): ReviewHumanCheck | undefined {
  if (!selected) return undefined;
  const candidates = [...index.calls.values()]
    .filter((call) => {
      if (call.name !== 'ask_user' || call.line <= afterLine) return false;
      const meta = call.arguments.reviewMeta;
      return call.arguments.question === selected.proposedQuestion
        && isDeepStrictEqual(call.arguments.options, selected.options)
        && !!meta && typeof meta === 'object' && !Array.isArray(meta)
        && (meta as Record<string, unknown>).purpose === 'review_human_verification'
        && (meta as Record<string, unknown>).targetSessionId === sessionId
        && (meta as Record<string, unknown>).criterionId === selected.criterionId
        && (meta as Record<string, unknown>).domain === selected.domain
        && (meta as Record<string, unknown>).expectedObservation === selected.expectedObservation;
    })
    .sort((a, b) => b.line - a.line);
  const call = candidates[0];
  if (!call) return undefined;
  const result = index.results.get(call.id);
  if (!result || result.toolName !== 'ask_user') return undefined;
  const details = result.details && typeof result.details === 'object' && !Array.isArray(result.details)
    ? result.details as Record<string, unknown> : {};
  const cancelled = details.cancelled === true;
  const answer = typeof details.answer === 'string' ? details.answer : undefined;
  const lower = answer?.toLowerCase() ?? '';
  const response = cancelled
    ? { source: 'cancelled' as const, cancelled: true as const, status: 'unanswered' as const, recordedAt: isoTimestamp(result.timestamp) }
    : answer
      ? {
          answer,
          source: details.source === 'custom' ? 'custom' as const : 'option' as const,
          cancelled: false as const,
          status: lower.includes('unable') ? 'unavailable' as const : lower.includes('inconclusive') ? 'inconclusive' as const : 'answered' as const,
          recordedAt: isoTimestamp(result.timestamp),
        }
      : { source: 'unanswered' as const, cancelled: false as const, status: 'unanswered' as const, recordedAt: isoTimestamp(result.timestamp) };
  return {
    toolCallId: call.id,
    input: call.arguments as unknown as AskUserReviewInput,
    response,
    interpretation: 'The scoped response was supplied unchanged to both fresh classifiers.',
  };
}

interface RecoveredPieces {
  proposals: [ReviewerProposalDraft, ReviewerProposalDraft];
  consolidation: ConsolidationDraft;
  frozenLedger: CriterionDefinition[];
  components: [ReviewerAssessmentDraft, ReviewerAssessmentDraft];
  adjudication?: ReviewerAdjudicationDraft;
  humanCheck?: ReviewHumanCheck;
}

function recoverPieces(orchestratorPath: string, sessionId: string, evidenceKey: string): RecoveredPieces {
  const index = indexReviewOrchestrator(orchestratorPath);
  const smallProposal = latestRole(index, sessionId, 'proposal-small', evidenceKey);
  const mediumProposal = latestRole(index, sessionId, 'proposal-medium', evidenceKey);
  const consolidationRole = latestRole(index, sessionId, 'consolidation', evidenceKey);
  const consolidationData = consolidationPayload(consolidationRole);
  const smallClassification = latestRole(index, sessionId, 'classification-small', evidenceKey);
  const mediumClassification = latestRole(index, sessionId, 'classification-medium', evidenceKey);
  const proposals: [ReviewerProposalDraft, ReviewerProposalDraft] = [proposalDraft(smallProposal), proposalDraft(mediumProposal)];
  const consolidation: ConsolidationDraft = {
    ...reviewerRuntime('consolidation', consolidationRole),
    ...(consolidationData.selectedHumanQuestion ? { selectedHumanQuestion: consolidationData.selectedHumanQuestion } : {}),
    provenance: { fromProposals: ['recovered-proposal-small', 'recovered-proposal-medium'], dedupNotes: consolidationData.dedupNotes },
  };
  const components: [ReviewerAssessmentDraft, ReviewerAssessmentDraft] = [
    classificationDraft(smallClassification, consolidationData.frozenLedger),
    classificationDraft(mediumClassification, consolidationData.frozenLedger),
  ];
  const materialFields = materialDisagreementFields(
    components[0] as unknown as ReviewerAssessment,
    components[1] as unknown as ReviewerAssessment,
  );
  let adjudication: ReviewerAdjudicationDraft | undefined;
  if (materialFields.length) adjudication = adjudicationDraft(
    latestRole(index, sessionId, 'adjudication', evidenceKey),
    requiredAdjudicationFields(materialFields),
  );
  const humanCheck = recoverHumanCheck(index, sessionId, consolidationData.selectedHumanQuestion, consolidationRole.result.line);
  return {
    proposals,
    consolidation,
    frozenLedger: consolidationData.frozenLedger,
    components,
    ...(adjudication ? { adjudication } : {}),
    ...(humanCheck ? { humanCheck } : {}),
  };
}

export function compileRecoveredReview(input: {
  orchestratorPath: string;
  orchestratorSessionId: string;
  sessionId: string;
  sessionPathAtReview: string;
  identityFallback?: boolean;
  evidenceManifest: EvidenceManifest;
}): SessionReviewV2 {
  const pieces = recoverPieces(input.orchestratorPath, input.sessionId, reviewEvidenceKey(input.evidenceManifest));
  if (pieces.consolidation.selectedHumanQuestion && !pieces.humanCheck) {
    throw new Error('selected human verification must be completed before recording a recovered review');
  }
  const draft: SessionReviewDraft = {
    sessionId: input.sessionId,
    sessionPathAtReview: input.sessionPathAtReview,
    ...(input.identityFallback !== undefined ? { identityFallback: input.identityFallback } : {}),
    frozenLedger: pieces.frozenLedger,
    proposals: pieces.proposals,
    consolidation: pieces.consolidation,
    components: pieces.components,
    ...(pieces.humanCheck ? { humanCheck: pieces.humanCheck } : {}),
    ...(pieces.adjudication ? { adjudication: pieces.adjudication } : {}),
    provenance: { evidenceManifest: input.evidenceManifest },
  };
  return validateSessionReviewV2(compileReviewDraft(draft, { orchestratorSessionId: input.orchestratorSessionId }));
}

function requiredAdjudicationFields(materialFields: string[]): string[] {
  return materialFields.flatMap((field) => {
    const criterionStatus = /^criterion:(.+)\.status$/.exec(field);
    return criterionStatus ? [field, `criterion:${criterionStatus[1]}.reason`] : [field];
  });
}

export interface ReviewRecoveryStatus {
  sessionId: string;
  workflowRefs: Record<ReviewWorkflowRole, string>;
  completedRoles: ReviewWorkflowRole[];
  invalidRoles: Array<{ role: ReviewWorkflowRole; error: string }>;
  missingRoles: ReviewWorkflowRole[];
  next: ReviewWorkflowRole | 'human-verification' | 'ready-to-record';
  handoff?: unknown;
}

export function getReviewRecoveryStatus(orchestratorPath: string, sessionId: string, evidenceManifest: EvidenceManifest): ReviewRecoveryStatus {
  const index = indexReviewOrchestrator(orchestratorPath);
  const evidenceKey = reviewEvidenceKey(evidenceManifest);
  const invalidRoles: Array<{ role: ReviewWorkflowRole; error: string }> = [];
  const recovered = new Map<ReviewWorkflowRole, RecoveredRole>();
  for (const role of roles) {
    try { recovered.set(role, latestRole(index, sessionId, role, evidenceKey)); }
    catch (error) {
      const message = (error as Error).message;
      if (!message.startsWith('missing ')) invalidRoles.push({ role, error: message });
    }
  }
  const refs = Object.fromEntries(roles.map((role) => [role, reviewWorkflowRef(sessionId, role, evidenceKey)])) as Record<ReviewWorkflowRole, string>;
  const invalidate = (role: ReviewWorkflowRole, error: unknown): void => {
    recovered.delete(role);
    invalidRoles.push({ role, error: (error as Error).message });
  };
  const response = (next: ReviewRecoveryStatus['next'], handoff?: unknown): ReviewRecoveryStatus => ({
    sessionId,
    workflowRefs: refs,
    completedRoles: roles.filter((role) => recovered.has(role)),
    invalidRoles,
    missingRoles: roles.filter((role) => !recovered.has(role)),
    next,
    ...(handoff === undefined ? {} : { handoff }),
  });

  const proposals = new Map<ReviewWorkflowRole, ReviewerProposalDraft>();
  for (const role of ['proposal-small', 'proposal-medium'] as const) {
    const value = recovered.get(role);
    if (!value) continue;
    try { proposals.set(role, proposalDraft(value)); }
    catch (error) { invalidate(role, error); }
  }
  for (const role of ['proposal-small', 'proposal-medium'] as const) if (!recovered.has(role)) return response(role);

  const proposalPair = [proposals.get('proposal-small')!, proposals.get('proposal-medium')!];
  const proposalHandoff = proposalPair.map((proposal) => ({
    criteria: proposal.criteria,
    ...(proposal.candidateHumanQuestion ? { candidateHumanQuestion: proposal.candidateHumanQuestion } : {}),
  }));
  const consolidationRole = recovered.get('consolidation');
  if (!consolidationRole) return response('consolidation', { proposals: proposalHandoff });
  let consolidation: ConsolidationPayload;
  try { consolidation = consolidationPayload(consolidationRole); }
  catch (error) {
    invalidate('consolidation', error);
    return response('consolidation', { proposals: proposalHandoff });
  }

  const humanCheck = recoverHumanCheck(index, sessionId, consolidation.selectedHumanQuestion, consolidationRole.result.line);
  if (consolidation.selectedHumanQuestion && !humanCheck) {
    return response('human-verification', { selectedHumanQuestion: consolidation.selectedHumanQuestion });
  }

  const components = new Map<ReviewWorkflowRole, ReviewerAssessmentDraft>();
  for (const role of ['classification-small', 'classification-medium'] as const) {
    const value = recovered.get(role);
    if (!value) continue;
    try { components.set(role, classificationDraft(value, consolidation.frozenLedger)); }
    catch (error) { invalidate(role, error); }
  }
  for (const role of ['classification-small', 'classification-medium'] as const) {
    if (!recovered.has(role)) return response(role, { frozenLedger: consolidation.frozenLedger, ...(humanCheck ? { humanCheck } : {}) });
  }

  const componentPair = [components.get('classification-small')!, components.get('classification-medium')!] as [ReviewerAssessmentDraft, ReviewerAssessmentDraft];
  const materialFields = materialDisagreementFields(componentPair[0] as unknown as ReviewerAssessment, componentPair[1] as unknown as ReviewerAssessment);
  if (materialFields.length) {
    const adjudicationRole = recovered.get('adjudication');
    if (!adjudicationRole) return response('adjudication', {
      frozenLedger: consolidation.frozenLedger,
      components: componentPair.map((component) => component.classifications),
      materialFields: requiredAdjudicationFields(materialFields),
    });
    try { adjudicationDraft(adjudicationRole, requiredAdjudicationFields(materialFields)); }
    catch (error) {
      invalidate('adjudication', error);
      return response('adjudication', {
        frozenLedger: consolidation.frozenLedger,
        components: componentPair.map((component) => component.classifications),
        materialFields: requiredAdjudicationFields(materialFields),
      });
    }
  }
  return response('ready-to-record');
}
