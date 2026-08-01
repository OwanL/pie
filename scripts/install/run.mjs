#!/usr/bin/env node
// Shared installer operations dispatcher.
//
// install.bat and install.sh are thin platform wrappers: they handle
// shell-specific concerns (env-var persistence, interactive prompts, exit
// handling, executable PATH hints) and delegate the cross-platform business
// logic here. Each subcommand is a focused, side-effect-bounded operation that
// the shell invokes at the right point in its flow:
//
//   node scripts/install/run.mjs repair-settings <settings.json>
//   node scripts/install/run.mjs merge-auth <in-tree-auth.json> <secure-auth.json>
//   node scripts/install/run.mjs relocate-auth <src-auth.json> <dest-auth.json>
//   node scripts/install/run.mjs configure-sessions <repoRoot>
//   node scripts/install/run.mjs resolve-pi
//   node scripts/install/run.mjs pinned-versions
//   node scripts/install/run.mjs verify-toolchain [--json]
//   node scripts/install/run.mjs write-vscode-agent-dir <repoRoot>
//   node scripts/install/run.mjs readiness --auth <path> [--in-tree-auth <path>] [--auth-dir <dir>] [--repo-root <dir>] [--vscode-agent-dir-expected <dir>]
//   node scripts/install/run.mjs has-jsonl <path> [--no-recurse]
//
// `verify-toolchain` is a dry run: it reports pinned-vs-actual drift and the
// install commands the wrapper WOULD run, but never installs anything.

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readJsonFile, writeJsonFile } from './lib/json.mjs';
import { repairExtensionPaths } from './lib/settings-repair.mjs';
import { mergeAuthProviders, readAuthProviders, relocateAuthFile } from './lib/auth.mjs';
import { lookupOnPath, resolvePiBinary } from './lib/pi-binary.mjs';
import { mergeAgentDirSetting, resolveVscodeSettingsDirs } from './lib/vscode-settings.mjs';
import { checkAuthReadiness, checkSplitBrain, checkVscodeAgentDir } from './lib/readiness.mjs';
import { readPinnedVersions, verifyToolchain } from './lib/toolchain.mjs';
import { directoryHasJsonlFiles } from './lib/sessions.mjs';
import { configureSessions } from './lib/sessions-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// Run a CLI command portably: on Windows, npm/pi/etc. are .cmd shims that
// spawnSync (shell:false) cannot resolve directly, so route through cmd.exe
// exactly like scripts/doctor.mjs does.
function run(command, args, cwd = repoRoot) {
  return process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command, ...args], { cwd, encoding: 'utf8', windowsHide: true })
    : spawnSync(command, args, { cwd, encoding: 'utf8' });
}

function npmConfigGetPrefix() {
  const result = run('npm', ['config', 'get', 'prefix']);
  if (result.status !== 0) return '';
  return (result.stdout ?? '').trim();
}

function resolvePiOnPath() {
  // Manual PATH search (no `which`/`where.exe` dependency); on Windows PATHEXT
  // resolves `pi` to the runnable `pi.cmd`, skipping any extensionless shim.
  return lookupOnPath({ name: 'pi', platform: process.platform, env: process.env });
}

function printHelp() {
  console.log(`Usage: node scripts/install/run.mjs <command> [args]

Commands:
  repair-settings <settings.json>       Rewrite absolute extension paths to this machine's npm prefix.
  merge-auth <in-tree> <secure>         Merge split-brain in-tree auth.json into the secure location and remove the in-tree copy.
  relocate-auth <src> <dest>            Atomically copy auth.json to the secure location with SHA-256 verification (no in-tree removal/ACL/env).
  configure-sessions <repoRoot>        Rewrite settings.json#sessionDir to the canonical store and migrate legacy session history.
  resolve-pi                            Print the resolved pi binary path (or empty line).
  pinned-versions                       Print the pinned Node/npm/pi versions (one per line).
  verify-toolchain [--json]             Dry-run: report pinned-vs-actual Node/npm/pi drift (never installs).
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
  const npmPrefix = npmConfigGetPrefix();
  if (!npmPrefix) {
    console.warn("WARN: Could not resolve 'npm config get prefix'; skipping extension path repair in settings.json.");
    return;
  }

  const result = repairExtensionPaths(settings, { npmPrefix, platform: process.platform });
  for (const { from, to, pkg } of result.rewritten) {
    console.log(`==> Rewriting extension path '${from}' -> '${to}'`);
    if (!existsSync(path.join(npmPrefix, 'node_modules', pkg))) {
      console.warn(`WARN: Extension package '${pkg}' is not installed under the npm global prefix. Install it with: npm i -g ${pkg}`);
    }
  }
  if (!result.changed) return;

  const backup = `${settingsPath}.extensions.${Date.now()}.bak`;
  copyFileSync(settingsPath, backup);
  // No trailing newline: matches the git-tracked settings.json style.
  writeJsonFile(settingsPath, result.settings, { trailingNewline: false });
  console.log('==> Normalized extension paths in settings.json');
  console.log(`==> Backed up the previous settings.json to ${backup}`);
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
    // Match install.sh: restrict the relocated credentials to the owner on
    // POSIX (chmod is a no-op concern on Windows, which uses ACLs).
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

function cmdResolvePi() {
  const prefix = npmConfigGetPrefix();
  const bin = resolvePiBinary({ platform: process.platform, prefix, onPath: resolvePiOnPath() });
  process.stdout.write(`${bin || ''}\n`);
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
  // install.bat delegates its full settings.json#sessionDir + legacy-import
  // orchestration here (batch cannot parse/rewrite JSON). install.sh keeps its
  // simpler scripts/migrate-local-sessions.mjs flow. Mirrors install.ps1's
  // session block exactly (default roots recursive; configured dir flat).
  const root = args[0] ? path.resolve(args[0]) : repoRoot;
  const { lines } = configureSessions({ repoRoot: root });
  for (const line of lines) console.log(line);
}

function cmdVerifyToolchain(args) {
  const asJson = args.includes('--json');
  const pinned = readPinnedVersions(repoRoot);

  const actualNode = process.versions.node;
  const npmResult = run('npm', ['--version']);
  const actualNpm = ((npmResult.stdout || '').trim() || (npmResult.stderr || '').trim());

  const piBin = resolvePiBinary({ platform: process.platform, prefix: npmConfigGetPrefix(), onPath: resolvePiOnPath() });
  let actualPi = '';
  if (piBin) {
    const piResult = run(piBin, ['--version']);
    // `pi --version` may write to stderr (e.g. the Windows .cmd shim), so fall
    // back to stderr to detect the actually-installed version correctly.
    actualPi = ((piResult.stdout || '').trim() || (piResult.stderr || '').trim());
  }

  const status = verifyToolchain({ pinned, actual: { node: actualNode, npm: actualNpm, pi: actualPi } });

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
  console.log(fmtLine('npm ', status.npm));
  console.log(fmtLine('pi  ', status.pi));
  if (status.npm.installCommand) console.log(`  would run: ${status.npm.installCommand.join(' ')}`);
  if (status.pi.installCommand) console.log(`  would run: ${status.pi.installCommand.join(' ')}`);
  if (!status.allOk) process.exitCode = 1;
}

function cmdWriteVscodeAgentDir(args) {
  const root = args[0] ? path.resolve(args[0]) : repoRoot;
  const dirs = resolveVscodeSettingsDirs();
  // install.bat creates %APPDATA%/Code/User even when VS Code is not yet
  // installed (so the setting is ready on first launch); install.sh only
  // writes to existing VS Code User dirs. Preserve both behaviours.
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
      // install.bat folds its pie.agentDir check in here; install.sh leaves this
      // unset (it has no equivalent check). Backward compatible when absent.
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

function cmdPinnedVersions() {
  // Single source of truth for the three pinned versions, read via the shared
  // scripts/toolchain.mjs helpers. Both shell installers consume this instead
  // of each re-parsing .node-version / package.json / the extension lockfile.
  // Prints node, npm, pi (one per line). Exits non-zero if any pin is missing.
  const { node, npm, pi } = readPinnedVersions(repoRoot);
  if (!node || !npm || !pi) {
    console.error('Could not resolve all pinned versions (node/npm/pi).');
    process.exit(1);
  }
  process.stdout.write(`${node}\n${npm}\n${pi}\n`);
}

const commands = {
  'repair-settings': cmdRepairSettings,
  'merge-auth': cmdMergeAuth,
  'relocate-auth': cmdRelocateAuth,
  'configure-sessions': cmdConfigureSessions,
  'resolve-pi': cmdResolvePi,
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
