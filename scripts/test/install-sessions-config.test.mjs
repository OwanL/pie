// Focused unit tests for scripts/install/lib/sessions-config.mjs — the
// settings.json#sessionDir rewrite + legacy-session-import orchestration that
// install.bat delegates to (batch cannot parse/rewrite JSON). install.sh keeps
// its simpler scripts/migrate-local-sessions.mjs flow, so this module is the
// Windows installer's fuller behaviour; the file-merge core (sessions.mjs) is
// tested separately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureSessions, resolveConfiguredSessionDir, DESIRED_SESSION_DIR } from '../install/lib/sessions-config.mjs';

function withTempDir(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-sessions-config-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function sessionJsonl(cwd, timestamp) {
  return `${JSON.stringify({ type: 'session', cwd, timestamp })}\n`;
}

function writeSettings(repoRoot, obj) {
  writeFileSync(path.join(repoRoot, 'settings.json'), `${JSON.stringify(obj)}`);
}

// ---------------------------------------------------------------------------
// resolveConfiguredSessionDir
// ---------------------------------------------------------------------------

test('resolveConfiguredSessionDir resolves ~ and ~-prefixed paths against homeDir', () => {
  const home = os.platform() === 'win32' ? 'C:\\Users\\me' : '/home/me';
  assert.equal(resolveConfiguredSessionDir('~', { homeDir: home }), home);
  assert.equal(resolveConfiguredSessionDir('~/foo', { homeDir: home }), path.join(home, 'foo'));
  assert.equal(resolveConfiguredSessionDir('~\\foo', { homeDir: home }), path.join(home, 'foo'));
});

test('resolveConfiguredSessionDir returns absolute paths verbatim', () => {
  const abs = os.platform() === 'win32' ? 'C:\\secure\\pie' : '/secure/pie';
  assert.equal(resolveConfiguredSessionDir(abs), abs);
});

test('resolveConfiguredSessionDir returns null for relative / empty / missing values', () => {
  assert.equal(resolveConfiguredSessionDir('relative/dir'), null);
  assert.equal(resolveConfiguredSessionDir(''), null);
  assert.equal(resolveConfiguredSessionDir(undefined), null);
  assert.equal(resolveConfiguredSessionDir(null), null);
});

test('DESIRED_SESSION_DIR is the canonical checkout-local store', () => {
  assert.equal(DESIRED_SESSION_DIR, 'data/outcomes/sessions');
});

// ---------------------------------------------------------------------------
// configureSessions — settings.json rewrite
// ---------------------------------------------------------------------------

test('configureSessions is a no-op when sessionDir is already canonical', () => withTempDir((root) => {
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  writeSettings(repo, { sessionDir: 'data/outcomes/sessions', foo: 1 });
  const res = configureSessions({ repoRoot: repo, homeDir: path.join(root, 'home') });
  assert.equal(res.settingsRewritten, false);
  assert.equal(res.migrated, false);
  // settings.json untouched (no backup created).
  assert.equal(existsSync(path.join(repo, 'settings.json.session-dir')), false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(repo, 'settings.json'), 'utf8')), { sessionDir: 'data/outcomes/sessions', foo: 1 });
  // newSessions points at the canonical store.
  assert.equal(res.newSessions, path.join(repo, 'data', 'outcomes', 'sessions'));
}));

test('configureSessions rewrites a non-canonical sessionDir and backs up settings.json', () => withTempDir((root) => {
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  writeSettings(repo, { sessionDir: '~/old-sessions', keep: true });
  const res = configureSessions({ repoRoot: repo, homeDir: path.join(root, 'home') });
  assert.equal(res.settingsRewritten, true);
  const written = JSON.parse(readFileSync(path.join(repo, 'settings.json'), 'utf8'));
  assert.equal(written.sessionDir, 'data/outcomes/sessions');
  assert.equal(written.keep, true);
  // A timestamped backup of the original exists with the old value.
  const backups = readdirSync(repo).filter((f) => /^settings\.json\.session-dir\.\d+\.bak$/.test(f));
  assert.equal(backups.length, 1);
  const backup = JSON.parse(readFileSync(path.join(repo, backups[0]), 'utf8'));
  assert.equal(backup.sessionDir, '~/old-sessions');
  // The rewrite is idempotent: a second run is a no-op.
  const res2 = configureSessions({ repoRoot: repo, homeDir: path.join(root, 'home') });
  assert.equal(res2.settingsRewritten, false);
  // No trailing newline + 2-space indent matches the tracked style.
  const raw = readFileSync(path.join(repo, 'settings.json'), 'utf8');
  assert.equal(raw.endsWith('\n'), false);
  assert.match(raw, /\n  "sessionDir"/);
  // Progress line announcing the rewrite.
  assert.ok(res.lines.some((l) => /Updated sessionDir in settings\.json/.test(l)));
}));

test('configureSessions adds sessionDir when settings.json lacks it', () => withTempDir((root) => {
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  writeSettings(repo, { other: 1 });
  const res = configureSessions({ repoRoot: repo, homeDir: path.join(root, 'home') });
  assert.equal(res.settingsRewritten, true);
  const written = JSON.parse(readFileSync(path.join(repo, 'settings.json'), 'utf8'));
  assert.equal(written.sessionDir, 'data/outcomes/sessions');
  assert.equal(written.other, 1);
  assert.ok(res.lines.some((l) => /Added sessionDir to settings\.json/.test(l)));
}));

test('configureSessions leaves settings.json alone when the file is missing', () => withTempDir((root) => {
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const res = configureSessions({ repoRoot: repo, homeDir: path.join(root, 'home') });
  assert.equal(res.settingsRewritten, false);
  assert.equal(existsSync(path.join(repo, 'settings.json')), false);
}));

test('configureSessions warns (and still rewrites) on an unresolvable relative sessionDir', () => withTempDir((root) => {
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  writeSettings(repo, { sessionDir: 'relative/without/tilde' });
  const res = configureSessions({ repoRoot: repo, homeDir: path.join(root, 'home') });
  assert.equal(res.settingsRewritten, true);
  assert.ok(res.lines.some((l) => /could not be resolved safely/.test(l)));
}));

// ---------------------------------------------------------------------------
// configureSessions — legacy session migration
// ---------------------------------------------------------------------------

test('configureSessions imports default legacy roots recursively', () => withTempDir((root) => {
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  mkdirSync(repo);
  writeSettings(repo, { sessionDir: 'data/outcomes/sessions' });
  // All three retired roots are recursive and must converge into the canonical store.
  const legacyDefault = path.join(home, '.pi', 'agent', 'sessions', 'sub');
  const legacyData = path.join(repo, 'data', 'sessions', 'sub');
  const legacyAgent = path.join(repo, 'sessions', 'sub');
  for (const directory of [legacyDefault, legacyData, legacyAgent]) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(legacyDefault, 'home.jsonl'), sessionJsonl('/repo', '2024-01-01T00:00:00.000Z'));
  writeFileSync(path.join(legacyData, 'data.jsonl'), sessionJsonl('/repo', '2024-01-01T00:00:00.000Z'));
  writeFileSync(path.join(legacyAgent, 'agent.jsonl'), sessionJsonl('/repo', '2024-01-01T00:00:00.000Z'));
  const res = configureSessions({ repoRoot: repo, homeDir: home });
  assert.equal(res.migrated, true);
  for (const file of ['home.jsonl', 'data.jsonl', 'agent.jsonl']) {
    assert.equal(existsSync(path.join(repo, 'data', 'outcomes', 'sessions', '--repo--', file)), true);
  }
  assert.ok(res.lines.some((l) => /Migrating session history/.test(l)));
}));

test('configureSessions imports a prior configured sessionDir non-recursively', () => withTempDir((root) => {
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  mkdirSync(repo);
  const configured = path.join(home, 'old-sessions');
  mkdirSync(configured, { recursive: true });
  mkdirSync(path.join(configured, 'nested'));
  writeFileSync(path.join(configured, 'top.jsonl'), sessionJsonl('/repo', '2024-01-01T00:00:00.000Z'));
  writeFileSync(path.join(configured, 'nested', 'deep.jsonl'), sessionJsonl('/repo', '2024-01-01T00:00:00.000Z'));
  writeSettings(repo, { sessionDir: configured });
  const res = configureSessions({ repoRoot: repo, homeDir: home });
  assert.equal(res.migrated, true);
  // Only the top-level file is imported (configured dir is non-recursive).
  assert.equal(existsSync(path.join(repo, 'data', 'outcomes', 'sessions', '--repo--', 'top.jsonl')), true);
  assert.equal(existsSync(path.join(repo, 'data', 'outcomes', 'sessions', '--repo--', 'deep.jsonl')), false);
  assert.ok(res.lines.some((l) => /Will import legacy session history from configured sessionDir/.test(l)));
}));

test('configureSessions normalizes an absolute canonical sessionDir to the relative form and skips importing from it', () => withTempDir((root) => {
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const canonical = path.join(repo, 'data', 'outcomes', 'sessions');
  writeSettings(repo, { sessionDir: canonical });
  const res = configureSessions({ repoRoot: repo, homeDir: path.join(root, 'home') });
  // The absolute path is rewritten to the tracked relative form (portable), so
  // settingsRewritten is true; but the resolved location == the canonical
  // store, so no import happens (migrated false) and it reports "already points".
  assert.equal(res.settingsRewritten, true);
  assert.equal(res.migrated, false);
  assert.equal(JSON.parse(readFileSync(path.join(repo, 'settings.json'), 'utf8')).sessionDir, 'data/outcomes/sessions');
  assert.ok(res.lines.some((l) => /sessionDir already points at/.test(l)));
}));

test('configureSessions reports no legacy history when none exists', () => withTempDir((root) => {
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  writeSettings(repo, { sessionDir: 'data/outcomes/sessions' });
  const res = configureSessions({ repoRoot: repo, homeDir: path.join(root, 'home') });
  assert.equal(res.migrated, false);
  assert.ok(res.lines.some((l) => /No existing session history found to migrate/.test(l)));
}));

test('configureSessions does not remove or alter the source auth/session files it imports from', () => withTempDir((root) => {
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  mkdirSync(repo);
  writeSettings(repo, { sessionDir: 'data/outcomes/sessions' });
  const legacyDefault = path.join(home, '.pi', 'agent', 'sessions');
  mkdirSync(legacyDefault, { recursive: true });
  const srcFile = path.join(legacyDefault, 's.jsonl');
  writeFileSync(srcFile, sessionJsonl('/repo', '2024-01-01T00:00:00.000Z'));
  configureSessions({ repoRoot: repo, homeDir: home });
  // Import is a copy, not a move: the source file is still there, byte-for-byte.
  assert.equal(existsSync(srcFile), true);
  const src = readFileSync(srcFile, 'utf8');
  const dest = readFileSync(path.join(repo, 'data', 'outcomes', 'sessions', '--repo--', 's.jsonl'), 'utf8');
  assert.equal(src, dest);
}));

test('configureSessions returns the newSessions path and a lines array', () => withTempDir((root) => {
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  writeSettings(repo, { sessionDir: 'data/outcomes/sessions' });
  const res = configureSessions({ repoRoot: repo, homeDir: path.join(root, 'home') });
  assert.equal(res.newSessions, path.join(repo, 'data', 'outcomes', 'sessions'));
  assert.ok(Array.isArray(res.lines));
  assert.ok(res.lines.length > 0);
}));
