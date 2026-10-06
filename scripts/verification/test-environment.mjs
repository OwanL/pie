import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const FIXTURE_ROOT_ENV = 'PIE_TEST_FIXTURE_ROOT';

/** Resolve the isolated storage locations owned by one native test process. */
export function resolveTestProcessDirectories(fixtureRoot, pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Test process ID must be a positive integer.');
  const root = path.join(path.resolve(fixtureRoot), `process-${pid}`);
  const directories = {
    root,
    home: path.join(root, 'home'),
    appData: path.join(root, 'appdata'),
    localAppData: path.join(root, 'localappdata'),
    xdgConfig: path.join(root, 'xdg-config'),
    xdgData: path.join(root, 'xdg-data'),
    xdgCache: path.join(root, 'xdg-cache'),
    config: path.join(root, 'pi-config'),
    auth: path.join(root, 'auth'),
    data: path.join(root, 'data'),
    agent: path.join(root, 'agent'),
    sessions: path.join(root, 'agent', 'sessions'),
    cache: path.join(root, 'cache'),
  };
  return directories;
}

/** Initialize all user/auth/data locations before a native test file is loaded. */
export function initializeTestEnvironment(env = process.env, pid = process.pid) {
  const fixtureRoot = env[FIXTURE_ROOT_ENV];
  if (!fixtureRoot) return undefined;

  const directories = resolveTestProcessDirectories(fixtureRoot, pid);
  for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true });
  Object.assign(env, {
    HOME: directories.home,
    USERPROFILE: directories.home,
    APPDATA: directories.appData,
    LOCALAPPDATA: directories.localAppData,
    XDG_CONFIG_HOME: directories.xdgConfig,
    XDG_DATA_HOME: directories.xdgData,
    XDG_CACHE_HOME: directories.xdgCache,
    PI_CONFIG_DIR: directories.config,
    PI_CODING_AGENT_AUTH_DIR: directories.auth,
    PI_CODING_AGENT_DIR: directories.agent,
    PI_CODING_AGENT_SESSION_DIR: directories.sessions,
    PIE_DATA_DIR: directories.data,
    PIE_CACHE_DIR: directories.cache,
  });
  return directories;
}

// Node marks process-isolated test-file workers with NODE_TEST_CONTEXT. This
// keeps fixture setup limited to test processes, not callers importing helpers.
if (process.env.NODE_TEST_CONTEXT && process.env[FIXTURE_ROOT_ENV]) initializeTestEnvironment();
