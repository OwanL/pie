/**
 * Pins the renderer's defensive ViewState contract exported by
 * extension/src/webview/panel/state-validator.ts (`validateViewState`).
 *
 * The host → webview boundary must not silently render stale/broken UI, so
 * validateViewState returns violation strings for missing/mistyped critical
 * ViewState fields. These tests pin every critical field's missing/undefined
 * branch, wrong-type branch, and the all-valid happy path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { ViewState } from '../../../src/shared/protocol/webview';
import { validateViewState } from '../../../src/webview/panel/state-validator';

/**
 * Build a minimal ViewState object whose every CRITICAL_FIELD has a value of
 * the correct type. The validator only inspects the nested critical paths, so
 * we cast an `unknown` partial through `as unknown as ViewState` to satisfy TS
 * without constructing the full type.
 */
function validState(): ViewState {
  return {
    pruningSettings: {
      mode: 'auto',
      skillAlwaysKeep: ['skill-a'],
      toolAlwaysKeep: ['tool-a'],
      model: 'claude-sonnet-4',
      provider: 'anthropic',
    },
    toolResultPruningSettings: {
      enabled: true,
      profile: 'default',
      rules: {},
    },
    pruningCatalog: {
      skills: [],
      tools: [],
    },
    prefs: {},
    transcript: [],
    sessions: [],
    openTabPaths: [],
    systemPrompts: [],
    availableModels: [],
    availableModelsStatus: 'authoritative',
    availableExtensions: [],
    aggregateStats: {},
    fileChanges: [],
    readFilePaths: [],
    pendingComposerInputs: [],
  } as unknown as ViewState;
}

// Mirror the source's CRITICAL_FIELDS so each per-field test stays in lockstep
// with the validator's iteration order.
const CRITICAL_FIELDS: Array<{ path: string; type: string }> = [
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
  { path: 'availableModelsStatus', type: 'string' },
  { path: 'availableExtensions', type: 'array' },
  { path: 'aggregateStats', type: 'object' },
  { path: 'fileChanges', type: 'array' },
  { path: 'readFilePaths', type: 'array' },
  { path: 'pendingComposerInputs', type: 'array' },
];

/** Set a nested dotted path on a shallow-cloned object tree to `value`. */
function withField(state: ViewState, path: string, value: unknown): ViewState {
  const clone = structuredClone(state) as any;
  const parts = path.split('.');
  let cur = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return clone as ViewState;
}

/** A wrong-type value for a given expected type. */
function wrongValueFor(type: string): unknown {
  switch (type) {
    case 'string': return ['not', 'a', 'string']; // array where string expected
    case 'number': return 'not-a-number';
    case 'boolean': return 'not-a-boolean';
    case 'array': return 'not-an-array';
    case 'object': return 42; // primitive where object expected
    default: return 'wrong';
  }
}

test('a fully-valid ViewState returns no violations', () => {
  assert.deepEqual(validateViewState(validState()), []);
});

for (const spec of CRITICAL_FIELDS) {
  test(`undefined ${spec.path} → exactly one violation naming the path and 'undefined'`, () => {
    const state = withField(validState(), spec.path, undefined);
    const violations = validateViewState(state);
    assert.equal(violations.length, 1, `expected exactly one violation for ${spec.path}, got ${JSON.stringify(violations)}`);
    const msg = violations[0];
    assert.ok(msg.includes(`ViewState.${spec.path}`), `violation must name path 'ViewState.${spec.path}': ${msg}`);
    assert.ok(msg.includes('undefined'), `violation must mention 'undefined': ${msg}`);
    assert.ok(msg.includes(`expected ${spec.type}`), `violation must mention expected type '${spec.type}': ${msg}`);
  });

  test(`null ${spec.path} → exactly one violation naming the path and 'null'`, () => {
    const state = withField(validState(), spec.path, null);
    const violations = validateViewState(state);
    assert.equal(violations.length, 1, `expected exactly one violation for ${spec.path}, got ${JSON.stringify(violations)}`);
    const msg = violations[0];
    assert.ok(msg.includes(`ViewState.${spec.path}`), `violation must name path 'ViewState.${spec.path}': ${msg}`);
    assert.ok(msg.includes('null'), `violation must mention 'null': ${msg}`);
    assert.ok(msg.includes(`expected ${spec.type}`), `violation must mention expected type '${spec.type}': ${msg}`);
  });

  test(`wrong-type ${spec.path} → violation naming the path and expected type '${spec.type}'`, () => {
    const state = withField(validState(), spec.path, wrongValueFor(spec.type));
    const violations = validateViewState(state);
    // For wrong-type, only this field should be invalid (all others stay valid).
    assert.equal(violations.length, 1, `expected exactly one violation for ${spec.path}, got ${JSON.stringify(violations)}`);
    const msg = violations[0];
    assert.ok(msg.includes(`ViewState.${spec.path}`), `violation must name path 'ViewState.${spec.path}': ${msg}`);
    assert.ok(msg.includes(`expected ${spec.type}`), `violation must mention expected type '${spec.type}': ${msg}`);
    assert.ok(msg.includes('wrong type'), `violation must say 'wrong type': ${msg}`);
  });
}

test('multiple violations at once are all returned in CRITICAL_FIELDS iteration order', () => {
  let state: ViewState = validState();
  state = withField(state, 'pruningSettings.mode', undefined) as ViewState;
  state = withField(state, 'transcript', null) as ViewState;
  state = withField(state, 'sessions', 'not-an-array') as ViewState;
  state = withField(state, 'aggregateStats', 42) as ViewState;
  const violations = validateViewState(state);
  assert.equal(violations.length, 4, `expected 4 violations, got ${JSON.stringify(violations)}`);
  // Order follows CRITICAL_FIELDS iteration: mode < transcript < sessions < aggregateStats.
  assert.ok(violations[0].includes('ViewState.pruningSettings.mode'));
  assert.ok(violations[1].includes('ViewState.transcript'));
  assert.ok(violations[2].includes('ViewState.sessions'));
  assert.ok(violations[3].includes('ViewState.aggregateStats'));
});

test('violation strings include the dotted ViewState. path and the expected type token', () => {
  const state = withField(validState(), 'toolResultPruningSettings.enabled', 'not-a-boolean');
  const violations = validateViewState(state);
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /^ViewState\.toolResultPruningSettings\.enabled has wrong type: got string, expected boolean$/,
    `violation string shape drifted: ${violations[0]}`,
  );
});