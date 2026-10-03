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
//     setx/npm/code shims on PATH, so the whole flow executes without
//     mutating real User env / VS Code settings / npm globals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { inferRepoRoot } from '../../lib/sdk-version.mjs';

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
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal ?? null, error: r.error ?? null };
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
  assert.match(text, /call npm run bootstrap -- --package/);
  assert.equal((text.match(/call npm run bootstrap -- --package/g) ?? []).length, 1);
  assert.doesNotMatch(text, /resolve-pi|package-sources|PI_CMD|npm ci --include=dev|npm run build|npm run package|pi login|before running pi|pi CLI reads/);
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

test('preflight and unknown-argument handling fail before installer mutations', () => {
  const text = readFileSync(installBat, 'utf8');
  assert.match(text, /echo Unknown argument: %~1 1>&2\r?\nexit \/b 1/);

  const preflight = text.indexOf('REM --- preflight: validate prerequisites before any persistent mutations');
  const npmCheck = text.indexOf('where npm >nul 2>nul || goto :no_npm', preflight);
  const nodePinCheck = text.indexOf('if /i not "%NODE_VERSION%"=="%PIN_NODE%"', preflight);
  const authConsent = text.indexOf('REM --- auth relocation consent preflight (read-only)');
  const authValidation = text.indexOf('validate-auth-dir "%REPO_ROOT%" "%AUTH_DIR_ENV%"', authConsent);
  const authPrompt = text.indexOf('set /p MOVE_CHOICE=', authConsent);
  const firstMutation = text.indexOf('call :setx_user PI_CODING_AGENT_DIR');
  assert.ok(preflight >= 0 && npmCheck > preflight, 'npm availability is checked in preflight');
  assert.ok(nodePinCheck > npmCheck, 'the exact Node pin is checked after prerequisites resolve');
  assert.ok(authConsent > nodePinCheck && authConsent < firstMutation, 'auth relocation consent is decided before persistent changes');
  assert.ok(authValidation > authConsent && authValidation < authPrompt, 'saved auth directory is validated before any consent or persistent changes');
  assert.ok(authPrompt > authConsent && authPrompt < firstMutation, 'the user prompt precedes all persistent changes');
  assert.match(text, /if defined CI goto :auth_consent_ci/, 'CI deterministically approves the relocation prompt');
  assert.equal((text.match(/set \/p MOVE_CHOICE=/g) ?? []).length, 1, 'the relocation decision is not re-prompted later');
});

test('every goto/call target resolves to a defined label', () => {
  const text = readFileSync(installBat, 'utf8');
  const labels = new Set();
  for (const m of text.matchAll(/^\s*:(\w+)/gm)) labels.add(m[1]);
  const targets = new Set();
  // Only `goto :label` and `call :label` (with a colon) are subroutine
  // jumps; bare `call npm ...` / `call "%CODE_CLI%" ...` invoke external commands.
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
  assert.ok([
    0,
    1,
  ].includes(r.status), `unexpected exit ${r.status} (signal: ${r.signal ?? 'none'}, error: ${r.error ?? 'none'})\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /install\.bat --check - dry run/);
  assert.match(r.stdout, /Toolchain verification/);
  assert.match(r.stdout, /Would-do - run install\.bat without --check/);
  assert.match(r.stdout, /source bootstrap: restore packages \+ build\/package pie VSIX/);
  assert.doesNotMatch(r.stdout, /global Pi|pi CLI|Installing pinned.*pi/i);
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

test('full install runs end-to-end against a temp repo with mocked setx/npm/code shims', { skip: !isWindows && 'cmd.exe only' }, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pie-install-bat-'));
  try {
    // --- temp repo skeleton ---
    const tRepo = path.join(tmp, 'repo');
    const hostDir = path.join(tRepo, 'application', 'hosts', 'vscode');
    mkdirSync(hostDir, { recursive: true });
    mkdirSync(path.join(tRepo, 'scripts', 'install', 'lib'), { recursive: true });
    mkdirSync(path.join(tRepo, 'scripts', 'lib'), { recursive: true });
    mkdirSync(path.join(tRepo, 'scripts', 'migrations'), { recursive: true });
    cpSync(installBat, path.join(tRepo, 'install.bat'));
    cpSync(path.join(repoRoot, 'scripts', 'install'), path.join(tRepo, 'scripts', 'install'), { recursive: true });
    cpSync(path.join(repoRoot, 'scripts', 'install', 'toolchain.mjs'), path.join(tRepo, 'scripts', 'install', 'toolchain.mjs'));
    const migrationScript = path.join(tRepo, 'scripts', 'migrations', 'migrate-outcomes-store.mjs');
    cpSync(path.join(repoRoot, 'scripts', 'migrations', 'migrate-outcomes-store.mjs'), migrationScript);
    const migrationLog = path.join(tmp, 'migration.log');
    const migrationSource = readFileSync(migrationScript, 'utf8');
    const migrationShebangEnd = migrationSource.startsWith('#!') ? migrationSource.indexOf('\n') + 1 : 0;
    writeFileSync(migrationScript, `${migrationSource.slice(0, migrationShebangEnd)}import { appendFileSync as logMigrationInvocation } from 'node:fs';\nlogMigrationInvocation(process.env.MIGRATION_LOG, 'migrate-outcomes-store\\n');\n${migrationSource.slice(migrationShebangEnd)}`);
    cpSync(path.join(repoRoot, 'scripts', 'lib', 'sdk-version.mjs'), path.join(tRepo, 'scripts', 'lib', 'sdk-version.mjs'));
    // The source manifests, not the host dependency lockfile, are authoritative
    // for Pi's source version. Populate all four before exercising preflight.
    for (const packageName of ['tui', 'ai', 'agent', 'coding-agent']) {
      const fixtureManifest = path.join(tRepo, 'harness', 'pi', 'packages', packageName, 'package.json');
      mkdirSync(path.dirname(fixtureManifest), { recursive: true });
      cpSync(path.join(repoRoot, 'harness', 'pi', 'packages', packageName, 'package.json'), fixtureManifest);
    }
    // Pins: node matches the REAL node running the test (so the node check
    // passes); npm matches the shim-reported "9.9.9". Keep all pins in place
    // before negative preflight cases mutate the Node pin below.
    writeFileSync(path.join(tRepo, '.node-version'), `${process.versions.node}\n`);
    writeFileSync(path.join(tRepo, 'package.json'), JSON.stringify({ packageManager: 'npm@9.9.9' }));
    writeFileSync(
      path.join(hostDir, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/@earendil-works/pi-coding-agent': { version: '9.9.9' } } }),
    );
    writeFileSync(path.join(tRepo, 'settings.json'), JSON.stringify({
      sessionDir: 'data/outcomes/sessions',
      packages: ['npm:pi-web-access@0.27.0', 'npm:pi-mcp-adapter@2.20.1'],
    }));
    // Pre-create a vsix so the discovery + code --install-extension path runs
    // (the build shims do not produce one).
    writeFileSync(path.join(hostDir, 'pie-9.9.9.vsix'), '');

    // --- shims (no-op + log) ---
    const shims = path.join(tmp, 'shims');
    mkdirSync(shims, { recursive: true });
    mkdirSync(path.join(tmp, 'tmp'), { recursive: true });
    const shimLog = path.join(tmp, 'shim.log');
    const crlf = (s) => s.replace(/\n/g, '\r\n');
    writeFileSync(path.join(shims, 'setx.cmd'), crlf('@echo off\n>>"%SHIM_LOG%" echo setx %*\nexit /b 0\n'));
    writeFileSync(path.join(shims, 'reg.cmd'), crlf('@echo off\nif /i "%~1"=="query" if /i "%~4"=="PI_CODING_AGENT_SESSION_DIR" if defined MOCK_USER_SESSION_DIR echo PI_CODING_AGENT_SESSION_DIR    REG_SZ    %MOCK_USER_SESSION_DIR%\nif /i "%~1"=="query" if /i "%~4"=="PI_CODING_AGENT_AUTH_DIR" if defined MOCK_USER_AUTH_DIR echo PI_CODING_AGENT_AUTH_DIR    REG_SZ    %MOCK_USER_AUTH_DIR%\nexit /b 0\n'));
    writeFileSync(path.join(shims, 'npm.cmd'), crlf('@echo off\nif "%~1"=="--version" (echo 9.9.9 & exit /b 0)\n>>"%SHIM_LOG%" echo npm %* CWD=%CD% AUTH=%PI_CODING_AGENT_AUTH_DIR%\nif "%~1"=="run" if "%~2"=="bootstrap" if defined MOCK_BOOTSTRAP_FAIL exit /b 7\nexit /b 0\n'));
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
      CI: '1',
      SHIM_LOG: shimLog,
      MIGRATION_LOG: migrationLog,
      PI_CODING_AGENT_SESSION_DIR: processSessions,
      MOCK_USER_SESSION_DIR: userSessions,
    };

    const bat = path.win32.normalize(path.join(tRepo, 'install.bat'));
    const settingsPath = path.join(tRepo, 'settings.json');
    const settingsBeforePreflight = readFileSync(settingsPath);
    const authPath = path.join(tRepo, 'auth.json');
    const authBeforePreflight = Buffer.from('{"providers":{}}\n');
    writeFileSync(authPath, authBeforePreflight);

    const unknownOption = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `"${bat}" --bogus --no-pause`], {
      env, cwd: tRepo, encoding: 'utf8', windowsVerbatimArguments: true,
    });
    assert.equal(unknownOption.status, 1, `unknown option must fail\nstdout:\n${unknownOption.stdout}\nstderr:\n${unknownOption.stderr}`);
    assert.match(`${unknownOption.stdout}${unknownOption.stderr}`, /Unknown argument: --bogus/);
    assert.ok(!existsSync(shimLog), 'unknown options exit before setx/npm/pi/code shims run');
    assert.deepEqual(readFileSync(settingsPath), settingsBeforePreflight, 'settings.json is untouched');
    assert.deepEqual(readFileSync(authPath), authBeforePreflight, 'auth.json is untouched');
    assert.ok(!existsSync(path.join(tRepo, 'data', 'outcomes', 'sessions')), 'sessions are not migrated');
    assert.ok(!existsSync(path.join(tmp, 'appdata', 'Code', 'User', 'settings.json')), 'VS Code settings are untouched');

    writeFileSync(path.join(tRepo, '.node-version'), '0.0.0\n');
    const wrongNode = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `"${bat}" --no-pause`], {
      env, cwd: tRepo, encoding: 'utf8', windowsVerbatimArguments: true,
    });
    assert.equal(wrongNode.status, 1, `wrong Node pin must fail\nstdout:\n${wrongNode.stdout}\nstderr:\n${wrongNode.stderr}`);
    assert.match(`${wrongNode.stdout}${wrongNode.stderr}`, /Node\.js 0\.0\.0 is required/);
    assert.ok(!existsSync(shimLog), 'Node pin failure occurs before persistent commands');
    assert.deepEqual(readFileSync(settingsPath), settingsBeforePreflight, 'settings.json is untouched on Node pin failure');
    assert.deepEqual(readFileSync(authPath), authBeforePreflight, 'auth.json is untouched on Node pin failure');
    assert.ok(!existsSync(path.join(tRepo, 'data', 'outcomes', 'sessions')), 'sessions are not migrated on Node pin failure');
    assert.ok(!existsSync(path.join(tmp, 'appdata', 'Code', 'User', 'settings.json')), 'VS Code settings are untouched on Node pin failure');

    const nodeOnlyDir = path.join(tmp, 'node-only');
    mkdirSync(nodeOnlyDir);
    writeFileSync(path.join(nodeOnlyDir, 'node.cmd'), crlf(`@echo off\n"${process.execPath}" %*\nexit /b %ERRORLEVEL%\n`));
    const noNpm = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `"${bat}" --no-pause`], {
      env: { ...env, PATH: [nodeOnlyDir, `${sysRoot}\\System32`, sysRoot].join(';') },
      cwd: tRepo, encoding: 'utf8', windowsVerbatimArguments: true,
    });
    assert.equal(noNpm.status, 1, `missing npm must fail\nstdout:\n${noNpm.stdout}\nstderr:\n${noNpm.stderr}`);
    assert.match(`${noNpm.stdout}${noNpm.stderr}`, /npm is required but was not found on PATH/);
    assert.ok(!existsSync(shimLog), 'npm availability failure occurs before persistent commands');
    assert.deepEqual(readFileSync(settingsPath), settingsBeforePreflight, 'settings.json is untouched when npm is missing');
    assert.deepEqual(readFileSync(authPath), authBeforePreflight, 'auth.json is untouched when npm is missing');
    assert.ok(!existsSync(path.join(tRepo, 'data', 'outcomes', 'sessions')), 'sessions are not migrated when npm is missing');
    assert.ok(!existsSync(path.join(tmp, 'appdata', 'Code', 'User', 'settings.json')), 'VS Code settings are untouched when npm is missing');

    // A saved auth path equal to or below the checkout is rejected before any
    // persistent/session/auth work, so merge-auth cannot delete the source.
    writeFileSync(path.join(tRepo, '.node-version'), `${process.versions.node}\n`);
    const invalidAuthBytes = Buffer.from('{"openai":{"apiKey":"preflight-fixture-secret"}}\n');
    for (const invalidSavedAuthDir of [tRepo, path.join(tRepo, 'nested-auth'), '.', 'nested-auth']) {
      writeFileSync(authPath, invalidAuthBytes);
      writeFileSync(shimLog, '');
      writeFileSync(migrationLog, '');
      const invalidSavedAuth = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `"${bat}" --no-pause`], {
        env: { ...env, MOCK_USER_AUTH_DIR: invalidSavedAuthDir },
        cwd: tRepo, encoding: 'utf8', windowsVerbatimArguments: true,
      });
      const invalidOutput = `${invalidSavedAuth.stdout}${invalidSavedAuth.stderr}`;
      assert.equal(invalidSavedAuth.status, 1, `invalid saved auth path must fail before install operations\nstdout:\n${invalidSavedAuth.stdout}\nstderr:\n${invalidSavedAuth.stderr}`);
      assert.match(invalidOutput, /PI_CODING_AGENT_AUTH_DIR must point outside the Git checkout/);
      assert.match(invalidOutput, /Choose an external directory/);
      assert.doesNotMatch(invalidOutput, /preflight-fixture-secret/, 'validation does not read or print auth contents');
      assert.equal(readFileSync(shimLog, 'utf8'), '', 'invalid saved auth path invokes no persistent setx/npm/code shims');
      assert.equal(readFileSync(migrationLog, 'utf8'), '', 'invalid saved auth path invokes no session migration');
      assert.doesNotMatch(invalidOutput, /Bootstrapping and packaging|Source bootstrap/, 'invalid saved auth path never bootstraps');
      assert.deepEqual(readFileSync(settingsPath), settingsBeforePreflight, 'settings.json is unchanged on invalid saved auth path');
      assert.deepEqual(readFileSync(authPath), invalidAuthBytes, 'in-tree auth bytes are unchanged on invalid saved auth path');
      assert.ok(!existsSync(path.join(tRepo, 'data', 'outcomes')), 'invalid saved auth path creates no session data');
      assert.ok(!existsSync(path.join(tRepo, 'nested-auth')), 'invalid nested saved auth path creates no in-checkout destination');
      assert.ok(!existsSync(path.join(tmp, 'appdata', 'Code', 'User', 'settings.json')), 'VS Code settings are untouched on invalid saved auth path');
    }
    // A lexically external Windows junction that resolves into the checkout
    // must fail the same read-only preflight before any persistent operations.
    const checkoutJunction = path.join(tmp, 'checkout-junction');
    symlinkSync(tRepo, checkoutJunction, 'junction');
    writeFileSync(authPath, invalidAuthBytes);
    writeFileSync(shimLog, '');
    writeFileSync(migrationLog, '');
    const junctionAuth = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `"${bat}" --no-pause`], {
      env: { ...env, MOCK_USER_AUTH_DIR: checkoutJunction },
      cwd: tRepo, encoding: 'utf8', windowsVerbatimArguments: true,
    });
    const junctionOutput = `${junctionAuth.stdout}${junctionAuth.stderr}`;
    assert.equal(junctionAuth.status, 1, `checkout junction auth path must fail before install operations\nstdout:\n${junctionAuth.stdout}\nstderr:\n${junctionAuth.stderr}`);
    assert.match(junctionOutput, /PI_CODING_AGENT_AUTH_DIR must point outside the Git checkout/);
    assert.equal(readFileSync(shimLog, 'utf8'), '', 'checkout junction invokes no persistent commands');
    assert.equal(readFileSync(migrationLog, 'utf8'), '', 'checkout junction invokes no session migration');
    assert.deepEqual(readFileSync(authPath), invalidAuthBytes, 'checkout junction preflight leaves in-tree auth untouched');

    rmSync(shimLog, { force: true });
    writeFileSync(authPath, authBeforePreflight);

    // Declining relocation is a true preflight abort: no env persistence,
    // session migration, settings rewrite, or bootstrap runs; auth bytes stay put.
    writeFileSync(path.join(tRepo, '.node-version'), `${process.versions.node}\n`);
    const noCiEnv = { ...env };
    delete noCiEnv.CI;
    writeFileSync(migrationLog, '');
    const declinedInTree = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `"${bat}" --no-pause`], {
      env: noCiEnv, cwd: tRepo, encoding: 'utf8', windowsVerbatimArguments: true, input: 'n\n',
    });
    assert.equal(declinedInTree.status, 1, `declined auth relocation must abort\nstdout:\n${declinedInTree.stdout}\nstderr:\n${declinedInTree.stderr}`);
    assert.match(declinedInTree.stdout, /INSTALL ABORTED: auth relocation was declined/);
    assert.ok(!existsSync(shimLog), 'declining invokes no setx/npm/code shims');
    assert.equal(readFileSync(migrationLog, 'utf8'), '', 'declining invokes no global outcomes migration');
    assert.doesNotMatch(declinedInTree.stdout, /Outcomes migration|Source bootstrap/, 'declining performs no session migration or bootstrap');
    assert.deepEqual(readFileSync(settingsPath), settingsBeforePreflight, 'settings.json is untouched on relocation decline');
    assert.deepEqual(readFileSync(authPath), authBeforePreflight, 'in-tree auth bytes are unchanged on relocation decline');
    assert.ok(!existsSync(path.join(tRepo, 'data', 'outcomes')), 'no outcomes data is created on relocation decline');
    assert.ok(!existsSync(path.join(tmp, 'localappdata', 'pie')), 'no auth directory is created on relocation decline');
    assert.ok(!existsSync(path.join(tmp, 'appdata', 'Code', 'User', 'settings.json')), 'VS Code settings are untouched on relocation decline');

    // Legacy default auth is also consent-gated before it can be copied into
    // the checkout. Declining leaves the source bytes in place and creates no
    // in-tree auth.json or persistent installer state.
    rmSync(authPath);
    const oldAuthPath = path.join(tmp, 'home', '.pi', 'agent', 'auth.json');
    const oldAuthBytes = Buffer.from('{"anthropic":{"apiKey":"legacy-fixture"}}\n');
    mkdirSync(path.dirname(oldAuthPath), { recursive: true });
    writeFileSync(oldAuthPath, oldAuthBytes);
    writeFileSync(migrationLog, '');
    rmSync(shimLog, { force: true });
    const declinedOldDefault = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `"${bat}" --no-pause`], {
      env: noCiEnv, cwd: tRepo, encoding: 'utf8', windowsVerbatimArguments: true, input: 'n\n',
    });
    assert.equal(declinedOldDefault.status, 1, `declined legacy auth relocation must abort\nstdout:\n${declinedOldDefault.stdout}\nstderr:\n${declinedOldDefault.stderr}`);
    assert.match(declinedOldDefault.stdout, /INSTALL ABORTED: auth relocation was declined/);
    assert.ok(!existsSync(shimLog), 'declining legacy auth invokes no setx/npm/code shims');
    assert.equal(readFileSync(migrationLog, 'utf8'), '', 'declining legacy auth invokes no global outcomes migration');
    assert.doesNotMatch(declinedOldDefault.stdout, /Outcomes migration|Source bootstrap/, 'declining legacy auth performs no session migration or bootstrap');
    assert.deepEqual(readFileSync(oldAuthPath), oldAuthBytes, 'legacy auth bytes are unchanged on relocation decline');
    assert.ok(!existsSync(authPath), 'legacy auth is not copied into the checkout on relocation decline');
    assert.deepEqual(readFileSync(settingsPath), settingsBeforePreflight, 'settings.json is untouched on legacy auth relocation decline');
    assert.ok(!existsSync(path.join(tRepo, 'data', 'outcomes')), 'no outcomes data is created on legacy auth relocation decline');
    rmSync(path.join(tmp, 'home', '.pi'), { recursive: true, force: true });

    rmSync(authPath, { force: true });
    const r = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `"${bat}" --no-pause`], {
      env, cwd: tRepo, encoding: 'utf8', windowsVerbatimArguments: true,
    });

    const log = existsSync(shimLog) ? readFileSync(shimLog, 'utf8') : '';
    // The wrapper called every mutating external tool through the shims (no real
    // setx/npm/code ran), proving the full control flow executes.
    assert.equal(r.status, 0, `install failed\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}\nshim log:\n${log}`);
    assert.match(log, /setx PI_CODING_AGENT_DIR/);
    assert.match(log, /setx PI_CODING_AGENT_SESSION_DIR/);
    const defaultAuthDir = path.join(tmp, 'localappdata', 'pie');
    assert.ok(log.includes(`setx PI_CODING_AGENT_AUTH_DIR "${defaultAuthDir}"`), `clean install persists secure auth directory at User scope\nshim log:\n${log}\nstdout:\n${r.stdout}`);
    assert.ok(existsSync(defaultAuthDir), 'clean install initializes the secure auth directory without an in-tree auth.json');
    assert.ok(r.stdout.includes(`Auth:     ${defaultAuthDir}\\auth.json`), 'installer process resolves auth through the secure directory');
    assert.ok(log.includes(`npm run bootstrap -- --package CWD=${tRepo}`), 'bootstrap runs from the repository root');
    assert.equal((log.match(/npm run bootstrap -- --package/g) ?? []).length, 1, 'the root bootstrap runs exactly once');
    assert.doesNotMatch(log, /npm ci|npm run build|npm run package|pi install|@earendil-works\/pi-coding-agent/);
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
    assert.ok(
      !existsSync(path.join(tRepo, 'data', 'outcomes', 'session-reviews')),
      'retired review sidecars are not migrated into the canonical store',
    );

    // A User-scope custom auth directory remains authoritative, receives the
    // in-tree credentials via merge, and is applied to this installer process
    // even though the value was not inherited from its parent environment.
    const customAuthDir = path.join(tmp, 'custom auth');
    mkdirSync(customAuthDir, { recursive: true });
    writeFileSync(path.join(customAuthDir, 'auth.json'), JSON.stringify({ anthropic: { apiKey: 'existing-custom-key' } }));
    writeFileSync(authPath, JSON.stringify({ openai: { apiKey: 'in-tree-key' } }));
    writeFileSync(shimLog, '');
    const customAuthEnv = { ...env, MOCK_USER_AUTH_DIR: customAuthDir };
    delete customAuthEnv.CI;
    const customAuthInstall = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `"${bat}" --no-pause`], {
      env: customAuthEnv,
      cwd: tRepo, encoding: 'utf8', windowsVerbatimArguments: true, input: 'n\n',
    });
    const customAuthLog = readFileSync(shimLog, 'utf8');
    assert.equal(customAuthInstall.status, 0, `custom auth install failed\nstdout:\n${customAuthInstall.stdout}\nstderr:\n${customAuthInstall.stderr}\nshim log:\n${customAuthLog}`);
    assert.ok(!customAuthLog.includes('setx PI_CODING_AGENT_AUTH_DIR'), 'existing custom User-scope auth path is preserved');
    assert.doesNotMatch(customAuthInstall.stdout, /Move auth\.json to/, 'saved external auth directory merges without prompting even outside CI');
    assert.ok(customAuthInstall.stdout.includes(`Auth:     ${customAuthDir}\\auth.json`), 'User-scope custom path is applied to installer process');
    assert.ok(customAuthLog.includes(`AUTH=${customAuthDir}`), 'child installer commands inherit the User-scope custom auth path');
    assert.ok(!existsSync(authPath), 'in-tree auth file is removed after merging');
    assert.deepEqual(JSON.parse(readFileSync(path.join(customAuthDir, 'auth.json'), 'utf8')), {
      anthropic: { apiKey: 'existing-custom-key' },
      openai: { apiKey: 'in-tree-key' },
    }, 'existing custom auth is retained and augmented with in-tree credentials');

    // CI does not wait for stdin: with no saved external auth directory it
    // deterministically accepts relocation, then bootstrap remains protected.
    const ciAuthBytes = Buffer.from('{"openai":{"apiKey":"ci-fixture"}}\n');
    writeFileSync(authPath, ciAuthBytes);
    writeFileSync(shimLog, '');
    const ciRelocation = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `"${bat}" --no-pause`], {
      env: { ...env, MOCK_BOOTSTRAP_FAIL: '1' }, cwd: tRepo, encoding: 'utf8', windowsVerbatimArguments: true,
    });
    const ciRelocationLog = readFileSync(shimLog, 'utf8');
    assert.equal(ciRelocation.status, 1, 'CI relocation proceeds deterministically until the deliberately failed bootstrap');
    assert.doesNotMatch(ciRelocation.stdout, /Move auth\.json to/, 'CI uses the automatic consent decision without an interactive prompt');
    assert.match(ciRelocation.stdout, /auth\.json moved to/);
    assert.ok(!existsSync(authPath), 'CI relocation removes credentials from the checkout before bootstrap');
    assert.deepEqual(JSON.parse(readFileSync(path.join(defaultAuthDir, 'auth.json'), 'utf8')), { openai: { apiKey: 'ci-fixture' } });
    assert.match(ciRelocationLog, /npm run bootstrap -- --package/);
    assert.doesNotMatch(ciRelocationLog, /code --install-extension/);

    // A bootstrap failure propagates to the installer and prevents VSIX install.
    writeFileSync(shimLog, '');
    const bootstrapFailure = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `"${bat}" --no-pause`], {
      env: { ...env, MOCK_BOOTSTRAP_FAIL: '1' }, cwd: tRepo, encoding: 'utf8', windowsVerbatimArguments: true,
    });
    const failedBootstrapLog = readFileSync(shimLog, 'utf8');
    assert.equal(bootstrapFailure.status, 1);
    assert.match(bootstrapFailure.stdout, /Source bootstrap\/package failed with exit code 7/);
    assert.equal((failedBootstrapLog.match(/npm run bootstrap -- --package/g) ?? []).length, 1);
    assert.doesNotMatch(failedBootstrapLog, /code --install-extension/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
