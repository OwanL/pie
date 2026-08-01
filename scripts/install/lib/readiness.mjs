// Shared post-install readiness checks for the pie installers.
//
// The app starts but cannot talk to any model without auth/provider keys. Both
// installers detect that gap and tell the user exactly what to do next. The
// auth-content, provider-env, and split-brain checks were duplicated as inline
// PowerShell / `node -e` snippets; they now share these pure helpers.
//
// Platform-specific remediation advice (setx on Windows, export on POSIX) is
// selected via the `platform` option so the shared reporter stays accurate on
// both OSes. install.ps1 additionally keeps its pie.agentDir /
// PI_CODING_AGENT_DIR env checks in PowerShell (those are Windows-only and not
// duplicated with install.sh).

import path from 'node:path';
import { authHasContent, authProviderNames, readAuthProviders } from './auth.mjs';
import { readJsonFile } from './json.mjs';
import { resolveVscodeSettingsDirs } from './vscode-settings.mjs';

const PROVIDER_ENV_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'UMANS_API_KEY'];

/**
 * @typedef {'ok' | 'warn' | 'fail'} ReadinessLevel
 */

/**
 * @typedef {Object} ReadinessCheck
 * @property {ReadinessLevel} level
 * @property {string[]} lines
 */

/**
 * Check whether the backend has any usable credentials (auth.json content or a
 * provider API key env var). Returns platform-appropriate remediation advice.
 *
 * `providerEnvPresent` (when defined) overrides the env-var scan — install.ps1
 * checks provider keys at Windows User scope (registry), which a Node subprocess
 * cannot see in process.env, so the wrapper computes that itself and passes it
 * in. install.sh leaves it unset so this falls back to process.env.
 *
 * @param {{ authPath: string, providerEnv?: Record<string, string | undefined>, providerEnvPresent?: boolean, platform?: 'win32' | 'posix' }} input
 * @returns {ReadinessCheck}
 */
export function checkAuthReadiness({ authPath, providerEnv = process.env, providerEnvPresent, platform = process.platform }) {
  const auth = readAuthProviders(authPath);
  if (authHasContent(auth)) {
    const providers = authProviderNames(auth).join(', ');
    return { level: 'ok', lines: [`[ok] Auth credentials found (${providers}) at ${authPath}`] };
  }
  const present = providerEnvPresent ?? PROVIDER_ENV_VARS.some((name) => providerEnv[name]);
  if (present) {
    return { level: 'ok', lines: ['[ok] Provider API key env var detected — pi will use it automatically.'] };
  }
  const lines = [
    '[!] No auth.json content and no provider API key env vars found.',
    "    The pie panel will start but will get 401 / 'invalid api key' until you authenticate.",
    '    Pick ONE:',
  ];
  if (platform === 'win32') {
    lines.push(
      '      - Set a provider API key as a User env var, e.g.:',
      '          setx ANTHROPIC_API_KEY "sk-ant-..."   (then open a new terminal)',
    );
  } else {
    lines.push(
      '      • Export a provider API key, e.g.:',
      '          export ANTHROPIC_API_KEY="sk-ant-..."   (add to ~/.zshrc or ~/.bashrc)',
    );
  }
  lines.push(
    '      - Or run pi once interactively (then re-run this installer to merge creds):',
    '          pi --provider umans --model umans-glm-5.2 "hello"',
    '        (pi will prompt for an API key on first use and cache it in auth.json.)',
    '      See README.md → Authentication for the full list of supported providers.',
  );
  return { level: 'warn', lines };
}

/**
 * Verify `pie.agentDir` is set to the expected repo root in VS Code User
 * settings. install.ps1 did this check inline in PowerShell; install.bat folds
 * it into the shared readiness call via `--vscode-agent-dir-expected` (install.sh
 * leaves it unset, so this is skipped on POSIX). The setting is read from every
 * candidate VS Code User settings dir; the check passes if ANY of them already
 * points at the expected repo root (write-vscode-agent-dir writes to all that
 * exist, creating %APPDATA%/Code/User on Windows).
 *
 * @param {{ repoRoot: string, platform?: 'win32' | 'posix', env?: Record<string, string | undefined>, homedir?: string }} input
 * @returns {ReadinessCheck}
 */
export function checkVscodeAgentDir({ repoRoot, platform = process.platform, env = process.env, homedir }) {
  const dirs = resolveVscodeSettingsDirs({ platform, env, homedir });
  const settingsFiles = dirs.map((dir) => path.join(dir, 'settings.json'));
  const found = settingsFiles.some((file) => {
    const settings = readJsonFile(file, { fallback: null });
    return settings && typeof settings === 'object' && settings['pie.agentDir'] === repoRoot;
  });
  if (found) {
    return { level: 'ok', lines: ['[ok] pie.agentDir set -> backend will read models.json from repo root'] };
  }
  return {
    level: 'warn',
    lines: ['[!] pie.agentDir not set -> models may not appear. Run the installer again or set it manually in VS Code settings.'],
  };
}

/**
 * Detect split-brain: a real (non-empty) auth.json in the repo working tree
 * while the backend reads from a different PI_CODING_AGENT_AUTH_DIR.
 *
 * @param {{ inTreeAuthPath: string, authDirResolved: string, repoRoot: string }} input
 * @returns {ReadinessCheck | null} null when there is no split-brain
 */
export function checkSplitBrain({ inTreeAuthPath, authDirResolved, repoRoot }) {
  if (path.resolve(authDirResolved) === path.resolve(repoRoot)) return null;
  const inTree = readAuthProviders(inTreeAuthPath);
  if (!authHasContent(inTree)) return null;
  const backendAuthPath = path.join(authDirResolved, 'auth.json');
  return {
    level: 'warn',
    lines: [
      `[!] Split-brain: auth.json with real creds found in repo root, but backend reads from ${authDirResolved}`,
      `      Re-run this installer to auto-merge, or copy manually: cp '${inTreeAuthPath}' '${backendAuthPath}'`,
    ],
  };
}
