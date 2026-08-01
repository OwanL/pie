/**
 * Shared tool-call-analysis kind taxonomy: the canonical union types for
 * verification commands, tool failures, non-success result issues, and
 * treatment changes.
 *
 * This is the single source of truth for the four kind unions that were
 * previously duplicated across the extension host tree
 * (`extension/src/shared/tool-call-analysis/` + `extension/src/host/run-analytics/types.ts`)
 * and the analysis tree (`analysis/scripts/contracts.ts`). Both consumers
 * re-export from here so existing import sites stay unchanged.
 *
 * Only the type unions live here — the `*_KINDS` enumerated-value arrays and
 * the coercion functions remain in their per-package consumers (they are not
 * byte-identical across trees and were intentionally left duplicated).
 *
 * This module is pure TypeScript (no Node- or browser-only APIs) and is
 * authored under `verbatimModuleSyntax` so it is portable to all consumers
 * (NodeNext native + bundler). Type-only symbols use `export type`.
 */

/**
 * Verification command kinds: the categories of commands that verify project
 * state (tests, builds, linters, type-checkers, formatters). `other` covers
 * generic check/verify/validate commands that don't map to a more specific kind.
 */
export type VerificationCommandKind =
  | 'test'
  | 'build'
  | 'lint'
  | 'typecheck'
  | 'format'
  | 'other';

/**
 * Execution failures: the tool could not complete its job. Counted under
 * `failureCount` / `failureCountsByKind`. Non-success results (failing
 * tests/builds, empty searches) are tracked under `ToolResultIssueKind`.
 */
export type ToolFailureKind =
  | 'unavailable_tool'
  | 'invalid_tool_arguments'
  | 'missing_file_or_path'
  | 'shell_command_error'
  | 'timeout'
  | 'nonzero_exit'
  | 'unknown';

/**
 * Non-success results: the tool ran to completion and did its job correctly,
 * but the outcome it reported was not "success". These are measured signal
 * (a failing test/build, a pending check, or an empty search) — NOT tool
 * failures — and are counted under `resultIssueCount` / `resultIssueCountsByKind`.
 */
export type ToolResultIssueKind =
  | 'verification_failure'
  | 'probe_no_match'
  | 'verification_pending';

/**
 * Treatment change kinds: the dimensions of run configuration that can change
 * mid-session, recorded on `RunSnapshot.treatmentChangeKinds` so outcomes can
 * be compared across mixed-treatment runs.
 */
export type TreatmentChangeKind =
  | 'model'
  | 'thinking'
  | 'prompt'
  | 'toolSelection'
  | 'skills'
  | 'experimentAssignment'
  | 'extensions';