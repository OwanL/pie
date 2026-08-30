import type { ReviewWorkflowRole } from './types.js';

/** Current workflow calls use a tool-free evaluator whose only output is the
 * role's structured JSON. V1 refs remain recoverable so an in-flight review
 * is not discarded during migration. */
export const REVIEW_WORKFLOW_VERSION = 'session-review-v2';
export const LEGACY_REVIEW_WORKFLOW_VERSION = 'session-review-v1';
export const SESSION_EVALUATOR_AGENT = 'session-evaluator';
export const LEGACY_REVIEWER_AGENT = 'reviewer';

export function workflowRef(
  version: typeof REVIEW_WORKFLOW_VERSION | typeof LEGACY_REVIEW_WORKFLOW_VERSION,
  sessionId: string,
  role: ReviewWorkflowRole,
  evidenceKey: string,
): string {
  return `${version}/${sessionId}/${evidenceKey}/${role}`;
}

export function currentReviewWorkflowRef(sessionId: string, role: ReviewWorkflowRole, evidenceKey: string): string {
  return workflowRef(REVIEW_WORKFLOW_VERSION, sessionId, role, evidenceKey);
}

export function legacyReviewWorkflowRef(sessionId: string, role: ReviewWorkflowRole, evidenceKey: string): string {
  return workflowRef(LEGACY_REVIEW_WORKFLOW_VERSION, sessionId, role, evidenceKey);
}

export function expectedAgentForWorkflowRef(value: unknown): typeof SESSION_EVALUATOR_AGENT | typeof LEGACY_REVIEWER_AGENT | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith(`${REVIEW_WORKFLOW_VERSION}/`)) return SESSION_EVALUATOR_AGENT;
  if (value.startsWith(`${LEGACY_REVIEW_WORKFLOW_VERSION}/`)) return LEGACY_REVIEWER_AGENT;
  return undefined;
}
