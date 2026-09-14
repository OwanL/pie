/**
 * Runtime ViewState shape validator. Logs console errors for fields that are
 * missing or mistyped at the host → webview boundary so developers notice
 * immediately, even when defensive hydration masks the crash.
 */

import type { ViewState } from '../../shared/protocol';
import { webviewLog } from './utils/log';

interface FieldSpec {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
}

/** Fields that components iterate or access unconditionally — undefined here means a render crash. */
const CRITICAL_FIELDS: FieldSpec[] = [
  { path: 'pruningSettings.mode', type: 'string' },
  { path: 'pruningSettings.skillAlwaysKeep', type: 'array' },
  { path: 'pruningSettings.toolAlwaysKeep', type: 'array' },
  { path: 'pruningSettings.model', type: 'string' },
  { path: 'pruningSettings.provider', type: 'string' },
  { path: 'toolResultPruningSettings.enabled', type: 'boolean' },
  { path: 'toolResultPruningSettings.profile', type: 'string' },
  { path: 'toolResultPruningSettings.rules', type: 'object' },
  { path: 'sessionTitlesSettings.enabled', type: 'boolean' },
  { path: 'sessionTitlesSettings.provider', type: 'string' },
  { path: 'sessionTitlesSettings.model', type: 'string' },
  { path: 'sessionTitlesSettings.thinkingLevel', type: 'string' },
  { path: 'sessionTitlesSettings.timeoutSec', type: 'number' },
  { path: 'pruningCatalog.skills', type: 'array' },
  { path: 'pruningCatalog.tools', type: 'array' },
  { path: 'prefs', type: 'object' },
  { path: 'transcript', type: 'array' },
  { path: 'sessions', type: 'array' },
  { path: 'openTabPaths', type: 'array' },
  { path: 'sessionCapabilitiesBySession', type: 'object' },
  { path: 'generatingTitleSessionPaths', type: 'array' },
  { path: 'systemPrompts', type: 'array' },
  { path: 'availableModels', type: 'array' },
  { path: 'availableModelsStatus', type: 'string' },
  { path: 'availableExtensions', type: 'array' },
  { path: 'aggregateStats', type: 'object' },
  { path: 'workingTimeBySession', type: 'object' },
  { path: 'fileChanges', type: 'array' },
  { path: 'readFilePaths', type: 'array' },
  { path: 'pendingComposerInputs', type: 'array' },
];

function getNestedValue(obj: any, path: string): unknown {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function checkType(value: unknown, expectedType: FieldSpec['type']): boolean {
  if (expectedType === 'array') return Array.isArray(value);
  if (expectedType === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  return typeof value === expectedType;
}

function isValidPrimaryOperation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const operation = value as Record<string, unknown>;
  return typeof operation.operationId === 'string'
    && (operation.kind === 'session.create' || operation.kind === 'session.duplicate'
      || operation.kind === 'session.open' || operation.kind === 'session.close'
      || operation.kind === 'backend.restart' || operation.kind === 'message.send'
      || operation.kind === 'message.edit' || operation.kind === 'message.interrupt'
      || operation.kind === 'message.continue' || operation.kind === 'message.compact')
    && (operation.phase === 'awaiting-acceptance' || operation.phase === 'draining'
      || operation.phase === 'awaiting-old-generation-death'
      || operation.phase === 'awaiting-commit' || operation.phase === 'ambiguous')
    && Number.isInteger(operation.attempt)
    && (operation.attempt as number) >= 1
    && typeof operation.committed === 'boolean'
    && (operation.recovery === null
      || operation.recovery === 'retry'
      || operation.recovery === 'restart-backend'
      || operation.recovery === 'reconcile');
}

function validateSessionCapabilities(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const violations: string[] = [];
  for (const [sessionPath, candidate] of Object.entries(value)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      violations.push(`ViewState.sessionCapabilitiesBySession[${sessionPath}] is not an object`);
      continue;
    }
    const capabilities = candidate as Record<string, unknown>;
    for (const field of ['billableActivity', 'canContinue', 'canInterrupt', 'canCompact']) {
      if (typeof capabilities[field] !== 'boolean') {
        violations.push(`ViewState.sessionCapabilitiesBySession[${sessionPath}].${field} is not a boolean`);
      }
    }
    if (capabilities.primaryOperation !== undefined
      && !isValidPrimaryOperation(capabilities.primaryOperation)) {
      violations.push(`ViewState.sessionCapabilitiesBySession[${sessionPath}].primaryOperation is invalid`);
    }
  }
  return violations;
}

// ── Optional canonical activity/facet fields ────────────────────────────────
//
// The host omits these fields entirely under legacy analytics authority, so
// absence is valid. When present, the STATE_CONTRACT requires: global entry is
// explicitly global, session entries are keyed by the visible session path and
// carry a matching root-session scope, and unknown/suppressed/invalidated reads
// retain their scope but use null projection/revision/coverage/truncation
// rather than an empty complete result.

function isNullRevision(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number';
}

function validateCanonicalCounts(value: unknown, path: string): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${path} is not an object`];
  }
  const totals = value as Record<string, unknown>;
  const violations: string[] = [];
  for (const field of [
    'spanCount', 'observedCount', 'estimatedCount', 'unknownCount',
    'measuredKnownCount', 'measuredUnknownCount',
  ]) {
    const count = totals[field];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      violations.push(`${path}.${field} is not a nonnegative safe-integer count`);
    }
  }
  // The host stores measured work as a REAL duration: fractional milliseconds
  // are legitimate, negative ones are not.
  const measured = totals.measuredTotalMs;
  if (typeof measured !== 'number' || !Number.isFinite(measured) || measured < 0) {
    violations.push(`${path}.measuredTotalMs is not a nonnegative finite duration`);
  }
  return violations;
}

/** Attempted-change line counts: null, a nonnegative safe integer, or an
 *  arbitrary-length decimal string (the host's exact int64 serialization —
 *  no digit-count cap). Negative and fractional values are violations, never
 *  silently accepted. */
function isValidAttemptedLineCount(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  return typeof value === 'string' && /^\d+$/.test(value);
}

const CANONICAL_VERIFICATIONS = ['verified', 'unverified', 'not_applicable', 'unknown'];

function validateCanonicalKindRows(rows: unknown, path: string): string[] {
  if (!Array.isArray(rows)) return [];
  const violations: string[] = [];
  rows.forEach((row, index) => {
    const rowPath = `${path}.kinds[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      violations.push(`${rowPath} is not an object`);
      return;
    }
    const record = row as Record<string, unknown>;
    violations.push(...validateCanonicalCounts(record, rowPath));
    if (record.activityKind !== null && typeof record.activityKind !== 'string') {
      violations.push(`${rowPath}.activityKind is not a string or null`);
    }
  });
  return violations;
}

function validateCanonicalFacetRows(rows: unknown, path: string): string[] {
  if (!Array.isArray(rows)) return [];
  const violations: string[] = [];
  rows.forEach((row, index) => {
    const rowPath = `${path}.facets[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      violations.push(`${rowPath} is not an object`);
      return;
    }
    const record = row as Record<string, unknown>;
    for (const field of ['attemptedAddedLines', 'attemptedRemovedLines']) {
      if (!isValidAttemptedLineCount(record[field])) {
        violations.push(`${rowPath}.${field} is not a nonnegative integer line count or null`);
      }
    }
    const verification = record.verification;
    if (verification !== null
      && !(typeof verification === 'string' && CANONICAL_VERIFICATIONS.includes(verification))) {
      violations.push(`${rowPath}.verification is not a known verification or null`);
    }
  });
  return violations;
}

/** The nested read (and its projection) must carry the SAME scope as its
 *  entry: a session entry can never host a global-labelled projection, and a
 *  session rootSessionId must match across entry, read, and projection. */
function validateNestedReadScope(
  readValue: unknown,
  path: string,
  entryScope: Record<string, unknown> | undefined,
  isGlobal: boolean,
): string[] {
  if (!readValue || typeof readValue !== 'object' || Array.isArray(readValue)) return [];
  const read = readValue as Record<string, unknown>;
  const violations: string[] = [];
  const check = (scope: unknown, label: string): void => {
    const matches = !!scope && typeof scope === 'object' && !Array.isArray(scope)
      && (isGlobal
        ? (scope as Record<string, unknown>).kind === 'global'
        : (scope as Record<string, unknown>).kind === 'session'
          && (scope as Record<string, unknown>).rootSessionId === entryScope?.rootSessionId);
    if (!matches) violations.push(`${path}.${label} does not match the entry scope`);
  };
  check(read.scope, 'scope');
  const projection = read.projection;
  if (projection && typeof projection === 'object' && !Array.isArray(projection)) {
    check((projection as Record<string, unknown>).scope, 'projection scope');
  }
  return violations;
}

function validateCanonicalCoverage(value: unknown, path: string): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${path}.coverage is not an object`];
  }
  const coverage = value as Record<string, unknown>;
  const violations: string[] = [];
  if (typeof coverage.databaseSchemaVersion !== 'number') {
    violations.push(`${path}.coverage.databaseSchemaVersion is not a number`);
  }
  if (!isNullRevision(coverage.projectionRevision)) {
    violations.push(`${path}.coverage.projectionRevision is not a revision`);
  }
  if (!isNullRevision(coverage.snapshotWatermark)) {
    violations.push(`${path}.coverage.snapshotWatermark is not a watermark`);
  }
  if (!Array.isArray(coverage.generationIds) || typeof coverage.generationIdsTruncated !== 'boolean') {
    violations.push(`${path}.coverage.generationIds is not a bounded list`);
  }
  if (!coverage.pendingDetailCoverage
    || typeof coverage.pendingDetailCoverage !== 'object'
    || (coverage.pendingDetailCoverage as Record<string, unknown>).deliveryHistoryCoverage !== 'complete'
      && (coverage.pendingDetailCoverage as Record<string, unknown>).deliveryHistoryCoverage !== 'retained_only') {
    violations.push(`${path}.coverage.pendingDetailCoverage is invalid`);
  }
  const truncation = coverage.truncation as Record<string, unknown> | undefined;
  if (!truncation || typeof truncation !== 'object'
    || typeof truncation.rowLimit !== 'boolean'
    || typeof truncation.byteLimit !== 'boolean'
    || typeof truncation.cellLimit !== 'boolean') {
    violations.push(`${path}.coverage.truncation is invalid`);
  }
  return violations;
}

/** Validate one independently qualified activity or tool-facet read. */
function validateCanonicalRead(
  value: unknown,
  path: string,
  rowField: 'kinds' | 'facets',
): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${path} is not an object`];
  }
  const read = value as Record<string, unknown>;
  const violations: string[] = [];
  if (read.authority !== 'canonical' && read.authority !== 'unknown') {
    violations.push(`${path}.authority is not 'canonical' or 'unknown'`);
  }
  if (!isNullRevision(read.revision)) {
    violations.push(`${path}.revision is not a revision or null`);
  }
  if (read.authority === 'unknown') {
    for (const field of ['projection', 'coverage', 'truncated']) {
      if (read[field] !== null) {
        violations.push(`${path}.${field} must be null when authority is 'unknown'`);
      }
    }
    if (read.revision !== null) violations.push(`${path}.revision must be null when authority is 'unknown'`);
  } else {
    const projection = read.projection;
    if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
      violations.push(`${path}.projection is not an object under canonical authority`);
    } else {
      const rows = (projection as Record<string, unknown>)[rowField];
      if (!Array.isArray(rows)) violations.push(`${path}.projection.${rowField} is not an array`);
      if (typeof (projection as Record<string, unknown>).truncated !== 'boolean') {
        violations.push(`${path}.projection.truncated is not a boolean`);
      }
      if (rowField === 'kinds') {
        const kindProjection = projection as Record<string, unknown>;
        violations.push(...validateCanonicalCounts(kindProjection.totals, `${path}.projection.totals`));
        violations.push(...validateCanonicalKindRows(kindProjection.kinds, `${path}.projection`));
      }
      if (rowField === 'facets') {
        violations.push(...validateCanonicalFacetRows(
          (projection as Record<string, unknown>).facets,
          `${path}.projection`,
        ));
      }
      violations.push(...validateCanonicalCoverage(
        (projection as Record<string, unknown>).coverage,
        `${path}.projection`,
      ));
    }
    violations.push(...validateCanonicalCoverage(read.coverage, path));
    if (typeof read.truncated !== 'boolean') {
      violations.push(`${path}.truncated must be a boolean under canonical authority`);
    }
  }
  return violations;
}

function validateCanonicalActivityView(value: unknown, path: string, isGlobal: boolean): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${path} is not an object`];
  }
  const entry = value as Record<string, unknown>;
  const violations: string[] = [];
  const scope = entry.scope as Record<string, unknown> | undefined;
  if (isGlobal) {
    if (entry.sessionPath !== null) violations.push(`${path}.sessionPath must be null for the global entry`);
    if (!scope || scope.kind !== 'global') violations.push(`${path}.scope must be explicitly global`);
  } else {
    if (typeof entry.sessionPath !== 'string') violations.push(`${path}.sessionPath is not a string`);
    if (!scope || scope.kind !== 'session' || typeof scope.rootSessionId !== 'string') {
      violations.push(`${path}.scope must be a root-session scope`);
    }
  }
  if (!isNullRevision(entry.revision)) {
    violations.push(`${path}.revision is not a revision or null`);
  }
  violations.push(...validateCanonicalRead(entry.activity, `${path}.activity`, 'kinds'));
  violations.push(...validateCanonicalRead(entry.toolFacets, `${path}.toolFacets`, 'facets'));
  violations.push(...validateNestedReadScope(entry.activity, `${path}.activity`, scope, isGlobal));
  violations.push(...validateNestedReadScope(entry.toolFacets, `${path}.toolFacets`, scope, isGlobal));
  return violations;
}

function validateCanonicalActivityFields(state: ViewState): string[] {
  const violations: string[] = [];
  const truncated = state.canonicalActivityBySessionTruncated;
  if (truncated !== undefined && typeof truncated !== 'boolean') {
    violations.push('ViewState.canonicalActivityBySessionTruncated is not a boolean');
  }
  if (state.canonicalActivityGlobal !== undefined) {
    violations.push(...validateCanonicalActivityView(state.canonicalActivityGlobal, 'ViewState.canonicalActivityGlobal', true));
  }
  const bySession = state.canonicalActivityBySession;
  if (bySession !== undefined) {
    if (!bySession || typeof bySession !== 'object' || Array.isArray(bySession)) {
      violations.push('ViewState.canonicalActivityBySession is not an object');
    } else {
      for (const [sessionPath, entry] of Object.entries(bySession)) {
        const path = `ViewState.canonicalActivityBySession[${sessionPath}]`;
        violations.push(...validateCanonicalActivityView(entry, path, false));
        if (entry && typeof entry === 'object' && !Array.isArray(entry)
          && (entry as unknown as Record<string, unknown>).sessionPath !== sessionPath) {
          violations.push(`${path}.sessionPath does not match its address key`);
        }
      }
    }
  }
  return violations;
}

/** Validate incoming ViewState. Returns list of violations (empty = valid). */
export function validateViewState(state: ViewState): string[] {
  const violations: string[] = [];

  for (const spec of CRITICAL_FIELDS) {
    const value = getNestedValue(state, spec.path);
    if (value === undefined || value === null) {
      violations.push(`ViewState.${spec.path} is ${value === null ? 'null' : 'undefined'} (expected ${spec.type})`);
    } else if (!checkType(value, spec.type)) {
      violations.push(`ViewState.${spec.path} has wrong type: got ${typeof value}, expected ${spec.type}`);
    } else if (value instanceof Promise) {
      violations.push(`ViewState.${spec.path} is a Promise`);
    }
  }
  violations.push(...validateSessionCapabilities(state.sessionCapabilitiesBySession));
  violations.push(...validateCanonicalActivityFields(state));

  if (violations.length > 0) {
    webviewLog(
      'error',
      'state-validator',
      `Host delivered ViewState with ${violations.length} invalid field(s)`,
      { violations },
    );
  }

  return violations;
}
