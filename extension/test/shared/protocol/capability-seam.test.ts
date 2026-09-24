/**
 * Capability/operation protocol seam boundary guards (repository-organization
 * plan §3.2/§3.4; STATE_CONTRACT "Authoritative Session Activity and
 * Capabilities").
 *
 * The backend publishes only the inert `SessionCapabilityFacts` contract; the
 * reducer-owned operation projection (`primaryOperation`) is overlay-joined
 * exclusively by the pure host projection into the renderer DTO. If any of
 * these tests fail, a layering violation has been introduced: backend
 * producers must never import host-owned operation projections.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// tsx compiles .ts files to CJS where __dirname is available (import.meta.url is not).
declare const __dirname: string;

const PROTOCOL_ROOT = resolve(__dirname, '..', '..', '..', 'src', 'shared', 'protocol');
const BACKEND_ROOT = resolve(__dirname, '..', '..', '..', 'src', 'backend');

const FACTS_MODULE = resolve(PROTOCOL_ROOT, 'session-capability-facts.ts');
const OPERATION_MODULE = resolve(PROTOCOL_ROOT, 'session-operation-projection.ts');
const PROJECTION_MODULE = resolve(__dirname, '..', '..', '..', 'src', 'host', 'core', 'projection.ts');

/** Backend modules that produce or annotate session capability payloads. */
const BACKEND_CAPABILITY_PRODUCERS = [
  'session-activity.ts',
  'session-opened.ts',
  'session-event-shared.ts',
  'session-event-lifecycle.ts',
  'session-browser.ts',
  'request-handler-shared.ts',
  'request-handler-message.ts',
  'worker-runtime-host.ts',
].map((name) => resolve(BACKEND_ROOT, name));

test('capability facts contract stays inert: no imports, no operation overlay', () => {
  const source = readFileSync(FACTS_MODULE, 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m, 'session-capability-facts.ts must remain inert (no imports)');
  assert.doesNotMatch(
    source,
    /\bprimaryOperation\b/,
    'capability facts must not declare or reference the host operation overlay',
  );
  assert.ok(!source.includes('SessionPrimaryOperation'), 'capability facts must not reference host operation types');
  for (const fact of ['billableActivity', 'canContinue', 'canInterrupt', 'canCompact']) {
    assert.ok(source.includes(fact), `capability facts contract must declare ${fact}`);
  }
});

test('operation projection module may depend on facts, never the reverse', () => {
  const source = readFileSync(OPERATION_MODULE, 'utf8');
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(
    imports,
    ['./session-capability-facts.js'],
    'session-operation-projection.ts may import only the inert facts contract',
  );
  assert.ok(source.includes('primaryOperation'), 'operation projection must own the primaryOperation overlay');
  assert.ok(source.includes('export interface SessionCapabilities extends SessionCapabilityFacts'),
    'renderer DTO must extend the inert facts contract (wire shape is unchanged)');
});

test('backend capability producers must not import host-owned operation projections', () => {
  for (const path of BACKEND_CAPABILITY_PRODUCERS) {
    const source = readFileSync(path, 'utf8');
    const rel = path.slice(BACKEND_ROOT.length + 1);
    assert.ok(
      !source.includes('session-operation-projection'),
      `${rel} must not import the host operation projection module`,
    );
    assert.ok(!source.includes('primaryOperation'), `${rel} must not reference primaryOperation`);
    assert.ok(!source.includes('SessionPrimaryOperation'), `${rel} must not reference SessionPrimaryOperation`);
    if (/\bSessionCapabilities\b/.test(source)) {
      assert.fail(`${rel} must consume SessionCapabilityFacts, not the renderer DTO SessionCapabilities`);
    }
  }
});

test('backend producers consume the inert facts contract directly', () => {
  const activity = readFileSync(resolve(BACKEND_ROOT, 'session-activity.ts'), 'utf8');
  assert.match(
    activity,
    /from\s+['"][^'"]*shared\/protocol\/session-capability-facts\.js['"]/,
    'session-activity.ts must import the canonical facts contract',
  );
});

test('only the pure host projection joins facts and the operation overlay', () => {
  const projection = readFileSync(PROJECTION_MODULE, 'utf8');
  assert.ok(projection.includes('primaryOperation'), 'projection must overlay primaryOperation');
  assert.ok(
    projection.includes('SessionCapabilityFacts'),
    'projection must read the inert facts store as its base',
  );
});