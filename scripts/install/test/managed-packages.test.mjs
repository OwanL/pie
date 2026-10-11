import assert from 'node:assert/strict';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectManagedPackage,
  managedPackagePinsReady,
} from '../lib/managed-packages.mjs';
import { resolvePieDataPaths, resolvePieDataRoot } from '../../../lib/data-root/pie-data-root-core.mjs';
import { classifyMcpScriptSource, patchMcpScriptLoadingInSource } from '../../../lib/managed-packages/managed-package-contract.mjs';

const MCP_SCRIPT_IMPORT = 'import { runMcpScript } from "./mcp-code.ts";';
const MCP_SCRIPT_COMMENT = '// Script execution is loaded on demand; registration remains eager.';
const MCP_SCRIPT_CALL = [
  '        executeOwner?.throwIfInactive();',
  '        return runMcpScript(state, params.code, params.timeoutMs, getPiTools, signal);',
].join('\n');
const MCP_SCRIPT_LAZY_CALL = [
  '        executeOwner?.throwIfInactive();',
  '        const { runMcpScript } = await import("./mcp-code.ts");',
  '        executeOwner?.throwIfInactive();',
  '        return runMcpScript(state, params.code, params.timeoutMs, getPiTools, signal);',
].join('\n');
const MCP_INDEX = `${MCP_SCRIPT_IMPORT}\n\n${MCP_SCRIPT_CALL}\n`;
const MCP_INDEX_PATCHED = `${MCP_SCRIPT_COMMENT}\n\n${MCP_SCRIPT_LAZY_CALL}\n`;
const MCP_AGENT = [
  'import { join, resolve } from "node:path";',
  'export function getAgentPath(...segments: string[]): string {',
  '  return join(getAgentDir(), ...segments);',
  '}',
].join('\n');
const MCP_AGENT_PATCHED = [
  'import { join, resolve } from "node:path";',
  'export function getAgentPath(...segments: string[]): string {',
  '  const cacheDir = process.env.PIE_CACHE_DIR?.trim();',
  '  if (cacheDir && segments.length === 1 && (segments[0] === "mcp-cache.json" || segments[0] === "mcp-npx-cache.json")) {',
  '    return join(resolve(cacheDir), segments[0]);',
  '  }',
  '  return join(getAgentDir(), ...segments);',
  '}',
].join('\n');

function writeMcpFixture(root, index = MCP_INDEX, agentDir = MCP_AGENT) {
  const prefix = 'npm/node_modules/pi-mcp-adapter/';
  write(root, `${prefix}package.json`, JSON.stringify({ name: 'pi-mcp-adapter', version: '2.20.1' }));
  write(root, `${prefix}index.ts`, index);
  write(root, `${prefix}agent-dir.ts`, agentDir);
  write(root, `${prefix}mcp-code.ts`, '// script implementation');
  write(root, `${prefix}mcp-script-worker.mjs`, '// script worker');
}

function write(root, relative, value) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value, 'utf8');
}

test('MCP script-loading adaptation is exact, pure, and idempotent', () => {
  assert.equal(classifyMcpScriptSource(MCP_INDEX), 'pristine');
  assert.equal(patchMcpScriptLoadingInSource(MCP_INDEX), MCP_INDEX_PATCHED);
  assert.equal(classifyMcpScriptSource(MCP_INDEX_PATCHED), 'supported-patched');
  assert.equal(patchMcpScriptLoadingInSource(MCP_INDEX_PATCHED), MCP_INDEX_PATCHED);
  const surrounded = `// untouched before\n${MCP_INDEX}// untouched after\n`;
  assert.equal(patchMcpScriptLoadingInSource(surrounded), `// untouched before\n${MCP_INDEX_PATCHED}// untouched after\n`);
});

const unsupportedScriptSources = [
  ['missing import', MCP_INDEX.replace(`${MCP_SCRIPT_IMPORT}\n`, '')],
  ['import-only patch', MCP_INDEX.replace(MCP_SCRIPT_IMPORT, MCP_SCRIPT_COMMENT)],
  ['call-only patch', MCP_INDEX.replace(MCP_SCRIPT_CALL, MCP_SCRIPT_LAZY_CALL)],
  ['missing second guard', MCP_INDEX_PATCHED.replace(MCP_SCRIPT_LAZY_CALL, MCP_SCRIPT_LAZY_CALL.replace('\n        executeOwner?.throwIfInactive();', ''))],
  ['duplicate eager import', `${MCP_SCRIPT_IMPORT}\n${MCP_INDEX}`],
  ['duplicate lazy comment', `${MCP_SCRIPT_COMMENT}\n${MCP_INDEX_PATCHED}`],
  ['duplicate call', `${MCP_INDEX}${MCP_SCRIPT_CALL}\n`],
  ['duplicate complete patch', `${MCP_INDEX_PATCHED}${MCP_INDEX_PATCHED}`],
  ['drifted arguments', MCP_INDEX.replace('params.timeoutMs', '123')],
  ['drifted spacing', MCP_INDEX.replace('return runMcpScript', 'return  runMcpScript')],
  ['drifted guard', MCP_INDEX.replace('executeOwner?.', 'executeOwner.')],
  ['alternate static import', MCP_INDEX.replace(MCP_SCRIPT_IMPORT, 'import { runMcpScript as runScript } from "./mcp-code.ts";')],
  ['extra alternate static import', `${MCP_INDEX}import * as script from './mcp-code.ts';\n`],
  ['extra call', `${MCP_INDEX}runMcpScript(state, code);\n`],
  ['extra module load', `${MCP_INDEX_PATCHED}await import('./mcp-code.ts');\n`],
  ['trailing return drift', MCP_INDEX.replace('getPiTools, signal);', 'getPiTools, signal); changed();')],
];

for (const [label, source] of unsupportedScriptSources) {
  test(`MCP script-loading rejects ${label}`, () => {
    assert.equal(classifyMcpScriptSource(source), 'unsupported');
    assert.throws(() => patchMcpScriptLoadingInSource(source), /Unsupported MCP script-loading source/);
  });
}

test('MCP readiness supports pristine, complete patched, and mixed complete cache/script seams', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-managed-readiness-'));
  try {
    for (const [index, agentDir, expected] of [
      [MCP_INDEX, MCP_AGENT, 'pristine'],
      [MCP_INDEX_PATCHED, MCP_AGENT_PATCHED, 'supported-patched'],
      [MCP_INDEX, MCP_AGENT_PATCHED, 'supported-patched'],
      [MCP_INDEX_PATCHED, MCP_AGENT, 'supported-patched'],
    ]) {
      writeMcpFixture(root, index, agentDir);
      const result = inspectManagedPackage({ agentDir: root, packageName: 'pi-mcp-adapter', cacheDir: path.join(root, 'cache') });
      assert.equal(result.status, 'ready');
      assert.equal(result.sourceFingerprint, expected);
    }
    for (const [label, source] of unsupportedScriptSources) {
      writeMcpFixture(root, source);
      const result = inspectManagedPackage({ agentDir: root, packageName: 'pi-mcp-adapter', cacheDir: path.join(root, 'cache') });
      assert.equal(result.status, 'unsupported-source', label);
      assert.equal(result.sourceFingerprint, 'unsupported', label);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP readiness requires each script runtime file and agent source', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-managed-readiness-'));
  try {
    for (const relative of ['index.ts', 'agent-dir.ts', 'mcp-code.ts', 'mcp-script-worker.mjs']) {
      writeMcpFixture(root);
      rmSync(path.join(root, 'npm/node_modules/pi-mcp-adapter', relative));
      const result = inspectManagedPackage({ agentDir: root, packageName: 'pi-mcp-adapter', cacheDir: path.join(root, 'cache') });
      assert.equal(result.status, 'missing-source', relative);
      assert.ok(result.detail.endsWith(relative));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('managed package pins require both exact configured sources', () => {
  assert.equal(managedPackagePinsReady({ packages: [
    'npm:pi-web-access@0.27.0',
    { source: 'npm:pi-mcp-adapter@2.20.1', extensions: ['index.ts'] },
  ] }), true);
  assert.equal(managedPackagePinsReady({ packages: ['npm:pi-web-access@0.27.0'] }), false);
  assert.equal(managedPackagePinsReady({ packages: [
    'npm:pi-web-access@0.27.0',
    'npm:pi-web-access@0.28.0',
    'npm:pi-mcp-adapter@2.20.1',
  ] }), false);
  assert.equal(managedPackagePinsReady({ packages: [
    'npm:pi-web-access@0.27.0',
    'npm:pi-web-access',
    'npm:pi-mcp-adapter@2.20.1',
  ] }), false);
  assert.equal(managedPackagePinsReady({ packages: [
    'npm:pi-web-access@0.27.0',
    'npm:pi-mcp-adapter@2.20.1',
    'npm:unrelated@9.9.9',
  ] }), true);
});

test('managed package readiness reports missing package and never searches a sibling global copy', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-managed-readiness-'));
  const staleGlobal = mkdtempSync(path.join(os.tmpdir(), 'pie-managed-global-'));
  try {
    write(staleGlobal, 'package.json', JSON.stringify({ name: 'pi-web-access', version: '0.27.0' }));
    const result = inspectManagedPackage({
      agentDir: root,
      packageName: 'pi-web-access',
      cacheDir: path.join(root, 'cache'),
    });
    assert.equal(result.status, 'missing');
    assert.ok(result.root.endsWith(path.join('npm', 'node_modules', 'pi-web-access')));
    assert.deepEqual(result.cacheTargets, [path.join(root, 'cache', 'web-search-cache')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(staleGlobal, { recursive: true, force: true });
  }
});

test('managed package readiness rejects wrong pins and source-shape drift', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-managed-readiness-'));
  try {
    write(root, 'npm/node_modules/pi-mcp-adapter/package.json', JSON.stringify({ name: 'pi-mcp-adapter', version: '2.21.0' }));
    assert.equal(inspectManagedPackage({ agentDir: root, packageName: 'pi-mcp-adapter' }).status, 'wrong-version');

    writeMcpFixture(root);
    write(root, 'npm/node_modules/pi-mcp-adapter/agent-dir.ts', 'export const changed = true;');
    const result = inspectManagedPackage({ agentDir: root, packageName: 'pi-mcp-adapter', cacheDir: path.join(root, 'cache') });
    assert.equal(result.status, 'unsupported-source');
    assert.deepEqual(result.cacheTargets, [path.join(root, 'cache', 'mcp-cache.json'), path.join(root, 'cache', 'mcp-npx-cache.json')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('managed package readiness distinguishes an invalid manifest from a missing package', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-managed-readiness-'));
  try {
    write(root, 'npm/node_modules/pi-web-access/package.json', '{not json');
    const malformed = inspectManagedPackage({ agentDir: root, packageName: 'pi-web-access' });
    assert.equal(malformed.status, 'malformed-manifest');
    rmSync(path.join(root, 'npm'), { recursive: true, force: true });
    const missing = inspectManagedPackage({ agentDir: root, packageName: 'pi-web-access' });
    assert.equal(missing.status, 'missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor data-root resolver preserves default, absolute, and agent-relative cache targets', () => {
  assert.equal(resolvePieDataRoot({
    platform: 'linux',
    homeDir: '/home/alice',
    environment: {},
  }), '/home/alice/.local/share/pie/data');
  assert.equal(resolvePieDataPaths({
    platform: 'linux',
    dataDir: '/var/lib/pie-data/../pie-data',
    homeDir: '/home/alice',
    environment: {},
  }).cacheDir, '/var/lib/pie-data/cache');
  assert.equal(resolvePieDataPaths({
    platform: 'linux',
    dataDir: 'runtime-data',
    agentDir: '/opt/pi-agent',
    homeDir: '/home/alice',
    environment: {},
  }).cacheDir, '/opt/pi-agent/runtime-data/cache');
});
