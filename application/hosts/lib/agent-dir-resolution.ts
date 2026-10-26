import * as path from 'node:path';

/**
 * Agent-directory resolution for the pie backend.
 *
 * The backend (pi SDK) resolves its config dir via `getAgentDir()`, which reads
 * `PI_CODING_AGENT_DIR`. That dir must contain `settings.json` and `models.json`
 * for legacy custom model configuration. A
 * built-in provider list missing configured custom providers is the symptom of a
 * wrong/empty agent dir, NOT a missing auth key.
 *
 * This is a recurring failure: the VS Code User setting `pie.agentDir` is a
 * persisted absolute path that goes STALE whenever the repo is relocated or the
 * config is copied across machines (the installer writes the current path, but
 * a stale value already on disk — from a previous install on another machine —
 * is blindly trusted and silently overrides the correct OS env var). The result
 * is "custom provider missing" with no visible error.
 *
 * The robust contract here: a candidate dir is only trusted if it actually
 * contains `settings.json` (the file that defines an agent dir). Candidates are
 * tried in priority order; the first that validates wins. If none validate,
 * the normal Windows application home is selected, without creating files.
 * This makes the
 * previously-fatal "stale setting" scenario self-healing instead of silent.
 */

export interface ResolveAgentDirOptions {
  /** Value of the `pie.agentDir` VS Code setting (may be stale/empty). */
  configuredAgentDir?: string;
  /** Value of `process.env.PI_CODING_AGENT_DIR` (set by the installer at User scope). */
  envAgentDir?: string;
  /** Explicit checkout agent/config root, used only after setting and env. */
  checkoutRoot?: string;
  /** Loaded package directory; used to identify known checkout layouts only. */
  extensionPath?: string;
  /** Windows application-home authority; never derived from auth/data overrides. */
  localAppDataDir?: string;
  /** Defaults to the current platform. Normal defaults are currently Windows-only. */
  platform?: NodeJS.Platform;
  /** fs.exists stand-in, injectable for tests. Defaults to node:fs existsSync. */
  exists?: (filePath: string) => boolean;
}

export interface ResolvedAgentDir {
  /** Explicit validated root, or the normal application home (which may not exist yet). */
  agentDir: string;
  /** Which source the resolved dir came from. */
  source: 'setting' | 'env' | 'extension-relative' | 'normal';
  /**
   * Diagnostics for the caller to log/surface. Populated when a candidate was
   * considered but rejected (e.g. a stale `pie.agentDir` pointing at a path
   * that no longer exists) so the user can see WHY custom providers disappeared instead
   * of debugging a silent empty-provider list.
   */
  rejections: AgentDirRejection[];
}

export interface AgentDirRejection {
  source: 'setting' | 'env' | 'extension-relative';
  candidate: string;
  /** Why this candidate was rejected. */
  reason: 'not-a-directory' | 'missing-settings-json';
}

const defaultExists = (filePath: string): boolean => {
  try {
    return require('node:fs').existsSync(filePath);
  } catch {
    return false;
  }
};

/**
 * The file whose presence identifies a dir as a real pi agent dir. We check
 * `settings.json` (always present, defines packages/session-dir/etc.) rather
 * than `models.json` because settings.json is the canonical marker and some
 * valid agent dirs legitimately lack a models.json (relying on built-in models).
 *
 * Following the runtime-resolution.ts convention, the injected `exists` is the
 * single source of truth for "this path is present". A candidate is a valid
 * agent dir iff both the dir itself and its settings.json marker exist.
 */
const AGENT_DIR_MARKER = 'settings.json';

function isValidAgentDir(candidate: string, exists: (p: string) => boolean): boolean {
  return exists(candidate) && exists(path.join(candidate, AGENT_DIR_MARKER));
}

function buildRejection(
  source: AgentDirRejection['source'],
  candidate: string,
  exists: (p: string) => boolean,
): AgentDirRejection {
  const dirExists = exists(candidate);
  return {
    source,
    candidate,
    reason: dirExists ? 'missing-settings-json' : 'not-a-directory',
  };
}

/**
 * Resolve the pi agent directory that the backend will load config from.
 *
 * Candidate priority:
 *   1. `pie.agentDir` VS Code setting (validated — must contain settings.json)
 *   2. `PI_CODING_AGENT_DIR` env var (validated)
 *   3. Explicit checkout root (or the known checkout package layout), validated.
 *      Installed extension directories do not imply a checkout at their parent.
 *   4. Normal Windows application home (%LOCALAPPDATA%/pie), without a marker
 *      requirement or filesystem writes. Missing/unsupported defaults fail closed.
 *
 * Unlike the previous behavior, a STALE `pie.agentDir` no longer silently
 * clobbers a correct env var: if the setting's path doesn't validate, it is
 * rejected (recorded) and the env var is tried next.
 */
export function checkoutAgentRoot(extensionPath: string): string | undefined {
  const packageRoot = path.resolve(extensionPath);
  // Only known source package layouts imply an agent/config root. An installed
  // VS Code extension lives under ~/.vscode/extensions and must use setting/env.
  if (path.basename(packageRoot) === 'extension') {
    return path.dirname(packageRoot);
  }
  const hostsRoot = path.dirname(packageRoot);
  const applicationRoot = path.dirname(hostsRoot);
  if (path.basename(packageRoot) === 'vscode'
      && path.basename(hostsRoot) === 'hosts'
      && path.basename(applicationRoot) === 'application') {
    return path.dirname(applicationRoot);
  }
  return undefined;
}

/** Resolve only the supported application default; never use another Pi profile. */
export function resolveNormalAgentDir(
  localAppDataDir: string | undefined = process.env.LOCALAPPDATA,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') {
    throw new Error('The normal Pie configuration home is currently Windows-only; configure an explicit agent directory.');
  }
  const root = localAppDataDir?.trim();
  if (!root || root.includes('\u0000') || !path.win32.isAbsolute(root)) {
    throw new Error('LOCALAPPDATA must be a non-empty absolute path without NUL bytes to resolve the normal Pie configuration home.');
  }
  return path.win32.join(root, 'pie');
}

export function resolveAgentDir(options: ResolveAgentDirOptions): ResolvedAgentDir {
  const exists = options.exists ?? defaultExists;
  const rejections: AgentDirRejection[] = [];

  // 1. pie.agentDir setting (highest priority IF it validates)
  const configured = options.configuredAgentDir?.trim();
  if (configured) {
    if (isValidAgentDir(configured, exists)) {
      return { agentDir: configured, source: 'setting', rejections };
    }
    rejections.push(buildRejection('setting', configured, exists));
  }

  // 2. PI_CODING_AGENT_DIR env var
  const envDir = options.envAgentDir?.trim();
  if (envDir) {
    if (isValidAgentDir(envDir, exists)) {
      return { agentDir: envDir, source: 'env', rejections };
    }
    rejections.push(buildRejection('env', envDir, exists));
  }

  // 3. Explicit checkout root, or a root derived only from a known source layout.
  const checkoutRoot = options.checkoutRoot
    ?? (options.extensionPath ? checkoutAgentRoot(options.extensionPath) : undefined);
  if (checkoutRoot) {
    const candidate = path.resolve(checkoutRoot);
    if (isValidAgentDir(candidate, exists)) {
      return { agentDir: candidate, source: 'extension-relative', rejections };
    }
    rejections.push(buildRejection('extension-relative', candidate, exists));
  }

  // A fresh normal profile need not exist. Resolution performs no provisioning:
  // startup admission and the settings owner must govern any later writes.
  return {
    agentDir: resolveNormalAgentDir(options.localAppDataDir, options.platform),
    source: 'normal',
    rejections,
  };
}
