// Focused unit tests for scripts/install/lib/readiness.mjs — the post-install
// auth/provider/split-brain readiness checks shared by both shell installers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkAuthReadiness, checkSplitBrain, checkVscodeAgentDir } from '../install/lib/readiness.mjs';

function withTempDir(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-install-readiness-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function mkdirFor(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

test('checkAuthReadiness is ok when auth.json has real providers', () => withTempDir((root) => {
  const auth = path.join(root, 'auth.json');
  writeFileSync(auth, '{"anthropic":{"apiKey":"x"},"openai":{"apiKey":"y"}}');
  const check = checkAuthReadiness({ authPath: auth, platform: 'posix' });
  assert.equal(check.level, 'ok');
  assert.match(check.lines[0], /Auth credentials found \(anthropic, openai\)/);
}));

test('checkAuthReadiness is ok when a provider API key env var is present', () => withTempDir((root) => {
  const auth = path.join(root, 'auth.json');
  writeFileSync(auth, '{}');
  const check = checkAuthReadiness({ authPath: auth, providerEnv: { ANTHROPIC_API_KEY: 'sk-...' }, platform: 'posix' });
  assert.equal(check.level, 'ok');
  assert.match(check.lines[0], /Provider API key env var detected/);
}));

test('checkAuthReadiness gives Windows setx advice on Windows', () => withTempDir((root) => {
  const auth = path.join(root, 'auth.json');
  writeFileSync(auth, '{}');
  const check = checkAuthReadiness({ authPath: auth, providerEnv: {}, platform: 'win32' });
  assert.equal(check.level, 'warn');
  const joined = check.lines.join('\n');
  assert.match(joined, /setx ANTHROPIC_API_KEY/);
  assert.doesNotMatch(joined, /export ANTHROPIC_API_KEY/);
  assert.match(joined, /enter \/login/);
  assert.doesNotMatch(joined, /umans/i);
}));

test('checkAuthReadiness does not accept a retired provider key', () => withTempDir((root) => {
  const auth = path.join(root, 'auth.json');
  writeFileSync(auth, '{}');
  const check = checkAuthReadiness({ authPath: auth, providerEnv: { UMANS_API_KEY: 'retired' }, platform: 'posix' });
  assert.equal(check.level, 'warn');
}));

test('checkAuthReadiness gives POSIX export advice on POSIX', () => withTempDir((root) => {
  const auth = path.join(root, 'auth.json');
  writeFileSync(auth, '{}');
  const check = checkAuthReadiness({ authPath: auth, providerEnv: {}, platform: 'posix' });
  assert.equal(check.level, 'warn');
  const joined = check.lines.join('\n');
  assert.match(joined, /export ANTHROPIC_API_KEY/);
  assert.doesNotMatch(joined, /setx ANTHROPIC_API_KEY/);
}));

test('checkAuthReadiness treats a missing auth.json as no-content', () => withTempDir((root) => {
  const check = checkAuthReadiness({ authPath: path.join(root, 'missing.json'), providerEnv: {}, platform: 'posix' });
  assert.equal(check.level, 'warn');
}));

test('checkSplitBrain detects a real in-tree auth.json while the backend reads elsewhere', () => withTempDir((root) => {
  const inTree = path.join(root, 'repo', 'auth.json');
  mkdirFor(inTree);
  writeFileSync(inTree, '{"anthropic":{"apiKey":"x"}}');
  const check = checkSplitBrain({ inTreeAuthPath: inTree, authDirResolved: '/secure/pie', repoRoot: '/repo' });
  assert.ok(check);
  assert.equal(check.level, 'warn');
  assert.match(check.lines.join('\n'), /Split-brain/);
}));

test('checkSplitBrain returns null when the backend reads from the repo root', () => withTempDir((root) => {
  const inTree = path.join(root, 'auth.json');
  writeFileSync(inTree, '{"anthropic":{"apiKey":"x"}}');
  const check = checkSplitBrain({ inTreeAuthPath: inTree, authDirResolved: root, repoRoot: root });
  assert.equal(check, null);
}));

test('checkSplitBrain returns null when the in-tree auth.json is empty', () => withTempDir((root) => {
  const inTree = path.join(root, 'auth.json');
  writeFileSync(inTree, '{}');
  const check = checkSplitBrain({ inTreeAuthPath: inTree, authDirResolved: '/secure/pie', repoRoot: '/repo' });
  assert.equal(check, null);
}));

// ---------------------------------------------------------------------------
// checkVscodeAgentDir - pie.agentDir readiness (install.bat folds this into the
// readiness call via --vscode-agent-dir-expected; install.sh leaves it unset)
// ---------------------------------------------------------------------------

test('checkVscodeAgentDir is ok when a VS Code User settings.json points at the repo root', () => withTempDir((root) => {
  // Drive the Windows resolution via an isolated APPDATA so the only candidate
  // dir is under the temp tree.
  const appData = path.join(root, 'appdata');
  const userDir = path.join(appData, 'Code', 'User');
  mkdirSync(userDir, { recursive: true });
  const repoRoot = path.join(root, 'repo');
  writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify({ 'pie.agentDir': repoRoot }));
  const check = checkVscodeAgentDir({ repoRoot, platform: 'win32', env: { APPDATA: appData } });
  assert.equal(check.level, 'ok');
  assert.match(check.lines[0], /pie\.agentDir set/);
}));

test('checkVscodeAgentDir warns when no VS Code User settings.json exists', () => withTempDir((root) => {
  const appData = path.join(root, 'appdata');
  const repoRoot = path.join(root, 'repo');
  // No Code/User tree created => no settings.json to read.
  const check = checkVscodeAgentDir({ repoRoot, platform: 'win32', env: { APPDATA: appData } });
  assert.equal(check.level, 'warn');
  assert.match(check.lines.join('\n'), /pie\.agentDir not set/);
}));

test('checkVscodeAgentDir warns when the setting points elsewhere', () => withTempDir((root) => {
  const appData = path.join(root, 'appdata');
  const userDir = path.join(appData, 'Code', 'User');
  mkdirSync(userDir, { recursive: true });
  const repoRoot = path.join(root, 'repo');
  writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify({ 'pie.agentDir': path.join(root, 'other-repo') }));
  const check = checkVscodeAgentDir({ repoRoot, platform: 'win32', env: { APPDATA: appData } });
  assert.equal(check.level, 'warn');
}));

test('checkVscodeAgentDir is ok when ANY candidate dir matches (multiple VS Code installs)', () => withTempDir((root) => {
  // On POSIX the candidate list includes ~/.config/Code/User and the macOS
  // Application Support layout; exercise the XDG candidate via homedir.
  const home = path.join(root, 'home');
  const xdgUser = path.join(home, '.config', 'Code', 'User');
  mkdirSync(xdgUser, { recursive: true });
  const repoRoot = path.join(root, 'repo');
  writeFileSync(path.join(xdgUser, 'settings.json'), JSON.stringify({ 'pie.agentDir': repoRoot }));
  const check = checkVscodeAgentDir({ repoRoot, platform: 'posix', homedir: home, env: {} });
  assert.equal(check.level, 'ok');
}));

test('checkVscodeAgentDir tolerates a corrupt settings.json (treated as not-set)', () => withTempDir((root) => {
  const appData = path.join(root, 'appdata');
  const userDir = path.join(appData, 'Code', 'User');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(path.join(userDir, 'settings.json'), '{not json');
  const repoRoot = path.join(root, 'repo');
  const check = checkVscodeAgentDir({ repoRoot, platform: 'win32', env: { APPDATA: appData } });
  assert.equal(check.level, 'warn');
}));
