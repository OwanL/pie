/**
 * Architectural boundary guards.
 *
 * These tests enforce that concerns live in their designated layer:
 * - Alias resolution and turn-tracking belong in the arch reducer (core/reducer.ts)
 *
 * If any of these tests fail, it means a layering violation has been introduced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// tsx compiles .ts files to CJS where __dirname is available (import.meta.url is not).
declare const __dirname: string;

const CORE_ROOT = resolve(__dirname, '..', '..', '..', '..', 'src', 'host', 'core');
const ARCH_STATE_PATH = resolve(CORE_ROOT, 'arch-state.ts');
const EFFECT_RUNNER_PATH = resolve(CORE_ROOT, 'effect-runner.ts');
const SESSION_OPERATION_CONTROLLER_PATH = resolve(CORE_ROOT, 'session-operation-effect-controller.ts');

// ─── Guard: TranscriptState has no alias/turn fields ─────────────────────────

test('TranscriptState must not contain messageIdAlias or currentTurnBySession fields', () => {
  const archState = readFileSync(ARCH_STATE_PATH, 'utf8');

  // Extract the TranscriptState interface body from arch-state.ts (canonical location)
  const ifaceMatch = archState.match(/export interface TranscriptState\s*\{([\s\S]+?)\}/);
  assert.ok(ifaceMatch, 'TranscriptState interface not found in arch-state.ts');

  const body = ifaceMatch[1];
  assert.ok(!body.includes('messageIdAlias'), 'TranscriptState must not contain messageIdAlias — alias state belongs in ArchState');
  assert.ok(!body.includes('currentTurnBySession'), 'TranscriptState must not contain currentTurnBySession — turn tracking belongs in ArchState');
});

// ─── Guard: arch reducer is pure (no external imports beyond types) ──────────
// NOTE: The arch reducer now imports mutation helpers from core/transcript-helpers
// and window helpers from core/transcript-window, which is intentional
// for the Phase 5+ migration where the reducer owns transcript state directly.
// These imports are pure functions (no Redux coupling), so they are allowed.

test('EffectRunner delegates session-operation resources to the dedicated controller', () => {
  const effectRunner = readFileSync(EFFECT_RUNNER_PATH, 'utf8');
  const controller = readFileSync(SESSION_OPERATION_CONTROLLER_PATH, 'utf8');
  const resourcesOwnedByController = [
    'registeredSends',
    'legacyInFlightSends',
    'operationReconciliationTimers',
    'queuedEditOperations',
    'messageOperationTickets',
    'messageOperationBarriers',
    'queryOperationStatus(',
  ];

  assert.match(effectRunner, /private readonly sessionOperations: SessionOperationEffectController/);
  for (const resource of resourcesOwnedByController) {
    assert.ok(!effectRunner.includes(resource), `EffectRunner must not own session-operation resource ${resource}`);
    assert.ok(controller.includes(resource), `session-operation controller must own ${resource}`);
  }

  const fieldRegion = controller.match(/export class SessionOperationEffectController \{([\s\S]+?)\n {2}constructor/);
  assert.ok(fieldRegion, 'session-operation controller field region not found');
  assert.doesNotMatch(
    fieldRegion[1],
    /private[^\n]*(?:phase|outcome|acknowledgement|commitEvidence|recovery|terminal)/i,
    'controller fields must remain opaque execution/correlation resources, not semantic lifecycle state',
  );
  assert.doesNotMatch(
    controller,
    /from ['"].*(?:arch-state|operation-registry|reducer)/,
    'session-operation controller must observe reducer effects without importing semantic state',
  );
});

test('arch reducer must not import from extension-host', () => {
  const reducerPath = resolve(__dirname, '..', '..', '..', '..', 'src', 'host', 'core', 'reducer.ts');
  const reducer = readFileSync(reducerPath, 'utf8');

  const imports = [...reducer.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);

  for (const imp of imports) {
    assert.ok(!imp.includes('extension-host'), `Arch reducer must not import from extension-host (found: "${imp}")`);
  }
});

// ─── Guard: pure reducer spine must not call impure builtins ────────────────
// The reducer, its handlers, and the pure helpers they call must stay pure:
// no wall-clock time, no randomness, no console, no host imports. `new Date(x)`
// (deterministic, from an injected timestamp) is allowed; `new Date()` (current
// time) is not. A file that needs impurity belongs in the impure plumbing layer
// (message-router / queue-manager / effect-runner / dispatch), not here.

const PURE_SPINE_FILES = [
  'reducer.ts',
  'arch-state.ts',
  'effects.ts',
  'events.ts',
  'commands.ts',
  'projection.ts',
  'transcript-helpers.ts',
  'transcript-window.ts',
  'restored-session-plan.ts',
  'restored-session-summaries.ts',
  'session-opened-transcript.ts',
  'file-change-derivation.ts',
  'model-capability.ts',
];

const PURE_SPINE_REDUCER_DIR = resolve(CORE_ROOT, 'reducer');

const IMPURITY_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'Date.now()', re: /\bDate\.now\(/ },
  { name: 'Math.random()', re: /\bMath\.random\(/ },
  { name: 'new Date() (current time)', re: /new Date\(\s*\)/ },
  { name: 'console.*', re: /\bconsole\./ },
  { name: 'process.env', re: /\bprocess\.env\b/ },
];

function readPureSpineFiles(): Array<{ file: string; src: string }> {
  const files = PURE_SPINE_FILES.map((f) => resolve(CORE_ROOT, f));
  for (const entry of readdirSync(PURE_SPINE_REDUCER_DIR)) {
    if (entry.endsWith('.ts')) {
      files.push(resolve(PURE_SPINE_REDUCER_DIR, entry));
    }
  }
  return files.map((file) => ({ file, src: readFileSync(file, 'utf8') }));
}

test('pure reducer spine must not call impure builtins', () => {
  for (const { file, src } of readPureSpineFiles()) {
    for (const { name, re } of IMPURITY_PATTERNS) {
      assert.ok(!re.test(src), `${file}: pure spine must not use ${name}`);
    }
  }
});

test('pure reducer spine must not import vscode / node:fs / node:crypto', () => {
  for (const { file, src } of readPureSpineFiles()) {
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const imp of imports) {
      assert.ok(
        imp !== 'vscode' && !imp.startsWith('node:fs') && !imp.startsWith('node:crypto'),
        `${file}: pure spine must not import vscode/node:fs/node:crypto (found: "${imp}")`,
      );
    }
  }
});
