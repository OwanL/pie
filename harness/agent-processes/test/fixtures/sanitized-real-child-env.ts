import * as path from 'node:path';

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
