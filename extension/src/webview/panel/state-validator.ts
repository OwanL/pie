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
  { path: 'pruningCatalog.skills', type: 'array' },
  { path: 'pruningCatalog.tools', type: 'array' },
  { path: 'prefs', type: 'object' },
  { path: 'transcript', type: 'array' },
  { path: 'sessions', type: 'array' },
  { path: 'openTabPaths', type: 'array' },
  { path: 'systemPrompts', type: 'array' },
  { path: 'availableModels', type: 'array' },
  { path: 'availableExtensions', type: 'array' },
  { path: 'aggregateStats', type: 'object' },
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
