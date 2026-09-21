// Shared post-install readiness checks for the Windows installer.
//
// The app starts but cannot talk to any model without auth/provider keys. These
// pure helpers detect that gap and report remediation. The platform option is
// retained so the helpers remain independently testable.

import path from 'node:path';
import { authHasContent, authProviderNames, readAuthProviders } from './auth.mjs';
import { readJsonFile } from './json.mjs';
import { resolveVscodeSettingsDirs } from './vscode-settings.mjs';

const PROVIDER_ENV_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'];

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
 * `providerEnvPresent` (when defined) overrides the env-var scan. install.bat
 * checks provider keys at Windows User scope, which a Node subprocess cannot
 * see in process.env, so the wrapper computes that itself and passes it in.
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
    '      - Or authenticate a subscription provider interactively:',
    '          pi',
    '        Then enter /login and select a provider. Re-run this installer afterward',
    '        if pi wrote credentials into the checkout instead of the configured auth directory.',
    '      See README.md → Authentication for the supported options.',
  );
  return { level: 'warn', lines };
}

/**
 * Verify `pie.agentDir` is set to the expected repo root in VS Code User
 * settings. install.bat folds this into the shared readiness call via
 * `--vscode-agent-dir-expected`. The setting is read from every
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
      `      Re-run this installer to auto-merge, or copy manually: copy /Y "${inTreeAuthPath}" "${backendAuthPath}"`,
    ],
  };
}
