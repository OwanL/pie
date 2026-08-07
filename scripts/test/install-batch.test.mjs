// Tests for install.bat — the native Windows (cmd.exe) installer wrapper.
//
// install.bat is a thin platform wrapper around the shared Node runner
// (scripts/install/run.mjs); the runner's own behaviour is covered by the
// install-*.test.mjs suites. These tests cover the batch wrapper itself:
//   - static structural validation (CRLF, @echo off, no PS/WSL/Unix tools,
//     every goto/call target resolves to a label, references the shared runner)
//   - --help / --check execution smoke (parse + dispatch, no mutation)
//   - the Node-absent bootstrap path (mocked PATH; precise actionable failure)
//   - a full-install control-flow run against a temp repo with mocked
//     setx/npm/pi/code shims on PATH, so the whole flow executes without
//     mutating real User env / VS Code settings / npm globals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { inferRepoRoot } from '../lib/sdk-version.mjs';

const repoRoot = inferRepoRoot();
const installBat = path.win32.normalize(path.join(repoRoot, 'install.bat'));
const isWindows = process.platform === 'win32';
const { skip } = test;

/**
 * Run install.bat with cmd.exe, returning { status, stdout, stderr }.
 * Uses backslash paths + windowsVerbatimArguments so a repo path containing
 * spaces is quoted correctly for `cmd /d /s /c "<bat>" <args>`.
 */
function runBat(args, { env: extraEnv = {}, cwd } = {}) {
  const env = { ...process.env, CI: '1', ...extraEnv };
  const r = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `"${installBat}" ${args.join(' ')}`], {
    env,
    cwd,
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Lines that are NOT REM comments (so forbidden-tool scans skip explanatory comments). */
function nonRemLines(text) {
  return text.split(/\r?\n/).filter((l) => !/^\s*REM\b/i.test(l));
}

test('install.bat is CRLF, starts with @echo off, and references the shared runner', () => {
  const raw = readFileSync(installBat, null);
  assert.ok(raw.includes(0x0d), 'file contains CR (CRLF line endings)');
  assert.equal(raw.toString('utf8').replaceAll('\r\n', '\n').includes('\r'), false, 'no lone CR outside CRLF');
  const text = readFileSync(installBat, 'utf8');
  assert.match(text, /^@echo off\r?\n/);
  assert.match(text, /scripts[\\/]install[\\/]run\.mjs/);
});

test('install.bat invokes no PowerShell/WSL/Unix tools outside REM comments', () => {
  const text = readFileSync(installBat, 'utf8');
  const code = nonRemLines(text).join('\n');
  // The header REM explains the script does NOT require these; that is allowed.
  // Any invocation outside a comment would be a real dependency.
  for (const forbidden of ['powershell', 'pwsh', 'wsl', 'bash', 'grep', 'sed', 'awk', 'which', 'chmod', 'chown']) {
    assert.doesNotMatch(code, new RegExp(`\\b${forbidden}\\b`, 'i'), `non-comment line references ${forbidden}`);
  }
});

test('every goto/call target resolves to a defined label', () => {
  const text = readFileSync(installBat, 'utf8');
  const labels = new Set();
  for (const m of text.matchAll(/^\s*:(\w+)/gm)) labels.add(m[1]);
  const targets = new Set();
  // Only `goto :label` and `call :label` (with a colon) are subroutine
  // jumps; bare `call npm ...` / `call "pi.cmd" ...` invoke external commands.
  for (const m of text.matchAll(/\b(?:goto|call)\s+:(\w+)/gi)) targets.add(m[1]);
  for (const target of targets) {
    assert.ok(labels.has(target), `goto/call target ':${target}' has no matching label`);
  }
});

test('--help prints usage and exits 0 without mutating', { skip: !isWindows && 'cmd.exe only' }, () => {
  const r = runBat(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: install\.bat/);
  assert.match(r.stdout, /--check/);
});

test('--check runs the real shared runner and reports drift + would-do (read-only)', { skip: !isWindows && 'cmd.exe only' }, () => {
  // A real-repo --check is machine-dependent in its exit code (0 if the host
  // happens to match the pins, 1 on drift), so assert only on stable substrings
  // that are always present regardless of drift direction.
  const r = runBat(['--check']);
  assert.ok([0, 1].includes(r.status), `unexpected exit ${r.status}`);
  assert.match(r.stdout, /install\.bat --check - dry run/);
  assert.match(r.stdout, /Toolchain verification/);
  assert.match(r.stdout, /Would-do - run install\.bat without --check/);
  // No setx/install/build output should appear (dry run).
  assert.doesNotMatch(r.stdout, /Installing pinned/);
});

test('--check with no Node on PATH fails with an actionable bootstrap hint', { skip: !isWindows && 'cmd.exe only' }, () => {
  // PATH excludes node but keeps system32 (where/reg/find) + a temp empty dir.
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const noNodePath = [`${sysRoot}\\System32`, sysRoot, os.tmpdir()].join(';');
  const r = runBat(['--check'], { env: { PATH: noNodePath } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Node\.js is required but was not found on PATH/);
  // The pinned version is read from .node-version (no Node needed) and surfaced.
  assert.match(r.stdout, /24\.16\.0/);
  assert.match(r.stdout, /winget install OpenJS\.NodeJS\.LTS/);
  assert.match(r.stdout, /https:\/\/nodejs\.org\//);
});

test('full install runs end-to-end against a temp repo with mocked setx/npm/pi/code shims', { skip: !isWindows && 'cmd.exe only' }, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pie-install-bat-'));
  try {
    // --- temp repo skeleton ---
    const tRepo = path.join(tmp, 'repo');
    mkdirSync(path.join(tRepo, 'extension'), { recursive: true });
    mkdirSync(path.join(tRepo, 'scripts', 'install', 'lib'), { recursive: true });
    mkdirSync(path.join(tRepo, 'scripts', 'lib'), { recursive: true });
    cpSync(installBat, path.join(tRepo, 'install.bat'));
    cpSync(path.join(repoRoot, 'scripts', 'install'), path.join(tRepo, 'scripts', 'install'), { recursive: true });
    cpSync(path.join(repoRoot, 'scripts', 'toolchain.mjs'), path.join(tRepo, 'scripts', 'toolchain.mjs'));
    cpSync(path.join(repoRoot, 'scripts', 'migrate-outcomes-store.mjs'), path.join(tRepo, 'scripts', 'migrate-outcomes-store.mjs'));
    cpSync(path.join(repoRoot, 'scripts', 'lib', 'sdk-version.mjs'), path.join(tRepo, 'scripts', 'lib', 'sdk-version.mjs'));
    // Pins: node matches the REAL node running the test (so the node check
    // passes); npm/pi match the shim-reported "9.9.9".
    writeFileSync(path.join(tRepo, '.node-version'), `${process.versions.node}\n`);
    writeFileSync(path.join(tRepo, 'package.json'), JSON.stringify({ packageManager: 'npm@9.9.9' }));
    writeFileSync(
      path.join(tRepo, 'extension', 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/@earendil-works/pi-coding-agent': { version: '9.9.9' } } }),
    );
    writeFileSync(path.join(tRepo, 'settings.json'), JSON.stringify({ sessionDir: 'data/outcomes/sessions' }));
    // Pre-create a vsix so the discovery + code --install-extension path runs
    // (the build shims do not produce one).
    writeFileSync(path.join(tRepo, 'extension', 'pie-9.9.9.vsix'), '');

    // --- shims (no-op + log) ---
    const shims = path.join(tmp, 'shims');
    mkdirSync(shims, { recursive: true });
    const shimLog = path.join(tmp, 'shim.log');
    const crlf = (s) => s.replace(/\n/g, '\r\n');
    writeFileSync(path.join(shims, 'setx.cmd'), crlf('@echo off\n>>"%SHIM_LOG%" echo setx %*\nexit /b 0\n'));
    writeFileSync(path.join(shims, 'reg.cmd'), crlf('@echo off\nif /i "%~1"=="query" if /i "%~4"=="PI_CODING_AGENT_SESSION_DIR" if defined MOCK_USER_SESSION_DIR echo PI_CODING_AGENT_SESSION_DIR    REG_SZ    %MOCK_USER_SESSION_DIR%\nexit /b 0\n'));
    writeFileSync(path.join(shims, 'npm.cmd'), crlf('@echo off\nif "%~1"=="--version" (echo 9.9.9 & exit /b 0)\n>>"%SHIM_LOG%" echo npm %*\nexit /b 0\n'));
    writeFileSync(path.join(shims, 'pi.cmd'), crlf('@echo off\nif "%~1"=="--version" (echo 9.9.9 & exit /b 0)\n>>"%SHIM_LOG%" echo pi %*\nexit /b 0\n'));
    writeFileSync(path.join(shims, 'code.cmd'), crlf('@echo off\n>>"%SHIM_LOG%" echo code %*\nexit /b 0\n'));

    // Distinct process- and HKCU-level authorities must both be migrated.
    const createDisplacedAuthority = (name) => {
      const outcomes = path.join(tmp, name, 'data', 'outcomes');
      const sessions = path.join(outcomes, 'sessions');
      mkdirSync(sessions, { recursive: true });
      writeFileSync(
        path.join(sessions, `${name}.jsonl`),
        `${JSON.stringify({ type: 'session', id: `${name}-session`, cwd: 'C:/workspace', timestamp: '2026-08-02T00:00:00.000Z' })}\n`,
      );
      const reviews = path.join(outcomes, 'session-reviews');
      mkdirSync(reviews, { recursive: true });
      writeFileSync(
        path.join(reviews, 'reviews.jsonl'),
        `${JSON.stringify({ schemaVersion: 2, kind: 'production', sessionId: `${name}-session`, reviewId: `${name}-review` })}\n`,
      );
      return sessions;
    };
    const processSessions = createDisplacedAuthority('process-displaced');
    const userSessions = createDisplacedAuthority('user-displaced');

    // --- isolated env: all mutations land under tmp ---
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const nodeDir = path.win32.dirname(path.win32.normalize(process.execPath));
    const env = {
      SystemRoot: sysRoot,
      ComSpec: `${sysRoot}\\System32\\cmd.exe`,
      PATH: [shims, `${sysRoot}\\System32`, sysRoot, nodeDir].join(';'),
      APPDATA: path.join(tmp, 'appdata'),
      LOCALAPPDATA: path.join(tmp, 'localappdata'),
      USERPROFILE: path.join(tmp, 'home'),
      TEMP: path.join(tmp, 'tmp'),
      TMP: path.join(tmp, 'tmp'),
      USERDOMAIN: process.env.USERDOMAIN || 'DOMAIN',
      USERNAME: process.env.USERNAME || 'user',
      SHIM_LOG: shimLog,
      PI_CODING_AGENT_SESSION_DIR: processSessions,
      MOCK_USER_SESSION_DIR: userSessions,
    };

    const bat = path.win32.normalize(path.join(tRepo, 'install.bat'));
    const r = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `"${bat}" --no-pause`], {
      env, cwd: tRepo, encoding: 'utf8', windowsVerbatimArguments: true,
    });

    const log = existsSync(shimLog) ? readFileSync(shimLog, 'utf8') : '';
    // The wrapper called every mutating external tool through the shims (no real
    // setx/npm/code/pi ran), proving the full control flow executes.
    assert.equal(r.status, 0, `install failed\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}\nshim log:\n${log}`);
    assert.match(log, /setx PI_CODING_AGENT_DIR/);
    assert.match(log, /setx PI_CODING_AGENT_SESSION_DIR/);
    assert.match(log, /npm ci/);
    assert.match(log, /npm run build/);
    assert.match(log, /npm run package/);
    assert.match(log, /pi update/);
    assert.match(log, /code --install-extension/);
    // write-vscode-agent-dir wrote pie.agentDir into the isolated APPDATA tree.
    const vsSettings = path.join(tmp, 'appdata', 'Code', 'User', 'settings.json');
    assert.ok(existsSync(vsSettings), 'VS Code User settings.json was written');
    const written = JSON.parse(readFileSync(vsSettings, 'utf8'));
    assert.equal(written['pie.agentDir'], path.win32.normalize(tRepo));
    // settings.json sessionDir untouched (already canonical) + no backup created.
    const settings = JSON.parse(readFileSync(path.join(tRepo, 'settings.json'), 'utf8'));
    assert.equal(settings.sessionDir, 'data/outcomes/sessions');
    assert.ok(!existsSync(path.join(tRepo, 'settings.json.session-dir')), 'no settings.json backup was created');
    const canonicalSessions = path.join(tRepo, 'data', 'outcomes', 'sessions');
    assert.ok(
      readdirSync(canonicalSessions, { recursive: true }).some((entry) => String(entry).endsWith('displaced.jsonl')),
      'displaced sessions were migrated',
    );
    const migratedSessionNames = readdirSync(canonicalSessions, { recursive: true }).map(String);
    assert.ok(migratedSessionNames.some((entry) => entry.endsWith('process-displaced.jsonl')));
    assert.ok(migratedSessionNames.some((entry) => entry.endsWith('user-displaced.jsonl')));
    const migratedReviews = readFileSync(path.join(tRepo, 'data', 'outcomes', 'session-reviews', 'reviews.jsonl'), 'utf8');
    assert.match(migratedReviews, /process-displaced-review/);
    assert.match(migratedReviews, /user-displaced-review/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
