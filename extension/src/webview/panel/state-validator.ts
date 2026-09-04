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
      || operation.kind === 'message.send' || operation.kind === 'message.edit'
      || operation.kind === 'message.interrupt' || operation.kind === 'message.continue'
      || operation.kind === 'message.compact')
    && (operation.phase === 'awaiting-acceptance' || operation.phase === 'awaiting-commit' || operation.phase === 'ambiguous')
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
