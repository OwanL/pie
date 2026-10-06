#!/usr/bin/env node
// Windows installer operations dispatcher.
//
// install.bat handles cmd-specific concerns (environment persistence,
// interactive prompts, exit handling, and VS Code CLI discovery) and delegates
// testable business logic here. Each subcommand is a focused,
// side-effect-bounded operation invoked at the right point in its flow:
//
//   node scripts/install/run.mjs repair-settings <settings.json>
//   node scripts/install/run.mjs merge-auth <in-tree-auth.json> <secure-auth.json>
//   node scripts/install/run.mjs relocate-auth <src-auth.json> <dest-auth.json>
//   node scripts/install/run.mjs configure-sessions <repoRoot>
//   node scripts/install/run.mjs validate-auth-dir <repoRoot> <savedDir>
//   node scripts/install/run.mjs pinned-versions
//   node scripts/install/run.mjs verify-toolchain [--json]
//   node scripts/install/run.mjs write-vscode-agent-dir <repoRoot>
//   node scripts/install/run.mjs readiness --auth <path> [--in-tree-auth <path>] [--auth-dir <dir>] [--repo-root <dir>] [--vscode-agent-dir-expected <dir>]
//   node scripts/install/run.mjs has-jsonl <path> [--no-recurse]
//
// `verify-toolchain` is a dry run: it reports Proto-selected Node/pnpm drift
// plus Pi source provenance, but never installs anything or requires a global Pi CLI.

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readJsonFile, writeJsonFile } from './lib/json.mjs';
import { mergeAuthProviders, readAuthProviders, relocateAuthFile } from './lib/auth.mjs';
import { mergeAgentDirSetting, resolveVscodeSettingsDirs } from './lib/vscode-settings.mjs';
import { checkAuthReadiness, checkSplitBrain, checkVscodeAgentDir } from './lib/readiness.mjs';
import { readPinnedVersions, verifyToolchain } from './lib/toolchain.mjs';
import { directoryHasJsonlFiles } from './lib/sessions.mjs';
import { configureSessions } from './lib/sessions-config.mjs';
import { validateAuthDirectory } from './lib/auth-directory.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// Run a CLI command portably: on Windows, CLI shims cannot be resolved by
// spawnSync (shell:false), so route through cmd.exe, matching the shared
// subprocess helper's handling of Windows command shims.
function run(command, args, cwd = repoRoot) {
  return process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command, ...args], { cwd, encoding: 'utf8', windowsHide: true })
    : spawnSync(command, args, { cwd, encoding: 'utf8' });
}

function printHelp() {
  console.log(`Usage: node scripts/install/run.mjs <command> [args]

Commands:
  repair-settings <settings.json>       Report legacy global npm extension paths without rewriting them.
  merge-auth <in-tree> <secure>         Merge split-brain in-tree auth.json into the secure location and remove the in-tree copy.
  relocate-auth <src> <dest>            Atomically copy auth.json to the secure location with SHA-256 verification (no in-tree removal/ACL/env).
  configure-sessions <repoRoot>        Rewrite settings.json#sessionDir to the canonical store and migrate legacy session history.
  validate-auth-dir <repoRoot> <savedDir> Require the saved auth directory to be outside the Git checkout.
  pinned-versions                       Print pinned Node/pnpm/Pi source versions (one per line).
  verify-toolchain [--json]             Dry-run: report Proto-selected Node/pnpm drift and Pi source provenance (never installs).
  write-vscode-agent-dir <repoRoot>     Write pie.agentDir into each existing VS Code User settings.json.
  readiness --auth <path> [...]         Print auth/provider/split-brain (and optional pie.agentDir) readiness checks.
  has-jsonl <path> [--no-recurse]       Print 1 if the dir contains *.jsonl, else 0.`);
}

function cmdRepairSettings(args) {
  const settingsPath = args[0];
  if (!settingsPath) { console.error('repair-settings: missing settings.json path'); process.exit(2); }
  if (!existsSync(settingsPath)) return; // nothing to repair

  const settings = readJsonFile(settingsPath, { fallback: null });
  if (!settings || typeof settings !== 'object') {
    console.warn(`WARN: could not parse ${settingsPath}; skipping extension path repair.`);
    return;
  }
  const legacyPaths = (Array.isArray(settings.extensions) ? settings.extensions : [])
    .filter((entry) => typeof entry === 'string' && /[\\/]node_modules[\\/]/i.test(entry));
  if (legacyPaths.length > 0) {
    console.warn(`WARN: ${legacyPaths.length} legacy node_modules extension path(s) were left unchanged in ${settingsPath}. Replace them with a repository-owned extension path or a versioned settings.packages source; no global npm-prefix or installed-SDK fallback is used.`);
  }
}

function cmdMergeAuth(args) {
  const [inTreePath, securePath] = args;
  if (!inTreePath || !securePath) { console.error('merge-auth: requires <in-tree-auth.json> <secure-auth.json>'); process.exit(2); }
  if (!existsSync(inTreePath)) return; // nothing to merge

  // Secure location missing or empty {} -> just copy the in-tree file over.
  const secureEmpty = !existsSync(securePath) || statSync(securePath).size <= 2;
  if (secureEmpty) {
    mkdirSync(path.dirname(securePath), { recursive: true });
    copyFileSync(inTreePath, securePath);
    // Restrict credentials for direct non-Windows use; Windows uses ACLs.
    if (process.platform !== 'win32') chmodSync(securePath, 0o600);
    console.log(`==> auth.json copied from working tree to secure location '${securePath}' (was empty/missing)`);
    rmSync(inTreePath, { force: true });
    return;
  }

  const inTree = readAuthProviders(inTreePath);
  const secure = readAuthProviders(securePath);
  const { secure: merged, mergedCount } = mergeAuthProviders(inTree, secure);
  if (mergedCount > 0) {
    writeJsonFile(securePath, merged, { trailingNewline: true });
    console.log(`==> Merged ${mergedCount} provider(s) from working-tree auth.json into secure location '${securePath}'`);
  } else {
    console.log('==> Working-tree auth.json is a subset of secure auth.json; removing redundant in-tree copy');
  }
  rmSync(inTreePath, { force: true });
}

function cmdRelocateAuth(args) {
  const [src, dest] = args;
  if (!src || !dest) { console.error('relocate-auth: requires <src-auth.json> <dest-auth.json>'); process.exit(2); }
  if (!existsSync(src)) { console.error(`relocate-auth: source not found: ${src}`); process.exit(2); }
  // Atomic copy + SHA-256 verify + rollback. The wrapper (install.bat) owns the
  // surrounding Windows-specific steps: the interactive prompt, icacls ACL
  // restriction, setx PI_CODING_AGENT_AUTH_DIR, removing the in-tree source,
  // and the auth.json.removed breadcrumb — all run only after this succeeds.
  const result = relocateAuthFile({ src, dest, platform: process.platform });
  if (!result.ok) {
    console.error(`==> Hash verification failed after copy. auth.json was NOT moved.`);
    process.exit(1);
  }
  console.log(`==> auth.json copied to secure location '${dest}' and verified.`);
}

function cmdConfigureSessions(args) {
  // install.bat delegates its settings.json#sessionDir + legacy-import
  // orchestration here because batch cannot parse or rewrite JSON. Default
  // roots are recursive; a configured legacy directory is flat.
  const root = args[0] ? path.resolve(args[0]) : repoRoot;
  const { lines } = configureSessions({ repoRoot: root });
  for (const line of lines) console.log(line);
}

function cmdVerifyToolchain(args) {
  const asJson = args.includes('--json');
  const pinned = readPinnedVersions(repoRoot);

  const actualNode = process.versions.node;
  const pnpmResult = run('proto', ['run', 'pnpm', '--', '--version'], repoRoot);
  const actualPnpm = pnpmResult.status === 0
    ? ((pnpmResult.stdout || '').trim() || (pnpmResult.stderr || '').trim())
    : '';

  const status = verifyToolchain({ pinned, actual: { node: actualNode, pnpm: actualPnpm } });

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ pinned, ...status })}\n`);
    return;
  }

  console.log('==> Toolchain verification (dry run — nothing will be installed):');
  const fmtLine = (label, s) => {
    const drift = s.ok ? '' : ` (expected ${s.pinned})`;
    const tag = s.ok ? ' [ok]' : ' [DRIFT]';
    return `  ${label} ${s.actual || 'unavailable'}${drift}${tag}`;
  };
  console.log(fmtLine('Node', status.node));
  console.log(fmtLine('pnpm', status.pnpm));
  console.log(`  Pi source ${status.piSource.version || 'unavailable'} (${status.piSource.provenance})`);
  if (!status.allOk) process.exitCode = 1;
}

function cmdWriteVscodeAgentDir(args) {
  const root = args[0] ? path.resolve(args[0]) : repoRoot;
  const dirs = resolveVscodeSettingsDirs();
  // On Windows, create %APPDATA%/Code/User even when VS Code is not yet
  // installed so the setting is ready on first launch. Portable direct callers
  // only write to existing directories.
  const createIfMissing = process.platform === 'win32';
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      if (!createIfMissing) continue;
      mkdirSync(dir, { recursive: true });
    }
    const settingsPath = path.join(dir, 'settings.json');
    let settings = {};
    let corrupt = false;
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      } catch {
        // Match install.bat: back up the unparseable file before recreating it.
        corrupt = true;
        copyFileSync(settingsPath, `${settingsPath}.bak.${Date.now()}`);
        console.warn(`WARN: could not parse VS Code User settings.json (${settingsPath}); backed up and recreated.`);
      }
    }
    const { settings: merged, changed } = mergeAgentDirSetting(settings, root);
    if (changed) {
      mkdirSync(dir, { recursive: true });
      writeJsonFile(settingsPath, merged, { trailingNewline: true });
      console.log(`==> Set pie.agentDir to ${root} in VS Code User settings (${settingsPath})`);
    } else {
      console.log(`==> pie.agentDir already set in VS Code User settings (${settingsPath})`);
    }
  }
}

function cmdReadiness(args) {
  const opts = { authPath: '', inTreeAuthPath: '', authDirResolved: '', repoRoot, providerEnvPresent: undefined, vscodeAgentDirExpected: '' };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--auth') opts.authPath = args[++i];
    else if (a === '--in-tree-auth') opts.inTreeAuthPath = args[++i];
    else if (a === '--auth-dir') opts.authDirResolved = args[++i];
    else if (a === '--repo-root') opts.repoRoot = args[++i];
    else if (a === '--provider-env-present') {
      // install.bat checks provider keys at Windows User scope (registry), which
      // this subprocess cannot see; the wrapper passes the result (0/1) in.
      opts.providerEnvPresent = args[++i] === '1';
    }
    else if (a === '--vscode-agent-dir-expected') {
      // install.bat folds its pie.agentDir check in here. Keep the option
      // backward compatible when absent for direct callers.
      opts.vscodeAgentDirExpected = args[++i];
    }
  }
  if (!opts.authPath) { console.error('readiness: --auth <path> is required'); process.exit(2); }
  if (!opts.authDirResolved) opts.authDirResolved = path.dirname(opts.authPath);

  const authCheck = checkAuthReadiness({
    authPath: opts.authPath,
    platform: process.platform,
    ...(opts.providerEnvPresent !== undefined ? { providerEnvPresent: opts.providerEnvPresent } : {}),
  });
  for (const line of authCheck.lines) console.log(`  ${line}`);

  if (opts.inTreeAuthPath) {
    const split = checkSplitBrain({
      inTreeAuthPath: opts.inTreeAuthPath,
      authDirResolved: opts.authDirResolved,
      repoRoot: opts.repoRoot,
    });
    if (split) for (const line of split.lines) console.log(`  ${line}`);
  }

  if (opts.vscodeAgentDirExpected) {
    const agentDir = checkVscodeAgentDir({ repoRoot: opts.vscodeAgentDirExpected });
    for (const line of agentDir.lines) console.log(`  ${line}`);
  }
}

function cmdHasJsonl(args) {
  const target = args[0];
  if (!target) { console.error('has-jsonl: missing path'); process.exit(2); }
  const recursive = !args.includes('--no-recurse');
  process.stdout.write(directoryHasJsonlFiles(target, { recursive }) ? '1\n' : '0\n');
}

function cmdValidateAuthDir(args) {
  const [root, savedDir] = args;
  if (!root || !savedDir) {
    console.error('validate-auth-dir: requires <repoRoot> <savedDir>');
    process.exit(2);
  }

  // This command is intentionally read-only and never opens auth.json.
  const validation = validateAuthDirectory({ repoRoot: root, authDir: savedDir });
  if (!validation.valid) {
    console.error(`PI_CODING_AGENT_AUTH_DIR ${validation.reason}. Choose an external directory, preserve or move auth.json there, update the User-scope PI_CODING_AGENT_AUTH_DIR, and rerun install.bat.`);
    process.exit(1);
  }
}

function cmdPinnedVersions() {
  // Print repository Proto Node/pnpm pins and Pi source provenance one per line.
  const { node, pnpm, piSource } = readPinnedVersions(repoRoot);
  if (!node || !pnpm || !piSource) {
    console.error('Could not resolve pinned Node/pnpm/Pi source versions.');
    process.exit(1);
  }
  process.stdout.write(`${node}\n${pnpm}\n${piSource}\n`);
}

const commands = {
  'repair-settings': cmdRepairSettings,
  'merge-auth': cmdMergeAuth,
  'relocate-auth': cmdRelocateAuth,
  'configure-sessions': cmdConfigureSessions,
  'validate-auth-dir': cmdValidateAuthDir,
  'verify-toolchain': cmdVerifyToolchain,
  'pinned-versions': cmdPinnedVersions,
  'write-vscode-agent-dir': cmdWriteVscodeAgentDir,
  'readiness': cmdReadiness,
  'has-jsonl': cmdHasJsonl,
};

const [command, ...rest] = process.argv.slice(2);
const handler = commands[command];
if (!handler) {
  if (command) console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(command ? 2 : 0);
}
handler(rest);
