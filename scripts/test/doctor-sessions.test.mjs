// Focused unit tests for scripts/doctor-sessions.mjs — detection of sessions
// stranded in a legacy root without a canonical counterpart. The bucket
// derivation reuses scripts/install/lib/sessions.mjs so "stranded" matches the
// migration's placement exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectStrandedLegacySessions, legacySessionRoots } from '../doctor-sessions.mjs';

function withTempDir(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-doctor-sessions-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function sessionJsonl(cwd) {
  return `${JSON.stringify({ type: 'session', version: 3, id: 'x', timestamp: '2026-01-01T00:00:00.000Z', cwd })}\n`;
}

test('legacySessionRoots covers the SDK home default plus both repo-local legacy layouts', () => {
  const roots = legacySessionRoots({ repoRoot: '/repo', homeDir: '/home' });
  assert.deepEqual(roots, [
    path.join('/home', '.pi', 'agent', 'sessions'),
    path.join('/repo', 'data', 'sessions'),
    path.join('/repo', 'sessions'),
  ]);
});

test('legacySessionRoots defaults homeDir to os.homedir when omitted', () => {
  const roots = legacySessionRoots({ repoRoot: '/repo' });
  assert.equal(roots[0], path.join(os.homedir(), '.pi', 'agent', 'sessions'));
});

test('collectStrandedLegacySessions reports legacy files without a canonical counterpart', () => withTempDir((root) => {
  const repoRoot = path.join(root, 'repo');
  const homeDir = path.join(root, 'home');
  const canonical = path.join(repoRoot, 'data', 'outcomes', 'sessions');
  // <repoRoot>/sessions is the <agentDir>/sessions SDK default the backend retired.
  const legacyRoot = path.join(repoRoot, 'sessions');
  const bucket = path.join(canonical, '--c--repo--');
  mkdirSync(legacyRoot, { recursive: true });
  writeFileSync(path.join(legacyRoot, 'stranded.jsonl'), sessionJsonl('c:\\repo'));
  writeFileSync(path.join(legacyRoot, 'migrated.jsonl'), sessionJsonl('c:\\repo'));
  mkdirSync(bucket, { recursive: true });
  writeFileSync(path.join(bucket, 'migrated.jsonl'), 'present'); // canonical counterpart exists

  const report = collectStrandedLegacySessions({ repoRoot, homeDir, canonicalSessionDir: canonical });
  assert.equal(report.canonical, canonical);
  assert.equal(report.totalStranded, 1);
  const legacyEntry = report.roots.find((r) => r.root === legacyRoot);
  assert.equal(legacyEntry.stranded, 1);
  assert.equal(legacyEntry.total, 2);
}));

test('collectStrandedLegacySessions reports zero stranded once every legacy file has a canonical counterpart', () => withTempDir((root) => {
  const repoRoot = path.join(root, 'repo');
  const homeDir = path.join(root, 'home');
  const canonical = path.join(repoRoot, 'data', 'outcomes', 'sessions');
  const legacyRoot = path.join(repoRoot, 'data', 'sessions');
  const bucket = path.join(canonical, '--d--projects--');
  mkdirSync(legacyRoot, { recursive: true });
  mkdirSync(bucket, { recursive: true });
  writeFileSync(path.join(legacyRoot, 'a.jsonl'), sessionJsonl('d:\\projects'));
  writeFileSync(path.join(bucket, 'a.jsonl'), 'present');

  const report = collectStrandedLegacySessions({ repoRoot, homeDir, canonicalSessionDir: canonical });
  assert.equal(report.totalStranded, 0);
  assert.equal(report.roots.length, 1);
  assert.equal(report.roots[0].stranded, 0);
  assert.equal(report.roots[0].total, 1);
}));

test('collectStrandedLegacySessions uses the migration parser for a late session header', () => withTempDir((root) => {
  const repoRoot = path.join(root, 'repo');
  const homeDir = path.join(root, 'home');
  const canonical = path.join(repoRoot, 'data', 'outcomes', 'sessions');
  const legacyRoot = path.join(repoRoot, 'sessions');
  const bucket = path.join(canonical, '--e--late--');
  mkdirSync(legacyRoot, { recursive: true });
  mkdirSync(bucket, { recursive: true });
  const malformedPrefix = `${'x'.repeat(20 * 1024)}\n`;
  writeFileSync(path.join(legacyRoot, 'late.jsonl'), `${malformedPrefix}${sessionJsonl('e:\\late')}`);
  writeFileSync(path.join(bucket, 'late.jsonl'), 'present');

  const report = collectStrandedLegacySessions({ repoRoot, homeDir, canonicalSessionDir: canonical });
  assert.equal(report.totalStranded, 0, 'doctor and migration must derive the same late-header bucket');
}));

test('collectStrandedLegacySessions ignores missing legacy roots', () => {
  const report = collectStrandedLegacySessions({
    repoRoot: '/nonexistent-repo',
    homeDir: '/nonexistent-home',
    canonicalSessionDir: '/nonexistent-canonical',
  });
  assert.equal(report.totalStranded, 0);
  assert.equal(report.roots.length, 0);
});

test('collectStrandedLegacySessions treats a headerless transcript as the --unknown-- bucket (matching the migration)', () => withTempDir((root) => {
  const repoRoot = path.join(root, 'repo');
  const homeDir = path.join(root, 'home');
  const canonical = path.join(repoRoot, 'data', 'outcomes', 'sessions');
  const legacyRoot = path.join(repoRoot, 'sessions');
  mkdirSync(legacyRoot, { recursive: true });
  writeFileSync(path.join(legacyRoot, 'malformed.jsonl'), `${JSON.stringify({ type: 'message', text: 'no header' })}\n`);

  const report = collectStrandedLegacySessions({ repoRoot, homeDir, canonicalSessionDir: canonical });
  assert.equal(report.totalStranded, 1, 'a headerless transcript is stranded under the --unknown-- bucket');
  assert.equal(existsSync(path.join(canonical, '--unknown--', 'malformed.jsonl')), false);
}));
