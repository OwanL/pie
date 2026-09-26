import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveAgentDir } from '../agent-dir-resolution';

// Build an in-memory `exists` that treats the given paths as present.
// Normalizes both backslashes→forward slashes AND strips a leading drive
// letter (e.g. "C:" → "") so comparisons survive path.resolve() prepending
// the current drive on Windows. This mirrors how the production code resolves
// extensionPath's parent (an absolute OS path) and lets tests use simple
// slash-prefixed fixtures regardless of platform.
function makeExists(present: Set<string>): (p: string) => boolean {
  const norm = (p: string) =>
    p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^[a-zA-Z]:/, '');
  return (p: string) => present.has(norm(p));
}

function dirWith(dir: string): Set<string> {
  const n = dir.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^[a-zA-Z]:/, '');
  return new Set([n, `${n}/settings.json`]);
}

test('prefers the pie.agentDir setting when it validates', () => {
  const present = dirWith('/from/setting');
  // env dir also valid but setting has priority and wins
  for (const p of dirWith('/from/env')) present.add(p);

  const result = resolveAgentDir({
    configuredAgentDir: '/from/setting',
    envAgentDir: '/from/env',
    exists: makeExists(present),
  });

  assert.equal(result.agentDir, '/from/setting');
  assert.equal(result.source, 'setting');
  assert.deepEqual(result.rejections, []);
});

test('falls back to the env var when the stale setting points at a missing path', () => {
  // Simulates the recurring failure: pie.agentDir = "D:/Stale/pi-config" (gone),
  // but PI_CODING_AGENT_DIR env var = the real repo root (present).
  const present = dirWith('/real/repo');

  const result = resolveAgentDir({
    configuredAgentDir: 'D:/Stale/pi-config',
    envAgentDir: '/real/repo',
    exists: makeExists(present),
  });

  assert.equal(result.agentDir, '/real/repo');
  assert.equal(result.source, 'env');
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].source, 'setting');
  assert.equal(result.rejections[0].candidate, 'D:/Stale/pi-config');
  assert.equal(result.rejections[0].reason, 'not-a-directory');
});

test('a setting dir that exists but lacks settings.json is rejected as missing-settings-json', () => {
  // The candidate dir is present (stat says directory) but has no settings.json.
  const present = new Set<string>(['/empty/dir']); // dir but no settings.json
  // env also invalid so we fall through to the known checkout package layout.
  for (const p of dirWith('/repo/root')) present.add(p);

  const result = resolveAgentDir({
    configuredAgentDir: '/empty/dir',
    envAgentDir: '/also/invalid',
    extensionPath: '/repo/root/application/hosts/vscode',
    exists: makeExists(present),
  });

  // The known checkout package layout resolves to the OS absolute repo root.
  assert.equal(result.agentDir, path.resolve('/repo/root'));
  assert.equal(result.source, 'extension-relative');
  const settingRej = result.rejections.find((r) => r.source === 'setting');
  assert.equal(settingRej?.candidate, '/empty/dir');
  assert.equal(settingRej?.reason, 'missing-settings-json');
});

test('recovers via extension-relative fallback when both setting and env are stale', () => {
  const present = dirWith('/checkout/root');

  const result = resolveAgentDir({
    configuredAgentDir: '/gone/setting',
    envAgentDir: '/gone/env',
    extensionPath: '/checkout/root/application/hosts/vscode',
    exists: makeExists(present),
  });

  assert.equal(result.agentDir, path.resolve('/checkout/root'));
  assert.equal(result.source, 'extension-relative');
  assert.equal(result.rejections.length, 2);
  // Both prior candidates recorded as rejected.
  assert.ok(result.rejections.some((r) => r.source === 'setting'));
  assert.ok(result.rejections.some((r) => r.source === 'env'));
});

test('returns empty source=none when no candidate validates, with all rejections', () => {
  // Nothing exists — every candidate is rejected.
  const result = resolveAgentDir({
    configuredAgentDir: '/gone/setting',
    envAgentDir: '/gone/env',
    extensionPath: '/gone/application/hosts/vscode',
    exists: () => false,
  });

  assert.equal(result.agentDir, '');
  assert.equal(result.source, 'none');
  assert.equal(result.rejections.length, 3);
  assert.ok(result.rejections.every((r) => r.reason === 'not-a-directory'));
});

test('uses the env var when no setting is configured', () => {
  const present = dirWith('/from/env');
  const result = resolveAgentDir({
    configuredAgentDir: '',
    envAgentDir: '/from/env',
    exists: makeExists(present),
  });

  assert.equal(result.agentDir, '/from/env');
  assert.equal(result.source, 'env');
  assert.deepEqual(result.rejections, []);
});

test('uses extension-relative when no setting or env is configured', () => {
  const present = dirWith('/repo');
  const result = resolveAgentDir({
    configuredAgentDir: undefined,
    envAgentDir: undefined,
    extensionPath: '/repo/application/hosts/vscode',
    exists: makeExists(present),
  });

  assert.equal(result.agentDir, path.resolve('/repo'));
  assert.equal(result.source, 'extension-relative');
  assert.deepEqual(result.rejections, []);
});

test('an installed extension does not infer an agent dir from its parent', () => {
  const present = dirWith('/installed/extensions');
  const result = resolveAgentDir({
    extensionPath: '/installed/extensions/pie-sidebar-1.0.0',
    exists: makeExists(present),
  });

  assert.equal(result.agentDir, '');
  assert.equal(result.source, 'none');
  assert.deepEqual(result.rejections, []);
});

test('an explicit checkout root is tried after stale setting and env even for installed packages', () => {
  const present = dirWith('/checkout/root');
  const result = resolveAgentDir({
    configuredAgentDir: '/gone/setting',
    envAgentDir: '/gone/env',
    checkoutRoot: '/checkout/root',
    extensionPath: '/installed/extensions/pie-sidebar-1.0.0',
    exists: makeExists(present),
  });

  assert.equal(result.agentDir, path.resolve('/checkout/root'));
  assert.equal(result.source, 'extension-relative');
  assert.deepEqual(result.rejections.map((rejection) => rejection.source), ['setting', 'env']);
});

test('whitespace-only configuredAgentDir is ignored (treated as unset)', () => {
  const present = dirWith('/from/env');
  const result = resolveAgentDir({
    configuredAgentDir: '   ',
    envAgentDir: '/from/env',
    exists: makeExists(present),
  });

  assert.equal(result.agentDir, '/from/env');
  assert.equal(result.source, 'env');
  // '   ' trims to '' → not considered a candidate → no rejection recorded.
  assert.deepEqual(result.rejections, []);
});
