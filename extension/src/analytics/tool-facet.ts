import { encodeInt64, parseNonNegativeInt64, type AnalyticsToolFacetFields } from '../../../shared/analytics/contracts.js';
import type { ToolCall } from '../shared/protocol.js';
import { isRecord } from '../shared/type-guards.js';
import { extractCommandText, type ToolCallAnalysis } from '../shared/tool-call-analysis/index.js';
import { getPatchTextFromInput } from '../shared/tool-call-analysis/mutation-size.js';
import { extractFirstPathFromInput } from '../shared/tool-call-analysis/mutation-tools.js';

/**
 * Canonical tool/file facets: the typed `file-activity` facet of one terminal
 * tool call.
 *
 * Evidence is derived once per terminal tool from the tool-call analysis that
 * producer already computed for that tool, so execution never reanalyzes the
 * call or re-serializes a result body; rich content stays in the tool call's
 * linked detail payloads. Shell text is recorded as command evidence and is
 * never a count of underlying processes, and patch/input-derived line counts
 * are explicitly attempted, unverified proxies — never final worktree diffs.
 */

/** Typed facet identity suffix. Distinct facet types would use distinct
 * suffixes over the same scoped tool-call identity. */
export const TOOL_FACET_FILE_ACTIVITY_TYPE = 'file-activity';

/** Observed paths are a bounded projection of the tool's input/patch targets;
 * the complete text remains available through the tool call's detail payload. */
export const MAX_TOOL_FACET_PATHS = 64;

export type ToolFacetVerification = 'verified' | 'unverified' | 'not_applicable' | 'unknown';

/** Stable typed facet identity scoped to the already-scoped tool-call ID. */
export function toolFacetId(scopedToolCallId: string): string {
  return `${scopedToolCallId}:${TOOL_FACET_FILE_ACTIVITY_TYPE}`;
}

export interface ToolFacetEvidence {
  /** Observed shell text for command-carrying tools; empty otherwise. This is
   * the literal command evidence, not a process census. */
  commands: string[];
  /** The cwd the producer resolved for this tool's session, when known. */
  cwd: string | null;
  /** Bounded, deduplicated file paths observed in the tool input or patch. */
  observedPaths: string[];
  /** Patch/input-derived attempted line counts. Present (including zero) only
   * when the analysis produced file-mutation evidence; null means the tool has
   * no line-activity concept, never an invented empty change. */
  attemptedAddedLines: number | null;
  attemptedRemovedLines: number | null;
  /** Producer-derived line activity is an unverified proxy by construction. */
  verification: ToolFacetVerification;
}

const PATCH_FILE_PATH_PREFIXES = [
  '*** Add File:',
  '*** Update File:',
  '*** Delete File:',
  '*** Move to:',
  'rename to ',
] as const;

function observedPathsFromInput(input: unknown): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string | null | undefined): void => {
    const value = candidate?.trim();
    if (!value || seen.has(value) || paths.length >= MAX_TOOL_FACET_PATHS) return;
    seen.add(value);
    paths.push(value);
  };
  push(extractFirstPathFromInput(input));
  if (isRecord(input)) {
    const patchText = getPatchTextFromInput(input);
    if (patchText) {
      for (const line of patchText.replace(/\r\n?/g, '\n').split('\n')) {
        for (const prefix of PATCH_FILE_PATH_PREFIXES) {
          if (line.startsWith(prefix)) {
            push(line.slice(prefix.length).trim());
            break;
          }
        }
      }
    }
  }
  return paths;
}

/** Derive one terminal tool's facet evidence from the analysis already computed
 * for that tool by the producer. No result body is traversed here. */
export function deriveToolFacetEvidence(
  toolCall: ToolCall,
  analysis: ToolCallAnalysis,
  cwd?: string | null,
): ToolFacetEvidence {
  const commandText = extractCommandText(toolCall.input);
  const resolvedCwd = typeof cwd === 'string' && cwd.trim() ? cwd : null;
  const fileMutation = analysis.fileMutation;
  const hasFileOperation = (
    fileMutation.writeCount + fileMutation.editCount
    + fileMutation.deleteCount + fileMutation.renameCount
  ) > 0;
  return {
    commands: commandText.trim() ? [commandText] : [],
    cwd: resolvedCwd,
    observedPaths: observedPathsFromInput(toolCall.input),
    attemptedAddedLines: hasFileOperation ? fileMutation.lineAdditions : null,
    attemptedRemovedLines: hasFileOperation ? fileMutation.lineDeletions : null,
    verification: hasFileOperation ? 'unverified' : 'not_applicable',
  };
}

/** Build the shared tool-facet DTO fields for one terminal tool. Counts stay
 * absent (not zero) when the tool has no line-activity evidence, so recorded
 * zero evidence and unavailable evidence remain distinct. */
export function buildToolFacetFields(
  toolCall: ToolCall,
  analysis: ToolCallAnalysis,
  scopedToolCallId: string,
  cwd?: string | null,
): AnalyticsToolFacetFields {
  const evidence = deriveToolFacetEvidence(toolCall, analysis, cwd);
  return {
    toolCallId: scopedToolCallId,
    facetId: toolFacetId(scopedToolCallId),
    ...(evidence.commands.length > 0 ? { commands: evidence.commands } : {}),
    ...(evidence.cwd !== null ? { cwd: evidence.cwd } : {}),
    ...(evidence.observedPaths.length > 0 ? { observedPaths: evidence.observedPaths } : {}),
    ...(evidence.attemptedAddedLines === null ? {} : { attemptedAddedLines: evidence.attemptedAddedLines }),
    ...(evidence.attemptedRemovedLines === null ? {} : { attemptedRemovedLines: evidence.attemptedRemovedLines }),
    verification: evidence.verification,
  };
}

/** Minimal database surface the facet projection schema needs, mirroring the
 * other projection modules so statements stay plain `prepare` calls. */
export interface ToolFacetDatabase {
  exec(sql: string): void;
}

/** Typed durable facet storage and its versioned query view. The migration
 * that introduces it never backfills facet history: schema12 capture produced
 * no facets, and reconstruction from transcripts is prohibited. */
export function createToolFacetProjectionSchema(database: ToolFacetDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS analytics_tool_facet_observations (
      observation_registry_key TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      facet_id TEXT NOT NULL,
      tool_call_id TEXT,
      observation_kind TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      cwd TEXT,
      payload_json TEXT NOT NULL,
      projection_revision TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS analytics_tool_facet_observation_subject_idx
      ON analytics_tool_facet_observations(capture_subject_kind, capture_subject_key);
    CREATE INDEX IF NOT EXISTS analytics_tool_facet_observation_root_idx
      ON analytics_tool_facet_observations(root_session_id, projection_revision);
    CREATE INDEX IF NOT EXISTS analytics_tool_facet_observation_identity_idx
      ON analytics_tool_facet_observations(generation_id, facet_id, projection_revision);

    CREATE TABLE IF NOT EXISTS analytics_tool_facet_states (
      generation_id TEXT NOT NULL,
      facet_id TEXT NOT NULL,
      tool_call_id TEXT,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      commands_json TEXT,
      cwd TEXT,
      observed_paths_json TEXT,
      attempted_added_lines TEXT,
      attempted_removed_lines TEXT,
      verification TEXT,
      projection_revision TEXT NOT NULL,
      PRIMARY KEY(generation_id, facet_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS analytics_tool_facet_state_subject_idx
      ON analytics_tool_facet_states(capture_subject_kind, capture_subject_key);
    CREATE INDEX IF NOT EXISTS analytics_tool_facet_state_root_idx
      ON analytics_tool_facet_states(root_session_id, projection_revision);
    CREATE INDEX IF NOT EXISTS analytics_tool_facet_state_order_idx
      ON analytics_tool_facet_states(
        CAST(projection_revision AS INTEGER), generation_id, facet_id
      );

    CREATE VIEW IF NOT EXISTS analytics_tool_facet_v1 AS
      SELECT generation_id, facet_id, tool_call_id, capture_subject_kind, capture_subject_key,
        root_session_id, commands_json, cwd, observed_paths_json,
        attempted_added_lines, attempted_removed_lines, verification, projection_revision
      FROM analytics_tool_facet_states;
  `);
}

/** Validated facet DTO fields projected into the typed durable state columns. */
export interface ToolFacetStateColumns {
  commandsJson: string | null;
  cwd: string | null;
  observedPathsJson: string | null;
  attemptedAddedLines: string | null;
  attemptedRemovedLines: string | null;
  verification: string | null;
}

function optionalNonNegativeInt64Text(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  return parseNonNegativeInt64(value, `fields.${fieldName}`).toString();
}

function stringArrayJson(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return JSON.stringify(value);
}

export function toolFacetStateColumns(fields: Record<string, unknown>): ToolFacetStateColumns {
  return {
    commandsJson: stringArrayJson(fields.commands),
    cwd: typeof fields.cwd === 'string' && fields.cwd.length > 0 ? fields.cwd : null,
    observedPathsJson: stringArrayJson(fields.observedPaths),
    attemptedAddedLines: optionalNonNegativeInt64Text(fields.attemptedAddedLines, 'attemptedAddedLines'),
    attemptedRemovedLines: optionalNonNegativeInt64Text(fields.attemptedRemovedLines, 'attemptedRemovedLines'),
    verification: typeof fields.verification === 'string' ? fields.verification : null,
  };
}

export interface ToolFacetProjectionRow {
  generationId: string;
  facetId: string;
  toolCallId: string | null;
  rootSessionId: string | null;
  commands: string[] | null;
  cwd: string | null;
  observedPaths: string[] | null;
  attemptedAddedLines: number | string | null;
  attemptedRemovedLines: number | string | null;
  verification: ToolFacetVerification | null;
}

export interface ToolFacetProjectionReadModel {
  revision: number | string;
  scope: { kind: 'global' } | { kind: 'session'; rootSessionId: string };
  facets: ToolFacetProjectionRow[];
  truncated: boolean;
}

function decodedStringArray(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')
      ? parsed as string[]
      : null;
  } catch {
    return null;
  }
}

function decodedNonNegativeInt64(value: unknown): number | string | null {
  if (value === null || value === undefined) return null;
  // Stored text is the canonical int64 rendering; decode through the shared
  // helper so large values stay decimal strings and small ones stay numbers.
  return encodeInt64(parseNonNegativeInt64(value, 'facet line count'));
}

export function toolFacetProjectionRowFromStateRow(
  row: Record<string, unknown>,
): ToolFacetProjectionRow {
  const verification = row.verification === null || row.verification === undefined
    ? null
    : String(row.verification) as ToolFacetVerification;
  return {
    generationId: String(row.generation_id),
    facetId: String(row.facet_id),
    toolCallId: row.tool_call_id === null || row.tool_call_id === undefined ? null : String(row.tool_call_id),
    rootSessionId: row.root_session_id === null || row.root_session_id === undefined
      ? null : String(row.root_session_id),
    commands: decodedStringArray(row.commands_json),
    cwd: row.cwd === null || row.cwd === undefined ? null : String(row.cwd),
    observedPaths: decodedStringArray(row.observed_paths_json),
    attemptedAddedLines: decodedNonNegativeInt64(row.attempted_added_lines),
    attemptedRemovedLines: decodedNonNegativeInt64(row.attempted_removed_lines),
    verification,
  };
}