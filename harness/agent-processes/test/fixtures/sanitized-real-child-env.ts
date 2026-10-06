import * as path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Reconstruct only the invocation-owned recorder, never ambient Node options. */
export function trustedTestChildCoverageEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const directory = base.PIE_TEST_COVERAGE_DIR;
  const root = base.PIE_TEST_COVERAGE_ROOT;
  const cwd = base.PIE_TEST_COVERAGE_CWD;
  const includesJSON = base.PIE_TEST_COVERAGE_INCLUDES;
  if (!directory || !root || !cwd || includesJSON === undefined) return {};
  try {
    if (![directory, root, cwd].every(value => path.isAbsolute(value))) return {};
    if (realpathSync(root) !== realpathSync(repoRoot)) return {};
    const ownerRelative = path.relative(realpathSync(root), realpathSync(cwd));
    if (ownerRelative === '..' || ownerRelative.startsWith(`..${path.sep}`) || path.isAbsolute(ownerRelative)) return {};
    const privateRelative = path.relative(realpathSync(os.tmpdir()), realpathSync(directory));
    if (!privateRelative || privateRelative === '..' || privateRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(privateRelative) || realpathSync(directory) !== path.resolve(directory)) return {};
    const scope = statSync(directory);
    if (!scope.isDirectory() || (process.platform !== 'win32' && (scope.mode & 0o077) !== 0)) return {};
    const v8 = path.join(directory, 'v8');
    if (!statSync(v8).isDirectory() || realpathSync(v8) !== path.resolve(v8)) return {};
    const includes: unknown = JSON.parse(includesJSON);
    if (!Array.isArray(includes) || includes.some(value => typeof value !== 'string')) return {};
    return {
      PIE_TEST_COVERAGE_DIR: directory,
      PIE_TEST_COVERAGE_ROOT: root,
      PIE_TEST_COVERAGE_CWD: cwd,
      PIE_TEST_COVERAGE_INCLUDES: includesJSON,
      NODE_OPTIONS: `--require=${JSON.stringify(path.join(repoRoot, 'scripts/verification/coverage-capture.cjs'))}`,
      NODE_V8_COVERAGE: v8,
      JITI_SOURCE_MAPS: 'true',
    };
  } catch {
    return {};
  }
}

/** Keep source-artifact acceptance children offline and independent of the caller's credentials/configuration. */
export function buildSanitizedRealChildTestEnv(
  base: NodeJS.ProcessEnv,
  tempDir: string,
  childKind: 'inventory' | 'cold-helper',
): NodeJS.ProcessEnv {
  const allowed = new Set([
    'path', 'systemroot', 'windir', 'comspec', 'pathext', 'lang', 'lc_all', 'tz', 'tsx_tsconfig_path',
  ]);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(base).filter(([key]) => allowed.has(key.toLowerCase())),
  );
  const home = path.join(tempDir, 'home');
  const temp = path.join(tempDir, 'tmp');
  const hasDriveRoot = /^[a-z]:[\\/]/iu.test(home);

  return {
    ...env,
    ...trustedTestChildCoverageEnv(base),
    HOME: home,
    USERPROFILE: home,
    ...(hasDriveRoot ? { HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2) } : {}),
    APPDATA: path.join(tempDir, 'appdata'),
    LOCALAPPDATA: path.join(tempDir, 'local-appdata'),
    XDG_CONFIG_HOME: path.join(tempDir, 'xdg-config'),
    XDG_DATA_HOME: path.join(tempDir, 'xdg-data'),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    PI_CODING_AGENT_DIR: path.join(tempDir, 'agent'),
    PI_CODING_AGENT_AUTH_DIR: path.join(tempDir, 'auth'),
    PI_CODING_AGENT_SESSION_DIR: path.join(tempDir, 'sessions'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    YARN_OFFLINE: '1',
    YARN_ENABLE_NETWORK: '0',
    YARN_ENABLE_TELEMETRY: '0',
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    ...(childKind === 'inventory'
      ? { PIE_INITIAL_CONTEXT_INVENTORY: '1' }
      : { PIE_COLD_BROWSE_HELPER: '1' }),
  };
}
