import { isDeepStrictEqual } from 'node:util';

import { materialDisagreementFields } from './disagreement.js';
import { compileReviewDraft } from './draft.js';
import { hashCanonicalJson } from './hash.js';
import {
  validateClassifiedCriteria, validateCriterionDefinitions, validateCriterionStatusReason,
  validateReviewConfidence, validateReviewEvidenceVector, validateReviewHumanQuestionCandidate,
  validateReviewProcessVector, validateSessionReviewV2,
} from './validation.js';
import type {
  AskUserReviewInput, ClassifiedCriterion, ConsolidationDraft, CriterionDefinition,
  EvidenceManifest, ReviewHumanCheck, ReviewerAdjudicationDraft, ReviewerAssessment,
  ReviewerAssessmentDraft, ReviewerProposalDraft, ReviewerRuntime, ReviewWorkflowRole,
  SessionReviewDraft, SessionReviewV2,
} from './types.js';
import {
  currentReviewWorkflowRef, expectedAgentForWorkflowRef, legacyReviewWorkflowRef,
  SESSION_EVALUATOR_AGENT,
} from './workflow.js';
import {
  readRecoveryTranscriptIndex,
  type RecoveryToolCall as ToolCall,
  type RecoveryToolResult as ToolResult,
  type RecoveryTranscriptIndex as TranscriptIndex,
} from './recovery-transcript.js';

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
const MAX_REVIEWER_OUTPUT_CHARS = 256 * 1024;
export const MAX_REVIEW_ROLE_ATTEMPTS = 2;

export function reviewWorkflowRef(sessionId: string, role: ReviewWorkflowRole, evidenceKey: string): string {
  return currentReviewWorkflowRef(sessionId, role, evidenceKey);
}

export function reviewEvidenceKey(manifest: EvidenceManifest): string {
  return hashCanonicalJson(manifest);
}

function indexReviewOrchestrator(sessionPath: string): TranscriptIndex {
  return readRecoveryTranscriptIndex(sessionPath);
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

/** Locate complete top-level JSON objects while respecting braces inside JSON
 * strings. This is deliberately not a general repair pass: it only unwraps a
 * single intact object from common Markdown/preamble noise, and all recovered
 * fields still pass the normal role-specific validators. */
interface JsonObjectCandidate { text: string; start: number; end: number }

function balancedJsonObjects(raw: string): JsonObjectCandidate[] {
  const candidates: JsonObjectCandidate[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      if (depth > 0) quoted = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      candidates.push({ text: raw.slice(start, index + 1), start, end: index + 1 });
      if (candidates.length >= 16) break;
      start = -1;
    }
  }
  return candidates;
}

function parseJsonOutput(value: unknown, fallback: string): unknown {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback.trim();
  if (!raw) throw new Error('reviewer returned no final JSON output');
  if (raw.length > MAX_REVIEWER_OUTPUT_CHARS) {
    throw new Error(`reviewer output exceeds the ${MAX_REVIEWER_OUTPUT_CHARS}-character structured-output limit`);
  }
  try { return JSON.parse(raw) as unknown; }
  catch (directError) {
    const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map((match): JsonObjectCandidate => {
      const captured = match[1]!;
      const leading = captured.length - captured.trimStart().length;
      const text = captured.trim();
      const captureOffset = match[0].indexOf(captured);
      const start = match.index! + captureOffset + leading;
      return { text, start, end: start + text.length };
    });
    // The fenced matcher and brace scanner see the same physical object. Dedupe
    // by source span, never by JSON value: two separately emitted identical
    // objects are still ambiguous and must be rejected.
    const candidates = new Map<string, JsonObjectCandidate>();
    for (const candidate of [...fenced, ...balancedJsonObjects(raw)]) {
      candidates.set(`${candidate.start}:${candidate.end}`, candidate);
    }
    const parsed: unknown[] = [];
    for (const candidate of candidates.values()) {
      try {
        const value = JSON.parse(candidate.text) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        parsed.push(value);
      } catch { /* only complete, independently valid objects are eligible */ }
    }
    if (parsed.length === 1) return parsed[0];
    if (parsed.length > 1) throw new Error('reviewer output contains multiple JSON objects; exactly one is required');
    throw new Error(`reviewer output is not valid JSON: ${(directError as Error).message}`);
  }
}

function latestRole(index: TranscriptIndex, sessionId: string, role: ReviewWorkflowRole, evidenceKey: string): RecoveredRole {
  const workflowRef = reviewWorkflowRef(sessionId, role, evidenceKey);
  const legacyRef = legacyReviewWorkflowRef(sessionId, role, evidenceKey);
  const candidates = index.callOccurrences
    .filter((call) => call.name === 'subagent' && (call.arguments.workflowRef === workflowRef || call.arguments.workflowRef === legacyRef))
    .sort((a, b) => b.line - a.line);
  const call = candidates[0];
  if (!call) throw new Error(`missing ${role} subagent call (${workflowRef})`);
  const expectedAgent = expectedAgentForWorkflowRef(call.arguments.workflowRef) ?? SESSION_EVALUATOR_AGENT;
  if (call.arguments.agent !== expectedAgent) throw new Error(`${role} must use the ${expectedAgent} agent`);
  if (call.arguments.bucket !== expectedBucketByRole[role]) {
    throw new Error(`${role} must request the ${expectedBucketByRole[role]} bucket`);
  }
  const result = index.results.get(call.id);
  if (!result || result.toolName !== 'subagent') throw new Error(`${role} subagent call ${call.id} has no completed result`);
  const runtime = runtimeResult(result, call.id);
  const payload = parseJsonOutput(runtime.finalOutput, result.contentText);
  return { role, workflowRef: call.arguments.workflowRef as string, call, result, runtime, payload };
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
  if (bucket === 'frontier' || (requestedBucket === 'small' && bucket !== 'small')) {
    throw new Error(`${role} effective bucket ${bucket} is not a valid downgrade from ${requestedBucket}`);
  }
  const bucketDowngraded = actual.bucketDowngraded;
  if (typeof bucketDowngraded !== 'boolean' || bucketDowngraded !== (bucket !== requestedBucket)) {
    throw new Error(`${role} bucketDowngraded does not match requested/effective bucket`);
  }
  const modelId = typeof actual.model === 'string' && actual.model ? actual.model
    : typeof actual.selectedModel === 'string' && actual.selectedModel ? actual.selectedModel : undefined;
  return {
    reviewerId: `${role}:${recovered.call.id}`,
    toolCallId: recovered.call.id,
    requestedBucket,
    bucket,
    bucketDowngraded,
    modelId: string(modelId, `${role}.model`),
    provider: string(actual.provider, `${role}.provider`),
    family: string(actual.family, `${role}.family`),
    thinkingLevel: typeof actual.thinkingLevel === 'string' ? actual.thinkingLevel : null,
    promptHash: string(actual.promptHash, `${role}.promptHash`),
  };
}

const taxonomyActivities = new Set(['implement', 'debug', 'investigate', 'explain', 'design', 'operate', 'verify', 'other']);
const taxonomySurfaces = new Set(['ui', 'application_logic', 'api_integration', 'data', 'tests', 'documentation', 'configuration', 'infrastructure', 'developer_tooling', 'agent_harness', 'external_system', 'communication', 'other']);
const taxonomyEvidenceModes = new Set(['static_inspection', 'automated_check', 'runtime_observation', 'human_observation', 'external_confirmation', 'reasoning_or_sources', 'other']);

/** Repair only mechanically unambiguous taxonomy wire-shape mistakes. A
 * singleton valid activity array is the same value with one extra container.
 * Surface/evidence-mode enums are disjoint except `other`, so a value which is
 * invalid in its current namespace but valid only in the sibling namespace can
 * be moved without inventing evaluator meaning. Unknown aliases remain invalid. */
function normalizedCriterionDefinitions(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((rawCriterion) => {
    if (!rawCriterion || typeof rawCriterion !== 'object' || Array.isArray(rawCriterion)) return rawCriterion;
    const criterion = rawCriterion as Record<string, unknown>;
    if (!criterion.taxonomy || typeof criterion.taxonomy !== 'object' || Array.isArray(criterion.taxonomy)) return rawCriterion;
    const taxonomy = criterion.taxonomy as Record<string, unknown>;
    const normalized = { ...taxonomy };
    if (Array.isArray(taxonomy.activity)
      && taxonomy.activity.length === 1
      && typeof taxonomy.activity[0] === 'string'
      && taxonomyActivities.has(taxonomy.activity[0])) {
      normalized.activity = taxonomy.activity[0];
    }
    if (Array.isArray(taxonomy.surface)
      && taxonomy.surface.every((item) => typeof item === 'string')
      && Array.isArray(taxonomy.evidenceMode)
      && taxonomy.evidenceMode.every((item) => typeof item === 'string')) {
      const surfaces = taxonomy.surface as string[];
      const modes = taxonomy.evidenceMode as string[];
      const misplacedModes = surfaces.filter((item) => !taxonomySurfaces.has(item) && taxonomyEvidenceModes.has(item));
      const misplacedSurfaces = modes.filter((item) => !taxonomyEvidenceModes.has(item) && taxonomySurfaces.has(item));
      const unrecognizedSurface = surfaces.some((item) => !taxonomySurfaces.has(item) && !taxonomyEvidenceModes.has(item));
      const unrecognizedMode = modes.some((item) => !taxonomyEvidenceModes.has(item) && !taxonomySurfaces.has(item));
      if (!unrecognizedSurface && !unrecognizedMode) {
        normalized.surface = [...new Set([
          ...surfaces.filter((item) => taxonomySurfaces.has(item)),
          ...misplacedSurfaces,
        ])];
        normalized.evidenceMode = [...new Set([
          ...modes.filter((item) => taxonomyEvidenceModes.has(item)),
          ...misplacedModes,
        ])];
      }
    }
    return { ...criterion, taxonomy: normalized };
  });
}

function proposalDraft(recovered: RecoveredRole): ReviewerProposalDraft {
  const payload = object(recovered.payload, recovered.role);
  if (payload.candidateHumanQuestion !== undefined) validateReviewHumanQuestionCandidate(payload.candidateHumanQuestion, `${recovered.role}.candidateHumanQuestion`);
  return {
    ...reviewerRuntime(recovered.role, recovered),
    criteria: validateCriterionDefinitions(normalizedCriterionDefinitions(payload.criteria), `${recovered.role}.criteria`),
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
    frozenLedger: validateCriterionDefinitions(normalizedCriterionDefinitions(payload.frozenLedger), 'consolidation.frozenLedger'),
    ...(payload.selectedHumanQuestion === undefined ? {} : { selectedHumanQuestion: payload.selectedHumanQuestion as ConsolidationDraft['selectedHumanQuestion'] }),
    dedupNotes: dedupNotes as string[],
  };
}

function normalizedClassificationPayload(recovered: RecoveredRole): Record<string, unknown> {
  const root = object(recovered.payload, recovered.role);
  const payload = root.classifications === undefined ? root : object(root.classifications, `${recovered.role}.classifications`);
  const process = object(payload.process, `${recovered.role}.process`);
  // A reviewer can close the process object one brace too late and place the
  // complete evidence vector inside it. This is an unambiguous structural
  // mistake, not a semantic repair: hoist only that exact missing-top-level
  // shape, then run every normal validator on the recovered payload.
  if (process.evidence !== undefined) {
    const nestedEvidence = object(process.evidence, `${recovered.role}.process.evidence`);
    if (payload.evidence !== undefined && !isDeepStrictEqual(payload.evidence, nestedEvidence)) {
      throw new Error(`${recovered.role}.evidence conflicts with the evidence object nested inside process`);
    }
    const normalizedProcess = { ...process };
    delete normalizedProcess.evidence;
    return { ...payload, process: normalizedProcess, evidence: payload.evidence ?? nestedEvidence };
  }
  return payload;
}

function classificationDraft(recovered: RecoveredRole, frozenLedger: CriterionDefinition[]): ReviewerAssessmentDraft {
  const payload = normalizedClassificationPayload(recovered);
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

function normalizedAdjudicationFields(value: unknown, expectedFields?: string[]): unknown {
  let rawFields: unknown = value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    rawFields = Object.entries(value as Record<string, unknown>).map(([field, rawEntry]) => {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return rawEntry;
      const entry = rawEntry as Record<string, unknown>;
      const allowedKeys = new Set(['field', 'value', 'adjudication', 'rationale', 'evidenceRefs']);
      if (Object.keys(entry).some((key) => !allowedKeys.has(key))) return rawEntry;
      if (entry.field !== undefined && entry.field !== field) return rawEntry;
      if (entry.value !== undefined && entry.adjudication !== undefined && entry.value !== entry.adjudication) return rawEntry;
      return {
        field,
        value: entry.value ?? entry.adjudication,
        rationale: entry.rationale,
        evidenceRefs: entry.evidenceRefs,
      };
    });
  }
  if (!Array.isArray(rawFields)) return rawFields;
  const explicitFields = new Set(rawFields.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const field = (item as Record<string, unknown>).field;
    return typeof field === 'string' ? [field] : [];
  }));
  return rawFields.flatMap((rawEntry) => {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return [rawEntry];
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.field !== 'string' || typeof entry.value !== 'string') return [rawEntry];
    const match = /^criterion:(.+)\.status$/.exec(entry.field);
    if (!match) return [rawEntry];
    const reasonField = `criterion:${match[1]}.reason`;
    if (explicitFields.has(reasonField) || (expectedFields && !expectedFields.includes(reasonField))) return [rawEntry];
    const slash = entry.value.indexOf('/');
    if (slash <= 0 || slash !== entry.value.lastIndexOf('/')) return [rawEntry];
    const status = entry.value.slice(0, slash);
    const reason = entry.value.slice(slash + 1);
    if (!criterionStatusValues.has(status) || !criterionReasonValues.has(reason)) return [rawEntry];
    try { validateCriterionStatusReason(status, reason, `adjudication ${match[1]}`); }
    catch { return [rawEntry]; }
    return [
      { ...entry, value: status },
      { ...entry, field: reasonField, value: reason },
    ];
  });
}

function adjudicationDraft(recovered: RecoveredRole, expectedFields?: string[]): ReviewerAdjudicationDraft {
  const payload = object(recovered.payload, 'adjudication');
  const normalizedFields = normalizedAdjudicationFields(payload.resolvedFields, expectedFields);
  const resolvedFields = array(normalizedFields, 'adjudication.resolvedFields').map((rawValue, index) => {
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
  const resolvedByField = new Map(resolvedFields.map((item) => [item.field, item.value]));
  for (const field of fields) {
    const match = /^criterion:(.+)\.status$/.exec(field);
    if (!match) continue;
    const reasonField = `criterion:${match[1]}.reason`;
    const reason = resolvedByField.get(reasonField);
    if (reason !== undefined) validateCriterionStatusReason(resolvedByField.get(field), reason, `adjudication ${match[1]}`);
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
  const candidates = index.callOccurrences
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
  next: ReviewWorkflowRole | 'ready-to-record';
  handoff?: unknown;
  checkpoint: ReviewWorkflowCheckpoint;
}

export interface ReviewRoleLaunch {
  role: ReviewWorkflowRole;
  agent: typeof SESSION_EVALUATOR_AGENT;
  bucket: 'small' | 'medium';
  workflowRef: string;
  attempt: number;
  maxAttempts: number;
  retriesRemainingAfterLaunch: number;
  taskInstructions: string;
}

export interface ReviewWorkflowCheckpoint {
  version: 1;
  evidenceKey: string;
  state: 'run-roles' | 'ready-to-record' | 'blocked';
  nextAction: 'launch-required-roles' | 'recordRecoveredReview' | 'report-blocker';
  nextRoles: ReviewWorkflowRole[];
  attemptsByRole: Record<ReviewWorkflowRole, number>;
  maxAttemptsPerRole: number;
  launch: ReviewRoleLaunch[];
  blockedRoles: Array<{ role: ReviewWorkflowRole; attempts: number; error: string }>;
}

const taxonomyContract = [
  'Taxonomy namespaces are disjoint.',
  'origin values: explicit, necessary_implied. importance values: core, supporting, optional.',
  'activity values: implement, debug, investigate, explain, design, operate, verify, other.',
  'surface values: ui, application_logic, api_integration, data, tests, documentation, configuration, infrastructure, developer_tooling, agent_harness, external_system, communication, other.',
  'evidenceMode values: static_inspection, automated_check, runtime_observation, human_observation, external_confirmation, reasoning_or_sources, other.',
  'Never place an evidenceMode value such as human_observation in surface.',
].join(' ');
const statusReasonContract = [
  'Valid status/reason pairs only:',
  'met/none;',
  'partly_met or unmet with omitted, attempt_failed, incorrect_result, regression, or unknown;',
  'blocked with external_blocker, user_dependency, or unknown;',
  'not_assessable with human_evidence_missing, insufficient_artifact_evidence, or unknown;',
  'superseded/none.',
  'insufficient_artifact_evidence is never valid with partly_met.',
].join(' ');
const classificationVectorContract = [
  'process values: requirementDiscipline proportionate, underclarified, overclarified, not_assessable; verificationDiscipline proportionate, underverified, oververified, not_applicable, not_assessable; scopeControl controlled, minor_avoidable_drift, material_scope_drift, not_assessable; recovery effective, partly_effective, ineffective, not_needed, not_assessable; finalClaimAccuracy accurate, overclaimed, underclaimed, unclear, no_final_claim.',
  'evidence values: requirements clear, partly_clear, unclear; artifacts direct, partial, none, not_applicable; execution direct, partial, reported_only, none, not_applicable; human not_needed, supports, contradicts, inconclusive, unanswered, unavailable. confidence values: high, medium, low.',
].join(' ');

function outputContract(role: ReviewWorkflowRole): string {
  if (role === 'proposal-small' || role === 'proposal-medium') {
    return '{"criteria":[{"criterionId":"stable-id","statement":"observable outcome","origin":"explicit","importance":"core","taxonomy":{"activity":"implement","surface":["application_logic"],"evidenceMode":["static_inspection"]}}]}';
  }
  if (role === 'consolidation') {
    return '{"frozenLedger":[{"criterionId":"stable-id","statement":"observable outcome","origin":"explicit","importance":"core","taxonomy":{"activity":"implement","surface":["application_logic"],"evidenceMode":["static_inspection"]}}],"dedupNotes":["concise merge note"]}';
  }
  if (role === 'classification-small' || role === 'classification-medium') {
    return '{"criteria":[{"criterionId":"frozen-id","status":"met","reason":"none","evidenceRefs":["bundle reference"]}],"process":{"requirementDiscipline":"proportionate","verificationDiscipline":"proportionate","scopeControl":"controlled","recovery":"not_needed","finalClaimAccuracy":"accurate"},"evidence":{"requirements":"clear","artifacts":"direct","execution":"direct","human":"not_needed","limitations":["concrete limitation"]},"confidence":"high"}';
  }
  return '{"resolvedFields":[{"field":"exact field from materialFields","value":"valid value for that field","rationale":"evidence-grounded rationale","evidenceRefs":["bundle reference"]}]}';
}

function taskInstructions(role: ReviewWorkflowRole, priorError?: string): string {
  const phaseRule = role === 'consolidation'
    ? `Merge and deduplicate the two supplied proposals; do not classify the ledger. ${taxonomyContract}`
    : role.startsWith('classification')
      ? `Classify every frozen criterion exactly once without changing its definition. ${statusReasonContract} ${classificationVectorContract} process and evidence must be separate top-level sibling objects; never nest evidence inside process.`
      : role === 'adjudication'
        ? `Resolve every and only the supplied materialFields. ${statusReasonContract}`
        : `Propose observable criteria only; do not classify them or choose an overall. ${taxonomyContract}`;
  return [
    `Perform only the ${role} role using the exact bounded evidence and handoff supplied by the parent.`,
    phaseRule,
    priorError ? `Your prior attempt was rejected by schema validation: ${JSON.stringify(priorError.slice(0, 500))}. Correct that exact failure.` : '',
    'Return exactly one raw JSON object. Do not emit Markdown fences, headings, analysis, preamble, or trailing prose.',
    'Before returning, verify JSON parsing, top-level field placement, enum namespaces, and every dependent status/reason pair.',
    `Output contract: ${outputContract(role)}`,
  ].filter(Boolean).join(' ');
}

function roleAttemptCounts(index: TranscriptIndex, sessionId: string, evidenceKey: string): Record<ReviewWorkflowRole, number> {
  return Object.fromEntries(roles.map((role) => {
    const refs = new Set([
      reviewWorkflowRef(sessionId, role, evidenceKey),
      legacyReviewWorkflowRef(sessionId, role, evidenceKey),
    ]);
    const count = index.callOccurrences.filter((call) => call.name === 'subagent' && refs.has(String(call.arguments.workflowRef))).length;
    return [role, count];
  })) as Record<ReviewWorkflowRole, number>;
}

export function getReviewRecoveryStatus(orchestratorPath: string, sessionId: string, evidenceManifest: EvidenceManifest): ReviewRecoveryStatus {
  const index = indexReviewOrchestrator(orchestratorPath);
  const evidenceKey = reviewEvidenceKey(evidenceManifest);
  const attemptsByRole = roleAttemptCounts(index, sessionId, evidenceKey);
  const invalidRoles: Array<{ role: ReviewWorkflowRole; error: string }> = [];
  const recovered = new Map<ReviewWorkflowRole, RecoveredRole>();
  for (const role of roles) {
    try { recovered.set(role, latestRole(index, sessionId, role, evidenceKey)); }
    catch (error) {
      const message = (error as Error).message;
      if (!message.startsWith('missing ')) invalidRoles.push({ role, error: message });
    }
    // The retry budget controls future launches. If an accidental extra launch
    // is already durable, authenticated, and valid, discarding it cannot undo
    // the launch and only strands otherwise recoverable work. Keep the attempt
    // count as audit evidence; an invalid latest result still blocks below once
    // the budget is exhausted.
  }
  const refs = Object.fromEntries(roles.map((role) => [role, reviewWorkflowRef(sessionId, role, evidenceKey)])) as Record<ReviewWorkflowRole, string>;
  const invalidate = (role: ReviewWorkflowRole, error: unknown): void => {
    recovered.delete(role);
    invalidRoles.push({ role, error: (error as Error).message });
  };
  const response = (
    next: ReviewRecoveryStatus['next'],
    handoff?: unknown,
    requiredRoles: ReviewWorkflowRole[] = next === 'ready-to-record' ? [] : [next],
  ): ReviewRecoveryStatus => {
    const incompleteRoles = requiredRoles.filter((role) => !recovered.has(role));
    const blockedRoles = incompleteRoles
      .filter((role) => attemptsByRole[role] >= MAX_REVIEW_ROLE_ATTEMPTS)
      .map((role) => ({
        role,
        attempts: attemptsByRole[role],
        error: [...invalidRoles].reverse().find((invalid) => invalid.role === role)?.error ?? 'role did not produce a recoverable completed result',
      }));
    const state: ReviewWorkflowCheckpoint['state'] = next === 'ready-to-record'
      ? 'ready-to-record'
      : blockedRoles.length ? 'blocked' : 'run-roles';
    const launch = state !== 'run-roles' ? [] : incompleteRoles.map((role): ReviewRoleLaunch => ({
      role,
      agent: SESSION_EVALUATOR_AGENT,
      bucket: expectedBucketByRole[role],
      workflowRef: refs[role],
      attempt: attemptsByRole[role] + 1,
      maxAttempts: MAX_REVIEW_ROLE_ATTEMPTS,
      retriesRemainingAfterLaunch: Math.max(0, MAX_REVIEW_ROLE_ATTEMPTS - attemptsByRole[role] - 1),
      taskInstructions: taskInstructions(
        role,
        attemptsByRole[role] > 0
          ? [...invalidRoles].reverse().find((invalid) => invalid.role === role)?.error
          : undefined,
      ),
    }));
    return {
      sessionId,
      workflowRefs: refs,
      completedRoles: roles.filter((role) => recovered.has(role)),
      invalidRoles,
      missingRoles: roles.filter((role) => !recovered.has(role)),
      next,
      ...(handoff === undefined ? {} : { handoff }),
      checkpoint: {
        version: 1,
        evidenceKey,
        state,
        nextAction: state === 'ready-to-record' ? 'recordRecoveredReview' : state === 'blocked' ? 'report-blocker' : 'launch-required-roles',
        nextRoles: incompleteRoles,
        attemptsByRole,
        maxAttemptsPerRole: MAX_REVIEW_ROLE_ATTEMPTS,
        launch,
        blockedRoles,
      },
    };
  };

  const proposals = new Map<ReviewWorkflowRole, ReviewerProposalDraft>();
  for (const role of ['proposal-small', 'proposal-medium'] as const) {
    const value = recovered.get(role);
    if (!value) continue;
    try { proposals.set(role, proposalDraft(value)); }
    catch (error) { invalidate(role, error); }
  }
  const missingProposals = (['proposal-small', 'proposal-medium'] as const).filter((role) => !recovered.has(role));
  if (missingProposals.length) return response(missingProposals[0]!, undefined, [...missingProposals]);

  const proposalPair = [proposals.get('proposal-small')!, proposals.get('proposal-medium')!];
  const proposalHandoff = proposalPair.map((proposal) => ({
    criteria: proposal.criteria,
    ...(proposal.candidateHumanQuestion ? { candidateHumanQuestion: proposal.candidateHumanQuestion } : {}),
  }));
  const consolidationRole = recovered.get('consolidation');
  if (!consolidationRole) return response('consolidation', { proposals: proposalHandoff }, ['consolidation']);
  let consolidation: ConsolidationPayload;
  try {
    consolidation = consolidationPayload(consolidationRole);
    reviewerRuntime('consolidation', consolidationRole);
  }
  catch (error) {
    invalidate('consolidation', error);
    return response('consolidation', { proposals: proposalHandoff }, ['consolidation']);
  }

  const humanCheck = recoverHumanCheck(index, sessionId, consolidation.selectedHumanQuestion, consolidationRole.result.line);
  const components = new Map<ReviewWorkflowRole, ReviewerAssessmentDraft>();
  for (const role of ['classification-small', 'classification-medium'] as const) {
    const value = recovered.get(role);
    if (!value) continue;
    try { components.set(role, classificationDraft(value, consolidation.frozenLedger)); }
    catch (error) { invalidate(role, error); }
  }
  const missingClassifications = (['classification-small', 'classification-medium'] as const).filter((role) => !recovered.has(role));
  if (missingClassifications.length) return response(
    missingClassifications[0]!,
    { frozenLedger: consolidation.frozenLedger, ...(humanCheck ? { humanCheck } : {}) },
    [...missingClassifications],
  );

  const componentPair = [components.get('classification-small')!, components.get('classification-medium')!] as [ReviewerAssessmentDraft, ReviewerAssessmentDraft];
  const materialFields = materialDisagreementFields(componentPair[0] as unknown as ReviewerAssessment, componentPair[1] as unknown as ReviewerAssessment);
  if (materialFields.length) {
    const adjudicationRole = recovered.get('adjudication');
    if (!adjudicationRole) return response('adjudication', {
      frozenLedger: consolidation.frozenLedger,
      components: componentPair.map((component) => component.classifications),
      materialFields: requiredAdjudicationFields(materialFields),
    }, ['adjudication']);
    try { adjudicationDraft(adjudicationRole, requiredAdjudicationFields(materialFields)); }
    catch (error) {
      invalidate('adjudication', error);
      return response('adjudication', {
        frozenLedger: consolidation.frozenLedger,
        components: componentPair.map((component) => component.classifications),
        materialFields: requiredAdjudicationFields(materialFields),
      }, ['adjudication']);
    }
  }
  return response('ready-to-record');
}
