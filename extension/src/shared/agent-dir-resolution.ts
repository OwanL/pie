import * as path from 'node:path';

/**
 * Agent-directory resolution for the pie backend.
 *
 * The backend (pi SDK) resolves its config dir via `getAgentDir()`, which reads
 * `PI_CODING_AGENT_DIR`. That dir must contain `settings.json` and `models.json`
 * — the latter is the ONLY place custom providers are defined. A
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
 * tried in priority order; the first that validates wins. This makes the
 * previously-fatal "stale setting" scenario self-healing instead of silent.
 */

export interface ResolveAgentDirOptions {
  /** Value of the `pie.agentDir` VS Code setting (may be stale/empty). */
  configuredAgentDir?: string;
  /** Value of `process.env.PI_CODING_AGENT_DIR` (set by the installer at User scope). */
  envAgentDir?: string;
  /**
   * Optional fallback used only when no candidate validates. Pass the dir the
   * extension package was loaded from (`extensionPath/..`) so a co-located
   * `models.json` (checkout root) still resolves without any setting at all.
   */
  extensionPath?: string;
  /** fs.exists stand-in, injectable for tests. Defaults to node:fs existsSync. */
  exists?: (filePath: string) => boolean;
}

export interface ResolvedAgentDir {
  /** Absolute, validated agent dir (contains settings.json). Empty string if none validated. */
  agentDir: string;
  /** Which source the resolved dir came from. */
  source: 'setting' | 'env' | 'extension-relative' | 'none';
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
 *   3. `<extensionPath>/..` (checkout root, validated) — recovers the co-located
 *      repo layout even when both the setting and env var are unset/stale.
 *
 * Unlike the previous behavior, a STALE `pie.agentDir` no longer silently
 * clobbers a correct env var: if the setting's path doesn't validate, it is
 * rejected (recorded) and the env var is tried next.
 */
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

  // 3. extension-relative fallback (repo root co-located with the extension)
  if (options.extensionPath) {
    const relative = path.resolve(options.extensionPath, '..');
    if (isValidAgentDir(relative, exists)) {
      return { agentDir: relative, source: 'extension-relative', rejections };
    }
    rejections.push(buildRejection('extension-relative', relative, exists));
  }

  return { agentDir: '', source: 'none', rejections };
}
