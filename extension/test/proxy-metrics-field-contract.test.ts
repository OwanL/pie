/**
 * Cross-system contract: the host TypeScript `ProxyProviderMetrics` interface
 * field names MUST exactly match the JSON keys the Python proxy emits at
 * /health/proxy_metrics. Drift here silently makes the proxy status strip show
 * undefined/stale numbers to users — this test makes drift a build failure.
 *
 * This is a STATIC drift guard: it reads both source files AS TEXT, regex-
 * extracts the field lists, and asserts set equality + camelCase spelling
 * parity. It does NOT import the modules (the Python file lives in proxy/,
 * and importing the host service pulls in `vscode`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const HOST_PATH = path.join(ROOT, 'extension', 'src', 'host', 'proxy-metrics-service.ts');
const PYTHON_PATH = path.join(ROOT, 'proxy', 'pie_proxy_runtime.py');

/**
 * Extract the field names of the `ProxyProviderMetrics` interface from the
 * host TypeScript file. Matches `export interface ProxyProviderMetrics { ... }`
 * and pulls each `name:` line inside the body.
 */
function extractHostFields(filePath: string): string[] {
  const src = fs.readFileSync(filePath, 'utf8');
  const iface = src.match(/export\s+interface\s+ProxyProviderMetrics\s*\{([\s\S]*?)\}/);
  assert.ok(iface, `ProxyProviderMetrics interface not found in ${filePath}`);
  const body = iface![1];
  const fields: string[] = [];
  for (const line of body.split('\n')) {
    // matches `  fieldName: type;` or `  fieldName?: type;` (optional fields)
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\??\s*:/);
    if (m) fields.push(m[1]);
  }
  return fields;
}

/**
 * Extract the JSON keys the Python route uses when constructing each provider
 * dict in `register_proxy_metrics_route`. Matches the first `{ ... }` dict
 * literal built inside that function and pulls each `"key":` line.
 */
function extractPythonKeys(filePath: string): string[] {
  const src = fs.readFileSync(filePath, 'utf8');
  // The per-provider dict is the argument to `providers.append({ ... })` inside
  // register_proxy_metrics_route. Anchor directly on that call so we extract
  // the metrics dict (not the unrelated `{"error": ...}` unauthorized dict).
  const dict = src.match(/providers\.append\(\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(dict, `providers.append({...}) dict not found in ${filePath}`);
  const dictBody = dict![1];
  const keys: string[] = [];
  for (const line of dictBody.split('\n')) {
    // matches `"key":` (with surrounding double quotes)
    const m = line.match(/^\s*"([A-Za-z][A-Za-z0-9_]*)"\s*:/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

const HOST_FIELDS = extractHostFields(HOST_PATH);
const PYTHON_KEYS = extractPythonKeys(PYTHON_PATH);

const EXPECTED = [
  'provider',
  'modelInfoId',
  'activeRequests',
  'queuedRequests',
  'maxConcurrentRequests',
  'afterburnSeconds',
];

test('host ProxyProviderMetrics exposes exactly the expected field set', () => {
  assert.deepEqual(
    [...HOST_FIELDS].sort(),
    [...EXPECTED].sort(),
    `host fields drifted; got ${JSON.stringify(HOST_FIELDS)}`,
  );
});

test('python proxy emits exactly the expected key set at /health/proxy_metrics', () => {
  assert.deepEqual(
    [...PYTHON_KEYS].sort(),
    [...EXPECTED].sort(),
    `python keys drifted; got ${JSON.stringify(PYTHON_KEYS)}`,
  );
});

test('host field set and python key set are identical', () => {
  assert.deepEqual(
    [...HOST_FIELDS].sort(),
    [...PYTHON_KEYS].sort(),
    `host/python key drift:\n  host=${JSON.stringify(HOST_FIELDS)}\n  python=${JSON.stringify(PYTHON_KEYS)}`,
  );
});

test('each key uses identical camelCase spelling in both files (no snake_case drift)', () => {
  for (const field of EXPECTED) {
    const inHost = HOST_FIELDS.includes(field);
    const inPython = PYTHON_KEYS.includes(field);
    assert.ok(inHost, `expected camelCase key '${field}' missing from host interface`);
    assert.ok(inPython, `expected camelCase key '${field}' missing from python route dict`);
    // Guard against snake_case leakage (e.g. model_info_id) in either file.
    // Only meaningful when the field actually has uppercase letters: for an
    // all-lowercase field (e.g. `provider`) the snake form equals the field,
    // so the `!includes` check would always false-alarms.
    const snake = field.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
    if (snake !== field) {
      assert.ok(
        !HOST_FIELDS.includes(snake),
        `host unexpectedly used snake_case '${snake}' instead of '${field}'`,
      );
      assert.ok(
        !PYTHON_KEYS.includes(snake),
        `python unexpectedly used snake_case '${snake}' instead of '${field}'`,
      );
    }
  }
});